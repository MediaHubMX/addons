/**
 * AniList. Ported from the v1 addon.
 *
 * Free, keyless anime metadata behind one GraphQL endpoint. One catalog
 * holds films and series together, because AniList's own Media type does,
 * what an entry is only shows in its `format`. The addon also answers for
 * MyAnimeList ids (namespace `mal`), which is what `idPrefixes` is for.
 * AniList has no localized metadata, so the request language rides through
 * unused and the display strings stay German, as the v1 addon had them.
 */

const ENDPOINT = "https://graphql.anilist.co";

// AniList runs its API in a degraded state (30 requests a minute instead of
// 90) and answers a request without a `Referer` with 403 and "the API has been
// temporarily disabled", which is what a browser never sees and a server
// always does. Any non-empty referer passes, so ours says who is actually
// calling. Their own docs call the degradation temporary; the header costs
// nothing once it is over.
const UA = "MediaHubMX-AniList/2";
const REFERER = "https://mhub.mx/";

const MEDIA_FIELDS = `
  id idMal
  title { romaji english native }
  description(asHtml: false)
  coverImage { extraLarge large }
  bannerImage
  format episodes duration status genres averageScore countryOfOrigin
  startDate { year }
  siteUrl
`;

// A tile in a row on the detail page: a name, a picture and a year. Everything
// a list item carries would be a description per recommendation, and there are
// fourteen of them on one response.
const RELATED_FIELDS = `
  id idMal type format
  title { romaji english }
  coverImage { extraLarge large }
  startDate { year }
  averageScore
`;

// Only for the detail request: the credits, what it is like and what came
// before it are far too heavy for a catalog page.
const ITEM_FIELDS = `
  ${MEDIA_FIELDS}
  nextAiringEpisode { episode }
  streamingEpisodes { title thumbnail }
  trailer { id site }
  tags { name rank isGeneralSpoiler isMediaSpoiler }
  characters(sort: [ROLE, RELEVANCE], perPage: 25) {
    edges {
      role
      node { name { full } image { large } }
      voiceActors(language: JAPANESE, sort: RELEVANCE) { name { full } image { large } }
    }
  }
  staff(sort: RELEVANCE, perPage: 25) { edges { role node { name { full } image { large } } } }
  relations { edges { relationType node { ${RELATED_FIELDS} } } }
  recommendations(sort: RATING_DESC, perPage: 12) { nodes { mediaRecommendation { ${RELATED_FIELDS} } } }
`;

const HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json",
  "User-Agent": UA,
  Referer: REFERER,
};

const request = (query, variables) => ({
  method: "POST",
  headers: HEADERS,
  body: JSON.stringify({ query, variables }),
});

// The 30 a minute are counted per IP, so what the server asks for itself has
// to survive being told to wait. The message carries the seconds AniList
// named, and the host turns a throw into one answer for everyone who asks
// while it lasts.
function checkStatus(status, retryAfter) {
  if (status === 429) throw new Error(`anilist 429, retry after ${retryAfter || "?"}s`);
  if (status !== 200) {
    const err = new Error(`anilist ${status}`);
    err.status = status;
    throw err;
  }
}

// AniList answers an id it does not have with 404, and that is an answer: the
// caller gets a 404 too, where a throw would be a 502 and read as "this addon
// is broken".
const notFound = (err) => {
  if (err?.status === 404) return null;
  throw err;
};

function unpack(json) {
  if (json.errors) throw new Error(json.errors[0]?.message || "AniList error");
  return json.data;
}

async function gql(query, variables) {
  const res = await fetch(ENDPOINT, request(query, variables));
  checkStatus(res.status, res.headers.get("retry-after"));
  return unpack(await res.json());
}

// What the client is asked to fetch instead, for the two questions that do not
// share an answer between users: a search nobody repeats, and a detail page
// that would otherwise spend the server's rate limit per title. The id says
// what to do with what comes back, so nothing has to be remembered in between.
const askClient = (id, query, variables) => ({
  clientFetch: { id, url: ENDPOINT, ...request(query, variables) },
});

const stripHtml = (s) =>
  s ? s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || undefined : undefined;

// AniList scores out of 100, and `ratings` is a number next to imdb's and
// tmdb's, which are out of 10.
const rating = (score) => (score > 0 ? Math.round(score) / 10 : undefined);

// What the client says about a title before anyone reads a date.
const STATUS = {
  RELEASING: "ongoing",
  FINISHED: "released",
  NOT_YET_RELEASED: "upcoming",
  CANCELLED: "cancelled",
  HIATUS: "ongoing",
};

