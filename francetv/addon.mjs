/**
 * France.tv. Ported from the v1 addon.
 *
 * Two upstreams: the public "yatta" catalog API answers channels, genres and
 * search, and the francetelevisions player service answers one video,
 * metadata and a DASH manifest in one payload, the manifest Akamai-signed
 * through a token service when it has to be. The CDN itself is geo-blocked
 * to France; the catalog is not.
 */

const YATTA = "https://api-mobile.yatta.francetv.fr";
const PLAYER = "https://player.webservices.francetelevisions.fr/v1/videos";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";
const CATALOG_PAGE = 60;

// The channels the v1 addon browsed, names as it named them.
const CHANNELS = [
  { path: "france-2", name: "France 2" },
  { path: "france-3", name: "France 3" },
  { path: "france-4", name: "France 4" },
  { path: "france-5", name: "France 5" },
  { path: "franceinfo", name: "franceinfo" },
  { path: "la1ere", name: "La 1ère" },
];

// Genre filter → taxonomy slug (verified against /generic/taxonomy/{slug}/contents).
const GENRES = [
  { id: "series-et-fictions", name: "Séries & Fiktion" },
  { id: "films", name: "Filme" },
  { id: "documentaires", name: "Dokus" },
  { id: "societe", name: "Gesellschaft" },
  { id: "info", name: "Info" },
  { id: "sport", name: "Sport" },
  { id: "enfants", name: "Kinder" },
];

const getJson = async (url, referer) => {
  const headers = { "User-Agent": UA };
  if (referer) headers.Referer = referer;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`francetv ${res.status} on ${url}`);
  return res.json();
};
const yatta = (path) => getJson(YATTA + path);

// France.tv sends one picture per aspect ratio, and the type says which slot it
// belongs in: `vignette_2x3` is the poster, `background_16x9` the backdrop.
// Taking `images[0]` meant `background_16x9` won every time, a landscape
// picture in every portrait tile, and no background anywhere.
const urlOf = (list, type) => {
  const urls = (list || []).find((i) => i.type === type)?.urls || {};
  return urls["w:1024"] || urls["w:800"] || urls["w:2500"] || Object.values(urls)[0];
};

const imagesOf = (item) => {
  const list = item?.images || [];
  const out = {};
  const poster = urlOf(list, "vignette_2x3") || urlOf(list, "vignette_3x4");
  if (poster) out.poster = poster;
  // Clean frames first. `lt_16x9` is the same picture with the title burnt in,
  // which is a background of last resort, not a logo.
  const backdrops = [
    urlOf(list, "background_16x9"),
    urlOf(list, "vignette_16x9"),
    urlOf(list, "lt_16x9"),
  ].filter(Boolean);
  if (backdrops.length) out.backdrops = [...new Set(backdrops)];
  return Object.keys(out).length ? out : null;
};

// Ids carry their kind: video- is a playable video (its si_id), program- a
// series (its yatta path). The v1 addon used "video:"/"program:", a shape a
// colon does not survive on the wire.
const videoId = (si) => `video-${si}`;
const programId = (path) => `program-${path}`;

// A yatta item can be a program (series), a single unitaire/integrale video,
// or a category, which is a place and not a thing: opening it browses the
// taxonomy. Collections and events carry no fetchable id at all (their pages
// are not on this API) and are dropped; v1 turned them into videos keyed by
// the row's own numeric id, which answered nothing.
function toItem(it) {
  if (it.type === "categorie") {
    if (!it.url_complete) return null;
    const item = {
      id: `genre-${it.url_complete}`,
      type: "video",
      name: it.label || it.url_complete,
      directory: { type: "video", catalogId: `genre/${it.url_complete}` },
    };
    const images = imagesOf(it);
    if (images) item.images = images;
    return item;
  }
  const isProgram = it.type === "program" || !!it.program_path;
  if (isProgram && !it.program_path) return null;
  if (!isProgram && !it.si_id) return null;
  const id = isProgram ? programId(it.program_path) : videoId(it.si_id);
  const item = {
    id,
    type: isProgram ? "series" : "video",
    name: it.label || it.title || it.episode_title || id,
    ids: { francetv: id },
  };
  if (it.description) item.description = it.description;
  const images = imagesOf(it);
  if (images) item.images = images;
  return item;
}

