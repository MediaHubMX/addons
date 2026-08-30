/**
 * The host, not the addons: what it serves, and that both protocols reach the
 * same addon. Fixtures live in test/fixtures so the real addons stay out of it.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFile, readdir, mkdir, rm, writeFile } from "node:fs/promises";
import { cached, cacheStats } from "./cache.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = 5699;
const base = `http://127.0.0.1:${PORT}`;
let server;

before(async () => {
  server = spawn(process.execPath, [join(here, "serve.mjs")], {
    env: { ...process.env, PORT: String(PORT), ADDONS_DIR: join(here, "test", "fixtures") },
    stdio: "ignore",
  });
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${base}/health.json`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("server did not start");
});

after(() => server?.kill());

const get = async (path) => {
  const res = await fetch(base + path);
  return { status: res.status, body: await res.json().catch(() => null) };
};

const post = async (path, body) => {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "MediaHubMX/2" },
    body: JSON.stringify({ language: "en", region: "US", ...body }),
  });
  return { status: res.status, body: await res.json() };
};

test("a folder is an addon", async () => {
  // Nothing publishes the list any more, so the addons say it themselves.
  assert.equal((await get("/static-addon/mhub-addon.json")).body.id, "static-addon");
  assert.equal((await get("/dynamic-addon/mhub-addon.json")).body.id, "dynamic-addon");
});

test("static addon: files answer v2, the bridge answers v1", async () => {
  assert.equal((await get("/static-addon/mhub-addon.json")).body.id, "static-addon");
  assert.equal((await get("/static-addon/catalog/video/all.json")).body.items[0].name, "One");

  const v1 = await post("/static-addon/mediahubmx.json", {});
  assert.equal(v1.body.id, "static-addon");
  const catalog = await post("/static-addon/mediahubmx-catalog.json", {
    id: "all", adult: false, search: "", sort: "", filter: {}, cursor: null,
  });
  assert.equal(catalog.body.items[0].name, "One");
});

test("dynamic addon: the handler answers, and the query reaches it", async () => {
  // The manifest is a real file even here, which is how the addon is found.
  assert.equal((await get("/dynamic-addon/mhub-addon.json")).body.id, "dynamic-addon");

  const { body } = await get("/dynamic-addon/catalog/video/all.json?search=moon&cursor=3");
  assert.equal(body.items[0].name, "search=moon cursor=3");
});

test("a dynamic addon reaches v1 clients too", async () => {
  const v1 = await post("/dynamic-addon/mediahubmx.json", {});
  assert.equal(v1.body.id, "dynamic-addon");

  // The bridge reads this server, so the search a v1 client sends has to
  // arrive at the handler through the whole loop.
  const catalog = await post("/dynamic-addon/mediahubmx-catalog.json", {
    id: "all", adult: false, search: "moon", sort: "", filter: {}, cursor: null,
  });
  assert.equal(catalog.body.items[0].name, "search=moon cursor=");
});

test("a dynamic addon sees the credential, on both protocols", async () => {
  // The header is not a valid signature, so no identity comes out of it. What
  // is being tested is that it arrives at all: a v1 client's POST is answered
  // through a loopback GET against this same server, and the credential has to
  // survive that hop or the only clients that send one are the ones that lose
  // it.
  const credential = "not-a-real-signature";
  const res = await fetch(`${base}/dynamic-addon/identity.json`, {
    headers: { "mediahubmx-signature": credential },
  });
  const direct = await res.json();
  assert.equal(direct.credential, credential);
  assert.equal(direct.identity, null);

  const viaV1 = await fetch(`${base}/dynamic-addon/mediahubmx-catalog.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "MediaHubMX/2",
      "mediahubmx-signature": credential,
    },
    body: JSON.stringify({
      language: "en", region: "US",
      id: "identity", adult: false, search: "", sort: "", filter: {}, cursor: null,
    }),
  });
  const catalog = await viaV1.json();
  assert.equal(catalog.items[0].name, `credential=${credential}`);
});

test("an addon that ignores the third argument is unaffected", async () => {
  const { body } = await get("/static-addon/catalog/video/all.json");
  assert.equal(body.items[0].name, "One");
});

test("the health endpoint answers yes or no and nothing else", async () => {
  // Anyone at all can poll this one, so what it hands out is the whole
  // question a monitor asks and none of the answers to questions it did not.
  const res = await fetch(`${base}/health.json`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test("a host whose addons went away says so, and says it again when they return", async () => {
  // Up, answering, serving nothing: the addons are found once at startup, so
  // a volume that disappears afterwards leaves a process that looks fine from
  // the outside and is not.
  const dir = join(here, "test", "fixtures", ".vanishing");
  const addon = join(dir, "gone-addon");
  await mkdir(addon, { recursive: true });
  await writeFile(join(addon, "mhub-addon.json"), JSON.stringify({ id: "gone-addon", name: "Gone", specVersion: 2 }));

  const port = PORT + 2;
  const child = spawn(process.execPath, [join(here, "serve.mjs")], {
    env: { ...process.env, PORT: String(port), ADDONS_DIR: dir },
    stdio: "ignore",
  });
  const health = () => fetch(`http://127.0.0.1:${port}/health.json`);
  try {
    let res;
    for (let i = 0; i < 50; i++) {
      try { res = await health(); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    assert.equal(res.status, 200);

    await rm(addon, { recursive: true, force: true });
    assert.equal((await health()).status, 503);
    // The v1 action tells the truth from the same check, rather than each
    // endpoint having its own opinion about whether the host is working.
    assert.equal((await fetch(`http://127.0.0.1:${port}/mediahubmx-selftest.json`)).status, 503);

    await mkdir(addon, { recursive: true });
    assert.equal((await health()).status, 200);
  } finally {
    child.kill();
    await rm(dir, { recursive: true, force: true });
  }
});

test("the v1 selftest action answers what v1 says it answers", async () => {
  // `SelftestResponse: type: string, enum: [ok]`. This host used to answer an
  // object of its own making on a path the protocol had already spoken for,
  // which is a thing no v1 client asked for and a validator rejects.
  const res = await fetch(`${base}/mediahubmx-selftest.json`);
  assert.equal(res.status, 200);
  assert.equal(await res.json(), "ok");
});

test("a host with no addons says so, in the status a monitor reads", async () => {
  // The shape a broken build takes that still answers requests: the process
  // is up and healthy by every other measure, and serves nothing at all.
  const empty = join(here, "test", "fixtures", ".empty");
  await mkdir(empty, { recursive: true });
  const port = PORT + 1;
  const child = spawn(process.execPath, [join(here, "serve.mjs")], {
    env: { ...process.env, PORT: String(port), ADDONS_DIR: empty },
    stdio: "ignore",
  });
  try {
    let res;
    for (let i = 0; i < 50; i++) {
      try { res = await fetch(`http://127.0.0.1:${port}/health.json`); break; }
      catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { ok: false });
  } finally {
    child.kill();
    await rm(empty, { recursive: true, force: true });
  }
});

test("what is not an addon is not served", async () => {
  assert.equal((await get("/nope/mhub-addon.json")).status, 404);
  assert.equal((await get("/static-addon/catalog/video/nope.json")).status, 404);
  assert.equal((await get("/static-addon/%2e%2e/%2e%2e/etc/passwd")).status, 404);
});

test("everything imported from the protocol repo is in the image", async () => {
  // The host imports across repos, and the Dockerfile has to carry each of
  // those packages in by hand. Forgetting one builds a perfectly good image
  // that dies on its first line with ERR_MODULE_NOT_FOUND, which is a thing
  // no test here would otherwise notice and the cluster notices immediately.
  const sources = [];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (path.endsWith(".mjs") || path.endsWith(".js")) sources.push(path);
    }
  };
  await walk(here);

  const imported = new Set();
  for (const path of sources) {
    const code = await readFile(path, "utf-8");
    for (const [, name] of code.matchAll(/["']\.\.\/protocol\/packages\/([^/"']+)/g)) imported.add(name);
  }

  const dockerfile = await readFile(join(here, "Dockerfile"), "utf-8");
  const copied = new Set([...dockerfile.matchAll(/^COPY protocol\/packages\/(\S+)/gm)].map(([, n]) => n));

  assert.ok(imported.has("identity"), "the scan found no imports at all, so it is not testing anything");
  assert.deepEqual([...imported].filter((name) => !copied.has(name)), []);
});

const clientFetchResult = async (id, body) => {
  const res = await fetch(`${base}/dynamic-addon/client-fetch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, status: 200, body, encoding: "utf-8" }),
  });
  return { status: res.status, body: await res.json() };
};

test("an addon can have the client fetch for it", async () => {
  const asked = await get("/dynamic-addon/source/video/far.json");
  // The host wraps its own part around the addon's id, because the answer
  // arrives on a request of its own and has to say which one it answers. The
  // addon's part is still in there, and the fixture refuses anything else.
  assert.match(asked.body.clientFetch.id, /src:far$/);
  assert.equal(asked.body.clientFetch.url, "https://upstream.invalid/geo.json");

  // What the client brings back finishes the request it was asked for.
  const done = await clientFetchResult(asked.body.clientFetch.id, "hallo");
  assert.equal(done.status, 200);
  assert.deepEqual(done.body.sources, [{ url: "https://cdn.invalid/200.m3u8", name: "hallo" }]);

  // A static addon has no such route.
  const none = await fetch(`${base}/static-addon/client-fetch`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  });
  assert.equal(none.status, 404);
});

test("what the client fetched is the answer to the request that asked", async () => {
  // A key of its own, so the round trip above cannot answer this one.
  const path = "/dynamic-addon/source/video/far.json?x=1";
  const asked = await get(path);
  assert.ok(asked.body.clientFetch, "asked the client");

  await clientFetchResult(asked.body.clientFetch.id, "erste");

  // Filed under the request that asked for it: the next caller is served the
  // answer, not another instruction, and fetches nothing.
  const cached = await get(path);
  assert.deepEqual(cached.body.sources, [{ url: "https://cdn.invalid/200.m3u8", name: "erste" }]);

  // A different question is still a different key.
  const other = await get("/dynamic-addon/source/video/far.json?x=2");
  assert.ok(other.body.clientFetch, "asked the client again");
});

test("one addon's stray promise does not end the process", async () => {
  // A rejection nobody awaited: node would end the process, taking every
  // other addon with it.
  await get("/dynamic-addon/boom.json");
  await new Promise((r) => setTimeout(r, 300));

  // Still up, still healthy, and the other addon still answers.
  assert.deepEqual((await get("/health.json")), { status: 200, body: { ok: true } });
  assert.equal((await get("/static-addon/mhub-addon.json")).body.id, "static-addon");
});

test("an addon that throws is answered, not left hanging", async () => {
  // Without a boundary the rejection walks out of the handler and the caller
  // waits for its own timeout with no reply at all.
  const res = await get("/dynamic-addon/throws.json");
  assert.equal(res.status, 502);
  assert.equal(res.body.error, "upstream_failed");

  // And the process is still serving everyone else.
  assert.equal((await get("/static-addon/mhub-addon.json")).body.id, "static-addon");
});

// --- the response cache -----------------------------------------------
// What is under test is the behaviour, not the store, and it has to hold
// either way: the keys carry this process id so a run against a real redis
// cannot find what an earlier run left behind.
const K = `test-${process.pid}`;

test("a fresh answer is served without asking again", async () => {
  let calls = 0;
  const load = async () => ++calls;
  const key = [K, "fresh"];
  assert.equal(await cached(key, load, { refresh: 5000, ttl: 60_000 }), 1);
  assert.equal(await cached(key, load, { refresh: 5000, ttl: 60_000 }), 1);
  assert.equal(calls, 1);
});

test("callers arriving together cost one upstream call", async () => {
  let calls = 0;
  const load = async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 50));
    return calls;
  };
  const opts = { refresh: 5000, ttl: 60_000 };
  const all = await Promise.all(Array.from({ length: 10 }, () => cached([K, "herd"], load, opts)));
  assert.equal(calls, 1);
  assert.deepEqual(all, Array(10).fill(1));
});

test("a stale answer is served now and replaced behind it", async () => {
  let calls = 0;
  const load = async () => ++calls;
  const opts = { refresh: 20, ttl: 60_000 };
  assert.equal(await cached([K, "stale"], load, opts), 1);
  await new Promise((r) => setTimeout(r, 40));

  // Still the old one, immediately, and the new one is on its way.
  assert.equal(await cached([K, "stale"], load, opts), 1);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(await cached([K, "stale"], load, opts), 2);
});

test("an upstream having a bad day does not empty the cache", async () => {
  let calls = 0;
  const load = async () => {
    calls += 1;
    if (calls > 1) throw new Error("upstream is down");
    return "good";
  };
  const opts = { refresh: 20, ttl: 60_000 };
  assert.equal(await cached([K, "flaky"], load, opts), "good");
  await new Promise((r) => setTimeout(r, 40));

  // The refresh fails, and the answer is still there. Twice over.
  assert.equal(await cached([K, "flaky"], load, opts), "good");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(await cached([K, "flaky"], load, opts), "good");
  assert.ok(calls > 1, "the refresh was attempted");
});

test("a dead upstream is asked once, not once per caller", async () => {
  let calls = 0;
  const load = async () => {
    calls += 1;
    throw new Error("upstream is down");
  };
  const opts = { refresh: 5000, ttl: 60_000 };
  const group = `${K}-dead`;

  await assert.rejects(cached([K, "dead"], load, opts, group), /upstream is down/);
  await assert.rejects(cached([K, "dead"], load, opts, group), /upstream is down/);
  await assert.rejects(cached([K, "dead"], load, opts, group), /upstream is down/);

  // The same error, from memory. One caller paid for it, the upstream heard
  // about it once.
  assert.equal(calls, 1);
  const row = cacheStats().groups[group];
  assert.deepEqual({ miss: row.miss, dead: row.dead, upstream: row.upstream }, { miss: 1, dead: 2, upstream: 1 });
});

test("an answer can say how long it stays good", async () => {
  const opts = (value) => (value.old ? { refresh: 60_000, ttl: 60_000 } : { refresh: 10, ttl: 60_000 });
  let calls = 0;

  assert.deepEqual(await cached([K, "old"], async () => ({ old: true, n: ++calls }), opts), { old: true, n: 1 });
  assert.deepEqual(await cached([K, "new"], async () => ({ old: false, n: ++calls }), opts), { old: false, n: 2 });
  await new Promise((r) => setTimeout(r, 40));

  // The one that said it settles is untouched, the other one refreshed.
  await cached([K, "old"], async () => ({ old: true, n: ++calls }), opts);
  await cached([K, "new"], async () => ({ old: false, n: ++calls }), opts);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await cached([K, "old"], async () => ({ old: true, n: ++calls }), opts)).n, 1);
  assert.ok((await cached([K, "new"], async () => ({ old: false, n: ++calls }), opts)).n > 2);
});

test("the failure that must never happen: no redis is not an error", async () => {
  // A url nothing answers on. The point is that this returns at all, and fast:
  // the client's own retries would hold a request for half a minute.
  process.env.REDIS_URL = "redis://127.0.0.1:1";
  const started = Date.now();
  assert.equal(await cached([K, "noredis"], async () => "answered", { refresh: 5000, ttl: 60_000 }), "answered");
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started}ms`);
  delete process.env.REDIS_URL;
});

test("the counters say what the cache actually did", async () => {
  const group = `${K}-counted`;
  const opts = { refresh: 20, ttl: 60_000 };
  let calls = 0;
  const load = async () => ++calls;

  await cached([K, "counted"], load, opts, group); // miss
  await cached([K, "counted"], load, opts, group); // fresh
  await cached([K, "counted"], load, opts, group); // fresh
  await new Promise((r) => setTimeout(r, 40));
  await cached([K, "counted"], load, opts, group); // stale, refreshed behind it
  await new Promise((r) => setTimeout(r, 50));

  const row = cacheStats().groups[group];
  assert.deepEqual(
    { miss: row.miss, fresh: row.fresh, stale: row.stale, asked: row.asked, upstream: row.upstream },
    { miss: 1, fresh: 2, stale: 1, asked: 4, upstream: 2 },
  );
  // Three of the four were answered from the store, and only two cost the
  // upstream anything. That ratio is the whole point of counting.
  assert.equal(row.served, 0.75);
});
