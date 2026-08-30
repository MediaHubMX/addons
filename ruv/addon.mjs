/**
 * RÚV (Iceland). Ported from the v1 addon.
 *
 * One upstream: RÚV's open GraphQL API ("spilari"), keyless, what ruv.is
 * itself uses. The category list doubles as the catalog index, and one
 * program query answers a series with its episodes, each episode carrying
 * its HLS file already. Metadata works from anywhere; "open" streams play
 * worldwide, "locked" ones are geo-restricted to Iceland.
 *
 * A series is addressed by its numeric program id, an episode by
 * "<program>-<episode>" (program ids are numeric, so the first dash splits
 * them). Neither carries a colon, so an episode play request arriving as
 * "<program>:<season>:<episode>" can be told apart from both.
 */

const GQL = "https://spilari.nyr.ruv.is/gql/";
const PAGE = 40;

// The gateway flakes on 5xx often enough that v1 retried it; kept.
const gql = async (query, variables, tries = 2) => {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(GQL, {
        method: "POST",
        headers: { "content-type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ query, variables }),
      });
      if (res.status >= 500) { lastErr = new Error(`ruv graphql ${res.status}`); continue; }
      if (!res.ok) throw new Error(`ruv graphql ${res.status}`);
      const j = await res.json();
      if (j.errors) throw new Error(j.errors[0]?.message || "ruv graphql error");
      return j.data;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
};

// The categories are RÚV's own genre list, fetched once in a while rather
// than written down here.
const CATS_TTL_MS = 6 * 3600 * 1000;
let cats = [];
let catsAt = 0;

async function categories() {
  if (cats.length && Date.now() - catsAt < CATS_TTL_MS) return cats;
  const d = await gql(`{ Category(station: tv) { categories { title slug } } }`, {});
  cats = (d.Category?.categories || []).filter((c) => c.slug && c.title);
  catsAt = Date.now();
  return cats;
}

const CATEGORY_PROGRAMS = `{ Category(station: tv) { categories { slug programs { id title image short_description } } } }`;
const SEARCH_QUERY = `query ($t: String!) { Search(type: tv, text: $t) { id title slug image description } }`;
const PROGRAM_QUERY = `query ($id: Int!) { Program(id: $id) { id title image short_description episodes { id title file image duration } } }`;

// A GraphQL program -> a catalog item. id = its numeric program id.
function toItem(p) {
  if (!p?.id) return null;
  const id = String(p.id);
  const item = { id, type: "series", name: p.title || id, ids: { ruv: id } };
  // Search selects "description", everything else "short_description", v1
  // read only the latter either way, so a search hit carries none. Kept.
  if (p.short_description) item.description = p.short_description;
  if (p.image) item.images = { poster: p.image };
  return item;
}

async function catalog(catalogId, query) {
  if (catalogId !== "tv") return { items: [], nextCursor: null };
  const page = Number(query.get("cursor")) || 1;
  const slug = query.get("filter[flokkur]") || "";
  const search = query.get("search") || "";

  let programs;
  if (search) {
    const d = await gql(SEARCH_QUERY, { t: search });
    programs = d.Search || [];
  } else {
    const list = await categories().catch(() => []);
    const want = list.some((c) => c.slug === slug) ? slug : list[0]?.slug;
    if (!want) return { items: [], nextCursor: null };
    const d = await gql(CATEGORY_PROGRAMS, {});
    programs = (d.Category?.categories || []).find((c) => c.slug === want)?.programs || [];
  }

  const seen = new Set();
  const all = programs
    .map(toItem)
    .filter((it) => it && !seen.has(it.id) && seen.add(it.id));

  const start = (page - 1) * PAGE;
  return {
    items: all.slice(start, start + PAGE),
    nextCursor: start + PAGE < all.length ? String(page + 1) : null,
  };
}

// A program's episodes, in the API's order. RÚV has no seasons upstream, so
// everything is season 1: how v1 numbered them too. The episode's HLS file
// sits in the same payload, so the source rides on the child and the client
// does not have to ask again.
function childrenOf(p) {
  const pid = String(p.id);
  return (p.episodes || []).filter((e) => e?.id).map((e, i) => {
    const id = `${pid}-${e.id}`;
    const child = {
      id,
      type: "video",
      name: e.title || id,
      ids: { ruv: id },
      season: 1,
      episode: i + 1,
    };
    if (e.image) child.images = { poster: e.image };
    // Upstream answers seconds; v1 handed out milliseconds.
    if (e.duration) child.runtime = e.duration;
    if (e.file) child.sources = [{ url: e.file, name: "RÚV (HLS)", languages: ["is"] }];
    return child;
  });
}

async function item(id) {
  const d = await gql(PROGRAM_QUERY, { id: Number(id) });
  const p = d.Program;
  if (!p) return null;
  const pid = String(p.id);
  const out = { id: pid, type: "series", name: p.title || pid, ids: { ruv: pid } };
  if (p.short_description) out.description = p.short_description;
  if (p.image) out.images = { poster: p.image };
  const children = childrenOf(p);
  if (children.length) out.children = children;
  return out;
}

async function sources(id) {
  // A play request for an episode arrives from a v1 client as
  // "<program>:<season>:<episode>", the series id with the position
  // appended. Neither upstream id carries a colon, so the suffix is
  // unambiguous.
  const positional = /^(.*):(\d+):(\d+)$/.exec(id);
  const dash = id.indexOf("-");
  let programId;
  let episodeId = null;
  if (positional) {
    programId = positional[1];
  } else if (dash > 0) {
    programId = id.slice(0, dash);
    episodeId = id.slice(dash + 1);
  } else {
    return { sources: [] };
  }

  const d = await gql(PROGRAM_QUERY, { id: Number(programId) });
  const children = childrenOf(d.Program || {});
  const child = positional
    ? children.find((c) => c.season === Number(positional[2]) && c.episode === Number(positional[3]))
    : children.find((c) => c.id === `${programId}-${episodeId}`);
  const source = child?.sources?.[0];
  return { sources: source ? [source] : [] };
}

const valueOf = (segment) => {
  const raw = segment.replace(/\.json$/, "");
  return raw.startsWith("ruv:") ? raw.slice(4) : raw;
};

export async function get(pathname, query) {
  if (pathname === "/mhub-addon.json") return manifest();
  const [, resource, type, ...rest] = pathname.split("/");
  const segment = decodeURIComponent(rest.join("/"));
  if (!segment) return null;

  if (resource === "catalog") return catalog(segment.replace(/\.json$/, ""), query);

  const id = valueOf(segment);
  if (resource === "item") return item(id);
  if (resource === "source") return sources(id);
  return null;
}

async function manifest() {
  const list = await categories().catch(() => []);
  return {
    id: "ruv",
    name: "RÚV",
    specVersion: 2,
    version: "2.0.0",
    description: "RÚV (Isländischer Rundfunk): Serien, Filme, Dokus und Kinderprogramme. Kostenlos, ohne API-Key. „Offene“ Streams laufen weltweit, andere sind auf Island geo-beschränkt.",
    icon: "https://www.ruv.is/apple-touch-icon.png",
    resources: ["catalog", "item", "source"],
    types: ["series"],
    idPrefixes: ["ruv"],
    catalogs: [{
      id: "tv",
      name: "RÚV",
      type: "series",
      options: { shape: "landscape", displayName: true },
      features: {
        search: true,
        ...(list.length
          ? { filter: [{ id: "flokkur", name: "Kategorie", multiselect: false, values: list.map((c) => ({ id: c.slug, name: c.title })) }] }
          : {}),
      },
    }],
    dashboard: list.slice(0, 12).map((c) => ({
      name: `RÚV: ${c.title}`,
      catalog: "tv",
      filter: { flokkur: c.slug },
    })),
    // v1 cached searches for 30 minutes, categories for an hour.
    cache: { catalog: 3600, item: 86400, source: 3600 },
  };
}
