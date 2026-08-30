/**
 * One response cache for every addon that wants one.
 *
 * Two numbers, not one. `refresh` is how old an answer may get before it is
 * fetched again, `ttl` is when it is thrown away. They are not the same
 * question: freshness is `refresh`, and `ttl` only decides how much memory
 * this costs. An entry past its refresh is still served, immediately, while
 * the new one is fetched behind it. So a long ttl buys cheapness without
 * costing anyone accuracy, and an upstream sees at most one request per key
 * per refresh window no matter how many clients ask.
 *
 * Redis when `REDIS_URL` is set, this process otherwise, and an addon cannot
 * tell which. Redis is what makes a cache worth having across several pods and
 * across a restart, but a cache that only works with it would be a cache that
 * has to work, and nothing in here has to.
 *
 * Opt-in: an addon that never calls `ctx.cache` is served exactly as before.
 */

import { createClient } from "redis";

const PREFIX = "mhub:cache:";
// A bound for the in-process fallback. Redis has its own eviction.
const MEMORY_MAX = 2000;

const memory = new Map(); // key to record
const inFlight = new Map(); // key to the promise of a record

// How long the memory fallback is used after redis let us down, before trying
// it again. Long enough that a dead redis is not retried per request, short
// enough that a blip does not cost the shared cache until the next restart.
const RETRY_AFTER_MS = 30 * 1000;

let redis = null;
let connecting = null;
let downUntil = 0;

function markDown(err) {
  if (!downUntil) console.warn("cache: redis unavailable, using memory:", err?.message || err);
  redis?.quit().catch(() => {});
  redis = null;
  connecting = null;
  downUntil = Date.now() + RETRY_AFTER_MS;
}

/**
 * One connection for the process, and never a reason to make a request wait.
 * The retries are off on purpose: the default client keeps trying for half a
 * minute, and a request that waits that long for a cache has already lost more
 * than the cache could ever save it.
 */
async function client() {
  if (!process.env.REDIS_URL || Date.now() < downUntil) return null;
  if (redis) return redis;
  connecting ??= (async () => {
    const c = createClient({
      url: process.env.REDIS_URL,
      socket: { connectTimeout: 1000, reconnectStrategy: false },
    });
    // Without a handler an emitted error is an unhandled event and takes the
    // process with it. A cache is not worth a pod.
    c.on("error", (err) => markDown(err));
    await c.connect();
    // An open socket keeps node alive. The server runs forever anyway, but a
    // test run or a one-off script that touches the cache would hang at the
    // end waiting for a connection nobody is going to close.
    c.unref();
    downUntil = 0;
    redis = c;
    connecting = null;
  })().catch(markDown);
  // Waiting here is what makes a restarted process find a warm cache instead
  // of refilling one that is already full. It is bounded by connectTimeout,
  // and it happens once.
  await connecting;
  return redis;
}

// Start connecting before the first request rather than during it.
client();

async function read(key) {
  const c = await client();
  if (c) {
    try {
      const raw = await c.get(PREFIX + key);
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      markDown(err);
    }
  }
  return memory.get(key) ?? null;
}

async function write(key, record) {
  const c = await client();
  if (c) {
    try {
      await c.set(PREFIX + key, JSON.stringify(record), { EX: Math.ceil(record.x / 1000) });
      return;
    } catch (err) {
      // The answer is already on its way out, so a failed write costs nothing
      // but the next reader. Keep a memory copy so it costs that reader less.
      markDown(err);
    }
  }
  // delete-then-set keeps insertion order a true age queue, so the oldest key
  // is always the first one.
  memory.delete(key);
  memory.set(key, record);
  while (memory.size > MEMORY_MAX) {
    const oldest = memory.keys().next();
    if (oldest.done) break;
    memory.delete(oldest.value);
  }
}

// What a load threw, kept for a moment. An upstream that is down is down for
// every caller, and asking it once per visitor is how a bad day upstream
// becomes a slow day here. Memory only: whether this process just got an
// error is this process's business, and it expires faster than it would be
// worth sharing.
const FAILURE_MEMORY_MS = 30 * 1000;
const failures = new Map(); // key to the error and when it happened

const failedRecently = (key) => {
  const failure = failures.get(key);
  return failure && Date.now() - failure.t < FAILURE_MEMORY_MS ? failure.err : null;
};

function rememberFailure(key, err) {
  failures.delete(key);
  failures.set(key, { t: Date.now(), err });
  // delete-then-set keeps insertion order an age queue, so the walk stops at
  // the first entry still young enough to keep.
  for (const [old, failure] of failures) {
    if (Date.now() - failure.t < FAILURE_MEMORY_MS) break;
    failures.delete(old);
  }
}

