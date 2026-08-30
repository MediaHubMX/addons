/**
 * Internet Archive: public domain films, keyless. Ported from the v1 addon.
 *
 * One collection per catalog. The two lists that matter are kept verbatim from
 * v1 and are not cosmetic: PLAYABLE keeps items whose video files are gone out
 * of the rows, and EXCLUDE holds back titles that must never surface (upstream
 * vandalized metadata, indefensible titles, pirated rips).
 */

const UA = "MediaHubMX-InternetArchive/1.0";
const PAGE_SIZE = 60;

const COLLECTIONS = [
  { id: "feature_films", name: "Feature Films", query: "collection:feature_films" },
  { id: "film_noir", name: "Film Noir", query: "collection:Film_Noir" },
  { id: "scifi_horror", name: "Sci-Fi / Horror", query: "collection:SciFi_Horror" },
  { id: "silent_films", name: "Silent Films", query: "collection:silent_films" },
  { id: "classic_cartoons", name: "Classic Cartoons", query: "collection:classic_cartoons" },
  { id: "prelinger", name: "Prelinger Archive", query: "collection:prelinger" },
  // classic_tv was dropped (2026-08): the collection's top rows are commercial,
  // non-public-domain series uploads: pirated content we must not serve.
];
const BY_ID = Object.fromEntries(COLLECTIONS.map((c) => [c.id, c]));

// Only list items that actually have a playable derivative (same formats as
// sourcesOf), items whose video files were removed otherwise surface as
// "no sources found" right in the top rows.
const PLAYABLE =
  '(format:("h.264") OR format:("MPEG4") OR format:("512Kb MPEG4") OR format:("Ogg Video") OR format:("WebM"))';

// Identifiers that must not surface in the rows: upstream-vandalized
// metadata, and rips of films that are not public domain despite sitting in a
// public-domain collection. Which ones is a deployment decision, so it is
// configured, not compiled in: IA_EXCLUDE_IDS, comma separated.
const EXCLUDE = (process.env.IA_EXCLUDE_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
const EXCLUDE_Q = EXCLUDE.map((id) => ` AND -identifier:("${id}")`).join("");

const SORTS = [
  { id: "downloads", name: "Beliebt", sort: "downloads desc" },
  { id: "date", name: "Neu", sort: "date desc" },
  { id: "title", name: "Titel A–Z", sort: "titleSorter asc" },
];
const SORT_MAP = Object.fromEntries(SORTS.map((s) => [s.id, s.sort]));

// Decades, not single years: 127 year values are unusable on a TV remote, and
// these collections are classic films anyway.
const DECADES = [
  { id: "all", name: "Alle" },
  ...Array.from({ length: 13 }, (_, i) => {
    const d = 2020 - i * 10;
    return { id: `${d}-${d + 9}`, name: `${d}er` };
  }),
];

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`archive.org ${res.status} on ${url}`);
  return res.json();
}

const poster = (id) => `https://archive.org/services/img/${id}`;
// advancedsearch sometimes returns multi-valued fields (title) as arrays.
const one = (v) => (Array.isArray(v) ? v[0] : v);

// Descriptions are user-edited HTML (links, <br>, entities), render as text.
const stripHtml = (v) => v == null ? undefined : String(v)
  .replace(/<br\s*\/?>/gi, "\n")
  .replace(/<[^>]+>/g, "")
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, " ")
  .trim();

function toItem(doc) {
  const item = {
    id: doc.identifier,
    type: "video",
    name: one(doc.title) || doc.identifier,
    ids: { ia: doc.identifier },
    images: { poster: poster(doc.identifier) },
  };
  const description = stripHtml(one(doc.description));
  if (description) item.description = description;
  const year = Number(doc.year);
  if (year) item.year = year;
  return item;
}

async function search(query, page, sort) {
  const url = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(query)}`
    + `&fl[]=identifier&fl[]=title&fl[]=year&fl[]=description`
    + `&sort[]=${encodeURIComponent(sort)}&rows=${PAGE_SIZE}&page=${page}&output=json`;
  const data = await fetchJson(url);
  const docs = data.response?.docs || [];
  return {
    items: docs.map(toItem),
    nextCursor: page * PAGE_SIZE < (data.response?.numFound || 0) ? String(page + 1) : null,
  };
}

// Playable video files, mp4 first (same formats as PLAYABLE).
function videoFiles(files) {
  const rank = (f) => (/mp4/i.test(f.name) ? 0 : /webm/i.test(f.name) ? 1 : 2);
  return (files || [])
    .filter((f) => /^(h\.264|mpeg4|512kb mpeg4|ogg video|webm)/i.test(f.format || "")
      || /\.(mp4|webm|ogv)$/i.test(f.name || ""))
    .sort((a, b) => rank(a) - rank(b));
}

const sourcesOf = (id, videos) => videos.map((f) => ({
  url: `https://archive.org/download/${id}/${encodeURIComponent(f.name)}`,
  name: f.format || f.name,
}));

