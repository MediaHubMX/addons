/**
 * The Movie Database. Ported from the v1 addon.
 *
 * The metadata addon the others lean on: it answers for foreign namespaces
 * (imdb, tvdb, tvrage) as well as its own, which is what `idPrefixes` is for.
 * Everything it says is localized, so language decides the answer and rides on
 * every request, the manifest included.
 */

import { department, translator } from "./strings.mjs";

const API = "https://api.themoviedb.org/3";
// TMDB is the one upstream in here that wants a key. It belongs to the
// deployment, never to the repo.
const API_KEY = process.env.TMDB_API_KEY;
const IMAGE = "https://image.tmdb.org/t/p";

// Items that must not surface, as `<catalog>/<id>` (`movie/123,series/456`).
// What is on it is a deployment decision, not a property of TMDB. It is typed
// by hand into an environment, so `tv/` is read as `series/`: TMDB's own name
// for the same thing, and a blocklist that silently matches nothing is worse
// than no blocklist at all.
const BLOCKED = new Set((process.env.TMDB_BLOCKED_ITEMS || "")
  .split(",")
  .map((entry) => entry.trim().replace(/^tv\//, "series/"))
  .filter(Boolean));

// Everywhere an item can come out, not just the catalog it was written for:
// recommendations, a filmography, a season and a direct request all reach the
// same items.
const blocked = (catalogId, id) => BLOCKED.has(`${catalogId}/${id}`);

const lang = (query) => query.get("language") || "en";
const image = (path, size = "original") => (path ? `${IMAGE}/${size}${path}` : undefined);

async function api(path, params = {}) {
  if (!API_KEY) throw new Error("tmdb: TMDB_API_KEY is not set");
  const qs = new URLSearchParams({ api_key: API_KEY });
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") qs.set(key, String(value));
  }
  const res = await fetch(`${API}/${path}?${qs}`, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    const err = new Error(`tmdb ${res.status} on ${path}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// An id TMDB does not know is an answer, not a failure: null becomes a 404 for
// the caller, where a throw would become a 502 and read as "this addon is
// broken". Everything else still throws.
const notFound = (err) => {
  if (err?.status === 404) return null;
  throw err;
};

// ─── Catalogs ───

// v2 content type per catalog. The type is part of every item URL, and tmdb
// reuses the same id for a film and a series, so this is what keeps
// /item/video/tmdb:123 and /item/series/tmdb:123 apart.
const CATALOGS = {
  movie: { tmdbType: "movie", type: "video" },
  series: { tmdbType: "tv", type: "series" },
  person: { tmdbType: "person", type: "page" },
};

const SORTS = {
  movie: {
    popularity: { sort_by: "popularity.desc" },
    // Newest first means newest of what exists. Without the cap the row opens
    // with announcements: "100 Years" is dated 2099-12-31, and four of the
    // first five entries were films from the 2040s.
    releaseDate: { sort_by: "release_date.desc", untilToday: true },
    trendingDay: { endpoint: "trending/movie/day" },
    trendingWeek: { endpoint: "trending/movie/week" },
  },
  series: {
    popularity: { sort_by: "popularity.desc" },
    trendingDay: { endpoint: "trending/tv/day" },
    trendingWeek: { endpoint: "trending/tv/week" },
  },
};

// Genres are named in the language they are asked for, so they are fetched
// per language and kept.
const genreCache = new Map();
async function genres(catalogId, language) {
  const key = `${catalogId}:${language}`;
  if (!genreCache.has(key)) {
    const { tmdbType } = CATALOGS[catalogId];
    genreCache.set(key, api(`genre/${tmdbType}/list`, { language })
      .then((d) => d.genres || [])
      .catch(() => []));
  }
  return genreCache.get(key);
}

let languagesP = null;
function apiLanguages() {
  languagesP ||= api("configuration/languages").catch(() => []);
  return languagesP;
}

const YEARS = Array.from({ length: new Date().getFullYear() + 1 - 1900 }, (_, i) =>
  String(new Date().getFullYear() - i));

async function catalogDefinition(catalogId, language, t) {
  const { type } = CATALOGS[catalogId];
  if (catalogId === "person") {
    return { id: "person", name: t("people"), type, features: { search: true } };
  }

  const [genreList, langList] = await Promise.all([genres(catalogId, language), apiLanguages()]);
  return {
    id: catalogId,
    name: t(catalogId === "movie" ? "movies" : "series"),
    type,
    options: { displayName: false },
    features: {
      search: true,
      sort: Object.keys(SORTS[catalogId]).map((id) => ({ id, name: t(id) })),
      filter: [
        {
          id: "genre",
          name: t("genre"),
          multiselect: true,
          values: genreList.map((g) => ({ id: String(g.id), name: g.name })),
        },
        // One year, not several: TMDB filters by a single year, and offering a
        // multiselect that quietly uses the first pick is worse than saying so.
        { id: "year", name: t("year"), values: YEARS.map((y) => ({ id: y, name: y })) },
        {
          id: "with_original_language",
          name: t("origLang"),
          values: langList
            .map((l) => ({ id: l.iso_639_1, name: l.english_name }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        },
      ],
    },
  };
}

async function manifest(query) {
  const language = lang(query);
  const t = translator(language);
  const catalogs = await Promise.all(
    Object.keys(CATALOGS).map((id) => catalogDefinition(id, language, t)));

  return {
    id: "tmdb",
    // A brand, the same in every language.
    name: "The Movie Database",
    specVersion: 2,
    version: "2.0.0",
    description: t("description"),
    icon: "https://www.themoviedb.org/assets/apple-touch-icon-57ed4b3b0450fd5e9a0c20f34e814b82adaa1085c79bdde2f00ca8787b63d2c4.png",
    resources: ["catalog", "item"],
    types: ["video", "series", "page"],
    // What this addon answers for. Its own ids and the three foreign
    // namespaces it can look up, which is why every other addon can ask it
    // about an item it has never seen.
    idPrefixes: ["tmdb", "imdb", "tvdb", "tvrage"],
    // Said out loud, because every request asks TMDB with include_adult=false
    // and v2 has no per-request flag to change that.
    adult: false,
    catalogs,
    dashboard: [
      { name: t("trendingSeries"), catalog: "series", sort: "trendingDay" },
      { name: t("popularSeries"), catalog: "series", sort: "popularity" },
      { name: t("trendingMovies"), catalog: "movie", sort: "trendingDay" },
      { name: t("popularMovies"), catalog: "movie", sort: "popularity" },
    ],
    cache: { catalog: 21600, item: 86400 },
  };
}

// ─── Items ───

const ids = (data) => {
  const out = { tmdb: String(data.id) };
  const imdb = data.imdb_id || data.external_ids?.imdb_id;
  const tvdb = data.tvdb_id || data.external_ids?.tvdb_id;
  const tvrage = data.tvrage_id || data.external_ids?.tvrage_id;
  if (imdb) out.imdb = String(imdb);
  if (tvdb) out.tvdb = String(tvdb);
  if (tvrage) out.tvrage = String(tvrage);
  return out;
};

function person(entry) {
  const out = { name: entry.name };
  if (entry.character) out.role = entry.character;
  if (entry.profile_path) out.image = image(entry.profile_path);
  // Navigable, one way. A person page and a person's works were two routes to
  // the same thing, and the works catalog is the better one: it says who the
  // person is in the same response that lists what they made, where the page
  // item costs a second request to show the same works. `/item/page/tmdb:<id>`
  // keeps answering for anything that addresses it directly.
  if (entry.id) out.directory = { type: "video", catalogId: `person_${entry.id}` };
  return out;
}

// Writing credits as TMDB names them. Everything else in the writing
// department (script coordinator, story editor) is not an author of the work.
const WRITER_JOBS = new Set([
  "Screenplay", "Writer", "Story", "Teleplay", "Novel", "Author", "Book", "Original Story",
]);

const uniqueBy = (list, key) => {
  const seen = new Set();
  return (list || []).filter((entry) => {
    const k = key(entry);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

// What a video IS, in the order the app should offer it. Everything a studio
// posts lands in TMDB's list (birthday greetings, behind the scenes) and the
// button says TRAILER. So: trailers; teasers only when there is no trailer at
// all, clips only when there is neither.
const VIDEO_RANK = { Trailer: 0, Teaser: 1, Clip: 2 };
const MAX_VIDEOS = 24;

// TMDB filters videos by language and has no "give me all of them", so the
// languages have to be named. `null` catches the ones with no language set.
const VIDEO_LANGUAGES = [
  "en", "de", "fr", "es", "it", "pt", "nl", "pl", "tr", "ru", "ja", "ko", "zh",
  "cs", "sk", "hu", "ro", "uk", "ar", "hi", "sv", "da", "fi", "no", "el", "he",
  "th", "vi", "id", "ms", "null",
];
const videoLanguages = (language) =>
  [...new Set([String(language || "en").split("-")[0], ...VIDEO_LANGUAGES])].join(",");

// ─── Artwork ───

// TMDB carries its whole gallery on the item request via append_to_response,
// so everything below costs no extra round trip. `null` is the languageless
// variant, which for a logo means one with no foreign alphabet baked in.
const imageLanguages = (language) =>
  [...new Set([String(language || "en").split("-")[0], "en", "null"])].join(",");

// One logo, chosen here rather than in every client. Requested language first,
// English next, languageless last, better rated wins a tie. SVG is skipped:
// react-native's Image cannot render it, and a client that gets one shows
// nothing at all. w500 because a logo is drawn a few hundred pixels wide and
// the original is a 2000px PNG.
function titleLogo(images, language) {
  const want = String(language || "en").split("-")[0];
  const rank = (l) => (l === want ? 0 : l === "en" ? 1 : 2);
  const best = (images?.logos || [])
    .filter((l) => l.file_path && !l.file_path.endsWith(".svg"))
    .sort((a, b) =>
      rank(a.iso_639_1) - rank(b.iso_639_1)
      || (b.vote_average || 0) - (a.vote_average || 0))[0];
  return best ? image(best.file_path, "w500") : undefined;
}

// The backdrop pool, best first. Languageless ones lead: a backdrop with a
// title burnt into it in the wrong alphabet is worse than a plain one. The
// primary stays in front of them, it is the one TMDB itself picked for this
// language. Capped at what the spec allows.
function backdropPool(images, primary) {
  const rest = (images?.backdrops || [])
    .filter((b) => b.file_path)
    .sort((a, b) =>
      (a.iso_639_1 ? 1 : 0) - (b.iso_639_1 ? 1 : 0)
      || (b.vote_average || 0) - (a.vote_average || 0))
    .map((b) => image(b.file_path));
  return [...new Set([image(primary), ...rest].filter(Boolean))].slice(0, 10);
}

function videos(results, language) {
  const usable = (results || []).filter(
    (v) => v.site === "YouTube" && v.key && VIDEO_RANK[v.type] !== undefined);
  if (!usable.length) return [];

  const best = Math.min(...usable.map((v) => VIDEO_RANK[v.type]));
  const want = String(language || "en").split("-")[0];
  const sorted = usable
    .filter((v) => VIDEO_RANK[v.type] === best)
    .sort((a, b) =>
      // The user's own language first, English next, the rest after.
      (a.iso_639_1 === want ? 0 : a.iso_639_1 === "en" ? 1 : 2)
      - (b.iso_639_1 === want ? 0 : b.iso_639_1 === "en" ? 1 : 2)
      || (a.official ? 0 : 1) - (b.official ? 0 : 1)
      || new Date(b.published_at || 0) - new Date(a.published_at || 0));

  return uniqueBy(sorted, (v) => v.key).slice(0, MAX_VIDEOS).map((v) => {
    const out = { url: `https://www.youtube.com/watch?v=${v.key}`, name: v.name || "Trailer" };
    // Without it, the same trailer in three languages is three identical rows.
    if (v.iso_639_1) out.languages = [v.iso_639_1];
    return out;
  });
}

// A listing entry: what a catalog page carries. Genre ids only, no credits.
async function listItem(data, catalogId, language) {
  const { type } = CATALOGS[catalogId];
  if (catalogId === "person") {
    const out = {
      id: `tmdb:${data.id}`,
      type: "page",
      name: data.name,
      ids: { tmdb: String(data.id) },
      // A person is a place: opening one shows what they made.
      directory: { type: "video", catalogId: `person_${data.id}` },
    };
    if (data.profile_path) out.images = { poster: image(data.profile_path) };
    return out;
  }

  const item = {
    id: String(data.id),
    type,
    name: data.title || data.name || String(data.id),
    ids: ids(data),
  };
  if (data.overview) item.description = data.overview;
  const date = data.release_date || data.first_air_date;
  if (date) item.releaseDate = date;
  // TMDB's own score, not IMDb's, it is the one this addon can vouch for.
  // An entry with no votes yet carries a 0, which is not a rating.
  if (data.vote_average > 0 && data.vote_count > 0) item.ratings = { tmdb: data.vote_average };
  const images = {};
  if (data.poster_path) images.poster = image(data.poster_path);
  if (data.backdrop_path) images.backdrops = [image(data.backdrop_path)];
  if (Object.keys(images).length) item.images = images;

  if (data.genre_ids?.length) {
    const list = await genres(catalogId, language);
    const names = data.genre_ids.map((id) => list.find((g) => g.id === id)?.name).filter(Boolean);
    if (names.length) item.genres = names;
  }
  return item;
}

async function fullItem(data, catalogId, language, t) {
  const item = await listItem(data, catalogId, language);
  if (catalogId === "person") {
    // A person is a page: what there is to see are their works.
    item.catalogs = [{ id: `person_${data.id}`, name: item.name, type: "video" }];
    if (data.biography) item.description = data.biography;
    return item;
  }

  if (data.genres?.length) item.genres = data.genres.map((g) => g.name);
  if (data.original_title || data.original_name) item.originalName = data.original_title || data.original_name;
  if (data.runtime) item.runtime = data.runtime * 60;
  // Lists, primary first: a co-production has more than one country, a film
  // more than one audio language. The single-value `country`/`language` are
  // for channels and streams.
  const countries = (data.production_countries || []).map((c) => c.iso_3166_1).filter(Boolean);
  if (countries.length) item.countries = countries;
  const languages = (data.spoken_languages || []).map((l) => l.iso_639_1).filter(Boolean);
  if (languages.length) item.languages = languages;
  const production = (data.production_companies || []).map((c) => c.name).filter(Boolean);
  if (production.length) item.production = production;
  if (data.homepage) item.homepage = data.homepage;

  // The artwork a detail view needs and a list does not: the title logo for
  // the hero, and the pool of backdrops behind it.
  if (data.images) {
    const pool = backdropPool(data.images, data.backdrop_path);
    const logo = titleLogo(data.images, language);
    if (pool.length || logo) {
      item.images = { ...(item.images || {}) };
      if (pool.length) item.images.backdrops = pool;
      if (logo) item.images.logo = logo;
    }
  }

  const cast = uniqueBy(data.credits?.cast, (c) => c.id).map(person);
  const crew = data.credits?.crew || [];
  // What someone did on THIS title, which is `job`. `known_for_department` is
  // a property of the person, so filtering on it made every assistant director
  // whose career is directing a director of this film: Forrest Gump listed
  // five, four of whom were the second unit.
  const directors = uniqueBy(crew.filter((c) => c.job === "Director"), (c) => c.id);
  // A series is written before it is directed, and who made it up is a field
  // of its own at TMDB. Those names lead the writing credits.
  const writers = uniqueBy(
    [...(data.created_by || []), ...crew.filter((c) => WRITER_JOBS.has(c.job))],
    (c) => c.id);
  if (cast.length) item.cast = cast;
  if (directors.length) item.director = directors.map(person);
  if (writers.length) item.author = writers.map(person);

  const trailers = videos(data.videos?.results, language);
  if (trailers.length) item.videos = trailers;

  // Recommendations and similar titles are catalogs on the item, carried
  // inline so the detail view has them without another request. Their ids say
  // which list of whose they are: two catalogs on one item that share an id
  // are one list as far as a client is concerned, and it will say so.
  const related = [];
  for (const [key, name] of [["recommendations", t("recommended")], ["similar", t("similar")]]) {
    const results = data[key]?.results || [];
    if (!results.length) continue;
    related.push({
      id: `${key}_${catalogId}_${data.id}`,
      name,
      type: CATALOGS[catalogId].type,
      items: await Promise.all(results.map((r) => listItem(r, catalogId, language))),
      nextCursor: results.length >= 20 ? "2" : null,
    });
  }
  if (related.length) item.catalogs = related;

  return item;
}

// ─── Endpoints ───

const values = (query, name) =>
  (query.get(`filter[${name}]`) || "").split(",").map((v) => v.trim()).filter(Boolean);

// TMDB hands out 20 per page and a row on a TV wants more than that before it
// asks again, so one catalog request is a run of TMDB pages. The cursor is
// the TMDB page the next run starts at.
const PAGES_PER_REQUEST = 5;
// TMDB answers 422 past page 500, whatever total_pages claims.
const MAX_PAGE = 500;

async function catalog(catalogId, query) {
  const language = lang(query);
  const search = query.get("search") || "";
  const page = Number(query.get("cursor")) || 1;

  if (catalogId === "person" && !search) {
    // The person catalog exists to browse one person's works; without a
    // search there is nothing to list.
    return { items: [], nextCursor: null };
  }

  let endpoint = search ? `search/${CATALOGS[catalogId].tmdbType}` : `discover/${CATALOGS[catalogId].tmdbType}`;
  const params = { language, page, query: search, include_adult: false };

  if (!search && catalogId !== "person") {
    const sort = query.get("sort") || "popularity";
    const settings = SORTS[catalogId][sort] || SORTS[catalogId].popularity;
    if (settings.endpoint) endpoint = settings.endpoint;
    if (settings.sort_by) params.sort_by = settings.sort_by;
    if (settings.untilToday) params["release_date.lte"] = new Date().toISOString().slice(0, 10);

    const genreIds = values(query, "genre");
    if (genreIds.length) params.with_genres = genreIds.join(",");
    // `year` matches ANY release date TMDB holds, re-releases included, so
    // asking for 1999 answered with fifteen films from other years. The
    // primary date is the one the filter is about.
    const [year] = values(query, "year");
    if (year) params[catalogId === "movie" ? "primary_release_year" : "first_air_date_year"] = year;
    const [original] = values(query, "with_original_language");
    if (original) params.with_original_language = original;
  }

  // The first page says how many there are; the rest of the run follows in
  // parallel, and a run past the end is just shorter.
  const first = await api(endpoint, params);
  const total = Math.min(first.total_pages || page, MAX_PAGE);
  const last = Math.min(page + PAGES_PER_REQUEST - 1, total);
  const rest = await Promise.all(Array.from({ length: last - page }, (_, i) =>
    api(endpoint, { ...params, page: page + 1 + i }).catch(() => null)));
  let results = [first, ...rest].flatMap((data) => data?.results || []);
  if (catalogId === "series" && !search && (query.get("sort") || "popularity") === "popularity") {
    results = results.filter((r) => r.original_language !== "ar");
  }

  // TMDB's order shifts between pages, so a run can show a title twice.
  const items = [];
  const seen = new Set();
  for (const entry of results) {
    if (blocked(catalogId, entry.id) || seen.has(entry.id)) continue;
    seen.add(entry.id);
    items.push(await listItem(entry, catalogId, language));
  }
  return {
    items,
    nextCursor: last < total ? String(last + 1) : null,
  };
}

// Another page of what TMDB suggests next to an item.
async function relatedCatalog(kind, catalogId, id, query) {
  const language = lang(query);
  const page = Number(query.get("cursor")) || 1;
  const data = await api(`${CATALOGS[catalogId].tmdbType}/${id}/${kind}`, { language, page })
    .catch(notFound);
  if (!data) return null;
  const results = (data.results || []).filter((r) => !blocked(catalogId, r.id));
  return {
    items: await Promise.all(results.map((r) => listItem(r, catalogId, language))),
    nextCursor: data.page < data.total_pages ? String(data.page + 1) : null,
  };
}

// A person's filmography. The catalog is ABOUT someone, so it says who: the
// client shows that above the works, and it is the only page a viewer ever
// sees of a person.
// How many works one page of a filmography carries. Tom Hanks has 277 of
// them, and answering all of them at once was 166 KB into a television.
const CREDITS_PER_PAGE = 40;

async function personCredits(id, query) {
  const language = lang(query);
  const page = Number(query.get("cursor")) || 1;
  const [credits, person] = await Promise.all([
    api(`person/${id}/combined_credits`, { language }).catch(notFound),
    api(`person/${id}`, { language }).catch(() => null),
  ]);
  if (!credits) return null;

  // Acted in AND worked on: a director's own films are crew credits, so cast
  // alone left every director with nothing but the documentaries they were
  // interviewed for. Cast wins a tie, because being in it is the closer
  // relation, and TMDB lists the same title twice for two characters.
  const all = uniqueBy(
    [...(credits.cast || []), ...(credits.crew || [])],
    (c) => `${c.media_type}:${c.id}`)
    .filter((c) => !blocked(c.media_type === "tv" ? "series" : "movie", c.id));
  // Newest first, the way a filmography is read. Undated works are things
  // announced and not made, and they go to the end rather than the top.
  const releasedAt = (c) => c.release_date || c.first_air_date || "";
  all.sort((a, b) => releasedAt(b).localeCompare(releasedAt(a))
    || (b.popularity || 0) - (a.popularity || 0));

  const from = (page - 1) * CREDITS_PER_PAGE;
  const pageOf = all.slice(from, from + CREDITS_PER_PAGE);

  const items = [];
  for (const entry of pageOf) {
    const catalogId = entry.media_type === "tv" ? "series" : "movie";
    items.push(await listItem(entry, catalogId, language));
  }

  const result = {
    items,
    nextCursor: from + pageOf.length < all.length ? String(page + 1) : null,
  };
  if (person?.name) {
    // Short facts in our own wording and order, which is what the client
    // renders them as: what they do, when they were born, where.
    const meta = [
      department(person.known_for_department, language),
      lifespan(person, language),
      person.place_of_birth,
    ].filter(Boolean);

    result.directory = { name: person.name };
    if (person.biography) result.directory.description = person.biography;
    if (person.profile_path) result.directory.image = image(person.profile_path);
    if (meta.length) result.directory.meta = meta;
  }
  return result;
}

// When someone was born, written the way the reader writes a date: TMDB hands
// out ISO ("1972-03-13"), and the language is on the request anyway. The years
// stand next to it because the date alone makes the reader do the arithmetic.
// For someone who has died, that is their age when they died, which is the
// only age they have. Both dates for them, one for the living.
// (The number ages with the cache, so it can be a day behind around a
// birthday. Not worth a mechanism.)
function lifespan(person, language) {
  const born = parseDate(person.birthday);
  if (!born) return person.birthday || null;
  const died = parseDate(person.deathday);
  const written = (d) => new Intl.DateTimeFormat(language, { dateStyle: "long", timeZone: "UTC" }).format(d);
  return `${written(born)}${died ? ` - ${written(died)}` : ""} (${years(born, died || new Date())})`;
}

// A whole date or nothing: TMDB has handed out a bare year before, and
// `new Date("1972")` turns that into a first of January that was never a fact.
const parseDate = (iso) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || "")) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
};

