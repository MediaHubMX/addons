/**
 * Deutsche Welle: live TV channels, shows and video on demand. Ported from
 * the v1 addon.
 *
 * Two APIs, on purpose. DW's public GraphQL is the only one that knows the
 * live channels including EPG, can page through 10k videos and can filter by
 * title. But it sits behind bot protection, so it serves only the handful of
 * cached row and channel queries; the per-item detail runs over the REST API.
 */

const GQL = "https://www.dw.com/graphql";
const REST = "https://api.dw.com/api";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";
const PAGE = 24;

// Addon language to DW's Language enum.
const LANGS = { de: "GERMAN", en: "ENGLISH", es: "SPANISH", ru: "RUSSIAN", ar: "ARABIC" };
const langOf = (language) => LANGS[String(language || "en").slice(0, 2)] ?? "ENGLISH";

// DW's search matches the TITLE only, so a topic is a title match and
// therefore language specific: the German catalog has no "travel" in its
// titles. Hit counts checked against the live index.
const TOPICS = [
  { key: "documentary", name: "Documentaries", terms: { en: "documentary", de: "Dokumentation", es: "documental" } },
  { key: "business", name: "Business", terms: { en: "business", de: "Wirtschaft", es: "economía" } },
  { key: "climate", name: "Climate", terms: { en: "climate", de: "Klima", es: "clima" } },
  { key: "culture", name: "Culture", terms: { en: "culture", de: "Kultur", es: "cultura" } },
  { key: "politics", name: "Politics", terms: { en: "politics", de: "Politik", es: "política" } },
  { key: "europe", name: "Europe", terms: { en: "europe", de: "Europa", es: "europa" } },
  { key: "africa", name: "Africa", terms: { en: "africa", de: "Afrika", es: "áfrica" } },
  { key: "history", name: "History", terms: { en: "history", de: "Geschichte", es: "historia" } },
];
const termOf = (key, language) => {
  const topic = TOPICS.find((t) => t.key === key);
  return topic ? topic.terms[String(language || "en").slice(0, 2)] ?? topic.terms.en : key;
};

// ─── Upstreams ───

// A blocked GraphQL call is retried once: a 403 is not something to cache.
async function gql(query, variables, retry = true) {
  const res = await fetch(GQL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "User-Agent": UA,
      Origin: "https://www.dw.com",
      Referer: "https://www.dw.com/",
    },
    body: JSON.stringify({ query, variables }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) {
    if (retry) {
      await new Promise((r) => setTimeout(r, 1500));
      return gql(query, variables, false);
    }
    throw new Error(`dw graphql ${res.status}`);
  }
  if (data.errors) throw new Error(JSON.stringify(data.errors).slice(0, 300));
  return data.data;
}

// Two guards around every GraphQL call, both about asking less often:
// many TVs open the same row at the same moment and would each fetch, so they
// share one call; and if DW throttles anyway, a row serves what it served last
// time instead of erroring out to an empty screen.
const inFlight = new Map();
const lastGood = new Map();
const LAST_GOOD_MAX = 200;

async function politely(key, load) {
  try {
    const running = inFlight.get(key) ?? load().finally(() => inFlight.delete(key));
    inFlight.set(key, running);
    const value = await running;
    if (lastGood.size >= LAST_GOOD_MAX) lastGood.delete(lastGood.keys().next().value);
    lastGood.set(key, value);
    return value;
  } catch (err) {
    const stale = lastGood.get(key);
    if (!stale) throw err;
    console.warn(`dw: serving stale ${key} (${err?.message || err})`);
    return stale;
  }
}

async function rest(path) {
  const res = await fetch(`${REST}${path}`, { headers: { "User-Agent": UA } });
  // Something DW does not have is a 404 for the client, not an error for the
  // process: the host serves nine other addons in it. An id DW will not even
  // look at counts as the same thing: it answers 400 for anything that is not
  // a plain number, and a v1 client asking for an episode sends the video's id
  // with `:season:episode` on it, which is exactly that. Not a video, not an
  // outage.
  if (res.status === 404 || res.status === 400) return null;
  if (!res.ok) throw new Error(`dw rest ${res.status} on ${path}`);
  return res.json();
}

// ─── Text and images ───

