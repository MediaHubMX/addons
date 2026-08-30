/**
 * The EPG, as the addon uses it: read from Redis, kept in memory, rebuilt by a
 * child process when Redis has nothing.
 *
 * Without REDIS_URL there is no EPG. That is deliberate: the build peaks around
 * 400MB and re-running it in every pod, forever, is exactly why the v1 addon
 * may not be scaled out.
 */

import { spawn } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createClient } from "redis";
import { EPG_KEY, EPG_TTL_S, normalizeName, toKey } from "./epg-shared.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const REFRESH_MS = EPG_TTL_S * 1000;

let epg = null;
let loadedAt = 0;
let working = false;

async function readCache() {
  const client = createClient({ url: process.env.REDIS_URL });
  client.on("error", () => {}); // handled by the caller's catch
  await client.connect();
  try {
    const raw = await client.get(EPG_KEY);
    return raw ? JSON.parse(gunzipSync(Buffer.from(raw, "base64")).toString("utf-8")) : null;
  } finally {
    await client.quit().catch(() => {});
  }
}

function build(keys) {
  return new Promise((resolve) => {
    // Capped on purpose: the parse grows until the feed ends, and a ceiling
    // makes it collect instead of climbing toward the pod limit.
    const child = spawn(process.execPath, ["--max-old-space-size=256", join(here, "epg-build.mjs")], {
      stdio: ["pipe", "inherit", "inherit"],
      env: process.env,
    });
    child.stdin.end(JSON.stringify([...keys]));
    child.on("exit", (code) => resolve(code === 0));
    child.on("error", (err) => {
      console.warn("iptv-org: epg build failed to start:", err?.message || err);
      resolve(false);
    });
  });
}

/**
 * Makes sure an EPG is on its way, and never makes a request wait for it: a
 * catalog page without programme titles is worth more than a catalog page in
 * thirty seconds.
 */
let saidWhyNot = false;
export function ensureEpg(nameKeys) {
  if (!process.env.REDIS_URL) {
    // Once, and only where it can be read: an EPG that is off by configuration
    // looks exactly like an EPG that is broken, and the difference was
    // nowhere. Every channel comes back without programmes either way.
    if (!saidWhyNot) {
      console.warn("iptv-org: no REDIS_URL, so there is no epg and no channel will carry programmes");
      saidWhyNot = true;
    }
    return;
  }
  if (working) return;
  if (epg && Date.now() - loadedAt < REFRESH_MS) return;
  working = true;

  (async () => {
    try {
      let data = await readCache();
      if (!data) {
        // Nothing cached: build it, then read what the child wrote.
        const built = await build(nameKeys);
        if (built) data = await readCache();
        // A build that fails said nothing at all before, and the failure that
        // costs this addon its epg in production is the child being killed for
        // its memory, which is silent from in here. Not knowing why is worse
        // than the number being wrong.
        if (!built) console.warn("iptv-org: epg build failed, channels stay without programmes");
        else if (!data) console.warn("iptv-org: epg build finished but redis had nothing after it");
      }
      if (data) {
        epg = data;
        loadedAt = Date.now();
        console.log(`iptv-org: epg ready, ${Object.keys(data).length} name variants`);
      }
    } catch (err) {
      console.warn("iptv-org: epg unavailable:", err?.message || err);
    } finally {
      working = false;
    }
  })();
}

/** The programmes of a channel, or null. Matched the way the builder keyed them. */
export function findEpg(name) {
  if (!epg) return null;
  return epg[name.toLowerCase().trim()] || epg[normalizeName(name)] || epg[toKey(name)] || null;
}