// Whole years between two dates. UTC throughout, because an ISO date without a
// time IS UTC midnight: read in a western timezone it would be the day before.
function years(from, to) {
  let n = to.getUTCFullYear() - from.getUTCFullYear();
  const months = to.getUTCMonth() - from.getUTCMonth();
  if (months < 0 || (months === 0 && to.getUTCDate() < from.getUTCDate())) n--;
  return n;
}

// The addon is asked about items that are not its own, so a foreign id has to
// be turned into a tmdb one first.
const EXTERNAL = { imdb: "imdb_id", tvdb: "tvdb_id", tvrage: "tvrage_id" };

async function resolveId(rawId, catalogId) {
  const [namespace, ...rest] = rawId.split(":");
  const value = rest.join(":") || namespace;
  if (!rest.length || namespace === "tmdb") return value;

  const source = EXTERNAL[namespace];
  if (!source) return null;
  const found = await api(`find/${value}`, { external_source: source });
  const hit = catalogId === "series" ? found.tv_results?.[0] : found.movie_results?.[0];
  return hit ? String(hit.id) : null;
}

// An episode addresses itself the way the spec says and the way this addon
// lists it: the series id with season and episode appended. The last two
// segments are the numbers, whatever namespace stands in front of them.
const EPISODE = /^(.+):(\d+):(\d+)$/;

