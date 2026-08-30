/**
 * The public IPTV-ORG channel list. Ported from the v1 addon.
 *
 * One M3U file, ~12.7k channels, re-read every half hour. Everything the
 * catalog does is done on that list in memory: search, filters, sorting and
 * the country boost. The filter values are the playlist's own countries and
 * groups, so they ride on the catalog response instead of the manifest.
 */

import { ensureEpg, findEpg } from "./epg.mjs";
import { normalizeName, toKey } from "./epg-shared.mjs";

// The `cache` block in mhub-addon.json is deliberately low (300s). Every item
// carries what is on that channel right now, and the host caches whole
// answers, so a bigger number would freeze the programme titles. What is
// actually expensive here has its own caches: the playlist below, and the EPG
// in redis.
const PLAYLIST = "https://iptv-org.github.io/iptv/index.m3u";
// A row shows a handful of tiles and pages on scroll, so a page stays small.
// 500 a page: a channel number past 10,000 means the client walks the
// pages one after another (the protocol pages by cursor, nothing else), and
// at 100 that was 120 round trips. 500 channels are ~100 KB, fine to scroll.
const PAGE = 500;
const VIEW_CACHE_MAX = 64; // filtered/ordered lists kept per index (see catalog)

// The master playlist is SFW (iptv-org keeps NSFW in a separate
// index.nsfw.m3u), with two exceptions that slipped through: soft-adult
// music-clip channels. The app states "no adult content in its default state"
// to the TV stores, so these never surface. Matched on the normalized name AND
// the tvg-id stem, so an upstream rename stays blocked.
const BLOCKED = new Set(["musicboxsexy", "sextavision"]);
const channelKey = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

// The item id of a channel is the hash of its URL, exactly as in v1: a saved
// channel has to keep resolving after the conversion.
function djb2(str) {
  const buf = Buffer.from(str);
  let hash = 5381;
  for (let i = 0; i < buf.length; i += 1) hash = (hash << 5) + hash + buf[i];
  return hash;
}

const countryName = (code) => {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code.toUpperCase()) || code;
  } catch {
    return code;
  }
};

// ─── Playlist ───

const ATTR = /([\w-]+)="([^"]*)"/g;

// M3U, the subset iptv-org writes: one #EXTINF line with attributes and the
// channel name after the comma, optional #EXTVLCOPT lines, then the URL.
function parsePlaylist(text) {
  const channels = [];
  let current = null;

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith("#EXTINF:")) {
      const attrs = {};
      const head = line.slice(0, line.lastIndexOf(","));
      for (const [, key, value] of head.matchAll(ATTR)) attrs[key] = value;
      current = { attrs, name: line.slice(line.lastIndexOf(",") + 1).trim(), headers: {} };
      continue;
    }
    if (!current) continue;

    // Some channels only play with the headers the playlist carries for them.
    if (line.startsWith("#EXTVLCOPT:")) {
      const [key, ...rest] = line.slice("#EXTVLCOPT:".length).split("=");
      const value = rest.join("=");
      if (key === "http-user-agent") current.headers["User-Agent"] = value;
      if (key === "http-referrer") current.headers.Referer = value;
      continue;
    }
    if (line.startsWith("#")) continue;

    current.url = line;
    channels.push(current);
    current = null;
  }
  return channels;
}

