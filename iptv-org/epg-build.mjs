/**
 * Builds the EPG and puts it in Redis. Runs as its own process, on purpose.
 *
 * The feed is a ~500MB XML behind a gzip, and parsing it peaks around 400MB
 * RSS. In the addon host that peak would sit next to every other addon for the
 * rest of the pod's life; as a child process it is gone when this exits.
 *
 * stdin:  JSON array of the playlist's name keys (what to keep)
 * Redis:  writes the gzipped result under EPG_KEY
 */

import { createGunzip, gzipSync } from "node:zlib";
import { Readable } from "node:stream";
import { createClient } from "redis";
import { EPG_KEY, EPG_TTL_S, normalizeName, toKey, parseXmltvDate } from "./epg-shared.mjs";

const EPG_URL = process.env.EPG_URL || "https://epg.pw/xmltv/epg.xml.gz";

const readStdin = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
};

const allowed = new Set(await readStdin());
if (!allowed.size) {
  console.error("epg: no playlist keys, nothing to filter against");
  process.exit(1);
}

// XMLTV is regular enough to read block by block: a <channel> carries the
// display name an id belongs to, a <programme> carries what runs when. Only
// those two matter, so the scanner looks for nothing else.
const CHANNEL = /<channel\b[^>]*\bid="([^"]*)"[^>]*>([\s\S]*?)<\/channel>/g;
const PROGRAMME = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/g;
const DISPLAY_NAME = /<display-name[^>]*>([\s\S]*?)<\/display-name>/;
const TITLE = /<title[^>]*>([\s\S]*?)<\/title>/;
const ATTR = (name, s) => new RegExp(`\\b${name}="([^"]*)"`).exec(s)?.[1] || "";

const unescape = (s) => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&amp;/g, "&")
  .trim();

const names = new Map();      // channel id → display name
const allowedById = new Map(); // channel id → is it one of ours
const epg = {};

const now = Date.now();
// 12h is plenty: the EPG refreshes every 6h and a client is shown the current
// programme plus the next two.
const windowEnd = now + 12 * 3600 * 1000;

function isAllowed(id) {
  let hit = allowedById.get(id);
  if (hit === undefined) {
    const name = names.get(id);
    hit = !!name && (allowed.has(name.toLowerCase().trim())
      || allowed.has(normalizeName(name))
      || allowed.has(toKey(name)));
    allowedById.set(id, hit);
  }
  return hit;
}

function add(channelName, entry) {
  for (const key of new Set([
    channelName.toLowerCase().trim(),
    normalizeName(channelName),
    toKey(channelName),
  ])) {
    if (!key) continue;
    (epg[key] ||= []).push(entry);
  }
}

let kept = 0, skipped = 0, channels = 0;

function scan(buffer) {
  let consumed = 0;
  CHANNEL.lastIndex = 0;
  for (const m of buffer.matchAll(CHANNEL)) {
    const name = DISPLAY_NAME.exec(m[2])?.[1];
    if (name) { names.set(m[1], unescape(name)); channels++; }
    consumed = Math.max(consumed, m.index + m[0].length);
  }
  PROGRAMME.lastIndex = 0;
  for (const m of buffer.matchAll(PROGRAMME)) {
    consumed = Math.max(consumed, m.index + m[0].length);
    const attrs = m[1];
    const start = parseXmltvDate(ATTR("start", attrs));
    const stop = parseXmltvDate(ATTR("stop", attrs));
    const channelId = ATTR("channel", attrs);
    // Outside the window or not one of our channels: never built at all. The
    // full feed is ~844k programmes, of which only ours can ever be served.
    if (!(stop > now && start < windowEnd && isAllowed(channelId))) { skipped++; continue; }
    const title = TITLE.exec(m[2])?.[1];
    const channelName = names.get(channelId);
    if (!title || !channelName) { skipped++; continue; }
    // No description: nothing renders it and it was the biggest string per entry.
    add(channelName, { start: Math.floor(start / 1000), stop: Math.floor(stop / 1000), name: unescape(title) });
    kept++;
  }
  return consumed;
}

const t0 = Date.now();
const res = await fetch(EPG_URL, { headers: { "User-Agent": "MediaHubMX/2" } });
if (!res.ok) {
  console.error(`epg: ${EPG_URL} answered ${res.status}`);
  process.exit(1);
}

let stream = Readable.fromWeb(res.body);
if (EPG_URL.endsWith(".gz")) stream = stream.pipe(createGunzip());

// Everything before the last complete block is done with; what is left is the
// start of the next one. That keeps the buffer at one block, not one feed.
let buffer = "";
for await (const chunk of stream) {
  buffer += chunk.toString("utf-8");
  const consumed = scan(buffer);
  if (consumed) buffer = buffer.slice(consumed);
  // A buffer this big means the scanner found no closing tag for a long
  // while, which no real feed does. Cut it loose rather than grow forever.
  if (buffer.length > 4 * 1024 * 1024) buffer = buffer.slice(-1024 * 1024);
}

for (const entries of Object.values(epg)) entries.sort((a, b) => a.start - b.start);

// Gzipped, then base64: the payload is bytes, and every Redis client agrees
// on what a plain string is while they each have their own idea about buffers.
const payload = gzipSync(Buffer.from(JSON.stringify(epg))).toString("base64");
const client = createClient({ url: process.env.REDIS_URL });
await client.connect();
await client.set(EPG_KEY, payload, { EX: EPG_TTL_S });
await client.quit();

console.log(`epg: ${channels} channels, ${kept} programmes kept, ${skipped} skipped, `
  + `${Object.keys(epg).length} name variants, ${(payload.length / 1024 / 1024).toFixed(1)}MB stored, `
  + `${((Date.now() - t0) / 1000).toFixed(0)}s, peak RSS ${(process.memoryUsage.rss() / 1024 / 1024).toFixed(0)}MB`);
