/**
 * ARTE. Ported from the v1 addon.
 *
 * Two upstreams, both what arte.tv itself uses and neither needs auth: the
 * EMAC API answers pages and collections, the player API answers one program
 * and carries metadata and streams in the same payload. ARTE publishes in
 * German and French only, so the request language is folded onto one of the
 * two.
 */

const EMAC = "https://api.arte.tv/api/emac/v4";
const PLAYER = "https://api.arte.tv/api/player/v2/config";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

const PAGE_SIZE = 60;

// The categories the v1 addon browsed, names as it named them.
const CATEGORIES = [
  { id: "HOME", name: "Entdecken" },
  { id: "SER", name: "Serien & Fiktion" },
  { id: "CIN", name: "Filme" },
  { id: "DOR", name: "Dokus & Reportagen" },
  { id: "ACT", name: "Aktuelles & Gesellschaft" },
  { id: "DEC", name: "Entdeckung der Welt" },
  { id: "HIS", name: "Geschichte" },
  { id: "SCI", name: "Wissenschaft" },
  { id: "CPO", name: "Kultur & Pop" },
];

// ARTE only publishes in German and French.
const langOf = (query) =>
  String(query.get("language") || "").toLowerCase().startsWith("fr") ? "fr" : "de";

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  // An id ARTE does not have is a 404, and that is an answer, not an outage.
  // A v1 client asking for an episode sends the video's id with
  // `:season:episode` on it, an id no ARTE endpoint has ever heard of, and
  // throwing there put "arte 404" in the log as if the API were down.
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`arte ${res.status} on ${url}`);
  return res.json();
}

const imageOf = (raw) => {
  const url = raw?.mainImage?.url || raw?.images?.[0]?.url;
  return url ? url.replace("__SIZE__", "1920x1080") : undefined;
};

const isSeries = (raw) => raw?.kind?.isCollection || raw?.kind?.code === "TV_SERIES";
const isPlayable = (raw) => raw?.kind?.code === "SHOW" || isSeries(raw);

function toItem(raw) {
  if (!raw?.programId || !isPlayable(raw)) return null;
  const item = {
    id: raw.programId,
    type: isSeries(raw) ? "series" : "video",
    name: raw.title || raw.programId,
    ids: { arte: raw.programId },
  };
  const description = raw.shortDescription || raw.subtitle;
  if (description) item.description = description;
  const poster = imageOf(raw);
  if (poster) item.images = { poster };
  return item;
}

async function catalog(catalogId, query) {
  const lang = langOf(query);
  const page = Number(query.get("cursor")) || 1;
  if (!CATEGORIES.some((c) => c.id === catalogId)) return { items: [], nextCursor: null };

  const data = await fetchJson(`${EMAC}/${lang}/web/pages/${catalogId}/`);
  if (!data) return { items: [], nextCursor: null };
  const seen = new Set();
  const all = [];
  for (const zone of data.zones || []) {
    for (const raw of zone?.content?.data || []) {
      const item = toItem(raw);
      if (item && !seen.has(item.id) && seen.add(item.id)) all.push(item);
    }
  }
  const start = (page - 1) * PAGE_SIZE;
  return {
    items: all.slice(start, start + PAGE_SIZE),
    nextCursor: start + PAGE_SIZE < all.length ? String(page + 1) : null,
  };
}

// The player config answers one program: metadata and streams in one payload.
const player = (lang, id) => fetchJson(`${PLAYER}/${lang}/${id}`);

function streamsOf(config) {
  return (config?.data?.attributes?.streams || [])
    .filter((s) => s?.url)
    .map((s) => ({
      url: s.url,
      name: s.versions?.[0]?.label || s.mainQuality?.label || "ARTE",
      languages: [config.data.attributes.metadata?.language?.slice(0, 2)].filter(Boolean),
    }));
}

async function item(id, type, query) {
  const lang = langOf(query);

  // ARTE collections (series) are prefixed "RC-".
  if (type === "series" || id.startsWith("RC-")) {
    const data = await fetchJson(`${EMAC}/${lang}/web/collections/${id}`);
    if (!data) return null;
    const meta = data.metadata || {};
    const out = {
      id,
      type: "series",
      name: meta.title || id,
      ids: { arte: id },
    };
    if (meta.description || meta.subtitle) out.description = meta.description || meta.subtitle;
    if (meta.mainImage?.url) out.images = { poster: meta.mainImage.url.replace("__SIZE__", "1920x1080") };

    const seen = new Set();
    const children = [];
    for (const zone of data.zones || []) {
      for (const raw of zone?.content?.data || []) {
        if (raw?.kind?.code !== "SHOW" || !raw.programId) continue;
        if (seen.has(raw.programId)) continue;
        seen.add(raw.programId);
        const child = {
          id: raw.programId,
          type: "video",
          name: raw.title || raw.programId,
          ids: { arte: raw.programId },
          season: 1,
          episode: children.length + 1,
        };
        const description = raw.shortDescription || raw.subtitle;
        if (description) child.description = description;
        const poster = imageOf(raw);
        if (poster) child.images = { poster };
        children.push(child);
      }
    }
    if (children.length) out.children = children;
    return out;
  }

  const config = await player(lang, id);
  if (!config) return null;
  const a = config.data?.attributes || {};
  const m = a.metadata || {};
  const out = {
    id,
    type: "video",
    name: m.title || id,
    ids: { arte: id },
  };
  if (m.subtitle || m.description) out.description = m.subtitle || m.description;
  const poster = m.images?.[0]?.url;
  if (poster) out.images = { poster };
  if (a.duration?.seconds) out.runtime = a.duration.seconds;

  // The streams sit in the same payload as the metadata, so they are on the
  // item already and the client does not have to ask again.
  const sources = streamsOf(config);
  if (sources.length) out.sources = sources;
  return out;
}

async function sources(id, query) {
  // The play request for a series episode carries the episode's own id.
  const config = await player(langOf(query), id);
  // No such program is not the same answer as a program without streams: an
  // empty list is a list, and a caller working through a list of ids stops at
  // it instead of trying the next one.
  return config ? { sources: streamsOf(config) } : null;
}

const valueOf = (segment) => {
  const raw = segment.replace(/\.json$/, "");
  return raw.startsWith("arte:") ? raw.slice(5) : raw;
};

export async function get(pathname, query) {
  if (pathname === "/mhub-addon.json") return manifest();
  const [, resource, type, ...rest] = pathname.split("/");
  const segment = decodeURIComponent(rest.join("/"));
  if (!segment) return null;

  if (resource === "catalog") return catalog(segment.replace(/\.json$/, ""), query);

  const id = valueOf(segment);
  if (resource === "item") return item(id, type, query);
  if (resource === "source") return sources(id, query);
  return null;
}

function manifest() {
  return {
    id: "arte",
    name: "ARTE",
    specVersion: 2,
    version: "2.0.0",
    description: "ARTE Mediathek, der deutsch-französische Kultursender. Filme, Serien, Dokus und Reportagen.",
    icon: "https://static-cdn.arte.tv/replay/favicons/favicon-194x194.png",
    resources: ["catalog", "item", "source"],
    types: ["video", "series"],
    idPrefixes: ["arte"],
    catalogs: CATEGORIES.map((c) => ({
      id: c.id,
      name: c.name,
      type: "video",
      options: { shape: "landscape", displayName: true },
    })),
    dashboard: CATEGORIES.map((c) => ({ name: c.name, catalog: c.id })),
    cache: { catalog: 3600, item: 86400, source: 3600 },
  };
}
