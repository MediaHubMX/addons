/**
 * ARD Mediathek. Ported from the v1 addon.
 *
 * Everything in ARD's page gateway is addressed by URL: a row on the home page,
 * a show, an episode. So an id here is that URL with the gateway prefix cut
 * off, and the catalogs are whatever the home page currently offers, which is
 * why the manifest is computed.
 */

const GATEWAY = "https://api.ardmediathek.de/page-gateway/";
const PAGE_SIZE = 30;

const url = (id) => GATEWAY + id;
// The gateway prefix is the same on every id, so it is not part of one.
const idOf = (href) => String(href || "").split("?")[0].replace(GATEWAY, "");

async function fetchJson(path, params = {}) {
  const qs = new URLSearchParams(params);
  const query = qs.toString();
  // A path may already carry its own query (season links do, and the season
  // number is in it), so the two are joined, not replaced.
  const separator = path.includes("?") ? "&" : "?";
  const res = await fetch(url(path) + (query ? `${separator}${query}` : ""), {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`ard ${res.status} on ${path}`);
  return res.json();
}

// Images are templates with a {width} placeholder.
const imageOf = (images) => {
  const first = images && Object.values(images)[0];
  return first?.src ? first.src.replace("{width}", "900").split("?")[0] : undefined;
};

// ─── Catalogs ───

// The home page decides what the rows are, so the catalog list is fetched and
// kept for a while rather than written down here.
const HOME_TTL_MS = 6 * 3600 * 1000;
let home = null;
let homeAt = 0;

async function catalogs() {
  if (home && Date.now() - homeAt < HOME_TTL_MS) return home;
  const data = await fetchJson("pages/ard/home");
  home = (data.widgets || [])
    // Rows whose link still carries a {placeholder} cannot be fetched, and a
    // banner is an ad for something, not a list of anything.
    .filter((w) => w.type !== "banner" && w.type !== "navigation"
      && !/\/\{.*\}/.test(String(w.links?.self?.href || "").split("?")[0]))
    .filter((w) => w.title && w.links?.self?.href)
    .map((w) => ({ id: idOf(w.links.self.href), name: w.title }));
  homeAt = Date.now();
  return home;
}

// A teaser is a film, a show, or another list.
const DIRECTORY_TYPES = new Set(["compilation", "editorialPage"]);

function toItem(teaser) {
  const id = idOf(teaser.links?.target?.href);
  const name = teaser.shortTitle || teaser.mediumTitle || teaser.longTitle || id;
  const poster = imageOf(teaser.images);

  if (DIRECTORY_TYPES.has(teaser.type)) {
    // A list, not a thing: opening it shows what is in it.
    const item = { id, type: "video", name, directory: { type: "video", catalogId: id } };
    if (poster) item.images = { poster };
    return item;
  }

  const item = {
    id,
    type: teaser.type === "show" ? "series" : "video",
    name,
    ids: { ard: id },
  };
  if (poster) item.images = { poster };
  if (teaser.broadcastedOn) item.releaseDate = String(teaser.broadcastedOn).slice(0, 10);
  if (teaser.duration) item.runtime = teaser.duration;
  return item;
}

function toCatalogResponse(data, page) {
  // A page can be a list of rows (then its items ARE those rows) or a list of
  // teasers. ARD uses the same endpoint for both.
  if (data.widgets && !data.teasers) {
    return {
      items: (data.widgets || [])
        .filter((w) => w.type !== "top_navigation" && w.type !== "banner" && w.title)
        .map((w) => {
          const id = idOf(w.links?.self?.href);
          return { id, type: "video", name: w.title, directory: { type: "video", catalogId: id } };
        }),
      nextCursor: null,
    };
  }

  const pagination = data.pagination || {};
  const last = (pagination.pageNumber + 1) * pagination.pageSize >= pagination.totalElements;
  return {
    items: (data.teasers || []).map(toItem),
    nextCursor: last ? null : String(page + 1),
  };
}

async function catalog(catalogId, query) {
  const page = Number(query.get("cursor")) || 0;
  const search = query.get("search") || "";

  if (search) {
    const data = await fetchJson("widgets/ard/search/vod", { searchString: search, pageNumber: page });
    return toCatalogResponse(data, page);
  }
  const data = await fetchJson(catalogId, { pageNumber: page, pageSize: PAGE_SIZE });
  return toCatalogResponse(data, page);
}

// ─── Items ───

// ARD reworked this payload: the old `_mediaArray` shape is gone and streams
// live under `embedded.streams[].media[]`. The order is what makes the standard
// adaptive stream the default: standard audio before audio description, HLS
// before progressive MP4, then highest resolution first.
function sourcesOf(embedded) {
  const isHls = (m) => m.mimeType === "application/vnd.apple.mpegurl";
  const isAudioDescription = (m) => m.audios?.[0]?.kind === "audio-description";

  const media = (embedded?.streams || [])
    .filter((s) => s.kind === "main")
    .flatMap((s) => s.media || [])
    .filter((m) => m?.url);

  const seen = new Set();
  return media
    .filter((m) => !seen.has(m.url) && seen.add(m.url))
    .sort((a, b) =>
      (isAudioDescription(a) - isAudioDescription(b))
      || (isHls(b) - isHls(a))
      || ((b.maxVResolutionPx ?? 0) - (a.maxVResolutionPx ?? 0)))
    .map((m) => ({
      // ARD hands out protocol-relative urls.
      url: String(m.url).replace(/^\/\//, "https://"),
      name: `ARD Mediathek${m.forcedLabel ? ` ${m.forcedLabel}` : ""}`
        + `${isAudioDescription(m) ? " (Audiodeskription)" : ""}`,
      languages: [(m.audios?.[0]?.languageCode ?? "deu").slice(0, 2)],
    }));
}

const subtitlesOf = (embedded) => (embedded?.subtitles || []).flatMap((sub) => {
  const vtt = (sub.sources || []).find((s) => s.kind === "webvtt");
  return vtt ? [{ url: vtt.url, language: String(sub.languageCode ?? "deu").slice(0, 2), format: "vtt" }] : [];
});

async function loadItem(id, { seasoned = false } = {}) {
  const data = await fetchJson(id, seasoned ? { seasoned: true } : {});
  const widget = data.widgets?.[0];
  if (!widget) return null;
  return { data, widget, embedded: widget.mediaCollection?.embedded };
}

async function item(id, type) {
  const loaded = await loadItem(id, { seasoned: type === "series" });
  if (!loaded) return null;
  const { data, widget, embedded } = loaded;

  const out = {
    id,
    type: type === "series" ? "series" : "video",
    name: (type === "series" ? data.title : widget.title) || id,
    ids: { ard: id },
  };
  const description = type === "series" ? data.synopsis : widget.synopsis;
  if (description) out.description = description;
  const image = (type === "series" ? data.image?.src : widget.image?.src);
  if (image) out.images = { poster: image.replace("{width}", "900").split("?")[0] };

  if (type === "series") {
    // Asked with `seasoned`, every season widget already carries its episodes,
    // so a series costs one request instead of one per season. Its link is the
    // fallback, and it must keep its query: the season number lives in there,
    // and without it every season answers with the first one.
    const seasons = (data.widgets || [])
      .filter((w) => w.compilationType === "itemsOfSeason" && !w.binaryFeatures?.length);

    const children = [];
    for (const season of seasons) {
      let teasers = season.teasers;
      if (!teasers?.length) {
        const href = season.links?.self?.href;
        const loaded = href ? await fetchJson(href.replace(GATEWAY, "")).catch(() => null) : null;
        teasers = loaded?.teasers;
      }
      (teasers || []).forEach((teaser, index) => {
        const child = toItem(teaser);
        if (!child) return;
        child.season = Number(season.seasonNumber) || 1;
        child.episode = index + 1;
        children.push(child);
      });
    }
    if (children.length) out.children = children;
    return out;
  }

  // The item request already carries the streams, so the client does not have
  // to ask again. A geo-blocked item simply has none.
  if (!embedded?.isGeoBlocked) {
    const sources = sourcesOf(embedded);
    if (sources.length) out.sources = sources;
  }
  return out;
}

async function sources(id) {
  const loaded = await loadItem(id);
  if (!loaded || loaded.embedded?.isGeoBlocked) return { sources: [] };
  return { sources: sourcesOf(loaded.embedded) };
}

async function subtitles(id) {
  const loaded = await loadItem(id);
  if (!loaded) return { subtitles: [] };
  // v1 hung the captions off every source; v2 has a place of their own for them.
  return { subtitles: subtitlesOf(loaded.embedded) };
}

const valueOf = (segment) => {
  const raw = segment.replace(/\.json$/, "");
  return raw.startsWith("ard:") ? raw.slice(4) : raw;
};

export async function get(pathname, query) {
  if (pathname === "/mhub-addon.json") return manifest();
  const [, resource, type, ...rest] = pathname.split("/");
  const segment = decodeURIComponent(rest.join("/"));
  if (!segment) return null;

  if (resource === "catalog") return catalog(segment.replace(/\.json$/, ""), query);

  const id = valueOf(segment);
  if (resource === "item") return item(id, type);
  if (resource === "source") return sources(id);
  if (resource === "subtitle") return subtitles(id);
  return null;
}

async function manifest() {
  const rows = await catalogs();
  return {
    id: "ard-mediathek",
    name: "ARD Mediathek",
    specVersion: 2,
    version: "2.0.0",
    description: "Die Mediathek der ARD: Filme, Serien, Dokumentationen und Reportagen.",
    icon: "https://www.ardmediathek.de/apple-touch-icon.png",
    resources: ["catalog", "item", "source", "subtitle"],
    types: ["video", "series"],
    idPrefixes: ["ard"],
    catalogs: rows.map((row, i) => ({
      id: row.id,
      name: row.name,
      type: "video",
      options: { shape: "landscape", displayName: true },
      // Only the first catalog gets search: ARD searches its whole archive, not
      // one row, so the same result set under every row is noise.
      features: i === 0 ? { search: true } : undefined,
    })),
    dashboard: rows.map((row) => ({ name: row.name, catalog: row.id })),
    cache: { catalog: 3600, item: 86400, source: 3600, subtitle: 86400 },
  };
}