function toItem(m) {
  const item = {
    id: String(m.id),
    type: m.format === "MOVIE" ? "video" : "series",
    name: m.title?.english || m.title?.romaji || String(m.id),
    ids: { anilist: String(m.id) },
  };
  if (m.idMal) item.ids.mal = String(m.idMal);
  const description = stripHtml(m.description);
  if (description) item.description = description;
  const images = {};
  const poster = m.coverImage?.extraLarge || m.coverImage?.large;
  if (poster) images.poster = poster;
  if (m.bannerImage) images.backdrops = [m.bannerImage];
  if (Object.keys(images).length) item.images = images;
  if (m.genres?.length) item.genres = m.genres;
  if (m.startDate?.year) item.year = m.startDate.year;
  // Fetched since the first version and dropped on the floor: the score every
  // client shows next to a title, how long one episode runs, and whether the
  // thing is still airing.
  const score = rating(m.averageScore);
  if (score) item.ratings = { anilist: score };
  if (m.duration) item.runtime = m.duration * 60;
  if (STATUS[m.status]) item.status = STATUS[m.status];
  if (m.countryOfOrigin) item.countries = [m.countryOfOrigin];
  // The romaji title next to an English name is what people search for and
  // what every other addon calls the same show.
  const original = m.title?.romaji || m.title?.native;
  if (original && original !== item.name) item.originalName = original;
  return item;
}

// AniList has no season/episode entities, only an episode COUNT plus the
// `streamingEpisodes` list (titles like "Episode 12 - Foo", unordered, often
// incomplete). Seasons don't exist either: a second anime season is its own
// Media entry. So we synthesize episodes 1..n as season 1 and enrich them with
// whatever title/thumbnail `streamingEpisodes` provides.
const EPISODE_TITLE_RE = /^\s*(?:episode|folge|ep\.?)\s*(\d+)\s*(?:[-–—:]\s*(.*))?$/i;

const streamingByEpisode = (streamingEpisodes) => {
  const map = new Map();
  for (const se of streamingEpisodes || []) {
    const m = EPISODE_TITLE_RE.exec(se.title || "");
    if (!m) continue;
    const nr = Number(m[1]);
    if (map.has(nr)) continue;
    map.set(nr, { name: m[2]?.trim() || undefined, poster: se.thumbnail || undefined });
  }
  return map;
};

// Aired episodes: `episodes` is null while a show is still running, and for a
// running show it may already announce more than aired -> take the smaller one.
const airedEpisodes = (m, streaming) => {
  const total = m.episodes || undefined;
  const aired = m.nextAiringEpisode?.episode ? m.nextAiringEpisode.episode - 1 : undefined;
  const known = streaming.size ? Math.max(...streaming.keys()) : undefined;
  const n = total != null && aired != null ? Math.min(total, aired) : (total ?? aired ?? known);
  return Math.max(n || 0, 0);
};

const toEpisodes = (m) => {
  const streaming = streamingByEpisode(m.streamingEpisodes);
  const count = airedEpisodes(m, streaming);
  return Array.from({ length: count }, (_, i) => {
    const nr = i + 1;
    const se = streaming.get(nr) || {};
    const child = {
      // Episode ids by the namespace convention: series id + :season:episode.
      id: `${m.id}-${nr}`,
      type: "video",
      name: se.name || `Episode ${nr}`,
      ids: { anilist: `${m.id}:1:${nr}` },
      season: 1,
      episode: nr,
    };
    if (se.poster) child.images = { poster: se.poster };
    return child;
  });
};

// Sort options (feature) -> AniList MediaSort enum.
const SORTS = [
  { id: "popularity", name: "Beliebt", enum: "POPULARITY_DESC" },
  { id: "trending", name: "Trending", enum: "TRENDING_DESC" },
  { id: "score", name: "Top bewertet", enum: "SCORE_DESC" },
  { id: "newest", name: "Neu", enum: "START_DATE_DESC" },
];
const SORT_BY_ID = Object.fromEntries(SORTS.map((s) => [s.id, s]));