// GraphQL images are templates: ".../image/12345_${formatId}.jpg". 605 is the
// wide format DW uses for its own video teasers.
const imageOf = (image) => image?.staticUrl?.replace("${formatId}", "605");
// REST images come as a size list instead.
const restImage = (image) => image?.sizes?.[image.sizes.length - 1]?.url;

const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ndash: "–", mdash: "—", hellip: "…", auml: "ä", ouml: "ö", uuml: "ü",
  Auml: "Ä", Ouml: "Ö", Uuml: "Ü", szlig: "ß",
  bdquo: "„", ldquo: "“", rdquo: "”", sbquo: "‚", lsquo: "‘", rsquo: "’",
  laquo: "«", raquo: "»",
};

// REST `text` is article HTML and some teasers carry entities, so descriptions
// are rendered as plain text.
const stripHtml = (s) => !s ? undefined : String(s)
  .replace(/<br\s*\/?>/gi, "\n")
  .replace(/<\/(p|div|li|h[1-6])>\s*/gi, "\n")
  .replace(/<[^>]+>/g, " ")
  .replace(/&#(x?[0-9a-f]+);/gi, (m, code) => String.fromCodePoint(
    code[0].toLowerCase() === "x" ? parseInt(code.slice(1), 16) : parseInt(code, 10)))
  .replace(/&(\w+);/g, (m, name) => NAMED_ENTITIES[name] ?? m)
  .replace(/[ \t]+/g, " ").replace(/\n\s+/g, "\n").replace(/\n{3,}/g, "\n\n")
  .trim() || undefined;

// ─── Queries ───

const VIDEO_FIELDS = "id name teaser duration contentDate posterImageUrl";

const CHANNELS_QUERY = `{
  livestreamChannels {
    id name iso639Lang livestreamUrl
    nextTimeSlots { name startDate endDate program { mainContentImage { staticUrl } } }
  }
}`;

const SUBTITLES_QUERY = `query ($id: Int!, $lang: Language!) {
  content(id: $id, lang: $lang) {
    ... on Video { subtitles { subtitleUrl srcLanguage } }
  }
}`;

const PROGRAMS_QUERY = `query ($lang: Language!) {
  programsOverview(lang: $lang) {
    videoPrograms { id name teaser mainContentImage { staticUrl } }
  }
}`;

const PROGRAM_ITEMS_QUERY = `query ($id: Int!, $lang: Language!) {
  content(id: $id, lang: $lang) {
    ... on UnifiedProgram {
      name teaser description
      mainContentImage { staticUrl }
      moreContentsFromUnifiedProgram(types: VIDEO, amount: 50) {
        __typename
        ... on Video { ${VIDEO_FIELDS} }
      }
    }
  }
}`;

// ─── Mapping ───

function toVideo(v) {
  const item = {
    id: String(v.id),
    type: "video",
    name: v.name,
    ids: { dw: String(v.id) },
  };
  const description = stripHtml(v.teaser);
  if (description) item.description = description;
  if (v.contentDate) item.releaseDate = String(v.contentDate).slice(0, 10);
  if (v.duration) item.runtime = v.duration;
  if (v.posterImageUrl) item.images = { poster: v.posterImageUrl };
  return item;
}

function toProgram(p) {
  const item = {
    id: String(p.id),
    type: "series",
    name: p.name,
    ids: { dw_program: String(p.id) },
  };
  const description = stripHtml(p.teaser);
  if (description) item.description = description;
  const poster = imageOf(p.mainContentImage);
  if (poster) item.images = { poster };
  return item;
}

function toChannel(c) {
  const slots = (c.nextTimeSlots || []).filter((s) => s.startDate && s.endDate);
  const item = {
    id: String(c.id),
    type: "live",
    name: c.name,
    ids: { dw_channel: String(c.id) },
    url: c.livestreamUrl,
  };
  if (c.iso639Lang) item.languages = [c.iso639Lang];
  // The running programme carries the only artwork DW exposes per channel.
  const logo = imageOf(slots[0]?.program?.mainContentImage);
  if (logo) item.images = { logo, poster: logo };
  if (slots.length) {
    item.epg = slots.map((s) => ({
      title: s.name,
      start: new Date(s.startDate).toISOString(),
      end: new Date(s.endDate).toISOString(),
    }));
  }
  return item;
}

