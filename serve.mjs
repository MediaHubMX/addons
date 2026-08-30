/**
 * Serves every addon in this repo under its own path, in both protocols.
 *
 * A v2 addon is a folder of JSON files, so serving it is reading files. The
 * only reason this is a program and not a bucket is v1: legacy clients POST
 * `/<addon>/mediahubmx-<action>.json`, and @mediahubmx/v1-bridge answers them
 * from the very same files. An addon converted to v2 therefore keeps working
 * for clients that never heard of v2.
 *
 * An addon that cannot be files answers from an `addon.mjs` instead, for the
 * paths it has no file for. Such an addon may also export `clientFetch` to
 * take part in the client-fetch flow, for upstreams a server cannot reach.
 */

import { createServer } from "node:http";
import { readFile, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, resolve, sep } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { createV1Bridge } from "../protocol/packages/v1-bridge/index.js";
import { createIdentityReader } from "../protocol/packages/identity/index.js";
import { cached, cacheStats, cacheWrite } from "./cache.mjs";

const here = dirname(fileURLToPath(import.meta.url));
// Where the addons are. Only the tests ever set this, to serve fixtures.
const root = process.env.ADDONS_DIR ? resolve(process.env.ADDONS_DIR) : here;
const port = Number(process.env.PORT || 3000);

// The signed client identity, whichever protocol it arrived in. One reader for
// the process: it caches the v2 issuer keys, and there is nothing per-addon
// about reading a header.
const identityReader = createIdentityReader();

// The headers of the request currently being served. Needed because a dynamic
// addon is reached through a loopback (see attachBridges): the v1 bridge turns
// a v1 POST into a v2 GET against this same server, and without help the
// credential the v1 client sent would be dropped on that hop, for every
// client that actually sends one today.
const currentHeaders = new AsyncLocalStorage();

// Every directory holding an mhub-addon.json or an addon.mjs is an addon, and
// its directory name is its path. No list to keep in sync: adding a folder
// adds an addon. `private/` is scanned the same way: addons that live in
// another repository are laid in there at build time, and one ignored folder
// keeps them out of this one.
const SKIP = new Set(["node_modules", "private"]);
async function findAddons() {
  const found = new Map();
  const roots = [root, join(root, "private")];
  const entries = [];
  for (const base of roots) {
    try {
      for (const entry of await readdir(base, { withFileTypes: true })) entries.push([base, entry]);
    } catch (err) {
      if (err?.code !== "ENOENT") throw err;
    }
  }
  for (const [base, entry] of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || SKIP.has(entry.name)) continue;
    const dir = join(base, entry.name);
    let handler = null;
    try {
      await stat(join(dir, "addon.mjs"));
      handler = await import(join(dir, "addon.mjs"));
    } catch (err) {
      if (err?.code !== "ENOENT") throw err;
    }
    if (!handler) {
      try {
        await stat(join(dir, "mhub-addon.json"));
      } catch {
        continue;
      }
    }
    found.set(entry.name, { name: entry.name, dir, handler });
  }
  return found;
}

// Ten addons share this process, and node ends it on an unhandled rejection.
// A stray promise in one of them (a background refresh whose upstream went
// away) would take the other nine with it, so it is logged instead.
process.on("unhandledRejection", (err) => {
  console.error("unhandled rejection:", err?.stack || err);
});

const addons = await findAddons();

// The v1 bridge reads a v2 addon. For a folder that is the folder; for an
// addon that computes its answers it has to be this server, so the bridge
// reads the same endpoints a v2 client would instead of a second
// implementation of them existing.
function attachBridges() {
  for (const addon of addons.values()) {
    addon.bridge = addon.handler
      ? createV1Bridge(`http://127.0.0.1:${port}/${addon.name}`, { fetch: loopbackFetch })
      : createV1Bridge(addon.dir);
  }
}

// Carries the credential across the loopback, and nothing else: the hop is to
// 127.0.0.1, but it is still a new request, and a v2 GET that arrives without
// the header the v1 client sent is a request with no identity.
const CREDENTIAL_HEADERS = ["mediahubmx-signature", "mhub-token"];

