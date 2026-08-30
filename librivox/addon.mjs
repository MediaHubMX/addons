/**
 * LibriVox: free public-domain audiobooks read by volunteers, keyless API
 * (https://librivox.org/api/info). Ported from the v1 addon.
 *
 * A book is an `audio` item whose chapters (sections) are children, numbered
 * like series episodes. The mp3s live on archive.org and the book payload
 * (extended=1) inlines every section with its listen_url, so each child
 * carries its source already. The `source` resource stays for v1 clients:
 * their episodes cannot carry sources, so they ask for one per chapter, and
 * the bridge turns that into a request for `<book>:<season>:<section>`.
 */

const API = "https://librivox.org/api/feed/audiobooks";
const PAGE = 30;

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`librivox ${res.status} on ${url}`);
  return res.json();
}

// The list endpoint answers HTTP 404 when a query matches nothing (an author
// search with no hits, an empty genre), that is an empty result, not an error.
async function fetchList(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (res.status === 404) return { books: [] };
  if (!res.ok) throw new Error(`librivox ${res.status} on ${url}`);
  return res.json();
}

// Cover art: `coverart=1` makes the API return direct coverart_jpg links (many
// books have NO url_iarchive, so the iarchive-derived cover alone misses a lot).
const cover = (b) =>
  b.coverart_jpg ||
  (b.url_iarchive
    ? `https://archive.org/services/img/${b.url_iarchive.split("/").pop()}`
    : undefined);

// Book/section `language` is a display name ("English", "German"), map to real
// language codes for Source.language. Unknown names -> omit the field.
const LANG_CODES = {
  English: "en", German: "de", French: "fr", Spanish: "es", Italian: "it",
  Dutch: "nl", Portuguese: "pt", Russian: "ru", Japanese: "ja", Chinese: "zh",
  Polish: "pl", Swedish: "sv", Czech: "cs", Hungarian: "hu", Greek: "el",
};
const langCode = (name) => LANG_CODES[name];

const authorNames = (b) =>
  (b.authors || [])
    .map((a) => [a.first_name, a.last_name].filter(Boolean).join(" ").trim())
    .filter(Boolean)
    .join(", ");

const stripHtml = (s) =>
  s ? s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || undefined : undefined;

// A curated slice of LibriVox's genre taxonomy, their EXACT genre names (a wrong
// or slash-containing name makes the API 500, so these are verified working ones).
const GENRES = [
  "Science Fiction", "Fantastic Fiction", "Crime & Mystery Fiction",
  "Horror & Supernatural Fiction", "Action & Adventure Fiction",
  "Historical Fiction", "Romance", "Humor", "Children's Fiction",
  "Poetry", "Short Stories", "General Fiction",
  "Biography & Autobiography", "Travel & Geography", "Westerns", "Satire",
];

// No sort param exists and the default order is oldest-cataloged-first, so the
// plain row is the classics shelf: named honestly, as in v1.
const DASHBOARD = [
  { name: "Klassiker" },
  { name: "Science Fiction", genre: "Science Fiction" },
  { name: "Fantasy", genre: "Fantastic Fiction" },
  { name: "Krimi & Mystery", genre: "Crime & Mystery Fiction" },
  { name: "Abenteuer", genre: "Action & Adventure Fiction" },
  { name: "Horror", genre: "Horror & Supernatural Fiction" },
  { name: "Kinder", genre: "Children's Fiction" },
  { name: "Lyrik", genre: "Poetry" },
];

const listUrl = ({ genre, offset, titlePrefix, author }) => {
  const p = new URLSearchParams({
    format: "json",
    limit: String(PAGE),
    offset: String(offset || 0),
    coverart: "1",
  });
  if (genre) p.set("genre", genre);
  if (titlePrefix) p.set("title", `^${titlePrefix}`);
  if (author) p.set("author", author);
  return `${API}/?${p}`;
};

function toItem(b) {
  const item = {
    id: String(b.id),
    type: "audio",
    name: b.title || String(b.id),
    ids: { librivox: String(b.id) },
  };
  const description = [authorNames(b), stripHtml(b.description)].filter(Boolean).join(", ");
  if (description) item.description = description;
  const poster = cover(b);
  if (poster) item.images = { poster };
  const year = Number(b.copyright_year);
  if (year) item.year = year;
  return item;
}

async function catalog(catalogId, query) {
  if (catalogId !== "audiobooks") return null;
  const page = Number(query.get("cursor")) || 1;
  const offset = (page - 1) * PAGE;
  const genre = query.get("filter[genre]") || "";
  const search = query.get("search") || "";

  // `keywords`, the substring search v1 used, is silently ignored by the API
  // today (every query answers the default list). What still works: title
  // PREFIX (`title=^q`) and author last name (`author=q`). A search asks both
  // and merges, title hits first, a page can be short when the two overlap.
  if (search) {
    const [byTitle, byAuthor] = await Promise.all([
      fetchList(listUrl({ genre, offset, titlePrefix: search })),
      fetchList(listUrl({ genre, offset, author: search })),
    ]);
    const seen = new Set();
    const books = [...(byTitle.books || []), ...(byAuthor.books || [])]
      .filter((b) => b?.id != null && !seen.has(String(b.id)) && seen.add(String(b.id)));
    const full = (byTitle.books || []).length === PAGE || (byAuthor.books || []).length === PAGE;
    return { items: books.map(toItem), nextCursor: full ? String(page + 1) : null };
  }

  const data = await fetchList(listUrl({ genre, offset }));
  const books = Array.isArray(data.books) ? data.books : [];
  return {
    items: books.map(toItem),
    nextCursor: books.length === PAGE ? String(page + 1) : null,
  };
}

