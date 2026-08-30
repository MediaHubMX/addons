/**
 * NRK TV (Norway). Ported from the v1 addon.
 *
 * One upstream: NRK's open "psapi", keyless. The TV frontpage list is the
 * categories, a page's plugs are the catalog, and a series or a playback
 * manifest is one request each. Metadata works from anywhere; playback is
 * geo-restricted to Norway.
 *
 * A series is addressed by its slug, an episode by its program prfId. Neither
 * carries a colon, so an episode play request arriving as
 * "<slug>:<season>:<episode>" can be told apart from both.
 */

const PSAPI = "https://psapi.nrk.no";
const PAGE = 40;

const fetchJson = async (url) => {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`nrk ${res.status} on ${url}`);
  return res.json();
};

// Pick a reasonably-sized image (~960px wide) from NRK's webImages array.
const img = (webImages) => {
  if (!webImages?.length) return undefined;
  const sorted = [...webImages].sort((a, b) => (a.width || 0) - (b.width || 0));
  return (sorted.find((w) => (w.width || 0) >= 800) || sorted[sorted.length - 1]).uri;
};

// The categories are the TV frontpage list (Serier, Film, Barn, Humor, …),
// fetched once in a while rather than written down here.
const PAGES_TTL_MS = 6 * 3600 * 1000;
let pages = [];
let pagesAt = 0;

async function categories() {
  if (pages.length && Date.now() - pagesAt < PAGES_TTL_MS) return pages;
  const j = await fetchJson(`${PSAPI}/tv/pages`);
  pages = (j.pageListItems || []).filter((p) => p.id && p.title)
    .map((p) => ({ id: p.id, name: p.title }));
  pagesAt = Date.now();
  return pages;
}

// A homepage plug that targets a series -> a catalog item (id = series slug).
function toItem(plug) {
  const slug = plug.series?.seriesId;
  if (!slug) return null;
  const c = plug.displayContractContent || {};
  const item = {
    id: slug,
    type: "series",
    name: c.contentTitle || slug,
    ids: { nrk: slug },
  };
  if (c.description) item.description = c.description;
  const poster = img(c.displayContractImage?.webImages);
  if (poster) item.images = { poster };
  return item;
}

async function catalog(catalogId, query) {
  if (catalogId !== "tv") return { items: [], nextCursor: null };
  const page = Number(query.get("cursor")) || 1;
  const catId = query.get("filter[kategori]") || "";
  const search = query.get("search") || "";

  if (search) {
    const j = await fetchJson(`${PSAPI}/autocomplete?q=${encodeURIComponent(search)}`);
    // autocomplete returns a single ranked list, no pagination.
    return {
      items: (j.result || [])
        .filter((r) => r.type === "serie" && r._source?.id)
        .map((r) => ({
          id: r._source.id,
          type: "series",
          name: r._source.title || r._source.id,
          ids: { nrk: r._source.id },
        })),
      nextCursor: null,
    };
  }

  const cats = await categories().catch(() => []);
  const cat = cats.some((c) => c.id === catId) ? catId : cats[0]?.id;
  if (!cat) return { items: [], nextCursor: null };
  const j = await fetchJson(`${PSAPI}/tv/pages/${encodeURIComponent(cat)}`);
  const seen = new Set();
  const all = (j.sections || [])
    .flatMap((s) => s.included?.plugs || [])
    .filter((p) => p.targetType === "series")
    .map(toItem)
    .filter((it) => it && !seen.has(it.id) && seen.add(it.id));

  const start = (page - 1) * PAGE;
  return {
    items: all.slice(start, start + PAGE),
    nextCursor: start + PAGE < all.length ? String(page + 1) : null,
  };
}

// A series' episodes across its seasons, in the API's order.
function childrenOf(j) {
  const children = [];
  (j._embedded?.seasons || []).forEach((s, si) => {
    const eps = s._embedded?.episodes || s._embedded?.instalments || [];
    eps.forEach((e, ei) => {
      if (!e.prfId) return;
      const child = {
        id: e.prfId,
        type: "video",
        name: e.titles?.title || e.originalTitle || e.prfId,
        ids: { nrk: e.prfId },
        season: si + 1,
        episode: e.sequenceNumber || ei + 1,
      };
      const description = e.titles?.subtitle || e.details?.description?.text;
      if (description) child.description = description;
      if (e.releaseDateOnDemand) child.releaseDate = String(e.releaseDateOnDemand).slice(0, 10);
      const poster = img(e.image?.webImages);
      if (poster) child.images = { poster };
      children.push(child);
    });
  });
  return children;
}

async function item(slug) {
  const j = await fetchJson(`${PSAPI}/tv/catalog/series/${encodeURIComponent(slug)}`);
  const out = {
    id: slug,
    type: "series",
    name: j.titles?.title || j.sequential?.titles?.title || j.navigation?.title || slug,
    ids: { nrk: slug },
  };
  const children = childrenOf(j);
  if (children.length) out.children = children;
  return out;
}

function streamsOf(manifest) {
  return (manifest?.playable?.assets || [])
    .filter((a) => a.url && (a.format === "HLS" || /\.m3u8/.test(a.url)))
    .map((a) => ({ url: a.url, name: "NRK (HLS)", languages: ["no"] }));
}

async function sources(id) {
  // A play request for an episode arrives as "<slug>:<season>:<episode>",
  // the series id with the position appended. Neither a slug nor a prfId
  // carries a colon, so the suffix is unambiguous.
  const ep = /^(.*):(\d+):(\d+)$/.exec(id);
  if (ep) {
    const j = await fetchJson(`${PSAPI}/tv/catalog/series/${encodeURIComponent(ep[1])}`);
    const child = childrenOf(j)
      .find((c) => c.season === Number(ep[2]) && c.episode === Number(ep[3]));
    if (!child) return { sources: [] };
    id = child.id;
  }
  if (!id) return { sources: [] };
  const manifest = await fetchJson(`${PSAPI}/playback/manifest/program/${encodeURIComponent(id)}`);
  return { sources: streamsOf(manifest) };
}

const valueOf = (segment) => {
  const raw = segment.replace(/\.json$/, "");
  return raw.startsWith("nrk:") ? raw.slice(4) : raw;
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
    id: "nrk",
    name: "NRK",
    specVersion: 2,
    version: "2.0.0",
    description: "NRK TV (Norwegen): Serien, Filme, Dokus, Kinder- und Unterhaltungsprogramme des öffentlich-rechtlichen Senders. Kostenlos, ohne API-Key. Streams sind auf Norwegen geo-beschränkt.",
    icon: "https://tv.nrk.no/apple-touch-icon.png",
    resources: ["catalog", "item", "source"],
    types: ["series"],
    idPrefixes: ["nrk"],
    catalogs: [{
      id: "tv",
      name: "NRK",
      type: "series",
      options: { shape: "landscape", displayName: true },
      features: {
        search: true,
        ...(cats.length
          ? { filter: [{ id: "kategori", name: "Kategorie", multiselect: false, values: cats.map((c) => ({ id: c.id, name: c.name })) }] }
          : {}),
      },
    }],
    dashboard: cats.slice(0, 12).map((c) => ({
      name: `NRK: ${c.name}`,
      catalog: "tv",
      filter: { kategori: c.id },
    })),
    // v1 cached searches for 30 minutes, categories for an hour.
    cache: { catalog: 3600, item: 86400, source: 3600 },
  };
}
