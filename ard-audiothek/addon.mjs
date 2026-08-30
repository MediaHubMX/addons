/**
 * ARD Audiothek: Hörspiele, Podcasts, Dokus und Features aller deutschen
 * öffentlich-rechtlichen Sender. Ported from the v1 addon.
 *
 * Upstream is the keyless REST API under api.ardaudiothek.de, not
 * geo-blocked: a "programSet" is one show, its items are the episodes, and
 * the mp3 urls come straight from the broadcasters' podcast CDNs.
 *
 * A show is an `audio` item whose episodes are its children, what v1
 * modelled as a series. An episode's mp3 rides inline on the child. The
 * `source` resource stays for v1 clients: their episode play asks for
 * `<episode-id>:<season>:<episode>`, answered from the single-item endpoint.
 */

const API = "https://api.ardaudiothek.de";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

const PAGE = 60;
// One request returns every episode of a show; `offset` is ignored upstream,
// so a high `limit` is the only way to page through it.
const MAX_EPISODES = 500;

async function fetchJson(path) {
  const res = await fetch(`${API}${path}`, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`ard-audiothek ${res.status} on ${path}`);
  return res.json();
}

// Image urls carry a `{width}` placeholder.
const image = (o) => {
  const url = o?.image?.url1X1 || o?.image?.url;
  return url ? url.replace("{width}", "448") : undefined;
};

// The API nests differently per endpoint; this peels off the wrappers.
const nodesOf = (v) =>
  Array.isArray(v) ? v : v?.nodes || (v ? Object.values(v).filter((x) => x && x.id) : []);

// publicationStartDateAndTime is a full timestamp; releaseDate wants a date.
const date = (s) => (s ? String(s).slice(0, 10) : undefined);

const sourceOf = (e) => {
  const url = e?.audios?.[0]?.url || e?.audios?.[0]?.downloadUrl;
  return url ? { url, name: "ARD Audiothek", languages: ["de"] } : null;
};

function toShow(p) {
  const id = String(p.id);
  const item = { id, type: "audio", name: p.title || id, ids: { ard_audiothek: id } };
  if (p.synopsis) item.description = p.synopsis;
  const poster = image(p);
  if (poster) item.images = { poster };
  return item;
}

// The Audiothek has no seasons: everything is season 1, numbered by the
// delivered order (newest first), as v1 numbered them.
function toEpisode(e, i) {
  const id = String(e.id);
  const item = {
    id,
    type: "audio",
    name: e.title || id,
    ids: { ard_audiothek: id },
    season: 1,
    episode: i + 1,
  };
  if (e.synopsis) item.description = e.synopsis;
  const releaseDate = date(e.publicationStartDateAndTime);
  if (releaseDate) item.releaseDate = releaseDate;
  if (e.duration) item.runtime = e.duration;
  const poster = image(e);
  if (poster) item.images = { poster };
  const source = sourceOf(e);
  if (source) item.sources = [source];
  return item;
}

// ─── Caches ───
// A category page returns ALL its shows in one response (70–240), so paging,
// sorting and the station filter run on that cached list.
const CATEGORY_TTL_MS = 6 * 3600 * 1000;
const categories = new Map(); // id -> { at, shows }

async function categoryShows(id) {
  const hit = categories.get(id);
  if (hit && Date.now() - hit.at < CATEGORY_TTL_MS) return hit.shows;
  const data = await fetchJson(`/editorialcategories/${id}`);
  const sections = data?.data?.editorialCategory?.sections || [];
  const section = sections.find((s) => s.programSets);
  const shows = nodesOf(section?.programSets).map((p) => ({
    ...p,
    station: p.publicationService?.title || "",
  }));
  categories.set(id, { at: Date.now(), shows });
  return shows;
}

// ─── Catalogs ───

const SORTS = [
  { id: "default", name: "Empfohlen", cmp: null },
  { id: "title", name: "A–Z", cmp: (a, b) => String(a.title).localeCompare(String(b.title), "de") },
  { id: "episodes", name: "Meiste Folgen", cmp: (a, b) => (b.numberOfElements || 0) - (a.numberOfElements || 0) },
];
const SORT_BY_ID = Object.fromEntries(SORTS.map((s) => [s.id, s]));

// Stations recur across categories (counted over several category pages), so
// one shared list works here, unlike a per-category vocabulary.
const STATIONS = [
  "ARD", "Bayern 2", "WDR", "WDR 5", "NDR", "NDR Info", "NDR 2", "Deutschlandfunk",
  "Deutschlandfunk Kultur", "Deutschlandfunk Nova", "rbb", "radioeins", "SWR",
  "SWR Kultur", "SWR3", "BR", "hr", "MDR AKTUELL", "Bremen Zwei", "1LIVE", "funk",
];