function loopbackFetch(url, init = {}) {
  const headers = new Headers(init.headers);
  const incoming = currentHeaders.getStore();
  for (const name of CREDENTIAL_HEADERS) {
    const value = incoming?.[name];
    if (value) headers.set(name, value);
  }
  return fetch(url, { ...init, headers });
}

/**
 * What a dynamic addon gets besides path and query. A third argument, not a
 * changed signature, so every addon that does not care keeps working.
 *
 * `identity()` is lazy and answered once per request: verifying costs a
 * signature check, and for a v2 token a key fetch, so an addon that never asks
 * never pays for it. It resolves to null when there is no usable identity, and
 * the addon decides what that means: most of them have nothing to decide.
 *
 * `freshness(ms)` says how long THIS answer stays good, for when the addon
 * knows better than a manifest could say. A film from 2009 has settled and one
 * that comes out on Friday has not, and one number for "item" cannot tell them
 * apart. It lives on the context and not in a variable of this module on
 * purpose: two requests are in flight at the same time all day, and a shared
 * slot would hand one addon's answer the other one's lifetime.
 */
function requestContext(req) {
  let identity = null;
  const ctx = {
    headers: req.headers,
    identity: () => (identity ??= identityReader.read(req.headers)),
    freshnessMs: null,
    freshness: (ms) => {
      ctx.freshnessMs = ms;
    },
  };
  return ctx;
}

/**
 * What the manifest says about serving the addon: `cache` (seconds per
 * resource, part of the spec since v2 began and never read by anything until
 * now, which is why 34 addons declare it and none of them saw a cache) and
 * `identity` (whether an unsigned request is answered at all).
 */
const metaByAddon = new Map();
// Through the cache like everything else. A computed manifest costs an
// upstream call (tmdb fetches its genre names to build one), and paying that
// in every pod, on the first request that pod ever serves, is the one moment
// where it is most in the way.
const HINTS_REFRESH_MS = 3600 * 1000;

function manifestMeta(addon) {
  if (!metaByAddon.has(addon.name)) {
    metaByAddon.set(addon.name, cached([addon.name, ":meta"], async () => {
      try {
        // The addon answers first, the file second, exactly as everywhere
        // else: a dynamic addon may still keep a plain manifest on disk, and
        // for those the handler answers nothing for this path.
        const computed = addon.handler
          ? await addon.handler.get("/mhub-addon.json", new URLSearchParams(), { headers: {}, identity: async () => null })
          : null;
        const manifest = computed
          ?? JSON.parse(await readFile(join(addon.dir, "mhub-addon.json"), "utf-8"));
        return { cache: manifest?.cache ?? {}, identity: manifest?.identity ?? "none" };
      } catch {
        // An addon that cannot say is an addon that is not cached and not gated.
        return { cache: {}, identity: "none" };
      }
    }, { refresh: HINTS_REFRESH_MS, ttl: 24 * HINTS_REFRESH_MS }, `${addon.name}/meta`));
  }
  return metaByAddon.get(addon.name);
}
const cacheHints = async (addon) => (await manifestMeta(addon)).cache;

// The manifest is always answered, in every protocol: a client reads it to
// learn that the rest needs a credential. The v1 bridge's own manifest paths
// count, because a v1 client asks for those.
const MANIFEST_PATHS = new Set(["mhub-addon.json", "mediahubmx.json", "mediahubmx-addon.json", "mediaurl.json", "mediaurl-addon.json"]);


// The declared number is the freshness. What is left is when to throw the
// entry away, and that is only about what keeping it costs, so it is
// generous: an answer nobody asks for again ages out either way.
const DAY_MS = 24 * 3600 * 1000;
const ttlFor = (refresh) => Math.min(Math.max(refresh * 20, DAY_MS), 30 * DAY_MS);

const isClientFetch = (data) => !!data?.clientFetch?.id;