async function item(catalogId, rawId, query) {
  const language = lang(query);

  const episode = EPISODE.exec(rawId);
  if (episode) {
    // The series is what carries the id, so that is what a foreign namespace
    // has to be resolved as, whatever type the episode itself is asked under.
    const seriesId = await resolveId(episode[1], "series");
    if (!seriesId || blocked("series", seriesId)) return null;
    const data = await api(`tv/${seriesId}/season/${episode[2]}/episode/${episode[3]}`, { language })
      .catch(notFound);
    return data ? episodeItem(seriesId, data) : null;
  }

  const id = await resolveId(rawId, catalogId);
  if (!id || blocked(catalogId, id)) return null;

  if (catalogId === "person") {
    const data = await api(`person/${id}`, { language }).catch(notFound);
    return data?.id ? fullItem(data, catalogId, language, translator(language)) : null;
  }

  const data = await api(`${CATALOGS[catalogId].tmdbType}/${id}`, {
    language,
    include_video_language: videoLanguages(language),
    include_image_language: imageLanguages(language),
    append_to_response: "videos,credits,external_ids,similar,recommendations,images",
  }).catch(notFound);
  if (!data?.id) return null;

  const full = await fullItem(data, catalogId, language, translator(language));

  // A series says how it is built. The episodes themselves are a season's
  // worth each, so they are a catalog, not a thousand inline children, but a
  // catalog may bring its items along, and for a normal series it should (see
  // INLINE_MAX_EPISODES).
  if (catalogId === "series" && data.seasons?.length) {
    const seasons = data.seasons
      // An announced season is listed here before it has a single episode
      // (Silo carried an empty fourth one). A catalog that answers with nothing
      // is a season tab into the void. Only an explicit zero is dropped: if the
      // count is ever missing, keep the season rather than lose them all.
      // Season 0 (specials) stays, after the regular ones: tmdb lists it
      // first, and a series should not open on its extras.
      .filter((s) => s.episode_count !== 0)
      .sort((a, b) => (a.season_number || Infinity) - (b.season_number || Infinity))
      .map((s) => ({
        id: `season_${id}_${s.season_number}`,
        name: s.name || `Season ${s.season_number}`,
        type: "video",
        // Which season this is and how long it is: tmdb knows both here, and
        // with them the client stops guessing and can offer the season before
        // it has loaded it.
        season: s.season_number,
        count: s.episode_count,
        // The season's own synopsis, where tmdb has one. The client reads it
        // up into the hero while the season is the thing under the focus.
        ...(s.overview ? { description: s.overview } : {}),
        ...(s.air_date ? { releaseDate: s.air_date } : {}),
        ...(s.poster_path ? { images: { poster: image(s.poster_path) } } : {}),
        ...(s.vote_average > 0 ? { ratings: { tmdb: s.vote_average } } : {}),
      }));
    if (seasons.length) {
      await inlineSeasons(id, seasons, language);
      full.catalogs = [...seasons, ...(full.catalogs || [])];
    }
  }
  return full;
}

