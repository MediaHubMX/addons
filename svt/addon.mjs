/**
 * SVT Play (Sweden). Ported from the v1 addon.
 *
 * Two upstreams, both keyless and both what svtplay.se uses: the open GraphQL
 * API answers categories, search and a title's page; the REST video endpoint
 * answers one video's streams. Metadata works from anywhere, the streams are
 * geo-restricted to Sweden.
 *
 * A series is addressed by its svtplay path ("/svartan"), an episode by its
 * videoSvtId. Neither carries a colon, so an episode play request that
 * arrives as "<path>:<season>:<episode>" can be told apart from both.
 */

const GQL = "https://api.svt.se/contento/graphql";
const VIDEO = "https://api.svt.se/video";
const PAGE = 40;
// SVT rejects requests without a browser-like User-Agent (HTTP 403).
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

const img = (id) => (id ? `https://www.svtstatic.se/image/wide/992/${id}` : undefined);

const gql = async (query, variables) => {
  const res = await fetch(GQL, {
    method: "POST",
    headers: { "content-type": "application/json", Accept: "application/json", "User-Agent": UA },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`svt graphql ${res.status}`);
  const j = await res.json();
  if (j.errors) throw new Error(j.errors[0]?.message || "svt graphql error");
  return j.data;
};

const fetchJson = async (url) => {
  const res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": UA } });
  if (!res.ok) throw new Error(`svt ${res.status} on ${url}`);
  return res.json();
};

// The categories are SVT's genre list, fetched once in a while rather than
// written down here: SVT adds and drops rows (elections, championships).
const GENRES_TTL_MS = 6 * 3600 * 1000;
let genres = [];
let genresAt = 0;

async function categories() {
  if (genres.length && Date.now() - genresAt < GENRES_TTL_MS) return genres;
  const d = await gql(`{ genresInMain { genres { id name } } }`, {});
  genres = (d.genresInMain?.genres || []).filter((g) => g.id && g.name);
  genresAt = Date.now();
  return genres;
}

const ITEM_FIELDS = `name videoSvtId slug urls { svtplay } image { id } __typename`;

const CATEGORY_QUERY = `query ($id: String!) {
  categoryPage(id: $id) {
    modules {
      selection { itemsPaginated(pagination: { limit: 50, offset: 0 }) {
        items { item { ${ITEM_FIELDS} } } } } }
  }
}`;

const SEARCH_QUERY = `query ($q: String!) {
  searchPage(query: $q) { flat { hits { teaser { item { ${ITEM_FIELDS} } } } } }
}`;

const DETAILS_QUERY = `query ($path: String!) {
  detailsPageByPath(path: $path) {
    heading description
    item { name svtId videoSvtId __typename }
    modules {
      selection { name items { item { name videoSvtId urls { svtplay } image { id } __typename } } }
    }
  }
}`;

// A GraphQL "item" (Listable) -> a catalog item. id = its svtplay detail path.
function toItem(it) {
  const path = it?.urls?.svtplay;
  if (!path) return null;
  const item = { id: path, type: "series", name: it.name || path, ids: { svt: path } };
  const poster = img(it.image?.id);
  if (poster) item.images = { poster };
  return item;
}

async function catalog(catalogId, query) {
  if (catalogId !== "play") return { items: [], nextCursor: null };
  const page = Number(query.get("cursor")) || 1;
  const genre = query.get("filter[genre]") || "";
  const search = query.get("search") || "";

  let listables;
  if (search) {
    const d = await gql(SEARCH_QUERY, { q: search });
    listables = (d.searchPage?.flat?.hits || [])
      .map((h) => h.teaser?.item)
      .filter(Boolean);
  } else {
    const cats = await categories().catch(() => []);
    const cat = cats.some((c) => c.id === genre) ? genre : cats[0]?.id;
    if (!cat) return { items: [], nextCursor: null };
    const d = await gql(CATEGORY_QUERY, { id: cat });
    listables = (d.categoryPage?.modules || []).flatMap(
      (m) => m.selection?.itemsPaginated?.items?.map((x) => x.item) || [],
    );
  }

  const seen = new Set();
  const all = listables
    .map(toItem)
    .filter((it) => it && !seen.has(it.id) && seen.add(it.id));

  const start = (page - 1) * PAGE;
  return {
    items: all.slice(start, start + PAGE),
    nextCursor: start + PAGE < all.length ? String(page + 1) : null,
  };
}

// A title's playable items, in order, across the content modules of its page.
// Recommendation shelves and anything without a video id are skipped.
function childrenOf(dp) {
  const seen = new Set();
  const children = [];
  // Episode numbers count per SEASON, not per module: several modules (e.g.
  // "Avsnitt" and a clip shelf) fall back to season 1, and a module-local
  // index would hand them the same season-episode slot, the client keys
  // episodes by that pair and would drop all but one.
  const seq = new Map();
  for (const m of dp.modules || []) {
    const sel = m.selection || {};
    if (/upptäck|liknande|rekommen|mer\b/i.test(sel.name || "")) continue;
    const seasonName = (/säsong\s*(\d+)/i.exec(sel.name || "") || [])[1];
    const season = seasonName ? Number(seasonName) : 1;
    for (const x of sel.items || []) {
      const it = x.item;
      if (!it?.videoSvtId || seen.has(it.videoSvtId)) continue;
      seen.add(it.videoSvtId);
      const episode = (seq.get(season) || 0) + 1;
      seq.set(season, episode);
      const child = {
        id: it.videoSvtId,
        type: "video",
        name: it.name || it.videoSvtId,
        ids: { svt: it.videoSvtId },
        season,
        episode,
      };
      const poster = img(it.image?.id);
      if (poster) child.images = { poster };
      children.push(child);
    }
  }

  // A single video (movie/clip) with no episode modules: synthesize one
  // episode from the title's own video id so it stays playable.
  if (!children.length && dp.item?.videoSvtId) {
    children.push({
      id: dp.item.videoSvtId,
      type: "video",
      name: dp.heading || dp.item.name || dp.item.videoSvtId,
      ids: { svt: dp.item.videoSvtId },
      season: 1,
      episode: 1,
    });
  }
  return children;
}

async function item(path) {
  const d = await gql(DETAILS_QUERY, { path });
  const dp = d.detailsPageByPath;
  if (!dp) return null;

  const out = {
    id: path,
    type: "series",
    name: dp.heading || dp.item?.name || path,
    ids: { svt: path },
  };
  if (dp.description) out.description = dp.description;
  const children = childrenOf(dp);
  if (children.length) out.children = children;
  return out;
}

function streamsOf(data) {
  const hls = (data.videoReferences || []).filter((r) => r.url && /hls/i.test(r.format || ""));
  // Prefer the full adaptive CMAF/HLS stream.
  hls.sort((a, b) => (/full/i.test(b.format) ? 1 : 0) - (/full/i.test(a.format) ? 1 : 0));
  return hls.map((r) => ({ url: r.url, name: `SVT (${r.format})`, languages: ["sv"] }));
}

async function sources(id) {
  // A play request for an episode of a series arrives as
  // "<path>:<season>:<episode>", the series id with the position appended.
  // Neither a path nor a videoSvtId carries a colon, so the suffix is
  // unambiguous.
  const ep = /^(.*):(\d+):(\d+)$/.exec(id);
  if (ep) {
    const d = await gql(DETAILS_QUERY, { path: ep[1] });
    const child = childrenOf(d.detailsPageByPath || {})
      .find((c) => c.season === Number(ep[2]) && c.episode === Number(ep[3]));
    if (!child) return { sources: [] };
    id = child.id;
  }
  if (!id) return { sources: [] };
  const data = await fetchJson(`${VIDEO}/${encodeURIComponent(id)}`);
  return { sources: streamsOf(data) };
}

const valueOf = (segment) => {
  const raw = segment.replace(/\.json$/, "");
  return raw.startsWith("svt:") ? raw.slice(4) : raw;
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
  const cats = await categories().catch(() => []);
  return {
    id: "svt",
    name: "SVT Play",
    specVersion: 2,
    version: "2.0.0",
    description: "SVT Play (Schweden): Serien, Filme, Dokus, Nachrichten und Kinderprogramme des öffentlich-rechtlichen Senders. Kostenlos, ohne API-Key. Streams sind auf Schweden geo-beschränkt.",
    icon: "https://www.svtplay.se/apple-touch-icon.png",
    resources: ["catalog", "item", "source"],
    types: ["series"],
    idPrefixes: ["svt"],
    catalogs: [{
      id: "play",
      name: "SVT Play",
      type: "series",
      options: { shape: "landscape", displayName: true },
      features: {
        search: true,
        ...(cats.length
          ? { filter: [{ id: "genre", name: "Kategorie", multiselect: false, values: cats.map((c) => ({ id: c.id, name: c.name })) }] }
          : {}),
      },
    }],
    dashboard: cats.slice(0, 12).map((c) => ({
      name: `SVT: ${c.name}`,
      catalog: "play",
      filter: { genre: c.id },
    })),
    // v1 cached searches for 30 minutes, categories for an hour.
    cache: { catalog: 3600, item: 86400, source: 3600 },
  };
}