// What the cache holds for one request: the answer, and the lifetime the addon
// asked for if it asked for one. Both ways in write the same shape, because
// the way out reads only this one.
const cacheRecord = (value, refresh = null) => ({ value, refresh });

/**
 * Client-fetch and the cache, together.
 *
 * The answer to a client-fetch arrives on a second request, long after the one
 * that asked for it has been answered. To put it in the cache, that second
 * request has to say which question it answers, and the only thing that
 * travels the whole loop is the addon's `id`. So the host wraps its own part
 * around it on the way out and unwraps it on the way back.
 *
 * The addon never sees the wrapper. What the client sends back is not trusted
 * with more than a path: the addon is taken from the URL the result was posted
 * to, so a made-up wrapper can only reach the addon it was sent to.
 */
const WRAPPED = "mhub.";

const wrapId = (rel, search, id) =>
  `${WRAPPED}${Buffer.from(`${rel}\n${search}`).toString("base64url")}.${id}`;

function unwrapId(wrapped) {
  if (typeof wrapped !== "string" || !wrapped.startsWith(WRAPPED)) return null;
  const dot = wrapped.indexOf(".", WRAPPED.length);
  if (dot < 0) return null;
  try {
    const [rel, search] = Buffer.from(wrapped.slice(WRAPPED.length, dot), "base64url")
      .toString("utf-8").split("\n");
    if (!rel) return null;
    return { rel, search: search ?? "", id: wrapped.slice(dot + 1) };
  } catch {
    return null;
  }
}

const MIME = {
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
};

// The addon's own number when it has one, five minutes otherwise. One
// declaration decides both what this process keeps and what it tells the
// client, so the two cannot say different things.
const DEFAULT_MAX_AGE = 300;