// Flatten collections[].items[] (or top-level items[]) into catalog items.
const collectItems = (data) => {
  const out = [];
  const seen = new Set();
  const push = (it) => {
    const item = toItem(it);
    if (item && !seen.has(item.id) && seen.add(item.id)) out.push(item);
  };
  for (const c of data.collections || []) for (const it of c.items || []) push(it);
  for (const it of data.items || []) push(it);
  return out;
};

const paginate = (items, page) => {
  const start = (page - 1) * CATALOG_PAGE;
  return {
    items: items.slice(start, start + CATALOG_PAGE),
    nextCursor: start + CATALOG_PAGE < items.length ? String(page + 1) : null,
  };
};

async function catalog(catalogId, query) {
  const page = Number(query.get("cursor")) || 1;
  const search = query.get("search") || "";
  const genre = query.get("filter[genre]") || "";

  if (search) {
    const data = await yatta(`/apps/search?platform=apps&filters=with-collections&term=${encodeURIComponent(search)}`);
    return paginate(collectItems(data), page);
  }

  // Genre filter → browse a taxonomy category (server-side paginated). A
  // category teaser points here as the `genre/<slug>` catalog.
  const taxonomy = genre || (catalogId.startsWith("genre/") && catalogId.slice(6));
  if (taxonomy) {
    const data = await yatta(`/generic/taxonomy/${encodeURIComponent(taxonomy)}/contents?platform=apps&page=${page}`);
    const items = collectItems(data);
    return { items, nextCursor: items.length ? String(page + 1) : null };
  }

  if (catalogId.startsWith("ch/")) {
    const data = await yatta(`/apps/channels/${catalogId.slice(3)}?platform=apps`);
    return paginate(collectItems(data), page);
  }

  return { items: [], nextCursor: null };
}

// Give every episode a unique (season, episode) slot. Numbers coming from the
// API win; everything left over is filled into the free slots of its season, in
// grid order. The client keys episodes by `season-episode`, so a missing or
// duplicate number loses the episode.
const numberEpisodes = (episodes) => {
  const key = (s, e) => `${s}-${e}`;
  const taken = new Set();
  const pending = [];
  for (const ep of episodes) {
    ep.season = ep.season > 0 ? ep.season : 1;
    if (ep.episode > 0 && !taken.has(key(ep.season, ep.episode))) taken.add(key(ep.season, ep.episode));
    else pending.push(ep);
  }
  const next = new Map();
  for (const ep of pending) {
    let n = next.get(ep.season) || 1;
    while (taken.has(key(ep.season, n))) n++;
    ep.episode = n;
    taken.add(key(ep.season, n));
    next.set(ep.season, n + 1);
  }
  return episodes;
};

// A program's episodes are the items of its collections plus its content
// grid, keyed by si_id.
async function episodesOf(path) {
  const data = await yatta(`/apps/program/${path}?platform=apps`);
  const grids = [
    ...(data.collections || []).flatMap((c) => c.items || []),
    ...(data.content_grid || []),
  ];
  const seen = new Set();
  const children = [];
  for (const ep of grids) {
    const si = ep.si_id || ep.video_factory_id;
    if (!si || seen.has(si)) continue;
    seen.add(si);
    const id = videoId(si);
    const child = {
      id,
      type: "video",
      name: ep.episode_title || ep.label || ep.title || id,
      ids: { francetv: id },
      season: Number(ep.season) || 0,
      episode: Number(ep.episode) || 0,
    };
    if (ep.description) child.description = ep.description;
    const images = imagesOf(ep);
    if (images) child.images = images;
    children.push(child);
  }
  return { data, children: numberEpisodes(children) };
}

// The player config answers one video: metadata and the (to be signed)
// manifest in one payload.
const player = (siId) => getJson(
  `${PLAYER}/${siId}?device_type=desktop&browser=chrome&domain=www.france.tv`,
  "https://www.france.tv/",
);

