/**
 * RAI Play. Ported from the v1 addon.
 *
 * RAI has no separate API: every page on raiplay.it has a .json variant, and
 * that is what this reads. Streams come from the RAI "relinker", which answers
 * 403 to anyone outside Italy, a datacenter included. So the metadata is read
 * here and the relinker is the client's job: it asks with its own IP, and a
 * user in Italy gets a stream where the server got a refusal.
 */

const SITE = "https://www.raiplay.it";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";
const CATALOG_PAGE = 60;

// The browsable typologies the v1 addon had, names and kinds as it had them.
const TIPOLOGIE = [
  { id: "film", name: "Film", type: "video" },
  { id: "documentari", name: "Documentari", type: "video" },
  { id: "crime", name: "Crime", type: "series" },
  { id: "bambini", name: "Bambini", type: "series" },
  { id: "teen", name: "Teen", type: "series" },
  { id: "programmi", name: "Programmi", type: "series" },
  { id: "sport", name: "Sport", type: "series" },
];
const TIP_BY_ID = Object.fromEntries(TIPOLOGIE.map((t) => [t.id, t]));

async function fetchJson(path) {
  const url = path.startsWith("http") ? path : SITE + path;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`raiplay ${res.status} on ${url}`);
  return res.json();
}

// An id is the content's own path on raiplay.it, without the leading slash
// and the trailing .json, both are constants, so they are not part of one.
const idOf = (path) => String(path || "").replace(/^\//, "").replace(/\.json$/, "");
const pathOf = (id) => `/${id}.json`;

// RAI ships one picture in several crops, and the crop names say which slot
// each belongs in. Taking `landscape` for the poster put a 16:9 crop in every
// portrait tile. The `*_logo` variants are the same crops with the label burnt
// in as JPEG, so they are not a transparent logo and stay out of it.
const abs = (p) => (p ? (p.startsWith("http") ? p : SITE + p) : undefined);

const imagesOf = (images) => {
  const out = {};
  const poster = abs(images?.portrait || images?.portrait43 || images?.square);
  if (poster) out.poster = poster;
  const backdrop = abs(images?.landscape || images?.landscape43);
  if (backdrop) out.backdrops = [backdrop];
  if (!out.poster && !out.backdrops) return null;
  return out;
};

// Give every episode a unique (season, episode) slot. RAI carries the numbers
// only for part of the catalogue: specials like "Il meglio della stagione"
// come with none at all, and some programs number seasons by year. Numbers from
// the API win; the rest is filled into the free slots of its season, in order.
// The client keys episodes by `season-episode`, so a missing or duplicate
// number loses the episode.
const numberEpisodes = (episodes) => {
  const key = (s, e) => `${s}-${e}`;
  const num = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
  const taken = new Set();
  const pending = [];
  for (const ep of episodes) {
    ep.season = num(ep.season) || 1;
    ep.episode = num(ep.episode);
    if (ep.episode && !taken.has(key(ep.season, ep.episode))) taken.add(key(ep.season, ep.episode));
    else pending.push(ep);
  }
  const next = new Map();
  for (const ep of pending) {
    let n = next.get(ep.season) || 1;
    while (taken.has(key(ep.season, n))) n++;
    ep.episode = n;
    taken.add(key(ep.season, n));
    next.set(ep.season, n + 1);
  }
  return episodes;
};

// A "set" on a typology page is a program (movie/series) tile.
function toItem(set, defaultType) {
  const id = idOf(set.path_id);
  if (!id) return null;
  const item = {
    id,
    type: defaultType,
    name: set.name || id,
    ids: { raiplay: id },
  };
  if (set.subtitle) item.description = set.subtitle;
  const images = imagesOf(set.images);
  if (images) item.images = images;
  return item;
}

async function catalog(catalogId, query) {
  const tip = TIP_BY_ID[catalogId];
  if (!tip) return { items: [], nextCursor: null };
  const page = Number(query.get("cursor")) || 1;

  const doc = await fetchJson(`/tipologia/${catalogId}/index.json`);
  const seen = new Set();
  const all = [];
  for (const block of doc.contents || []) {
    for (const set of block.contents || []) {
      const item = toItem(set, tip.type);
      if (item && !seen.has(item.id) && seen.add(item.id)) all.push(item);
    }
  }
  // The page comes whole; paging is slicing it.
  const start = (page - 1) * CATALOG_PAGE;
  return {
    items: all.slice(start, start + CATALOG_PAGE),
    nextCursor: start + CATALOG_PAGE < all.length ? String(page + 1) : null,
  };
}

// A program's episodes hide in its blocks' sets (seasons and collections),
// each set a page of its own. Capped, as the v1 addon capped it.
async function episodesOf(prog) {
  const episodes = [];
  const seen = new Set();
  for (const block of (prog.blocks || []).slice(0, 3)) {
    for (const set of (block.sets || []).slice(0, 3)) {
      if (!set.path_id) continue;
      const s = await fetchJson(set.path_id).catch(() => null);
      for (const it of s?.items || s?.contents || []) {
        const id = idOf(it.path_id);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const child = {
          id,
          type: "video",
          name: it.episode_title || it.name || id,
          ids: { raiplay: id },
          season: Number(it.season),
          episode: Number(it.episode),
        };
        if (it.subtitle) child.description = it.subtitle;
        const images = imagesOf(it.images);
        if (images) child.images = images;
        episodes.push(child);
      }
    }
  }
  return episodes;
}

async function item(id) {
  const prog = await fetchJson(pathOf(id));

  const out = {
    id,
    type: "video",
    name: prog.name || id,
    ids: { raiplay: id },
  };
  const description = prog.program_info?.description || prog.additional_info?.description;
  if (description) out.description = description;
  const images = imagesOf(prog.images);
  if (images) out.images = images;

  // One video or none: a film. More: a series with children.
  const children = await episodesOf(prog);
  if (children.length > 1) {
    out.type = "series";
    out.children = numberEpisodes(children);
  }
  return out;
}

// The relinker URL of any RAI content path. With `output=64` the relinker
// answers XML carrying the manifest URL instead of redirecting to the media,
// and a redirect is the one thing a client-fetch cannot report back.
const relinkerOf = async (videoId) => {
  let path = pathOf(videoId);
  // Program path -> take its main video.
  if (!/\/video\//.test(path)) {
    const prog = await fetchJson(path);
    path = prog.first_item_path || path;
  }
  const video = await fetchJson(path);
  const relinker = video?.video?.content_url;
  if (!relinker) return null;
  return `${relinker}${relinker.includes("?") ? "&" : "?"}output=64`;
};

async function sources(id) {
  // A v1 client asks for an episode as the series id with :season:episode
  // appended; resolve that to the episode's own video path first.
  const episodeRef = /^(.+):(\d+):(\d+)$/.exec(id);
  if (episodeRef) {
    const [, progId, season, episode] = episodeRef;
    const prog = await fetchJson(pathOf(progId)).catch(() => null);
    if (!prog) return { sources: [] };
    const children = numberEpisodes(await episodesOf(prog));
    const found = children.find((c) => c.season === Number(season) && c.episode === Number(episode));
    if (!found) return { sources: [] };
    id = found.id;
  }
  const url = await relinkerOf(id).catch(() => null);
  if (!url) return { sources: [] };
  return { clientFetch: { id: "src", url, headers: { "User-Agent": UA } } };
}

// What the client got from the relinker: XML with the manifest URL, or the
// 403 page anyone outside Italy gets. The v1 addon's fall-through to the
// request URL was a bug that handed out a dead link, so a refusal is no source.
export async function clientFetch(result) {
  if (result.id !== "src") return null;
  if (result.status !== 200 || !result.body) return { sources: [] };
  const m = /<url type="content">\s*<!\[CDATA\[(.*?)\]\]>/s.exec(result.body);
  const url = m?.[1];
  if (!url || /video_no_available/.test(url)) return { sources: [] };
  return { sources: [{ url, name: "RAI Play", languages: ["it"] }] };
}

const valueOf = (segment) => {
  const raw = segment.replace(/\.json$/, "");
  return raw.startsWith("raiplay:") ? raw.slice(8) : raw;
};

export async function get(pathname, query) {
  if (pathname === "/mhub-addon.json") return manifest();
  const [, resource, , ...rest] = pathname.split("/");
  const segment = decodeURIComponent(rest.join("/"));
  if (!segment) return null;

  try {
    if (resource === "catalog") return await catalog(segment.replace(/\.json$/, ""), query);
    const id = valueOf(segment);
    if (resource === "item") return await item(id);
    if (resource === "source") return await sources(id);
  } catch {
    // An upstream with a bad moment answers 404 rather than hanging the host.
    return null;
  }
  return null;
}

function manifest() {
  return {
    id: "raiplay",
    name: "RAI Play",
    specVersion: 2,
    version: "2.1.0",
    description: "RAI Play, die Mediathek des italienischen öffentlichen Rundfunks. Filme, Serien, Dokus, Crime u.v.m. Hinweis: Streams sind auf Italien geo-beschränkt.",
    icon: "https://www.raiplay.it/favicon.ico",
    resources: ["catalog", "item", "source"],
    types: ["video", "series"],
    idPrefixes: ["raiplay"],
    catalogs: TIPOLOGIE.map((t) => ({
      id: t.id,
      name: t.name,
      type: t.type,
      options: { shape: "landscape", displayName: true },
    })),
    dashboard: TIPOLOGIE.map((t) => ({ name: t.name, catalog: t.id })),
    // No hint for source: the stream is whatever the relinker told one
    // client, and the host would hand a cached answer to the next one.
    cache: { catalog: 3600, item: 86400 },
  };
}
