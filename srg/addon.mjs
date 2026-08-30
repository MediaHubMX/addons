/**
 * SRG SSR: Play SRF, RTS, RSI and RTR in one addon. Ported from the v1
 * addon.
 *
 * Two public, keyless upstreams shared by all four business units: the Play
 * v3 API browses a unit's shows and a show's episodes, the Integration Layer
 * resolves a media urn to its streams. Each unit publishes in its own
 * language (SRF de, RTS fr, RSI it, RTR rm), so the unit is the locale and
 * there is nothing the request language has to be folded onto.
 *
 * v1 keyed items "{bu}:{showId}" and episodes by their media urn, both full
 * of colons, which do not survive the v2 round trip. An id here is
 * "{bu}-{showId}" for a series and "{bu}-{mediaId}" for an episode (split on
 * the first dash; uuids keep theirs), and the urn is rebuilt from it.
 */

const IL = "https://il.srgssr.ch/integrationlayer";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

const PAGE_SIZE = 100;

// The business units, offered as separate catalogs.
const BUS = ["srf", "rts", "rsi", "rtr"];
const BU_INFO = {
  srf: { name: "SRF", languages: ["de"] },
  rts: { name: "RTS", languages: ["fr"] },
  rsi: { name: "RSI", languages: ["it"] },
  rtr: { name: "RTR", languages: ["rm"] },
};
const isBu = (x) => BUS.includes(x);

const play = (bu) => `https://www.${bu}.ch/play/v3/api/${bu}/production`;

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`srg ${res.status} on ${url}`);
  return res.json();
}

// "{bu}-{id}" <-> bu + id. Ids themselves carry dashes (uuids), so only the
// first one separates the unit.
const splitId = (id) => {
  const dash = String(id).indexOf("-");
  const bu = String(id).slice(0, dash);
  const rest = String(id).slice(dash + 1);
  return isBu(bu) && rest ? [bu, rest] : [null, null];
};

// ─── Upstream ───

/** Whole A–Z show catalog of a business unit. */
const getShows = async (bu) => {
  const data = await fetchJson(`${play(bu)}/shows`);
  return data.data || [];
};

// Topics (genres) of a business unit, {id (uuid), title (localised)}.
const getTopics = async (bu) => {
  const data = await fetchJson(`${play(bu)}/topics`);
  const list = data?.data || data || [];
  return list.filter((t) => t?.id && t?.title).map((t) => ({ id: t.id, title: t.title }));
};

// Topics ride on the manifest (one filter per catalog), so they are fetched
// once and kept, instead of four requests per manifest.
const TOPICS_TTL_MS = 6 * 3600 * 1000;
let topics = null;
let topicsAt = 0;

async function topicsByBu() {
  if (topics && Date.now() - topicsAt < TOPICS_TTL_MS) return topics;
  const entries = await Promise.all(
    BUS.map(async (bu) => [bu, await getTopics(bu).catch(() => [])]),
  );
  topics = Object.fromEntries(entries);
  topicsAt = Date.now();
  return topics;
}

const getShow = async (bu, showId) =>
  (await getShows(bu)).find((s) => s.id === showId);

/** Raw episode list of a show (first page, as the v1 addon served it). */
const fetchEpisodes = async (bu, showId) => {
  const data = await fetchJson(
    `${play(bu)}/videos-by-show-id?showId=${encodeURIComponent(showId)}`,
  );
  return data.data?.data || [];
};

// ─── Mapping ───

function showItem(bu, show) {
  const id = `${bu}-${show.id}`;
  const item = {
    id,
    type: "series",
    name: show.title || id,
    ids: { srg: id },
  };
  const description = show.lead || show.description;
  if (description) item.description = description;
  if (show.imageUrl) item.images = { poster: show.imageUrl };
  return item;
}

// An episode's id is built from its media urn ("urn:{bu}:video:{mediaId}").
// An episode without an urn can never be resolved, so it is left out rather
// than handed to clients without usable ids.
function episodeItem(ep, index) {
  const urn = String(ep.urn || "");
  const parts = urn.split(":");
  if (parts[0] !== "urn" || !isBu(parts[1]) || !parts[3]) return null;
  const id = `${parts[1]}-${parts.slice(3).join(":")}`;
  const item = {
    id,
    type: "video",
    name: ep.title || id,
    ids: { srg: id },
    season: 1,
    episode: index + 1,
  };
  const description = ep.lead || ep.description;
  if (description) item.description = description;
  if (ep.date) item.releaseDate = String(ep.date).slice(0, 10);
  if (ep.imageUrl) item.images = { poster: ep.imageUrl };
  return item;
}

// ─── Endpoints ───

