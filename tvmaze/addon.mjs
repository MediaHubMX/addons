/**
 * TVmaze. Ported from the v1 addon.
 *
 * Free, keyless TV metadata (https://www.tvmaze.com/api). Series only, and
 * like tmdb it answers for the foreign namespaces it can look up (imdb, tvdb)
 * as well as its own, which is what `idPrefixes` is for. TVmaze speaks
 * English only, so the request locale changes nothing.
 */

const BASE = "https://api.tvmaze.com";
const PAGE_SIZE = 250; // TVmaze /shows pages are fixed at 250

const fetchJson = async (url) => {
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`tvmaze ${res.status} on ${url}`);
  return res.json();
};

const stripHtml = (s) =>
  s ? s.replace(/<[^>]+>/g, "").trim() || undefined : undefined;

const image = (img) => img?.original || img?.medium || undefined;

const idsOf = (show) => {
  const ids = { tvmaze: String(show.id) };
  if (show.externals?.imdb) ids.imdb = show.externals.imdb;
  if (show.externals?.thetvdb) ids.tvdb = String(show.externals.thetvdb);
  return ids;
};

function toItem(show) {
  const item = {
    id: String(show.id),
    type: "series",
    name: show.name || String(show.id),
    ids: idsOf(show),
  };
  const description = stripHtml(show.summary);
  if (description) item.description = description;
  if (show.premiered) item.releaseDate = show.premiered;
  const poster = image(show.image);
  if (poster) item.images = { poster };
  if (show.genres?.length) item.genres = show.genres;
  return item;
}

// The episode-numbering convention: the series id with season and episode
// appended, so a source addon can read which episode it is without asking
// anyone. The episode's own id is TVmaze's episode id.
function toChild(show, ids, ep) {
  const suffix = `${ep.season}:${ep.number}`;
  const child = {
    id: String(ep.id),
    type: "video",
    name: ep.name || `Episode ${ep.number}`,
    ids: { tvmaze: `${ids.tvmaze}:${suffix}` },
    season: ep.season,
    episode: ep.number,
  };
  if (ids.imdb) child.ids.imdb = `${ids.imdb}:${suffix}`;
  if (ids.tvdb) child.ids.tvdb = `${ids.tvdb}:${suffix}`;
  const description = stripHtml(ep.summary);
  if (description) child.description = description;
  if (ep.airdate) child.releaseDate = ep.airdate;
  // TVmaze says minutes, the protocol wants seconds.
  if (ep.runtime) child.runtime = ep.runtime * 60;
  const poster = image(ep.image);
  if (poster) child.images = { poster };
  return child;
}

// ─── Catalog ───

// v1's filter and sort choices, kept as they were named there.
const GENRES = [
  "Action", "Adventure", "Anime", "Comedy", "Crime", "Drama", "Espionage",
  "Family", "Fantasy", "History", "Horror", "Legal", "Medical", "Music",
  "Mystery", "Romance", "Science-Fiction", "Sports", "Supernatural",
  "Thriller", "War", "Western",
];
const STATUS = [
  { id: "Running", name: "Laufend" },
  { id: "Ended", name: "Beendet" },
];
const SORTS = [
  { id: "rating", name: "Bewertung" },
  { id: "premiered", name: "Premiere" },
  { id: "name", name: "Name A–Z" },
];

// TVmaze has no server-side genre/sort browse, so filter and sort the fetched
// page in memory (scoped to that page, as v1 did).
function applyBrowse(shows, { genres, status, sort }) {
  let s = shows;
  if (genres.length) s = s.filter((sh) => (sh.genres || []).some((g) => genres.includes(g)));
  if (status) s = s.filter((sh) => sh.status === status);
  if (sort === "rating")
    s = [...s].sort((a, b) => (b.rating?.average || 0) - (a.rating?.average || 0));
  else if (sort === "premiered")
    s = [...s].sort((a, b) => String(b.premiered || "").localeCompare(String(a.premiered || "")));
  else if (sort === "name")
    s = [...s].sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
  return s.map(toItem);
}