// An episode, wherever it is asked for: in its season's list, or on its own.
// Both have to agree, because the id in the list is what comes back as a
// request.
function episodeItem(seriesId, e) {
  const out = {
    // The episode of a series, in the namespace convention: the series id
    // with season and episode appended.
    id: `tmdb:${seriesId}:${e.season_number}:${e.episode_number}`,
    type: "video",
    name: e.name || `Episode ${e.episode_number}`,
    ids: { tmdb: `${seriesId}:${e.season_number}:${e.episode_number}` },
    season: e.season_number,
    episode: e.episode_number,
  };
  if (e.overview) out.description = e.overview;
  if (e.air_date) out.releaseDate = e.air_date;
  // A still is 16:9 and belongs in `thumbnail`. Putting it under `poster`
  // hands a portrait slot a landscape picture, and every client that crops
  // to 2:3 cuts the middle out of the frame.
  if (e.still_path) out.images = { thumbnail: image(e.still_path) };
  if (e.runtime) out.runtime = e.runtime * 60;
  return out;
}

// How many episodes a series may carry inline. Measured on real data: about
// 385 bytes per episode, 109 gzipped: 300 episodes are some 33 KB on the wire,
// less than one poster. Below that line the whole series travels with the item,
// and switching seasons costs nothing; above it (daily shows, long soaps) the
// seasons stay references and are fetched when they are opened.
const INLINE_MAX_EPISODES = 300;
// TMDB takes at most 20 appended sub-requests in one call.
const APPEND_MAX = 20;