// AniList's fixed genre list, and the media formats (label -> API key).
const GENRES = [
  "Action", "Adventure", "Comedy", "Drama", "Ecchi", "Fantasy", "Horror",
  "Mahou Shoujo", "Mecha", "Music", "Mystery", "Psychological", "Romance",
  "Sci-Fi", "Slice of Life", "Sports", "Supernatural", "Thriller",
];
const FORMATS = [
  { id: "TV", name: "TV-Serie" },
  { id: "MOVIE", name: "Film" },
  { id: "OVA", name: "OVA" },
  { id: "ONA", name: "ONA" },
  { id: "SPECIAL", name: "Special" },
];
const CURRENT_YEAR = new Date().getFullYear();
const YEARS = Array.from({ length: CURRENT_YEAR - 1969 }, (_, i) => String(CURRENT_YEAR - i));

// "Neu" must mean recently STARTED, not recently announced. Plain
// START_DATE_DESC leads with NOT_YET_RELEASED and CANCELLED entries plus
// entries whose start date is unknown (those sort to the very top), 98% of that
// row carried no episodes at all. Restricting to aired titles within a rolling
// window fixes both.
const NEWEST_YEARS = 2;
const NEWEST_ARGS = [
  "status_in: [RELEASING, FINISHED]",
  `startDate_greater: ${(CURRENT_YEAR - NEWEST_YEARS) * 10000 + 101}`,
];

const values = (query, name) =>
  (query.get(`filter[${name}]`) || "").split(",").map((v) => v.trim()).filter(Boolean);

const PER_PAGE = 50;

function catalogQuery(query) {
  const page = Number(query.get("cursor")) || 1;
  const sortDef = SORT_BY_ID[query.get("sort")] || SORT_BY_ID.popularity;
  const search = query.get("search") || "";
  const genres = values(query, "genre");
  const formats = values(query, "format");
  const [yearValue] = values(query, "year");
  const year = yearValue ? Number(yearValue) : undefined;

  const useSearch = !!search;
  const varDefs = ["$page: Int", "$perPage: Int"];
  const vars = { page, perPage: PER_PAGE };
  const mediaArgs = [`type: ANIME`];

  if (useSearch) {
    varDefs.push("$search: String");
    vars.search = search;
    mediaArgs.push("search: $search", "sort: SEARCH_MATCH");
  } else {
    mediaArgs.push(`sort: ${sortDef.enum}`);
    if (sortDef.id === "newest") {
      // An explicit year filter wins over the rolling window, otherwise
      // "Neu" + year 2015 would return nothing.
      mediaArgs.push(...(year ? NEWEST_ARGS.slice(0, 1) : NEWEST_ARGS));
    }
  }
  if (genres.length) {
    varDefs.push("$genres: [String]");
    vars.genres = genres;
    mediaArgs.push("genre_in: $genres");
  }
  if (formats.length) {
    varDefs.push("$formats: [MediaFormat]");
    vars.formats = formats;
    mediaArgs.push("format_in: $formats");
  }
  if (year) {
    varDefs.push("$year: Int");
    vars.year = year;
    mediaArgs.push("seasonYear: $year");
  }

  return {
    page,
    useSearch,
    query: `query (${varDefs.join(", ")}) {
      Page(page: $page, perPage: $perPage) {
        pageInfo { hasNextPage }
        media(${mediaArgs.join(", ")}) {
          ${MEDIA_FIELDS}
        }
      }
    }`,
    vars,
  };
}

const catalogShape = (data, page) => ({
  items: (data.Page?.media || []).map(toItem),
  nextCursor: data.Page?.pageInfo?.hasNextPage ? String(page + 1) : null,
});

// The addon answers for its own numeric ids, its own namespace and the mal
// one. AniList's Media covers films and series alike, so the requested v2
// type only addresses the route: the answer carries the real one.
// One lookup for both things a detail request can be: the item itself and the
// places it can be watched. Same id, same two namespaces, different fields.
function mediaQuery(segment, fields) {
  const [namespace, ...rest] = segment.split(":");
  const byMal = rest.length > 0 && namespace === "mal";
  if (rest.length > 0 && namespace !== "mal" && namespace !== "anilist") return null;
  const id = Number(rest.length ? rest.join(":") : namespace);
  if (!Number.isInteger(id)) return null;

  return {
    query: `query ($id: Int) {
      Media(${byMal ? "idMal: $id" : "id: $id"}, type: ANIME) { ${fields} }
    }`,
    vars: { id },
  };
}

const itemQuery = (segment) => mediaQuery(segment, ITEM_FIELDS);
const sourceQuery = (segment) => mediaQuery(segment, "externalLinks { site url type }");

// ─── What a detail page carries ───