const loadChannels = () => politely("live", async () => {
  const data = await gql(CHANNELS_QUERY);
  return (data.livestreamChannels || []).filter((c) => c.livestreamUrl).map(toChannel);
});

// Detail over REST: the same data without spending a GraphQL call on every
// tile a user opens.
async function loadVideo(id) {
  const data = await rest(`/detail/video/${encodeURIComponent(id)}`);
  if (!data) return null;
  const main = data.mainContent || {};

  // HLS first, because it adapts to the bandwidth, which is what a TV needs.
  // The fixed-bitrate mp4 renditions stay as manual fallbacks, highest first.
  const sources = (main.sources || [])
    .filter((s) => s.url && (s.format === "HLS" || s.format === "mp4"))
    .sort((a, b) => (b.format === "HLS") - (a.format === "HLS") || (b.bitrate || 0) - (a.bitrate || 0))
    .map((s) => ({ url: s.url, name: s.format === "HLS" ? "HLS" : `${Math.round((s.bitrate || 0) / 1000)}k` }));

  const item = {
    id: String(id),
    type: "video",
    name: data.name || main.name,
    ids: { dw: String(id) },
  };
  const description = stripHtml(data.text || data.teaser);
  if (description) item.description = description;
  if (data.displayDate) item.releaseDate = String(data.displayDate).slice(0, 10);
  if (main.duration) item.runtime = main.duration;
  const poster = restImage(main.previewImage);
  if (poster) item.images = { poster };
  if (sources.length) item.sources = sources;
  return item;
}

// ─── Endpoints ───

async function catalog(catalogId, query) {
  const language = query.get("language") || "en";
  const lang = langOf(language);

  if (catalogId === "live") return { items: await loadChannels(), nextCursor: null };

  if (catalogId === "programs") {
    const data = await politely(`programs:${lang}`, () => gql(PROGRAMS_QUERY, { lang }));
    return {
      items: (data?.programsOverview?.videoPrograms || []).filter((p) => p.id && p.name).map(toProgram),
      nextCursor: null,
    };
  }

  if (catalogId !== "videos") return null;

  const page = Number(query.get("cursor")) || 1;
  const topic = query.get("filter[topic]") || "";
  // DW takes a single condition, so an explicit search beats the row's topic.
  const term = query.get("search") || (topic ? termOf(topic, language) : "");
  const order = query.get("sort") === "oldest" ? "ASC" : "DESC";

  const data = await politely(`videos:${lang}:${order}:${term}:${page}`, () =>
    // The term is optional, so it must not be declared either: DW answers 400
    // for a declared-but-unused variable.
    gql(`query ($lang: Language!, $offset: Int!, $amount: Int!, $order: SortOrder!${term ? ", $term: String!" : ""}) {
      findContents(
        lang: $lang, types: VIDEO, offset: $offset, amount: $amount,
        ${term ? `must: { field: "name", operator: match, value: $term },` : ""}
        sort: { field: "contentDate", order: $order }
      ) {
        totalHits
        hits { ... on Video { ${VIDEO_FIELDS} } }
      }
    }`, { lang, offset: (page - 1) * PAGE, amount: PAGE, order, ...(term ? { term } : {}) }));

  const found = data.findContents || {};
  return {
    items: (found.hits || []).filter((v) => v.id && v.name).map(toVideo),
    nextCursor: page * PAGE < (found.totalHits || 0) ? String(page + 1) : null,
  };
}

async function program(id, language) {
  const lang = langOf(language);
  const data = await politely(`program:${lang}:${id}`, () =>
    gql(PROGRAM_ITEMS_QUERY, { id: Number(id), lang }));
  const prog = data?.content;
  if (!prog?.name) return null;

  const item = {
    id: String(id),
    type: "series",
    name: prog.name,
    ids: { dw_program: String(id) },
    // DW shows have no season concept, so everything is season 1 in the API's
    // order. Each episode carries the video's own id, so playing one takes the
    // same path as any other video.
    children: (prog.moreContentsFromUnifiedProgram || [])
      .filter((v) => v.__typename === "Video" && v.id && v.name)
      .map((v, i) => ({ ...toVideo(v), season: 1, episode: i + 1 })),
  };
  const description = stripHtml(prog.teaser || prog.description);
  if (description) item.description = description;
  const poster = imageOf(prog.mainContentImage);
  if (poster) item.images = { poster };
  return item;
}