// Fill the seasons with their episodes, in ONE upstream call. A season that
// TMDB does not return simply keeps no items: the client fetches that one on
// its own, which is what the catalog id is for.
async function inlineSeasons(seriesId, seasons, language) {
  const total = seasons.reduce((n, s) => n + (s.count || 0), 0);
  if (!total || total > INLINE_MAX_EPISODES || seasons.length > APPEND_MAX) return;
  const data = await api(`tv/${seriesId}`, {
    language,
    append_to_response: seasons.map((s) => `season/${s.season}`).join(","),
  }).catch(() => null);
  if (!data) return;
  for (const s of seasons) {
    const episodes = data[`season/${s.season}`]?.episodes;
    if (episodes?.length) s.items = episodes.map((e) => episodeItem(seriesId, e));
  }
}

// One season of a series, as a catalog.
async function season(seriesId, seasonNumber, query) {
  if (blocked("series", seriesId)) return null;
  const language = lang(query);
  const data = await api(`tv/${seriesId}/season/${seasonNumber}`, { language }).catch(notFound);
  if (!data) return null;
  return { items: (data.episodes || []).map((e) => episodeItem(seriesId, e)), nextCursor: null };
}

const TYPE_TO_CATALOG = { video: "movie", series: "series", page: "person" };

// A film from years ago is finished, and its runtime is not going to change.
// One that came out this month is still being filled in, and a series can
// always gain an episode, so neither of those gets the long window. The
// manifest declares one number for "item" and cannot make this distinction,
// which is what ctx.freshness is for.
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const SETTLED_MS = 365 * DAY;
function itemFreshness(item) {
  if (!item || item.type === "series") return 6 * HOUR;
  const at = Date.parse(item.releaseDate ?? "");
  return Number.isFinite(at) && Date.now() - at > SETTLED_MS ? 7 * DAY : 6 * HOUR;
}