/** Runs `load` once for a key, however many callers arrive while it runs. */
function once(key, load) {
  const running = inFlight.get(key) ?? load().finally(() => inFlight.delete(key));
  inFlight.set(key, running);
  return running;
}

async function fill(key, load, options) {
  const value = await load();
  const { refresh, ttl } = typeof options === "function" ? options(value) : options;
  const record = { v: value, t: Date.now(), r: refresh, x: ttl };
  // A ttl of zero is an answer that is not one: kept for this caller, kept
  // nowhere else.
  if (ttl) await write(key, record);
  return record;
}

const idOf = (key) => (Array.isArray(key) ? key.join(" ") : String(key));

/**
 * Put an answer in the cache that `cached` did not load. For the answer that
 * arrives the long way round: the addon asked the client to fetch, so the
 * request that started it was over before the answer existed.
 */
export async function cacheWrite(key, value, { refresh, ttl }) {
  if (!ttl) return;
  await write(idOf(key), { v: value, t: Date.now(), r: refresh, x: ttl });
}

/**
 * Counted per group, because a number that is right for one addon's catalogs
 * is not evidence about anything else. What the four say:
 *
 * - `fresh` was answered without asking anyone. Nothing to tune.
 * - `stale` was answered from the store while the new one was fetched. Costs
 *   an upstream call, costs the caller nothing.
 * - `miss` had nothing to answer with. Costs an upstream call AND the wait.
 * - `failed` is a refresh that threw, so an old answer stayed.
 * - `dead` was refused without asking, because the last attempt for that key
 *   threw and the upstream is given a moment before being asked again.
 *
 * A group that is nearly all `miss` is a group whose entries age out before
 * anyone asks again, and its declared number is not buying anything. One that
 * is nearly all `fresh` could carry a longer one. That is the whole reason
 * these exist: the numbers in the manifests were reasoned about, not measured.
 */
const stats = new Map();
const count = (group, what) => {
  let row = stats.get(group);
  if (!row) stats.set(group, (row = { fresh: 0, stale: 0, miss: 0, failed: 0, dead: 0 }));
  row[what] += 1;
};

export function cacheStats() {
  const groups = {};
  for (const [name, row] of stats) {
    const asked = row.fresh + row.stale + row.miss + row.dead;
    groups[name] = {
      ...row,
      asked,
      upstream: row.stale + row.miss,
      served: asked ? Number(((row.fresh + row.stale) / asked).toFixed(3)) : 0,
    };
  }
  return {
    store: redis ? "redis" : process.env.REDIS_URL ? "memory (redis unreachable)" : "memory",
    entriesInMemory: memory.size,
    groups,
  };
}

/**
 * `key` is everything the answer depends on. The language belongs in it, and
 * so does a version of your own: change the shape of what you return and the
 * old shape is still out there under the old key.
 *
 * `options` is `{ refresh, ttl }` in milliseconds, or a function of the loaded
 * value returning the same, for an answer that carries its own rate of change
 * (a film from 2009 and one that comes out on Friday are not the same
 * question).
 *
 * `group` is what the counters add this call up under. Keys are unique per
 * request and would count to one each, which is not evidence about anything.
 */
export function cached(key, load, options, group = "other") {
  const id = idOf(key);
  return (async () => {
    const hit = await read(id);
    const age = hit ? Date.now() - hit.t : Infinity;

    if (hit && age < hit.r) {
      count(group, "fresh");
      return hit.v;
    }

    if (hit) {
      // Stale, so answer now and fetch behind it. An upstream having a bad day
      // must not turn a warm cache into a cold one, so a failed refresh leaves
      // the entry exactly where it is.
      count(group, "stale");
      if (!failedRecently(id)) {
        once(id, () => fill(id, load, options)).catch((err) => {
          count(group, "failed");
          rememberFailure(id, err);
          console.warn(`cache: refresh failed for ${id}:`, err?.message || err);
        });
      }
      return hit.v;
    }

    // Nothing to answer with and the last attempt threw, so the caller gets
    // that same error now instead of waiting for the upstream to produce it
    // again.
    const dead = failedRecently(id);
    if (dead) {
      count(group, "dead");
      throw dead;
    }

    count(group, "miss");
    try {
      const record = await once(id, () => fill(id, load, options));
      failures.delete(id);
      return record.v;
    } catch (err) {
      rememberFailure(id, err);
      throw err;
    }
  })();
}

export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
