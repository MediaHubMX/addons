/**
 * PeerTube. Ported from the v1 addon.
 *
 * PeerTube is federated, so there is no single upstream: discovery runs
 * through SepiaSearch, which indexes the public instances, while a video's
 * metadata and streams come from whichever instance hosts it. Neither side
 * needs a key. The hosting instance travels inside the item id (`host|uuid`),
 * because the pipe survives a URL path where a colon would not, which is how
 * the item and source handlers know where to ask.
 */

const SEPIA = "https://sepiasearch.org/api/v1/search/videos";
const COUNT = 24;

// PeerTube's fixed category taxonomy (numeric ids), named as the v1 addon
// named them.
const CATS = [
  { id: 15, title: "Wissenschaft & Technik" },
  { id: 13, title: "Bildung" },
  { id: 1, title: "Musik" },
  { id: 2, title: "Filme" },
  { id: 7, title: "Gaming" },
  { id: 9, title: "Comedy" },
  { id: 10, title: "Unterhaltung" },
  { id: 11, title: "News & Politik" },
  { id: 5, title: "Sport" },
  { id: 4, title: "Kunst" },
  { id: 17, title: "Kinder" },
  { id: 18, title: "Essen" },
];
const CAT_IDS = new Set(CATS.map((c) => String(c.id)));

const SORTS = [
  { id: "views", name: "Beliebt", param: "-views" },
  { id: "recent", name: "Neu", param: "-publishedAt" },
  { id: "likes", name: "Meiste Likes", param: "-likes" },
];
const SORT_PARAM = Object.fromEntries(SORTS.map((s) => [s.id, s.param]));

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`peertube ${res.status} on ${url}`);
  return res.json();
}

// A search hit names its hosting instance on the account or channel.
const hostOf = (v) =>
  v.account?.host || v.channel?.host || (v.url ? new URL(v.url).hostname : null);

function toItem(v) {
  const host = hostOf(v);
  if (!host || !v.uuid) return null;
  const id = `${host}|${v.uuid}`;
  const item = { id, type: "video", name: v.name || id, ids: { peertube: id } };
  const description = v.truncatedDescription || v.description;
  if (description) item.description = description;
  if (v.thumbnailUrl) item.images = { poster: v.thumbnailUrl };
  if (v.publishedAt) {
    const year = Number(String(v.publishedAt).slice(0, 4));
    if (year) item.year = year;
  }
  // v2 runtime is seconds; the bridge turns it into v1's milliseconds.
  if (v.duration) item.runtime = v.duration;
  return item;
}

async function catalog(catalogId, query) {
  if (catalogId !== "videos") return { items: [], nextCursor: null };
  const page = Number(query.get("cursor")) || 1;
  const search = query.get("search") || "";
  const category = (query.get("filter[kategorie]") || "").split(",")[0];
  // SepiaSearch ranks by "-match" once a query is involved, views otherwise.
  const sort = SORT_PARAM[query.get("sort")] || (search ? "-match" : "-views");

  const p = new URLSearchParams({
    count: String(COUNT),
    start: String((page - 1) * COUNT),
    sort,
    nsfw: "false",
  });
  if (search) p.set("search", search);
  if (category && CAT_IDS.has(category)) p.set("categoryOneOf", category);

  const data = await fetchJson(`${SEPIA}?${p}`);
  const items = (data.data || []).map(toItem).filter(Boolean);
  const start = (page - 1) * COUNT;
  return {
    items,
    nextCursor: start + COUNT < (data.total || 0) ? String(page + 1) : null,
  };
}

// A video's own instance answers with everything, metadata and files in one
// payload. Instances come and go (that is federation), so a dead one is a
// 404 here, not a hanging request.
async function detail(id) {
  const i = id.indexOf("|");
  const host = id.slice(0, i);
  const uuid = id.slice(i + 1);
  if (!host || !uuid) return null;
  try {
    return await fetchJson(`https://${host}/api/v1/videos/${encodeURIComponent(uuid)}`);
  } catch {
    return null;
  }
}

// HLS first, then the progressive MP4s highest resolution first, v1's order.
function sourcesOf(d) {
  const sources = [];
  const hls = (d.streamingPlaylists || [])[0];
  if (hls?.playlistUrl) sources.push({ url: hls.playlistUrl, name: "HLS (adaptiv)" });
  for (const f of (d.files || [])
    .filter((f) => f.fileUrl)
    .sort((a, b) => (b.resolution?.id || 0) - (a.resolution?.id || 0))) {
    sources.push({ url: f.fileUrl, name: f.resolution?.label || "MP4" });
  }
  return sources;
}

async function item(id) {
  const d = await detail(id);
  if (!d) return null;
  const host = id.slice(0, id.indexOf("|"));
  const out = { id, type: "video", name: d.name || id, ids: { peertube: id } };
  if (d.description) out.description = d.description;
  if (d.thumbnailPath) out.images = { poster: `https://${host}${d.thumbnailPath}` };
  if (d.publishedAt) out.releaseDate = d.publishedAt.slice(0, 10);
  if (d.duration) out.runtime = d.duration;
  // The streams sit in the same payload as the metadata, so they are on the
  // item already; the source resource stays for the clients that ask.
  const sources = sourcesOf(d);
  if (sources.length) out.sources = sources;
  return out;
}

async function sources(id) {
  const d = await detail(id);
  return { sources: d ? sourcesOf(d) : [] };
}

const valueOf = (segment) => {
  const raw = segment.replace(/\.json$/, "");
  return raw.startsWith("peertube:") ? raw.slice("peertube:".length) : raw;
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

function manifest() {
  return {
    id: "peertube",
    name: "PeerTube",
    specVersion: 2,
    version: "2.0.0",
    description:
      "PeerTube: das freie, föderierte Video-Netzwerk. Durchsuche und entdecke Videos aus tausenden Instanzen (via SepiaSearch). Kostenlos, ohne API-Key.",
    icon: "https://joinpeertube.org/img/icons/apple-touch-icon.png",
    resources: ["catalog", "item", "source"],
    types: ["video"],
    idPrefixes: ["peertube"],
    catalogs: [{
      id: "videos",
      name: "PeerTube",
      type: "video",
      options: { shape: "landscape", displayName: true },
      features: {
        search: true,
        sort: SORTS.map((s) => ({ id: s.id, name: s.name })),
        filter: [{
          id: "kategorie",
          name: "Kategorie",
          multiselect: false,
          values: CATS.map((c) => ({ id: String(c.id), name: c.title })),
        }],
      },
    }],
    // The v1 addon's pages: the two sort rows, then the first eight categories.
    dashboard: [
      { name: "Beliebt", catalog: "videos", sort: "views" },
      { name: "Neu", catalog: "videos", sort: "recent" },
      ...CATS.slice(0, 8).map((c) => ({
        name: c.title,
        catalog: "videos",
        sort: "views",
        filter: { kategorie: String(c.id) },
      })),
    ],
    cache: { catalog: 1800, item: 86400, source: 3600 },
  };
}