export async function get(pathname, query, ctx) {
  const [, resource, type, ...rest] = pathname.split("/");
  if (resource === "mhub-addon.json" || pathname === "/mhub-addon.json") return manifest(query);

  const segment = decodeURIComponent(rest.join("/")).replace(/\.json$/, "");
  const catalogId = TYPE_TO_CATALOG[type];
  if (!catalogId) return null;

  if (resource === "catalog") {
    // What is on an item is a catalog too: another page of the same list has
    // to come from somewhere.
    const related = /^(recommendations|similar)_(movie|series)_(\d+)$/.exec(segment);
    if (related) return relatedCatalog(related[1], related[2], related[3], query);
    // A season of a series, and a person's works, are catalogs whose id says
    // whose they are.
    const seasonOf = /^season_(\d+)_(\d+)$/.exec(segment);
    if (seasonOf) return season(seasonOf[1], seasonOf[2], query);
    // A person's works, whatever type the client asks them under.
    const person = /^person_(\d+)$/.exec(segment);
    if (person) return personCredits(person[1], query);
    if (!CATALOGS[segment]) return null;
    // A search is not a catalog: the list behind it changes with whatever
    // anyone types, so it stays good for an hour and not for six.
    if (query.get("search")) ctx?.freshness?.(HOUR);
    return catalog(segment, query);
  }

  if (resource === "item") {
    const found = await item(catalogId, segment, query);
    ctx?.freshness?.(itemFreshness(found));
    return found;
  }
  return null;
}