// Items carry .asr.srt captions; `language` is a display name and often
// missing. These collections are English, which is the honest fallback.
const SUB_LANGS = {
  english: "en", eng: "en", german: "de", fre: "fr", french: "fr",
  spanish: "es", italian: "it", portuguese: "pt", russian: "ru",
};

async function metadata(id) {
  const meta = await fetchJson(`https://archive.org/metadata/${encodeURIComponent(id)}`);
  return meta?.metadata ? meta : null;
}

async function item(id) {
  const meta = await metadata(id);
  if (!meta) return null;
  const md = meta.metadata || {};
  const videos = videoFiles(meta.files);

  const out = {
    id,
    type: "video",
    name: one(md.title) || id,
    ids: { ia: id },
    images: { poster: poster(id) },
  };
  const description = stripHtml(one(md.description));
  if (description) out.description = description;
  const year = Number(md.year);
  if (year) out.year = year;
  const seconds = Number(videos[0]?.length);
  if (seconds > 0) out.runtime = Math.round(seconds);
  // The files are known here, so the client does not have to ask again.
  const sources = sourcesOf(id, videos);
  if (sources.length) out.sources = sources;
  return out;
}

async function subtitles(id) {
  const meta = await metadata(id);
  if (!meta) return { subtitles: [] };
  const language = SUB_LANGS[String(one(meta.metadata?.language) || "").toLowerCase()] || "en";
  const base = `https://archive.org/download/${encodeURIComponent(id)}`;
  return {
    subtitles: (meta.files || [])
      .filter((f) => /\.srt$/i.test(f.name || ""))
      .map((f) => ({ url: `${base}/${encodeURIComponent(f.name)}`, language, format: "srt" })),
  };
}

const idOf = (segment) => segment.replace(/\.json$/, "").replace(/^ia:/, "");

async function catalog(catalogId, query) {
  const page = Number(query.get("cursor")) || 1;
  const sort = SORT_MAP[query.get("sort")] || "downloads desc";
  const search_ = query.get("search") || "";
  const decade = query.get("filter[year]") || "";
  const [from, to] = decade && decade !== "all" ? decade.split("-") : [];
  const years = from ? ` AND year:[${from} TO ${to}]` : "";
  const collection = BY_ID[catalogId];

  if (search_) {
    // Search stays INSIDE the row's collection: unscoped, every row showed the
    // identical result set. And it keeps the exclusions, which is what holds
    // back the titles the rows hold back.
    return search(
      `(${search_}) AND mediatype:movies AND ${PLAYABLE}`
      + `${collection ? ` AND ${collection.query}` : ""}${EXCLUDE_Q}${years}`,
      page, sort);
  }
  if (!collection) return null;
  return search(`${collection.query} AND mediatype:movies AND ${PLAYABLE}${EXCLUDE_Q}${years}`, page, sort);
}

export async function get(pathname, query) {
  if (pathname === "/mhub-addon.json") return manifest();
  const [, resource, type, ...rest] = pathname.split("/");
  if (type !== "video") return null;
  const segment = decodeURIComponent(rest.join("/"));

  if (resource === "catalog") return catalog(segment.replace(/\.json$/, ""), query);
  const id = idOf(segment);
  if (!id) return null;
  if (resource === "item") return item(id);
  if (resource === "subtitle") return subtitles(id);
  if (resource === "source") {
    const found = await item(id);
    return { sources: found?.sources || [] };
  }
  return null;
}

function manifest() {
  return {
    id: "internet-archive",
    name: "Internet Archive",
    specVersion: 2,
    version: "2.0.0",
    description: "Public-Domain-Filme und Videos aus dem Internet Archive (archive.org), kostenlos, ohne API-Key. Klassiker, Film Noir, Sci-Fi, Stummfilme u.v.m.",
    icon: "https://archive.org/images/glogo.jpg",
    resources: ["catalog", "item", "source", "subtitle"],
    types: ["video"],
    idPrefixes: ["ia"],
    catalogs: COLLECTIONS.map((c) => ({
      id: c.id,
      name: c.name,
      type: "video",
      options: { shape: "landscape", displayName: true },
      features: {
        search: true,
        sort: SORTS.map((s) => ({ id: s.id, name: s.name })),
        filter: [{ id: "year", name: "Jahrzehnt", multiselect: false, values: DECADES }],
      },
    })),
    cache: { catalog: 21600, item: 86400, source: 86400, subtitle: 86400 },
  };
}