async function catalog(catalogId, query) {
  if (!isBu(catalogId)) return { items: [], nextCursor: null };
  const page = Number(query.get("cursor")) || 1;
  const search = (query.get("search") || "").toLowerCase();
  const topic = (query.get("filter[topic]") || "").split(",")[0];

  let shows = await getShows(catalogId);
  if (topic) shows = shows.filter((s) => (s.topicList || []).includes(topic));
  if (search) shows = shows.filter((s) => String(s.title || "").toLowerCase().includes(search));

  const start = (page - 1) * PAGE_SIZE;
  return {
    items: shows.slice(start, start + PAGE_SIZE).map((s) => showItem(catalogId, s)),
    nextCursor: start + PAGE_SIZE < shows.length ? String(page + 1) : null,
  };
}

async function item(id) {
  const [bu, showId] = splitId(id);
  if (!bu) return null;

  const [show, episodes] = await Promise.all([
    getShow(bu, showId),
    fetchEpisodes(bu, showId).catch(() => []),
  ]);

  const out = {
    id,
    type: "series",
    name: show?.title || id,
    ids: { srg: id },
  };
  const description = show?.lead || show?.description;
  if (description) out.description = description;
  if (show?.imageUrl) out.images = { poster: show.imageUrl };

  const children = episodes.map(episodeItem).filter(Boolean);
  if (children.length) out.children = children;
  return out;
}

/** Resolve an SRG media urn (urn:{bu}:video:...) to its HLS stream(s). */
async function urnSources(urn) {
  const data = await fetchJson(
    `${IL}/2.1/mediaComposition/byUrn/${encodeURIComponent(urn)}.json`,
  );
  const resources = data?.chapterList?.[0]?.resourceList || [];
  return resources
    .filter((r) => r.streaming === "HLS" && r.url)
    .sort((a, b) => (b.quality === "HD" ? 1 : 0) - (a.quality === "HD" ? 1 : 0))
    .map((r) => ({
      url: r.url,
      name: `${r.quality || "HLS"}`,
      // The urn carries the BU: map it to its language, not the BU code.
      languages: [BU_INFO[urn.split(":")[1]]?.language || "de"],
    }));
}

async function sources(id) {
  // A play request for an episode either carries the episode's own id
  // ("{bu}-{mediaId}") or, from a v1 client through the bridge, the series
  // id with the ":season:episode" suffix the bridge appends, which is looked
  // up in the show's episode list first.
  const coordinate = /^(.*):(\d+):(\d+)$/.exec(id);
  if (coordinate) {
    const [bu, showId] = splitId(coordinate[1]);
    if (bu) {
      const episodes = await fetchEpisodes(bu, showId).catch(() => []);
      const found = episodes
        .map(episodeItem)
        .find((c) => c && c.season === Number(coordinate[2]) && c.episode === Number(coordinate[3]));
      if (found) {
        const [epBu, mediaId] = splitId(found.id);
        return { sources: await urnSources(`urn:${epBu}:video:${mediaId}`).catch(() => []) };
      }
    }
    // Not a series the list knows: the pre-suffix id was a media id all along
    // (a client that sends the episode's ids with the coordinates attached).
    id = coordinate[1];
  }

  const [bu, mediaId] = splitId(id);
  // Asked for anything else (a series id, a foreign id): resolve nothing, as
  // the v1 addon did for non-urn ids.
  if (!bu) return { sources: [] };
  const found = await urnSources(`urn:${bu}:video:${mediaId}`).catch(() => []);
  return { sources: found };
}

const valueOf = (segment) => {
  const raw = segment.replace(/\.json$/, "");
  return raw.startsWith("srg:") ? raw.slice(4) : raw;
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
  const topics = await topicsByBu();
  return {
    id: "srg",
    name: "SRG SSR",
    specVersion: 2,
    version: "2.0.0",
    description:
      "Die Mediatheken der SRG SSR: Play SRF (de), RTS (fr), RSI (it) und RTR (rm). Sendungen, Serien, Dokus und Filme. Streams sind auf die Schweiz geo-beschränkt.",
    icon: "https://www.srf.ch/build/assets/srf-apple-touch-icon-BRxTgjQQ.png",
    resources: ["catalog", "item", "source"],
    types: ["series"],
    idPrefixes: ["srg"],
    catalogs: BUS.map((bu) => ({
      id: bu,
      name: BU_INFO[bu].name,
      type: "series",
      options: { shape: "landscape", displayName: true },
      features: {
        search: true,
        ...(topics[bu]?.length
          ? {
            filter: [{
              id: "topic",
              name: "Thema",
              multiselect: false,
              values: topics[bu].map((t) => ({ id: t.id, name: t.title })),
            }],
          }
          : {}),
      },
    })),
    dashboard: BUS.map((bu) => ({ name: `${BU_INFO[bu].name}: Sendungen A–Z`, catalog: bu })),
    cache: { catalog: 3600, item: 86400, source: 3600 },
  };
}
