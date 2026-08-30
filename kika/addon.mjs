/**
 * KiKA: der Kinderkanal von ARD und ZDF. Ported from the v1 addon.
 *
 * Served through ARD's page gateway (the same API the ARD Mediathek uses)
 * with org "kika": the home page lists the categories, a category pages its
 * teasers, and an item carries metadata and streams in one payload. The
 * gateway's widget ids contain a colon, so they cannot be catalog ids here,
 * the catalog stays the v1 addon's single one, the category a filter on it.
 */

const GW = "https://api.ardmediathek.de/page-gateway";
const ORG = "kika";
const PAGE_SIZE = 30;

const fetchJson = async (url) => {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`kika ${res.status} on ${url}`);
  return res.json();
};

const img = (src) => (src ? src.replace("{width}", "640") : undefined);

// ─── Categories ───

// The categories are whatever the org's home page currently offers, so they
// are fetched and kept for a while rather than written down here.
const HOME_TTL_MS = 6 * 3600 * 1000;
let cats = null;
let catsAt = 0;

async function categories() {
  if (cats && Date.now() - catsAt < HOME_TTL_MS) return cats;
  try {
    // embedded=true, so only categories that actually contain videos are kept.
    const home = await fetchJson(`${GW}/pages/${ORG}/home?embedded=true&devicetype=pc`);
    const seen = new Set();
    cats = (home.widgets ?? [])
      .filter((w) =>
        w.id && w.title && w.links?.self?.href
        && (w.type === "gridlist" || w.type === "extended_gridlist")
        && (w.teasers ?? []).some((t) => t.type === "ondemand"))
      .filter((w) => !seen.has(w.title) && seen.add(w.title))
      .map((w) => ({ id: w.id, title: w.title, href: w.links.self.href }));
  } catch {
    // The manifest must still answer when the home page does not: no filter,
    // no dashboard rows, and the catalog falls back to an empty list.
    cats = [];
  }
  catsAt = Date.now();
  return cats;
}

// ─── Catalog ───

// A home-page widget (a category) -> a paged content URL. ARD pages are
// 0-based, the cursor is the v1 addon's 1-based page.
const pagedUrl = (href, page) => {
  const u = new URL(href);
  u.searchParams.set("pageNumber", String(page - 1));
  u.searchParams.set("pageSize", String(PAGE_SIZE));
  u.searchParams.set("embedded", "true");
  u.searchParams.set("devicetype", "pc");
  return u.toString();
};

const searchUrl = (q, page) =>
  `${GW}/widgets/${ORG}/search/vod?searchString=${encodeURIComponent(q)}` +
  `&pageNumber=${page - 1}&pageSize=${PAGE_SIZE}&devicetype=pc`;

// The real playable crid lives in the teaser's target link, in editorial
// lists `teaser.id` is only the curation entry id, not the media id. Anything
// that is not a single on-demand video (shows, sections, editorial nav pages)
// is skipped, as the v1 addon did.
const contentId = (t) => {
  const m = (t?.links?.target?.href || "").match(/\/item\/([^/?]+)/);
  return m ? m[1] : null;
};

function toItem(t) {
  const id = t?.type === "ondemand" ? contentId(t) : null;
  if (!id) return null;
  const item = {
    id,
    type: "video",
    name: t.longTitle || t.mediumTitle || t.shortTitle || id,
    ids: { kika: id },
  };
  if (t.show?.title) item.description = t.show.title;
  if (t.broadcastedOn) item.releaseDate = String(t.broadcastedOn).slice(0, 10);
  if (t.duration) item.runtime = t.duration;
  const poster = img(t.images?.aspect16x9?.src);
  if (poster) item.images = { poster };
  return item;
}

const hasMore = (pg) =>
  pg && Number.isFinite(pg.totalElements)
    ? (pg.pageNumber + 1) * pg.pageSize < pg.totalElements
    : false;

async function catalog(catalogId, query) {
  if (catalogId !== "videos") return { items: [], nextCursor: null };
  const page = Number(query.get("cursor")) || 1;
  const search = query.get("search") || "";
  const catId = (query.get("filter[kategorie]") || "").split(",")[0];

  let data;
  if (search) {
    data = await fetchJson(searchUrl(search, page));
  } else {
    const cats = await categories();
    // Without a filter the catalog is the first category, which is what the
    // v1 addon served for its bare "videos" catalog.
    const cat = cats.find((c) => c.id === catId) || cats[0];
    if (!cat) return { items: [], nextCursor: null };
    data = await fetchJson(pagedUrl(cat.href, page));
  }

  const items = (data.teasers ?? []).map(toItem).filter(Boolean);
  return { items, nextCursor: hasMore(data.pagination) ? String(page + 1) : null };
}