function buildIndex(text) {
  const channels = [];
  const countries = new Set();
  const groups = new Set();

  for (const raw of parsePlaylist(text)) {
    const tvgId = raw.attrs["tvg-id"] || "";
    const name = raw.name || raw.attrs["tvg-name"] || "";
    if (!raw.url || !name) continue;
    if (BLOCKED.has(channelKey(name)) || BLOCKED.has(channelKey(tvgId.split(".")[0]))) continue;

    const country = /\.([a-z]{2})@/.exec(tvgId)?.[1] || "";
    if (country) countries.add(country);
    const group = raw.attrs["group-title"] || "";
    for (const g of group.split(";")) if (g) groups.add(g);

    if (raw.attrs["http-user-agent"]) raw.headers["User-Agent"] = raw.attrs["http-user-agent"];
    if (raw.attrs["http-referrer"]) raw.headers.Referer = raw.attrs["http-referrer"];

    const id = String(djb2(raw.url));
    channels.push({
      id,
      type: "live",
      name,
      url: raw.url,
      ids: tvgId ? { tvg: tvgId, urlId: id } : { urlId: id },
      ...(country ? { countries: [country.toUpperCase()] } : {}),
      // `logo` is the slot a live channel's picture belongs in, and what a v2
      // client reads for one; `poster` is the same file again so the grid tile
      // has something to show. Publishing only `poster` left every channel
      // here blank in a v2 client while the v1 bridge, which falls back to
      // `poster` for IptvItem.logo, made it look fine from the other protocol.
      ...(raw.attrs["tvg-logo"]
        ? { images: { logo: raw.attrs["tvg-logo"], poster: raw.attrs["tvg-logo"] } }
        : {}),
      ...(Object.keys(raw.headers).length ? { headers: raw.headers } : {}),
      _group: group,
      _country: country,
    });
  }

  // What this catalog can do is what today's playlist happens to contain, so
  // it is answered with the catalog instead of frozen in the manifest.
  const features = {
    search: true,
    sort: [
      { id: "default", name: "Default" },
      { id: "name", name: "Name" },
    ],
    filter: [],
  };
  if (countries.size > 1) {
    features.filter.push({
      id: "country",
      name: "Country",
      values: [...countries]
        .map((c) => ({ id: c, name: countryName(c) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    });
    features.sort.push({ id: "country", name: "Country" });
  }
  if (groups.size > 1) {
    features.filter.push({
      id: "group",
      name: "Group",
      values: [...groups].sort().map((g) => ({ id: g, name: g })),
    });
    features.sort.push({ id: "group", name: "Group" });
  }

  // The names the EPG has to be filtered down to: everything else in that feed
  // belongs to channels this playlist does not carry.
  const nameKeys = new Set();
  for (const c of channels) {
    nameKeys.add(c.name.toLowerCase().trim());
    nameKeys.add(normalizeName(c.name));
    nameKeys.add(toKey(c.name));
  }
  nameKeys.delete("");

  return { channels, features, nameKeys, sorted: new Map(), views: new Map() };
}

// Stale-while-revalidate: after the first load requests always get the list in
// memory, and an expired TTL only starts a background refresh. The upstream
// changes about daily and nobody should wait on the download inline. A failed
// refresh keeps serving what we have.
const TTL_MS = 30 * 60 * 1000;
let index = null;
let loadedAt = 0;
let loading = null;

async function load() {
  const res = await fetch(PLAYLIST, { headers: { "User-Agent": "MediaHubMX/2" } });
  if (!res.ok) throw new Error(`playlist ${res.status}`);
  const built = buildIndex(await res.text());
  if (!built.channels.length) throw new Error("playlist has no channels");
  return built;
}

async function getIndex() {
  if (!index) {
    // Nothing to serve yet, so this one waits. Reset on failure, otherwise
    // every later request would be served the same rejection.
    loading = loading || load().finally(() => { loading = null; });
    index = await loading;
    loadedAt = Date.now();
    return index;
  }
  if (Date.now() - loadedAt > TTL_MS && !loading) {
    loading = load().then(
      (built) => { index = built; loadedAt = Date.now(); },
      (err) => { console.warn("iptv-org: refresh failed:", err?.message || err); }
    ).finally(() => { loading = null; });
  }
  return index;
}

// ─── Catalog ───

// Upstream marks channels it knows to be unreliable right in the name:
// [Geo-blocked] plays only from its home country, [Not 24/7] is off air most
// of the day. About one in ten carries such a marker, they stay in the list,
// but never at the top of a row.
const UNRELIABLE = /\[(geo-blocked|not 24\/7)\]/i;

// The viewer's own country first, then the rest of the world, unreliable last.
// Stable within each bucket, so the chosen sort still decides the order there.
function prioritize(items, region) {
  const home = [], world = [], unreliable = [];
  for (const item of items) {
    if (UNRELIABLE.test(item.name)) unreliable.push(item);
    else if (region && item._country === region) home.push(item);
    else world.push(item);
  }
  return home.concat(world, unreliable);
}

function sortedBy(idx, sort) {
  if (idx.sorted.has(sort)) return idx.sorted.get(sort);
  const items = [...idx.channels];
  if (sort === "name") items.sort((a, b) => a.name.localeCompare(b.name));
  else if (sort === "country") items.sort((a, b) => a._country.localeCompare(b._country));
  else if (sort === "group") items.sort((a, b) => a._group.localeCompare(b._group));
  idx.sorted.set(sort, items);
  return items;
}

// The internal fields are for us, not for the client.
const publish = ({ _group, _country, ...item }) => item;

// A row shows what is on now, so a listed channel carries the current
// programme and the next two. The detail view gets the whole day.
function withEpg(channel, all = false) {
  const item = publish(channel);
  const programmes = findEpg(channel.name);
  if (!programmes) return item;

  let shown = programmes;
  if (!all) {
    const now = Math.floor(Date.now() / 1000);
    const from = programmes.findIndex((p) => p.stop > now);
    shown = from >= 0 ? programmes.slice(from, from + 3) : programmes.slice(-1);
  }
  // Seconds in the cache because 38k entries add up, ISO on the wire because
  // that is what the schema says.
  return {
    ...item,
    epg: shown.map((p) => ({
      title: p.name,
      start: new Date(p.start * 1000).toISOString(),
      end: new Date(p.stop * 1000).toISOString(),
    })),
  };
}

async function catalog(query) {
  const idx = await getIndex();
  ensureEpg(idx.nameKeys);
  const search = (query.get("search") || "").toLowerCase();
  const sort = query.get("sort") || "default";
  const country = query.get("filter[country]") || "";
  const group = query.get("filter[group]") || "";
  const cursor = Number(query.get("cursor")) || 0;

  // The country boost only means something while the list is not already
  // scoped or ordered by country: that says what the viewer wants to see.
  const region = country || sort === "country"
    ? ""
    : String(query.get("region") || "").toLowerCase();
  // One list per view (sort, search, filters, region), kept on the index so
  // it goes with it when the index is rebuilt: a client paging through the
  // list asks for the same view page after page, and filtering and ordering
  // 12,000 channels again for each page was most of what a page cost.
  // Bounded - search terms are as many as keystrokes.
  const viewKey = [sort, search, country, group, region].join("\u0000");
  let items = idx.views.get(viewKey);
  if (!items) {
    items = sortedBy(idx, sort);
    if (search) items = items.filter((i) => i.name.toLowerCase().includes(search));
    if (country) items = items.filter((i) => i._country === country);
    if (group) items = items.filter((i) => i._group.includes(group));
    items = prioritize(items, region);
    if (idx.views.size >= VIEW_CACHE_MAX) idx.views.delete(idx.views.keys().next().value);
    idx.views.set(viewKey, items);
  }

  const total = items.length;
  const page = items.slice(cursor, cursor + PAGE);
  return {
    items: page.map(withEpg),
    features: idx.features,
    // Compared against the filtered total, so the last page ends the row
    // instead of sending the client after one more, empty one.
    nextCursor: cursor + page.length < total ? String(cursor + page.length) : null,
  };
}

export async function get(pathname, query) {
  const [, resource, type, ...rest] = pathname.split("/");
  if (type !== "live") return null;
  const segment = rest.join("/");

  if (resource === "catalog") return segment === "channels.json" ? catalog(query) : null;

  if (resource === "item") {
    const id = segment.replace(/\.json$/, "").replace(/^urlId:/, "");
    const idx = await getIndex();
    ensureEpg(idx.nameKeys);
    const found = idx.channels.find((c) => c.id === id);
    return found ? withEpg(found, true) : null;
  }
  return null;
}