// A book with its chapters (sections), inlined by extended=1. Item and source
// both load this; the sections carry the listen_urls either way.
async function loadBook(id) {
  const data = await fetchJson(`${API}/?id=${encodeURIComponent(id)}&extended=1&coverart=1&format=json`);
  return Array.isArray(data.books) ? data.books[0] : undefined;
}

// Only sections with a listen_url surface, and their fallback number is the
// index in THAT list: children and source lookups number the same way.
const sectionsOf = (b) => (b.sections || []).filter((s) => s.listen_url);
const sectionNum = (s, i) => s.section_number || i + 1;

const sourceOf = (b, s, i) => {
  const source = { url: s.listen_url, name: "LibriVox (MP3)" };
  const language = langCode(s.language || b.language);
  if (language) source.languages = [language];
  return source;
};

const childOf = (b, s, i) => {
  const num = sectionNum(s, i);
  const child = {
    id: `${b.id}-${num}`,
    type: "audio",
    name: s.title || `Kapitel ${num}`,
    ids: { librivox: `${b.id}-${num}` },
    season: 1,
    episode: Number(num) || i + 1,
    sources: [sourceOf(b, s, i)],
  };
  const playtime = Number(s.playtime);
  if (playtime) child.runtime = playtime;
  const poster = cover(b);
  if (poster) child.images = { poster };
  return child;
};

// The id forms this addon is addressed by: the bare book id ("47"), a chapter
// ("47-5"), both under the namespace ("librivox:47-5"), and the bridge's
// episode form for v1 clients ("47:1:5" = book:season:section). Book ids and
// section numbers are numeric, so first and last segment say everything.
function parseId(segment) {
  let s = segment.replace(/\.json$/, "");
  if (s.startsWith("librivox:")) s = s.slice("librivox:".length);
  const parts = s.split(/[:-]/);
  return { bookId: parts[0], section: parts.length > 1 ? parts[parts.length - 1] : null };
}

async function item(id) {
  const { bookId, section } = parseId(id);
  if (!bookId) return null;
  const b = await loadBook(bookId);
  if (!b) return null;
  const out = toItem(b);
  const seconds = Number(b.totaltimesecs);
  if (seconds) out.runtime = seconds;
  const children = sectionsOf(b).map((s, i) => childOf(b, s, i));
  if (children.length) out.children = children;
  // A chapter addressed as an item answers with its own slice of the book.
  if (section != null) return children.find((c) => c.id === `${b.id}-${section}`) || null;
  return out;
}

async function sources(id) {
  const { bookId, section } = parseId(id);
  if (!bookId) return null;
  const b = await loadBook(bookId);
  if (!b) return null;
  const sections = sectionsOf(b);
  if (section != null) {
    const i = sections.findIndex((s, j) => String(sectionNum(s, j)) === section);
    return { sources: i < 0 ? [] : [sourceOf(b, sections[i], i)] };
  }
  // Asked for the book itself: every chapter, named, a source list of 128
  // identical "LibriVox (MP3)" entries would be useless.
  return {
    sources: sections.map((s, i) => ({
      ...sourceOf(b, s, i),
      name: s.title || `Kapitel ${sectionNum(s, i)}`,
    })),
  };
}

export async function get(pathname, query) {
  if (pathname === "/mhub-addon.json") return manifest();
  const [, resource, type, ...rest] = pathname.split("/");
  if (type !== "audio") return null;
  const segment = decodeURIComponent(rest.join("/"));
  if (!segment) return null;

  if (resource === "catalog") return catalog(segment.replace(/\.json$/, ""), query);
  if (resource === "item") return item(segment);
  if (resource === "source") return sources(segment);
  return null;
}

function manifest() {
  return {
    id: "librivox",
    name: "LibriVox",
    specVersion: 2,
    version: "2.0.0",
    description: "LibriVox, kostenlose, gemeinfreie Hörbücher, eingelesen von Freiwilligen. Ohne API-Key. Jedes Kapitel ist als Episode abspielbar (MP3).",
    icon: "https://librivox.org/favicon.ico",
    resources: ["catalog", "item", "source"],
    types: ["audio"],
    idPrefixes: ["librivox"],
    catalogs: [
      {
        id: "audiobooks",
        name: "LibriVox",
        type: "audio",
        options: { shape: "portrait", displayName: true },
        // No server-side sort or language filter exists (a `language` param is
        // silently ignored); what search means here is on the catalog handler.
        features: {
          search: true,
          filter: [{ id: "genre", name: "Genre", multiselect: false, values: GENRES.map((g) => ({ id: g, name: g })) }],
        },
      },
    ],
    dashboard: DASHBOARD.map((r) => ({
      name: r.name,
      catalog: "audiobooks",
      ...(r.genre ? { filter: { genre: r.genre } } : {}),
    })),
    cache: { catalog: 21600, item: 86400, source: 86400 },
  };
}