// ─── Items ───

// Pull playable streams out of an item's mediaCollection.embedded (HLS first,
// then highest-res MP4). Language codes are normalised to two letters.
function sourcesOf(embedded) {
  const isHls = (m) => m.mimeType === "application/vnd.apple.mpegurl";
  const media = (embedded?.streams ?? [])
    .filter((s) => !s.kind || s.kind === "main")
    .flatMap((s) => s.media ?? [])
    .filter((m) => m?.url);
  const seen = new Set();
  const uniq = media.filter((m) => !seen.has(m.url) && seen.add(m.url));
  uniq.sort((a, b) => {
    if (isHls(a) !== isHls(b)) return isHls(a) ? -1 : 1;
    return (b.maxVResolutionPx ?? 0) - (a.maxVResolutionPx ?? 0);
  });
  return uniq.map((m) => ({
    // ARD hands out protocol-relative urls.
    url: m.url.replace(/^\/\//, "https://"),
    name: isHls(m) ? "Auto (HLS)" : `${m.maxVResolutionPx ?? ""}p`.trim(),
    languages: [(m.audios?.[0]?.languageCode ?? "deu").slice(0, 2)],
  }));
}

async function loadItem(id) {
  // The universal "ard" item endpoint resolves crids from any broadcaster:
  // kika content is often hosted under hr, ndr, daserste, zdf, …
  const data = await fetchJson(`${GW}/pages/ard/item/${id}?devicetype=pc&embedded=true`);
  const player = (data.widgets ?? []).find((w) => w.mediaCollection) ?? {};
  const embedded = player.mediaCollection?.embedded;
  return { data, player, embedded };
}

async function item(id) {
  const { data, player, embedded } = await loadItem(id);
  const out = {
    id,
    type: "video",
    name: data.title || player.title || id,
    ids: { kika: id },
  };
  const description = player.synopsis || data.synopsis;
  if (description) out.description = description;
  if (player.broadcastedOn) out.releaseDate = String(player.broadcastedOn).slice(0, 10);
  if (embedded?.meta?.durationSeconds) out.runtime = embedded.meta.durationSeconds;
  const poster = img(data.image?.src || player.image?.src);
  if (poster) out.images = { poster };

  // The item payload already carries the streams, so they are on the item and
  // the client does not have to ask again. A geo-blocked item keeps them,
  // the v1 addon handed them out and let the player find out.
  const sources = sourcesOf(embedded);
  if (sources.length) out.sources = sources;
  return out;
}

async function sources(id) {
  const { embedded } = await loadItem(id);
  return { sources: sourcesOf(embedded) };
}

const valueOf = (segment) => {
  const raw = segment.replace(/\.json$/, "");
  return raw.startsWith("kika:") ? raw.slice(5) : raw;
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
  const cats = await categories();
  return {
    id: "kika",
    name: "KiKA",
    specVersion: 2,
    version: "2.0.0",
    description:
      "KiKA: der Kinderkanal von ARD und ZDF: Serien, Filme, Dokus und Wissen für Kinder. Kostenlos, ohne API-Key. Streams sind i.d.R. auf Deutschland geo-beschränkt.",
    icon: "https://www.kika.de/apple-touch-icon.png",
    resources: ["catalog", "item", "source"],
    types: ["video"],
    idPrefixes: ["kika"],
    catalogs: [{
      id: "videos",
      name: "KiKA",
      type: "video",
      options: { shape: "landscape", displayName: true },
      features: {
        search: true,
        // No server-side sort exists; "Neueste" is itself a category.
        ...(cats.length
          ? {
            filter: [{
              id: "kategorie",
              name: "Kategorie",
              multiselect: false,
              values: cats.map((c) => ({ id: c.id, name: c.title })),
            }],
          }
          : {}),
      },
    }],
    // One homescreen row per category, as the v1 addon's pages had them.
    dashboard: cats.slice(0, 12).map((c) => ({
      name: c.title,
      catalog: "videos",
      filter: { kategorie: c.id },
    })),
    cache: { catalog: 3600, item: 86400, source: 3600 },
  };
}
