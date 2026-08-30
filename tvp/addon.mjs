/**
 * TVP VOD (Poland's public broadcaster). Ported from the v1 addon.
 *
 * One keyless JSON API (vod.tvp.pl/api) answers everything: the full
 * catalogue, a serial's seasons and episodes, and one product's playlist.
 * Metadata answers worldwide, the playlist endpoint is geo-locked to Poland
 * (403 GEOIP_FILTER_FAILED elsewhere, a datacenter included), so the playlist
 * is the client's job: it asks with its own IP, and a user in Poland gets a
 * stream where the server got a refusal. Sources stay a resource of their own
 * and degrade to none instead of failing the item.
 */

const API = "https://vod.tvp.pl/api/products";
const Q = "lang=pl&platform=BROWSER";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

const PAGE_SIZE = 60;

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`tvp ${res.status} on ${url}`);
  return res.json();
}

// One picture per aspect ratio, never a list to choose from. `3x4` is the
// portrait one and belongs in the poster; `16x9` is a background. Before this
// the 16x9 took the poster slot and nothing filled the background at all.
// The list endpoint hands out thumbnails, a 16x9 arrives 315px wide, which is
// nothing on a TV. Every image carries a templateUrl with its size in the path,
// and asking for more gets more, up to whatever the source holds.
const SIZES = { "16x9": [1280, 720], "3x4": [800, 1066], "1x1": [800, 800] };

const urlOf = (o, ratio) => {
  const im = o?.images?.[ratio]?.[0];
  if (!im) return undefined;
  const [w, h] = SIZES[ratio] || [];
  const url = w && im.templateUrl
    ? im.templateUrl.replace(/\{width:\d+\}/, w).replace(/\{height:\d+\}/, h)
    : im.url;
  return url ? (url.startsWith("//") ? `https:${url}` : url) : undefined;
};

const imagesOf = (o) => {
  const out = {};
  const poster = urlOf(o, "3x4") || urlOf(o, "1x1");
  if (poster) out.poster = poster;
  const backdrop = urlOf(o, "16x9");
  if (backdrop) out.backdrops = [backdrop];
  return Object.keys(out).length ? out : null;
};

// v1 keyed items "vod:<id>"/"serial:<id>"/"episode:<id>" under tvp_id, a
// colon a v2 id cannot keep, so they are dashed.
const slim = (o) => ({
  id: o.type === "SERIAL" ? `serial-${o.id}` : `vod-${o.id}`,
  serial: o.type === "SERIAL",
  title: o.title,
  lead: o.lead,
  year: Number(o.year) || undefined,
  since: Date.parse(o.since) || 0, // ISO string upstream. Number() would yield NaN
  duration: Number(o.duration) || undefined,
  genres: (o.genres || []).map((g) => g.name).filter(Boolean),
  images: imagesOf(o),
});

// --- the whole catalogue, cached ------------------------------------------------
// The list endpoint takes ONLY `limit` + `firstResult`, no search, no sort,
// no filter (all verified against the API). So the full index is pulled once
// and search/sort/filter run on it. ~6300 titles take ~7s over 63 requests.
const INDEX_PAGE = 100;
const CONCURRENCY = 8;
const INDEX_TTL = 6 * 3600 * 1000;

let _index = null;
let _indexP = null;
const loadIndex = () => {
  if (_index && Date.now() - _index.at < INDEX_TTL) return Promise.resolve(_index.items);
  if (!_indexP) {
    _indexP = (async () => {
      const first = await fetchJson(`${API}/vods?${Q}&limit=${INDEX_PAGE}&firstResult=0`);
      const total = first.meta?.totalCount || 0;
      const raw = [...(first.items || [])];
      const offsets = [];
      for (let o = INDEX_PAGE; o < total; o += INDEX_PAGE) offsets.push(o);
      for (let i = 0; i < offsets.length; i += CONCURRENCY) {
        const batch = await Promise.all(
          offsets
            .slice(i, i + CONCURRENCY)
            .map((o) =>
              fetchJson(`${API}/vods?${Q}&limit=${INDEX_PAGE}&firstResult=${o}`).catch(() => null),
            ),
        );
        for (const b of batch) if (b?.items) raw.push(...b.items);
      }
      _index = { at: Date.now(), items: raw.map(slim) };
      return _index.items;
    })().finally(() => {
      _indexP = null;
    });
  }
  return _indexP;
};

const toItem = (o) => {
  const item = {
    id: o.id,
    type: o.serial ? "series" : "video",
    name: o.title || o.id,
    ids: { tvp: o.id },
  };
  if (o.lead) item.description = o.lead;
  if (o.year) item.year = o.year;
  if (o.duration) item.runtime = o.duration; // v2 runtime is seconds, v1's was ms
  if (o.images) item.images = o.images;
  return item;
};