async function subtitles(id, language) {
  const lang = langOf(language);
  const data = await politely(`subs:${lang}:${id}`, () =>
    gql(SUBTITLES_QUERY, { id: Number(id), lang }));
  return {
    subtitles: (data?.content?.subtitles || [])
      .filter((s) => s.subtitleUrl && /^[a-z]{2}$/.test(s.srcLanguage || ""))
      .map((s) => ({ url: s.subtitleUrl, language: s.srcLanguage, format: "vtt" })),
  };
}

const valueOf = (segment) => {
  const id = segment.replace(/\.json$/, "");
  const colon = id.indexOf(":");
  return colon > 0 ? id.slice(colon + 1) : id;
};

// A live channel carries what is running on it right now, and the declared
// hour would freeze that. Everything else here is on demand and does not move,
// which is why one number per resource cannot cover both.
const LIVE_FRESH_MS = 5 * 60 * 1000;

export async function get(pathname, query, ctx) {
  if (pathname === "/mhub-addon.json") return manifest(query);
  const [, resource, type, ...rest] = pathname.split("/");
  const segment = decodeURIComponent(rest.join("/"));
  const language = query.get("language") || "en";
  if (type === "live") ctx?.freshness?.(LIVE_FRESH_MS);

  if (resource === "catalog") return catalog(segment.replace(/\.json$/, ""), query);

  const id = valueOf(segment);
  if (!id) return null;

  if (resource === "item") {
    if (type === "live") return (await loadChannels()).find((c) => c.id === id) || null;
    if (type === "series") return program(id, language);
    if (type === "video") return loadVideo(id);
    return null;
  }
  if (resource === "source") {
    if (type === "live") {
      const channel = (await loadChannels()).find((c) => c.id === id);
      return { sources: channel ? [{ url: channel.url, name: "Live" }] : [] };
    }
    if (type !== "video") return null;
    const video = await loadVideo(id);
    // No such video is not the same answer as a video without sources. An
    // empty list is a list, and a caller trying one id after another stops at
    // it, so an id DW does not know has to come back as nothing at all.
    return video ? { sources: video.sources || [] } : null;
  }
  // Live channels have no captions, only videos can have them.
  if (resource === "subtitle" && type === "video") return subtitles(id, language);
  return null;
}

function manifest(query) {
  const language = query.get("language") || "en";
  return {
    id: "dw",
    name: "DW, Deutsche Welle",
    specVersion: 2,
    version: "3.0.0",
    description: "Deutsche Welle. Live-TV in vier Sprachen plus Mediathek: Nachrichten, Dokus und Reportagen. Kostenlos, ohne API-Key.",
    icon: "https://www.dw.com/images/icons/favicon-180x180.png",
    resources: ["catalog", "item", "source", "subtitle"],
    types: ["video", "series", "live"],
    idPrefixes: ["dw", "dw_channel", "dw_program"],
    catalogs: [
      {
        id: "videos",
        name: "DW",
        type: "video",
        options: { shape: "landscape", displayName: true },
        features: {
          search: true,
          sort: [{ id: "newest", name: "Neu" }, { id: "oldest", name: "Älteste" }],
          filter: [{
            id: "topic",
            name: "Thema",
            multiselect: false,
            values: TOPICS.map((t) => ({ id: t.key, name: t.name })),
          }],
        },
      },
      { id: "programs", name: "DW Sendungen", type: "series", options: { shape: "landscape", displayName: true } },
      { id: "live", name: "DW Live", type: "live", options: { shape: "landscape", displayName: true } },
    ],
    dashboard: [
      { name: "Live TV", catalog: "live" },
      { name: "Sendungen", catalog: "programs" },
      { name: "Neu", catalog: "videos", sort: "newest" },
      ...TOPICS.map((t) => ({ name: t.name, catalog: "videos", sort: "newest", filter: { topic: t.key } })),
    ],
    cache: { catalog: 3600, item: 86400, source: 86400, subtitle: 86400 },
  };
}