// A voice actor is the cast, the character is the part they play. That is the
// same shape a film has, and it keeps the name a client can search for in the
// name field. Characters without a voice actor still count: the part exists,
// and its picture is the one people recognise.
function toCast(characters) {
  const out = [];
  for (const edge of characters?.edges || []) {
    const character = edge.node?.name?.full;
    const actor = edge.voiceActors?.[0];
    const name = actor?.name?.full || character;
    if (!name) continue;
    const person = { name };
    if (character && character !== name) person.role = character;
    const image = actor?.image?.large || edge.node?.image?.large;
    if (image) person.image = image;
    out.push(person);
  }
  return out;
}

// AniList writes a staff role as free text: "Director", "Chief Director",
// "Series Composition (eps 1-12)", "Script, Storyboard". Only the two roles a
// client has a field for are picked out, and the role has to end where the
// name does, or "Director of Photography" directed the show. What may follow
// is what AniList appends: an episode range in brackets, or a second role.
const ROLE_END = String.raw`(\s*[(,]|$)`;
const DIRECTOR_ROLE = new RegExp(String.raw`^(chief\s+)?director${ROLE_END}`, "i");
const AUTHOR_ROLE = new RegExp(
  String.raw`^(original\s+(creator|story)|story|script|series\s+composition)${ROLE_END}`, "i");

function toStaff(staff, match) {
  const seen = new Set();
  const out = [];
  for (const edge of staff?.edges || []) {
    const name = edge.node?.name?.full;
    if (!name || !match.test(edge.role || "") || seen.has(name)) continue;
    seen.add(name);
    const person = { name, role: edge.role };
    const image = edge.node?.image?.large;
    if (image) person.image = image;
    out.push(person);
  }
  return out;
}

// AniList's tags are voted on, and the vote is what separates "Kaiju" on
// Attack on Titan from a tag three people clicked. Spoilers are left out: this
// is a description of the show, shown before anyone has watched it.
const TAG_RANK = 60;
const MAX_TAGS = 10;
const toTags = (tags) => (tags || [])
  .filter((t) => t.name && !t.isGeneralSpoiler && !t.isMediaSpoiler && (t.rank ?? 0) >= TAG_RANK)
  .slice(0, MAX_TAGS)
  .map((t) => t.name);

// What another anime IS to this one. Everything not listed is left out: an
// adaptation is the manga this came from, a character relation is a cameo, and
// neither is something a client can open.
const RELATIONS = {
  PREQUEL: "Vorgänger",
  SEQUEL: "Fortsetzung",
  SIDE_STORY: "Nebengeschichte",
  PARENT: "Hauptserie",
  SPIN_OFF: "Ableger",
  ALTERNATIVE: "Alternative",
  SUMMARY: "Zusammenfassung",
};

function relatedItems(relations) {
  const out = [];
  for (const edge of relations?.edges || []) {
    const label = RELATIONS[edge.relationType];
    if (!label || edge.node?.type !== "ANIME") continue;
    const item = toItem(edge.node);
    // Which one it is, on the tile: a row of six covers says nothing about
    // what came first.
    item.name = `${label}: ${item.name}`;
    out.push(item);
  }
  return out;
}

// A row on the detail page. Inline, with no cursor: everything there is came
// with the item, so there is no second page to ask for.
const row = (id, name, items, type) => (items.length ? [{ id, name, type, items }] : []);

// Where a title can be watched, as AniList's editors keep it. STREAMING only:
// the other kinds are the official website and a Twitter account, and neither
// is a place to watch anything. None of these play by themselves, a client
// opens them the way it opens any link it cannot resolve.
function sourceShape(data) {
  const sources = (data.Media?.externalLinks || [])
    .filter((link) => link.type === "STREAMING" && link.url)
    .map((link) => ({ url: link.url, name: link.site || "Stream", kind: "website" }));
  return { sources };
}

function itemShape(data) {
  const m = data.Media;
  if (!m) return null;

  const out = toItem(m);

  const cast = toCast(m.characters);
  if (cast.length) out.cast = cast;
  const directors = toStaff(m.staff, DIRECTOR_ROLE);
  if (directors.length) out.director = directors;
  const authors = toStaff(m.staff, AUTHOR_ROLE);
  if (authors.length) out.author = authors;
  const tags = toTags(m.tags);
  if (tags.length) out.tags = tags;
  // AniList holds a youtube id, and has held one with a tab character in it.
  if (m.trailer?.site === "youtube" && m.trailer.id?.trim()) {
    out.videos = [{ url: `https://www.youtube.com/watch?v=${m.trailer.id.trim()}`, name: "Trailer" }];
  }

  const recommendations = (m.recommendations?.nodes || [])
    .map((n) => n.mediaRecommendation)
    .filter((r) => r?.id && r.type === "ANIME")
    .map(toItem);
  const catalogs = [
    ...row(`related_${m.id}`, "Verwandt", relatedItems(m.relations), out.type),
    ...row(`recommendations_${m.id}`, "Ähnliche Anime", recommendations, out.type),
  ];
  if (catalogs.length) out.catalogs = catalogs;

  if (out.type === "video") return out;
  const children = toEpisodes(m);
  if (children.length) out.children = children;
  return out;
}

