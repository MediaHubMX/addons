/**
 * OpenSubtitles. Ported from the v1 addon.
 *
 * One upstream, no auth, no API key: the legacy REST search on
 * rest.opensubtitles.org, which takes its filters as path segments that MUST
 * be alphabetical. Downloads come from dl.opensubtitles.org, already recoded
 * to UTF-8. A subtitle-only addon: no catalogs, it answers for foreign imdb
 * ids, an episode arriving as `<series-id>:<season>:<episode>`.
 *
 * The search is rate-limited per IP, and every title is a lookup nobody else
 * repeats, so the server does not spend its limit on them: the client
 * searches, one language per round, and the host files the finished list
 * under the request for the next caller.
 */

const SEARCH = "https://rest.opensubtitles.org/search";
// A descriptive UA is required by the legacy API.
const UA = "MediaHubMX-OpenSubtitles/1.0";

// mhub Subtitle.type only allowed srt/vtt/ttml, keep formats we can map.
const KEEP_FORMATS = new Set(["srt", "vtt"]);

// 2-letter -> ISO639-2/B (sublanguageid). Common languages; extend as needed.
const ISO2_TO_3 = {
  en: "eng", de: "ger", fr: "fre", it: "ita", es: "spa", pt: "por",
  nl: "dut", pl: "pol", ru: "rus", tr: "tur", sv: "swe", da: "dan",
  no: "nor", fi: "fin", cs: "cze", el: "ell", he: "heb", ar: "ara",
  ja: "jpn", ko: "kor", zh: "chi", hu: "hun", ro: "rum", uk: "ukr",
  bg: "bul", hr: "hrv", sr: "scc", sk: "slo", sl: "slv",
};

// Languages to fetch: request language + a Swiss/EU default set, deduped.
const DEFAULT_LANGS = ["en", "de", "fr", "it"];

const pad7 = (imdb) => String(imdb).replace(/^tt/i, "").padStart(7, "0");

// Build the search URL with the segments in ALPHABETICAL order (API requirement).
const searchUrl = (imdb, iso3, episode) => {
  const parts = [];
  if (episode?.episode != null) parts.push(`episode-${episode.episode}`);
  parts.push(`imdbid-${pad7(imdb)}`);
  if (episode?.season != null) parts.push(`season-${episode.season}`);
  parts.push(`sublanguageid-${iso3}`);
  return `${SEARCH}/${parts.join("/")}`;
};

const downloadUrl = (idSubtitleFile) =>
  `https://dl.opensubtitles.org/en/download/subencoding-utf8/file/${idSubtitleFile}`;

const toSubtitle = (s) => {
  const format = (s.SubFormat || "").toLowerCase();
  if (!KEEP_FORMATS.has(format) || !s.IDSubtitleFile) return null;
  return {
    url: downloadUrl(s.IDSubtitleFile),
    language: s.ISO639 || "unknown",
    name: s.SubFileName || s.MovieReleaseName || "OpenSubtitles",
    format,
  };
};

// An episode asks for the series id with season and episode appended
// (`imdb:tt123:2:5`); a film is the bare id.
const parseId = (raw) => {
  const [imdb, season, episode] = raw.split(":");
  if (!imdb) return null;
  const ep = {};
  if (season != null && season !== "") ep.season = Number(season);
  if (episode != null && episode !== "") ep.episode = Number(episode);
  return { imdb, episode: Object.keys(ep).length ? ep : undefined };
};

// Best-rated / most-downloaded first, capped per language.
const rank = (list) =>
  (Array.isArray(list) ? list : [])
    .map((s) => ({ s, score: parseFloat(s.SubRating) || 0, dl: parseInt(s.SubDownloadsCnt) || 0 }))
    .sort((a, b) => b.score - a.score || b.dl - a.dl)
    .slice(0, 8)
    .map(({ s }) => toSubtitle(s))
    .filter(Boolean);

// One round: the client searches the next language, the id carries what the
// answer is for and what the rounds before it found. Nothing is remembered
// here, the answer may reach a different pod.
const askClient = (state) => ({
  clientFetch: {
    id: JSON.stringify(state),
    url: searchUrl(state.imdb, state.langs[0], state.episode),
    headers: { "User-Agent": UA },
  },
});

async function subtitles(rawId, query) {
  // Only the imdb namespace is declared, but the bridge asks what it is given.
  if (!rawId.startsWith("imdb:")) return null;
  const parsed = parseId(rawId.slice(5));
  if (!parsed) return { subtitles: [] };
  const { imdb, episode } = parsed;

  // Which languages to fetch. One request per language (comma-lists are
  // rejected by this API).
  const langs = [];
  for (const l of [query.get("language"), ...DEFAULT_LANGS]) {
    const two = String(l || "").slice(0, 2).toLowerCase();
    const iso3 = ISO2_TO_3[two];
    if (iso3 && !langs.includes(iso3)) langs.push(iso3);
  }
  if (!langs.length) return { subtitles: [] };
  return askClient({ imdb, episode, langs, subs: [] });
}

export async function clientFetch(result) {
  let state;
  try {
    state = JSON.parse(result.id);
  } catch {
    return null;
  }
  if (!state?.langs?.length) return null;

  // A language with nothing, or a bad moment upstream, is an empty list, not
  // the end of the other languages.
  let list = [];
  if (result.status === 200 && result.body) {
    try {
      list = JSON.parse(result.body);
    } catch {}
  }
  const seen = new Set(state.subs.map((s) => s.url));
  const subs = [...state.subs, ...rank(list).filter((s) => !seen.has(s.url))];
  const langs = state.langs.slice(1);
  if (langs.length) return askClient({ ...state, langs, subs });
  return { subtitles: subs };
}

export async function get(pathname, query) {
  if (pathname === "/mhub-addon.json") return manifest();
  // The type (video or series) changes nothing: the search reads the episode
  // numbers off the id either way.
  const [, resource, , ...rest] = pathname.split("/");
  const segment = decodeURIComponent(rest.join("/"));
  if (resource !== "subtitle" || !segment) return null;
  return subtitles(segment.replace(/\.json$/, ""), query);
}

function manifest() {
  return {
    id: "opensubtitles",
    name: "OpenSubtitles",
    specVersion: 2,
    version: "2.1.0",
    description:
      "Untertitel von OpenSubtitles.org (kostenlos, ohne API-Key). Sucht per IMDb-ID passende Untertitel in mehreren Sprachen.",
    icon: "https://www.mhub.mx/assets/images/favicon.png",
    resources: ["subtitle"],
    types: ["video", "series"],
    idPrefixes: ["imdb"],
    // v1 cached a lookup for 24h.
    cache: { subtitle: 86400 },
  };
}