const sourceOf = async (data) => {
  const video = data?.video;
  if (!video?.url) return null;
  let url = video.url;
  const tokenSvc = video.token?.akamai;
  if (tokenSvc) {
    try {
      const signed = await getJson(
        `${tokenSvc}${tokenSvc.includes("?") ? "&" : "?"}url=${encodeURIComponent(video.url)}`,
        "https://www.france.tv/",
      );
      if (signed?.url) url = signed.url;
    } catch {
      // Fall back to the un-signed url.
    }
  }
  return { url, name: video.drm ? "France.tv (DRM)" : "France.tv", languages: ["fr"] };
};

async function item(id) {
  // A single video: the player config carries metadata and streams in one
  // payload, so the sources are on the item already.
  if (id.startsWith("video-")) {
    const data = await player(id.slice(6));
    const meta = data.meta || {};
    const out = {
      id,
      type: "video",
      name: [meta.title, meta.additional_title].filter(Boolean).join(" - ") || id,
      ids: { francetv: id },
    };
    if (meta.description) out.description = meta.description;
    if (meta.image_url) out.images = { poster: meta.image_url };
    const source = await sourceOf(data);
    if (source) out.sources = [source];
    return out;
  }

  if (id.startsWith("program-")) {
    const { data, children } = await episodesOf(id.slice(8));
    const out = {
      id,
      type: "series",
      name: data.label || data.title || id,
      ids: { francetv: id },
    };
    if (data.description) out.description = data.description;
    const images = imagesOf(data);
    if (images) out.images = images;
    if (children.length) out.children = children;
    return out;
  }

  return null;
}

async function sources(id) {
  // A v1 client asks for an episode as the series id with :season:episode
  // appended; resolve that to the episode's own video first.
  const episodeRef = /^(program-[^:]+):(\d+):(\d+)$/.exec(id);
  if (episodeRef) {
    const [, progId, season, episode] = episodeRef;
    const { children } = await episodesOf(progId.slice(8)).catch(() => ({ children: [] }));
    const found = children.find((c) => c.season === Number(season) && c.episode === Number(episode));
    if (!found) return { sources: [] };
    id = found.id;
  }
  if (!id.startsWith("video-")) return { sources: [] };
  const source = await sourceOf(await player(id.slice(6)));
  return { sources: source ? [source] : [] };
}

const valueOf = (segment) => {
  const raw = segment.replace(/\.json$/, "");
  return raw.startsWith("francetv:") ? raw.slice(9) : raw;
};

export async function get(pathname, query) {
  if (pathname === "/mhub-addon.json") return manifest();
  const [, resource, , ...rest] = pathname.split("/");
  const segment = decodeURIComponent(rest.join("/"));
  if (!segment) return null;

  try {
    if (resource === "catalog") return await catalog(segment.replace(/\.json$/, ""), query);
    const id = valueOf(segment);
    if (resource === "item") return await item(id);
    if (resource === "source") return await sources(id);
  } catch {
    // An upstream with a bad moment answers 404 rather than hanging the host.
    return null;
  }
  return null;
}

function manifest() {
  return {
    id: "francetv",
    name: "France.tv",
    specVersion: 2,
    version: "2.0.0",
    description: "France.tv, die Mediathek des französischen öffentlichen Rundfunks (France 2/3/4/5, franceinfo). Filme, Serien, Dokus. Hinweis: Streams sind auf Frankreich geo-beschränkt.",
    icon: "https://www.france.tv/apple-touch-icon.png",
    resources: ["catalog", "item", "source"],
    types: ["video", "series"],
    idPrefixes: ["francetv"],
    catalogs: CHANNELS.map((c) => ({
      id: `ch/${c.path}`,
      name: c.name,
      type: "video",
      options: { shape: "landscape", displayName: true },
      features: {
        search: true,
        filter: [{ id: "genre", name: "Genre", multiselect: false, values: GENRES }],
      },
    })),
    dashboard: CHANNELS.map((c) => ({ name: c.name, catalog: `ch/${c.path}` })),
    // The channel pages move fast (news), so the v1 addon kept catalogs at
    // half an hour instead of the usual hour.
    // The player service signs its manifest urls with an Akamai token that
    // runs out after six hours, and an item carries its sources inline. A day
    // would mean handing out a dead url for eighteen hours of every twenty
    // four, so the item does not outlive the token.
    cache: { catalog: 1800, item: 3600, source: 3600 },
  };
}