export async function get(pathname, query) {
  if (pathname === "/mhub-addon.json") return manifest();
  const [, resource, type, ...rest] = pathname.split("/");
  const segment = decodeURIComponent(rest.join("/")).replace(/\.json$/, "");
  if (!segment) return null;

  if (resource === "catalog") {
    if (segment !== "anime") return null;
    const built = catalogQuery(query);
    // A search is one person's question. The rows everybody sees are the
    // server's job, because one call answers them for all of us.
    if (built.useSearch) return askClient(`search:${built.page}`, built.query, built.vars);
    const data = await gql(built.query, built.vars);
    return catalogShape(data, built.page);
  }
  if (resource === "item") {
    if (type !== "video" && type !== "series") return null;
    const built = itemQuery(segment);
    return built && askClient("item", built.query, built.vars);
  }
  if (resource === "source") {
    if (type !== "video" && type !== "series") return null;
    const built = sourceQuery(segment);
    if (!built) return null;
    // The server asks for this one. A handful of links per title, the same for
    // everyone who asks, so one call a day answers all of them.
    const data = await gql(built.query, built.vars).catch(notFound);
    return data && sourceShape(data);
  }
  return null;
}

/**
 * The answer the client brought back. What the host does with it afterwards is
 * the host's business: it files it under the request that asked for it, so the
 * next caller is served from the cache and never fetches anything.
 */
export async function clientFetch(result) {
  if (result.status === 404) return null;
  checkStatus(result.status, result.headers?.["retry-after"]);
  const data = unpack(JSON.parse(result.body));
  const [what, page] = result.id.split(":");
  if (what === "item") return itemShape(data);
  if (what === "search") return catalogShape(data, Number(page) || 1);
  return null;
}

function manifest() {
  return {
    id: "anilist",
    name: "AniList",
    specVersion: 2,
    version: "2.0.0",
    description:
      "Anime-Katalog von AniList (kostenlos, ohne API-Key). Sortierung, Genre-/Jahr-/Format-Filter, Suche und Details. Filme und Serien.",
    icon: "https://anilist.co/img/icons/favicon-32x32.png",
    resources: ["catalog", "item", "source"],
    types: ["series", "video"],
    // Its own namespace and MyAnimeList's, which the v1 addon carried as the
    // triggers anilist_id and mal_id.
    idPrefixes: ["anilist", "mal"],
    catalogs: [{
      id: "anime",
      name: "Anime",
      // Films and series share one catalog, the way AniList's Media shares
      // one type. Declared as series because that is the bulk of anime.
      type: "series",
      options: { shape: "portrait", displayName: true },
      features: {
        search: true,
        sort: SORTS.map(({ id, name }) => ({ id, name })),
        filter: [
          { id: "genre", name: "Genre", multiselect: true, values: GENRES.map((g) => ({ id: g, name: g })) },
          { id: "year", name: "Jahr", multiselect: false, values: YEARS.map((y) => ({ id: y, name: y })) },
          { id: "format", name: "Format", multiselect: true, values: FORMATS.map((f) => ({ id: f.id, name: f.name })) },
        ],
      },
    }],
    // The v1 addon's home screen rows: one per sort, then the genre rows.
    dashboard: [
      { name: "Beliebt", catalog: "anime", sort: "popularity" },
      { name: "Trending", catalog: "anime", sort: "trending" },
      { name: "Top bewertet", catalog: "anime", sort: "score" },
      { name: "Neu", catalog: "anime", sort: "newest" },
      { name: "Action", catalog: "anime", sort: "popularity", filter: { genre: "Action" } },
      { name: "Abenteuer", catalog: "anime", sort: "popularity", filter: { genre: "Adventure" } },
      { name: "Fantasy", catalog: "anime", sort: "popularity", filter: { genre: "Fantasy" } },
      { name: "Romance", catalog: "anime", sort: "popularity", filter: { genre: "Romance" } },
    ],
    cache: { catalog: 21600, item: 86400, source: 86400 },
  };
}