const values = (query, name) =>
  (query.get(`filter[${name}]`) || "").split(",").map((v) => v.trim()).filter(Boolean);

async function catalog(query) {
  const page = Number(query.get("cursor")) || 1;
  const opts = {
    genres: values(query, "genre"),
    status: values(query, "status")[0],
    sort: query.get("sort") || undefined,
  };
  const search = query.get("search") || "";

  if (search) {
    const results =
      (await fetchJson(`${BASE}/search/shows?q=${encodeURIComponent(search)}`)) || [];
    return { items: applyBrowse(results.map((r) => r.show), opts), nextCursor: null };
  }

  // Browse the full index, 250 per page (0-based upstream).
  const shows = (await fetchJson(`${BASE}/shows?page=${page - 1}`)) || [];
  return {
    items: applyBrowse(shows, opts),
    nextCursor: shows.length === PAGE_SIZE ? String(page + 1) : null,
  };
}

// ─── Item ───

// The addon is asked about items that are not its own, so a foreign id has to
// be looked up first. TVmaze's lookup endpoints answer one show (or 404)
// instead of a find-list.
const LOOKUP = { imdb: "imdb", tvdb: "thetvdb" };

async function item(rawId) {
  const [namespace, ...rest] = rawId.split(":");
  const value = rest.join(":") || namespace;

  let show = null;
  if (!rest.length || namespace === "tvmaze") {
    show = await fetchJson(`${BASE}/shows/${value}?embed[]=episodes`);
  } else if (LOOKUP[namespace]) {
    show = await fetchJson(`${BASE}/lookup/shows?${LOOKUP[namespace]}=${encodeURIComponent(value)}`);
  }
  if (!show) return null;

  // lookup/* doesn't embed episodes; fetch them if missing.
  let episodes = show._embedded?.episodes;
  if (!episodes) {
    episodes = (await fetchJson(`${BASE}/shows/${show.id}/episodes`)) || [];
  }

  const full = toItem(show);
  const ids = idsOf(show);
  if (episodes.length) full.children = episodes.map((ep) => toChild(show, ids, ep));
  return full;
}

// ─── Wiring ───

function manifest() {
  return {
    id: "tvmaze",
    name: "TVmaze",
    specVersion: 2,
    version: "2.0.0",
    description:
      "Serien-Infos und Episodenführer von TVmaze (kostenlos, ohne API-Key). Liefert imdb/tvdb-IDs, damit andere Addons passende Streams finden.",
    icon: "https://static.tvmaze.com/images/favico/apple-touch-icon-180x180.png",
    resources: ["catalog", "item"],
    types: ["series"],
    // What this addon answers for: its own ids and the two foreign namespaces
    // it can look up, so other addons can ask it about a series they know
    // only by imdb or tvdb.
    idPrefixes: ["tvmaze", "imdb", "tvdb"],
    catalogs: [
      {
        id: "shows",
        name: "TVmaze",
        type: "series",
        options: { displayName: true },
        features: {
          search: true,
          sort: SORTS,
          filter: [
            { id: "genre", name: "Genre", multiselect: true, values: GENRES.map((g) => ({ id: g, name: g })) },
            { id: "status", name: "Status", multiselect: false, values: STATUS },
          ],
        },
      },
    ],
    dashboard: [{ name: "TVmaze: Serien", catalog: "shows" }],
    cache: { catalog: 21600, item: 86400 },
  };
}

export async function get(pathname, query) {
  const [, resource, type, ...rest] = pathname.split("/");
  if (resource === "mhub-addon.json" || pathname === "/mhub-addon.json") return manifest();

  const segment = decodeURIComponent(rest.join("/")).replace(/\.json$/, "");
  if (!segment) return null;

  // One catalog, one type: series is all TVmaze talks about.
  if (resource === "catalog" && type === "series" && segment === "shows") return catalog(query);
  if (resource === "item" && type === "series") return item(segment);
  return null;
}