async function catalog(catalogId, query) {
  const page = Number(query.get("cursor")) || 1;
  const sortDef = SORT_BY_ID[query.get("sort")] || SORT_BY_ID.default;
  const stations = (query.get("filter[station]") || "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const search = (query.get("search") || "").trim();

  // Search is global and paged by the API itself.
  if (search) {
    const data = await fetchJson(
      `/search/programsets?query=${encodeURIComponent(search)}&limit=${PAGE}&offset=${(page - 1) * PAGE}`,
    );
    const found = data?.data?.search?.programSets;
    const total = found?.numberOfElements ?? 0;
    return {
      items: nodesOf(found).map(toShow),
      nextCursor: page * PAGE < total ? String(page + 1) : null,
    };
  }

  let shows;
  try {
    shows = await categoryShows(catalogId);
  } catch (err) {
    console.warn("ard-audiothek: catalog failed:", err?.message || err);
    return { items: [], nextCursor: null };
  }
  if (stations.length) shows = shows.filter((s) => stations.includes(s.station.toLowerCase()));
  if (sortDef.cmp) shows = [...shows].sort(sortDef.cmp);

  const start = (page - 1) * PAGE;
  return {
    items: shows.slice(start, start + PAGE).map(toShow),
    nextCursor: start + PAGE < shows.length ? String(page + 1) : null,
  };
}

// ─── Items ───

async function loadShow(id) {
  const data = await fetchJson(`/programsets/${id}?limit=${MAX_EPISODES}&offset=0`);
  return data?.data?.programSet;
}

async function loadEpisode(id) {
  const data = await fetchJson(`/items/${id}`);
  return data?.data?.item;
}

function showItem(set) {
  const out = toShow(set);
  const children = nodesOf(set.items).slice(0, MAX_EPISODES).map(toEpisode);
  if (children.length) out.children = children;
  return out;
}

async function item(id) {
  // An episode play shape (`<episode-id>:<season>:<episode>`) is an episode
  // ask; so is a bare id that no program set answers for (a child re-fetch).
  const episodeId = episodeIdOf(id);
  if (episodeId) {
    const e = await loadEpisode(episodeId).catch(() => null);
    return e ? toEpisode(e, 0) : null;
  }
  const set = await loadShow(id).catch(() => null);
  if (set) return showItem(set);
  const e = await loadEpisode(id).catch(() => null);
  return e ? toEpisode(e, 0) : null;
}

// Ids are the API's numeric ids, so the first segment says what an episode
// play means; the bridge appends `:season:episode` to the episode's own id.
const episodeIdOf = (id) => {
  const m = /^(\d+):(\d+):(\d+)$/.exec(id);
  return m ? m[1] : null;
};

async function sources(id) {
  const episodeId = episodeIdOf(id);
  if (episodeId) {
    const e = await loadEpisode(episodeId).catch(() => null);
    const source = sourceOf(e);
    return { sources: source ? [source] : [] };
  }
  // A bare show id ("play the show") is the newest episode.
  const set = await loadShow(id).catch(() => null);
  if (set) {
    const source = sourceOf(nodesOf(set.items)[0]);
    return { sources: source ? [source] : [] };
  }
  const e = await loadEpisode(id).catch(() => null);
  const source = sourceOf(e);
  return { sources: source ? [source] : [] };
}

// ─── Manifest ───

// The categories ARE the catalogs, so the manifest is computed from them.
// v1 did the same at startup, with this fallback if the list won't load.
const FALLBACK_CATEGORIES = [
  { id: "42914710", title: "Doku & Reportage" },
  { id: "42914712", title: "Hörspiel" },
  { id: "63764892", title: "True Crime" },
  { id: "42914742", title: "Wissen" },
];

let categoriesPromise = null;
function editorialCategories() {
  categoriesPromise ||= fetchJson("/editorialcategories")
    .then((data) => {
      const list = nodesOf(data?.data?.editorialCategories)
        .filter((c) => c.id && c.title)
        .map((c) => ({ id: String(c.id), title: String(c.title).trim() }));
      return list.length ? list : FALLBACK_CATEGORIES;
    })
    .catch((err) => {
      // The next manifest ask tries again instead of serving the fallback forever.
      categoriesPromise = null;
      console.warn("ard-audiothek: failed to load categories:", err?.message || err);
      return FALLBACK_CATEGORIES;
    });
  return categoriesPromise;
}

async function manifest() {
  const cats = await editorialCategories();
  return {
    id: "ard-audiothek",
    name: "ARD Audiothek",
    specVersion: 2,
    version: "2.0.0",
    description:
      "ARD Audiothek: Hörspiele, Podcasts, Dokus und Features aller deutschen öffentlich-rechtlichen Sender. Kostenlos, ohne API-Key, nicht geo-beschränkt.",
    icon: "https://www.ardaudiothek.de/apple-icon-180.png",
    resources: ["catalog", "item", "source"],
    types: ["audio"],
    idPrefixes: ["ard_audiothek"],
    catalogs: cats.map((c) => ({
      id: c.id,
      name: c.title,
      type: "audio",
      options: { shape: "square", displayName: true },
      features: {
        search: true,
        sort: SORTS.map((s) => ({ id: s.id, name: s.name })),
        filter: [{ id: "station", name: "Sender", multiselect: true, values: STATIONS.map((s) => ({ id: s, name: s })) }],
      },
    })),
    dashboard: cats.slice(0, 8).map((c) => ({ name: c.title, catalog: c.id })),
    cache: { catalog: 3600, item: 86400, source: 86400 },
  };
}

// Ids arrive bare (our own catalog's items) or under the addon's namespace.
// The type in the path is the asker's guess, the bridge tries v1's "series"
// and "video" before "audio", so the id alone decides.
const bareId = (segment) =>
  decodeURIComponent(segment).replace(/\.json$/, "").replace(/^ard_audiothek:/, "");

export async function get(pathname, query) {
  if (pathname === "/mhub-addon.json") return manifest();
  const [, resource, , ...rest] = pathname.split("/");
  const id = bareId(rest.join("/"));
  if (!id) return null;

  if (resource === "catalog") return catalog(id, query);
  if (resource === "item") return item(id);
  if (resource === "source") return sources(id);
  return null;
}