// --- catalog features (all applied on the index, see above) ---------------------
const SORTS = [
  { id: "newest", name: "Najnowsze", cmp: (a, b) => b.since - a.since },
  // Many titles start with a stray space upstream, trim before comparing.
  { id: "title", name: "A–Z", cmp: (a, b) => String(a.title).trim().localeCompare(String(b.title).trim(), "pl") },
  { id: "year", name: "Rok (najnowsze)", cmp: (a, b) => (b.year || 0) - (a.year || 0) },
];
const SORT_BY_ID = Object.fromEntries(SORTS.map((s) => [s.id, s]));

// The most common genres, counted over the full index. Films and series use
// entirely DIFFERENT vocabularies upstream ("dokumentalny" never appears on a
// series, "rozrywka" never on a film), so each catalog gets its own list,
// a shared one leaves most filter values empty. Hardcoded so the manifest is
// available without waiting for the index build.
const FILM_GENRES = [
  "dokumentalny", "historyczny", "dramat", "biograficzny", "komedia",
  "scena współczesna", "scena klasyki", "religijny", "thriller", "familijny",
  "sensacyjny", "obyczajowy", "przyrodniczy", "dramat obyczajowy",
];
const SERIAL_GENRES = [
  "kultura", "historia", "rozrywka", "wiedza", "sensacyjne", "religia",
  "seriale", "styl życia", "kostiumowe", "publicystyka", "obyczajowe",
  "programy", "bajki dla najmłodszych", "podróże",
];

const CATALOGS = [
  { id: "filmy", name: "Filmy i programy", type: "video", serial: false, genres: FILM_GENRES },
  { id: "seriale", name: "Seriale", type: "series", serial: true, genres: SERIAL_GENRES },
];

async function catalog(catalogId, query) {
  const cat = CATALOGS.find((c) => c.id === catalogId) || CATALOGS[0];
  const page = Number(query.get("cursor")) || 1;
  const sortDef = SORT_BY_ID[query.get("sort")] || SORT_BY_ID.newest;
  const genres = (query.get("filter[genre]") || "")
    .split(",")
    .map((g) => g.trim().toLowerCase())
    .filter(Boolean);
  const search = (query.get("search") || "").trim().toLowerCase();

  let items = await loadIndex();
  items = items.filter((o) => o.serial === cat.serial);
  if (genres.length) items = items.filter((o) => o.genres.some((g) => genres.includes(g.toLowerCase())));
  if (search) items = items.filter((o) => String(o.title).toLowerCase().includes(search));

  items = [...items].sort(sortDef.cmp);
  const start = (page - 1) * PAGE_SIZE;
  return {
    items: items.slice(start, start + PAGE_SIZE).map(toItem),
    nextCursor: start + PAGE_SIZE < items.length ? String(page + 1) : null,
  };
}