function send(res, status, body, type = "text/plain; charset=utf-8", maxAge = DEFAULT_MAX_AGE) {
  res.writeHead(status, {
    "Content-Type": type,
    "Access-Control-Allow-Origin": "*",
    // A maxAge of 0 is "do not keep this", which is not the same as "no
    // number given". Only the second one falls back to the default.
    "Cache-Control": status !== 200 || maxAge === 0 ? "no-store" : `public, max-age=${maxAge || DEFAULT_MAX_AGE}`,
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
}

// What this process has done since it started. A log that only ever speaks up
// when something breaks cannot be told apart from a log nobody is writing to,
// which is the state an addon host spends most of its life in.
const tally = { requests: 0, failed: 0, lastFailureAt: null };

// One line every so often, so the log shows a working server working. Short
// enough to read at a glance and rare enough not to become the noise it is
// meant to cut through.
const HEARTBEAT_MS = 5 * 60 * 1000;
async function heartbeat() {
  // Runs the health check itself rather than reporting the last one a caller
  // happened to trigger: a monitor that is misconfigured, paused or not built
  // yet would otherwise leave the log saying nothing about health at all,
  // which is the state this line exists to prevent.
  const failure = await healthCheck();
  const stats = cacheStats();
  const rows = Object.values(stats.groups);
  const asked = rows.reduce((n, r) => n + r.asked, 0);
  const fromCache = rows.reduce((n, r) => n + r.fresh + r.stale, 0);
  const served = asked ? `${Math.round((fromCache / asked) * 100)}% from cache` : "nothing cached yet";
  const line =
    `mhub addons: ${failure ? `UNHEALTHY (${failure})` : "healthy"}, ` +
    `up ${hms(process.uptime())}, ${addons.size} addons, ` +
    `${tally.requests} requests, ${tally.failed} failed, ${served}, ${stats.store}`;
  if (failure) console.error(line);
  else console.log(line);
}

function hms(seconds) {
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  const h = Math.floor(s / 3600);
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// What "broken" means for this process, in the one place both the endpoint
// and the log read it from. Returns the reason, or null while all is well.
//
// It stays inside this server on purpose. An addon host that decides its own
// health by calling thirty upstreams reports their bad days as its own and
// wakes someone up over a Mediathek being slow; failed requests are counted
// and logged instead, where a human can weigh them.
//
// The directory is read on every check rather than trusted from startup: the
// addons are found once, and a volume that goes away afterwards leaves a
// process that is up, answers, and serves nothing. That is exactly the kind
// of broken a monitor exists to catch, and the only kind this can catch by
// looking.
async function unhealthy() {
  if (!addons.size) return "no addons loaded";
  try {
    const present = new Set();
    for (const base of [root, join(root, "private")]) {
      try {
        for (const entry of await readdir(base, { withFileTypes: true })) {
          if (entry.isDirectory()) present.add(entry.name);
        }
      } catch (err) {
        if (err?.code !== "ENOENT") throw err;
      }
    }
    const gone = [...addons.keys()].filter((name) => !present.has(name));
    if (gone.length === addons.size) return "the addon directory is gone";
    if (gone.length) return `addons no longer on disk: ${gone.join(", ")}`;
  } catch (err) {
    return `the addon directory cannot be read: ${err?.code || err?.message || err}`;
  }
  return null;
}

// Said when it changes, not once per poll: a monitor asking every minute would
// otherwise write the same line all night. What counts as a change is the
// reason and not just the verdict, so a host that breaks in a second way while
// already broken says so instead of staying on the first explanation.
let lastReason = null;
async function healthCheck() {
  const failure = await unhealthy();
  if ((failure || null) !== lastReason) {
    if (failure) console.error(`mhub addons: UNHEALTHY, ${failure}`);
    else console.log("mhub addons: healthy again");
    lastReason = failure || null;
  }
  return failure;
}

const server = createServer((req, res) => {
  // Kept before the handler rewrites it for the bridge, so the log says which
  // request failed and not which path the bridge saw.
  const asked = `${req.method} ${req.url}`;
  tally.requests++;
  return currentHeaders.run(req.headers, () =>
    // An addon whose upstream is having a bad day throws, and that throw has
    // to end as an answer. Without this the request is never replied to at
    // all and the caller waits for its own timeout, while the rejection walks
    // out of the handler and gets logged with no request next to it.
    handleRequest(req, res).catch((err) => {
      tally.failed++;
      tally.lastFailureAt = new Date().toISOString();
      console.error(`${asked} failed:`, err?.stack || err);
      if (res.headersSent) return res.end();
      send(res, 502, JSON.stringify({ error: "upstream_failed" }), MIME[".json"]);
    })
  );
});

async function handleRequest(req, res) {
  const url = new URL(req.url, "http://addons.local");
  const pathname = decodeURIComponent(url.pathname);

  // Answered for every path, before anything is looked up: a browser asks
  // before it fetches, and it asks about paths that do not exist yet. A client
  // that sends Cache-Control (real clients do, to defeat stale 404s) needs
  // this even to find out whether an addon is here at all.
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Max-Age": "86400",
    });
    return res.end();
  }

  // What the cache actually did, so the numbers in the manifests can be
  // checked against traffic instead of argued about. Counted per process and
  // since it started, and behind a token because how often an addon is asked
  // is nobody else's business. No token in the environment, no endpoint.
  if (pathname === "/cache-stats.json") {
    const token = process.env.CACHE_STATS_TOKEN;
    if (!token || url.searchParams.get("token") !== token) {
      return send(res, 404, JSON.stringify({ error: "not_found" }), MIME[".json"]);
    }
    return send(res, 200, JSON.stringify({ uptimeSeconds: Math.round(process.uptime()), ...cacheStats() }, null, 2), MIME[".json"], 0);
  }

  // Is this host healthy: the one endpoint an external monitor watches, and
  // the one thing on this server anyone at all may ask. So it answers yes or
  // no and nothing else. What is wrong, how long it has been up, how much it
  // is asked and what it keeps its cache in are all somebody's business, but
  // not the public's, and a monitor needs none of it to tell whether to wake
  // someone. That detail is in the log and behind the token on
  // `/cache-stats.json`.
  //
  // Not called after any protocol: nothing in v1 or v2 asks for this, and the
  // one path that sounds like it, `/mediahubmx-selftest.json`, is a v1 action
  // with an answer of its own (below). Operating a server and speaking its
  // protocol are different jobs and do not share a name.
  if (pathname === "/health.json") {
    const failure = await healthCheck();
    return send(res, failure ? 503 : 200, JSON.stringify({ ok: !failure }), MIME[".json"], 0);
  }

  // The v1 action of the same name, answered the way v1 specifies it: the
  // string "ok" and nothing else. It was answering an object of this host's
  // own invention, which no v1 client and no validator asked for. What that
  // object says now lives at /health.json, where it is free to say more.
  if (pathname === "/mediahubmx-selftest.json") {
    return await healthCheck()
      ? send(res, 503, JSON.stringify({ error: "unhealthy" }), MIME[".json"], 0)
      : send(res, 200, JSON.stringify("ok"), MIME[".json"], 0);
  }

  const [, name, ...rest] = pathname.split("/");
  const addon = addons.get(name);
  if (!addon) return send(res, 404, JSON.stringify({ error: "not_found" }), MIME[".json"]);

  // The manifest has one address. The bare addon path points at it instead of
  // answering with a second copy, so nothing ends up cached under two URLs.
  // The query rides along, it carries the locale the manifest is built for.
  if (rest.join("/") === "") {
    res.writeHead(302, {
      Location: `/${name}/mhub-addon.json${url.search}`,
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    });
    return res.end();
  }

  // What the client fetched on the addon's behalf. The addon gets it back and
  // answers what it was asked for in the first place.
  // `identity: "required"` in the manifest: nothing but the manifest is
  // answered without a usable credential. The addon's own code never has to
  // check; the reader answers null for missing, expired and forged alike.
  if ((await manifestMeta(addon)).identity === "required" && !MANIFEST_PATHS.has(rest.join("/"))) {
    if (!(await identityReader.read(req.headers))) {
      return send(res, 401, JSON.stringify({ error: "identity_required" }), MIME[".json"], 0);
    }
  }

  if (req.method === "POST" && rest.join("/") === "client-fetch") {
    if (!addon.handler?.clientFetch) {
      return send(res, 404, JSON.stringify({ error: "not_found" }), MIME[".json"]);
    }
    try {
      const result = JSON.parse(await readBody(req));
      // The request this answers, if the host put a wrapper on it. Everything
      // else is the plain v2 flow, unchanged.
      const asked = unwrapId(result.id);
      const data = await addon.handler.clientFetch(asked ? { ...result, id: asked.id } : result);
      if (!data) return send(res, 404, JSON.stringify({ error: "not_found" }), MIME[".json"]);

      if (asked && isClientFetch(data)) {
        // One more round. The wrapper carries the same request onward, so the
        // last answer of the chain still knows where it belongs.
        const id = wrapId(asked.rel, asked.search, data.clientFetch.id);
        return send(res, 200, JSON.stringify({ clientFetch: { ...data.clientFetch, id } }), MIME[".json"], 0);
      }
      if (asked) {
        // The answer the first request could not give. Filed under that
        // request's key, so the next caller is served without a detour.
        const hints = await cacheHints(addon);
        const seconds = hints[asked.rel.split("/")[0]];
        if (seconds) {
          const refresh = seconds * 1000;
          await cacheWrite(
            [addon.name, asked.rel, asked.search],
            cacheRecord(data),
            { refresh, ttl: ttlFor(refresh) },
          );
        }
      }
      return send(res, 200, JSON.stringify(data), MIME[".json"]);
    } catch (err) {
      return send(res, 400, JSON.stringify({ error: err?.message || "bad request" }), MIME[".json"]);
    }
  }

  // v1 routes first: the bridge answers them, everything else falls through to
  // the files, which is what a v2 client reads. The bridge sees the path
  // WITHOUT the addon segment, the way mounting works everywhere in Node. The
  // query has to survive that rewrite: it carries search, filters and cursor.
  req.url = "/" + rest.join("/") + url.search;

  return addon.bridge.middleware(req, res, async () => {
    const rel = rest.join("/");

    // The addon answers first, files second. An addon that computes anything
    // also computes its manifest, because catalog names are localized and a
    // file cannot read a query string.
    const resource = rel.split("/")[0];
    const hints = await cacheHints(addon);
    // Whether an identity-reading addon's answers may sit in this shared
    // cache is the ADDON's call, made with its cache hints and freshness:
    // an addon that personalises simply declares no cache for that resource.
    const seconds = hints[resource];

    if (addon.handler) {
      try {
      const ctx = requestContext(req);
      const ask = async () => cacheRecord(
        await addon.handler.get("/" + rel, url.searchParams, ctx),
        ctx.freshnessMs,
      );
      let data;
      let maxAge = seconds;
      // Everything the answer depends on. The query carries language, region,
      // search, filters and cursor, sorted so the same request is the same key
      // however the client ordered it.
      const search = [...url.searchParams.entries()].sort().map(([k, v]) => `${k}=${v}`).join("&");
      if (seconds) {
        const got = await cached([addon.name, rel, search], ask, ({ value, refresh }) => {
          // An instruction to go fetch is not an answer and must not age like
          // one: it is handed out again next time, and what the client brings
          // back takes its place in the cache.
          if (isClientFetch(value)) return { refresh: 0, ttl: 0 };
          const r = refresh ?? seconds * 1000;
          return { refresh: r, ttl: ttlFor(r) };
        }, `${addon.name}/${resource}`);
        data = got.value;
        // What the client is told and what this process keeps are the same
        // number, override included. Two answers to one question is how they
        // drift apart.
        maxAge = got.refresh ? Math.round(got.refresh / 1000) : seconds;
      } else {
        const got = await ask();
        data = got.value;
        maxAge = got.refresh ? Math.round(got.refresh / 1000) : seconds;
      }
      if (isClientFetch(data)) {
        // Only a cacheable resource gets a wrapper, because only its answer
        // has a key to be filed under.
        const id = seconds ? wrapId(rel, search, data.clientFetch.id) : data.clientFetch.id;
        return send(res, 200, JSON.stringify({ clientFetch: { ...data.clientFetch, id } }), MIME[".json"], 0);
      }
      if (data) return send(res, 200, JSON.stringify(data), MIME[".json"], maxAge);
      } catch (err) {
        // The two refusals the spec types. An addon signals them by throwing
        // the error name; everything else stays what it was, a failure.
        if (err?.message === "identity_required") {
          return send(res, 401, JSON.stringify({ error: "identity_required" }), MIME[".json"], 0);
        }
        if (err?.message === "entitlement_required") {
          return send(res, 403, JSON.stringify({ error: "entitlement_required" }), MIME[".json"], 0);
        }
        if (err?.message === "rate_limited") {
          return send(res, 429, JSON.stringify({ error: "rate_limited" }), MIME[".json"], 0);
        }
        throw err;
      }
    }

    const file = resolve(join(addon.dir, rel));
    if (file !== addon.dir && !file.startsWith(addon.dir + sep)) {
      return send(res, 403, JSON.stringify({ error: "forbidden" }), MIME[".json"]);
    }
    try {
      return send(res, 200, await readFile(file), MIME[extname(file)] || "application/octet-stream", seconds);
    } catch (err) {
      if (err?.code !== "ENOENT" && err?.code !== "EISDIR") throw err;
    }
    send(res, 404, JSON.stringify({ error: "not_found" }), MIME[".json"]);
  });
}

server.listen(port, () => {
  attachBridges();
  console.log(`mhub addons on :${port}: ${addons.size ? [...addons.keys()].join(", ") : "none yet"}`);
  // Unreferenced: a heartbeat is something to read while the server runs, not
  // a reason for it to keep running.
  setInterval(heartbeat, HEARTBEAT_MS).unref();
});