// TVP numbers episodes per season, but not always, the list order fills the
// gaps so no two episodes share a season-episode slot (the client keys them
// by that, and the source lookup finds them by that).
const numberEpisodes = (episodes) => {
  const key = (s, e) => `${s}-${e}`;
  const taken = new Set();
  const pending = [];
  for (const ep of episodes) {
    ep.season = ep.season > 0 ? ep.season : 1;
    if (ep.episode > 0 && !taken.has(key(ep.season, ep.episode))) taken.add(key(ep.season, ep.episode));
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

const MAX_EPISODES = 500;

async function episodesOf(serialId) {
  const seasons = await fetchJson(`${API}/vods/serials/${serialId}/seasons?${Q}`).catch(() => []);
  const episodes = [];
  for (const s of (Array.isArray(seasons) ? seasons : []).slice(0, 20)) {
    if (episodes.length >= MAX_EPISODES) break;
    const eps = await fetchJson(`${API}/vods/serials/${serialId}/seasons/${s.id}/episodes?${Q}`).catch(() => []);
    for (const e of Array.isArray(eps) ? eps : []) {
      const child = {
        id: `episode-${e.id}`,
        type: "video",
        name: e.title || `episode-${e.id}`,
        ids: { tvp: `episode-${e.id}` },
        // An episode's `season` is the full SEASON object, not a number.
        season: Number(e.season?.number ?? s.number) || 1,
        episode: Number(e.number) || 0,
      };
      if (e.lead) child.description = e.lead;
      const images = imagesOf(e);
      if (images) child.images = images;
      episodes.push(child);
    }
  }
  return numberEpisodes(episodes.slice(0, MAX_EPISODES));
}

async function item(id) {
  if (id.startsWith("serial-")) {
    const serialId = id.slice(7);
    const doc = await fetchJson(`${API}/vods/serials/${serialId}?${Q}`);
    const out = {
      id,
      type: "series",
      name: doc.title || id,
      ids: { tvp: id },
    };
    if (doc.description || doc.lead) out.description = doc.description || doc.lead;
    if (Number(doc.year)) out.year = Number(doc.year);
    const images = imagesOf(doc);
    if (images) out.images = images;
    const children = await episodesOf(serialId);
    if (children.length) out.children = children;
    return out;
  }

  if (!id.startsWith("vod-")) return null;
  const doc = await fetchJson(`${API}/vods/${id.slice(4)}?${Q}`);
  const out = {
    id,
    type: "video",
    name: doc.title || id,
    ids: { tvp: id },
  };
  if (doc.description || doc.lead) out.description = doc.description || doc.lead;
  if (Number(doc.year)) out.year = Number(doc.year);
  if (doc.duration) out.runtime = Number(doc.duration) || undefined;
  const images = imagesOf(doc);
  if (images) out.images = images;
  return out;
}

async function sources(id) {
  // A v1 client playing an episode asks with the position appended:
  // "<serial-id>:<season>:<episode>". Neither id carries a colon of its own,
  // so the suffix is unambiguous. An episode's own id resolves directly.
  const ep = /^((?:serial|episode)-\d+):(\d+):(\d+)$/.exec(id);
  if (ep) {
    if (ep[1].startsWith("episode-")) {
      id = ep[1];
    } else {
      const children = await episodesOf(ep[1].slice(7));
      const child = children.find((c) => c.season === Number(ep[2]) && c.episode === Number(ep[3]));
      if (!child) return { sources: [] };
      id = child.id;
    }
  }
  if (id.startsWith("serial-")) return { sources: [] }; // a series itself has no stream
  const num = id.startsWith("vod-") ? id.slice(4) : id.startsWith("episode-") ? id.slice(8) : null;
  if (!num) return { sources: [] };

  return {
    clientFetch: {
      id: "src",
      url: `${API}/${num}/videos/playlist?videoType=MOVIE&${Q}`,
      headers: { "User-Agent": UA },
    },
  };
}

// The playlist the client got, or the 403 anyone outside Poland gets.
export async function clientFetch(result) {
  if (result.id !== "src") return null;
  if (result.status !== 200 || !result.body) return { sources: [] };
  let data;
  try {
    data = JSON.parse(result.body);
  } catch {
    return { sources: [] };
  }
  const sources = (data?.sources?.HLS || [])
    .filter((s) => s.src)
    .map((s) => ({ url: s.src, name: "TVP HLS", languages: ["pl"] }));
  return { sources };
}

const valueOf = (segment) => {
  const raw = segment.replace(/\.json$/, "");
  return raw.startsWith("tvp:") ? raw.slice(4) : raw;
};

export async function get(pathname, query) {
  if (pathname === "/mhub-addon.json") return manifest();
  const [, resource, , ...rest] = pathname.split("/");
  const segment = decodeURIComponent(rest.join("/"));
  if (!segment) return null;

  if (resource === "catalog") return catalog(segment.replace(/\.json$/, ""), query);

  const id = valueOf(segment);
  if (resource === "item") return item(id);
  if (resource === "source") return sources(id);
  return null;
}

function manifest() {
  return {
    id: "tvp",
    name: "TVP VOD",
    specVersion: 2,
    version: "2.1.0",
    description:
      "TVP VOD: Mediathek des polnischen öffentlich-rechtlichen Rundfunks. Filme, Dokus und Serien, kostenlos und ohne API-Key. Hinweis: die Streams sind auf Polen geo-beschränkt.",
    icon: "https://vod.tvp.pl/static/images/favicon.png",
    resources: ["catalog", "item", "source"],
    types: ["video", "series"],
    idPrefixes: ["tvp"],
    catalogs: CATALOGS.map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      options: { shape: "landscape", displayName: true },
      features: {
        search: true,
        sort: SORTS.map(({ id, name }) => ({ id, name })),
        filter: [{ id: "genre", name: "Gatunek", multiselect: true, values: c.genres.map((g) => ({ id: g, name: g })) }],
      },
    })),
    dashboard: [
      { name: "Najnowsze filmy", catalog: "filmy", sort: "newest" },
      { name: "Najnowsze seriale", catalog: "seriale", sort: "newest" },
      { name: "Dokument", catalog: "filmy", sort: "newest", filter: { genre: "dokumentalny" } },
      { name: "Historia", catalog: "filmy", sort: "newest", filter: { genre: "historyczny" } },
      { name: "Komedia", catalog: "filmy", sort: "newest", filter: { genre: "komedia" } },
      { name: "Kryminał", catalog: "seriale", sort: "newest", filter: { genre: "sensacyjne" } },
    ],
    // v1 cached catalogs for an hour; the index itself rebuilds every six.
    // No hint for source: the playlist is what one client was told, and the
    // host would hand a cached answer to the next one.
    cache: { catalog: 3600, item: 86400 },
  };
}
