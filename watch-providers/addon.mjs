/**
 * Where to watch: streaming availability per region from TMDB's
 * watch/providers endpoint (JustWatch data). Ported from the v1 addon.
 * Keyless: the same shared public TMDB key the tmdb addon uses, overridable
 * via env.
 *
 * A source-only addon: it owns no items and answers for other addons',
 * that is what idPrefixes is for. What it says depends on the viewer's
 * country, so region decides the answer.
 */

const API = "https://api.themoviedb.org/3";
// TMDB is the one upstream in here that wants a key. It belongs to the
// deployment, never to the repo.
const API_KEY = process.env.TMDB_API_KEY;

// Region to fall back to when the item has no offers in the requested one.
const FALLBACK_REGION = process.env.WATCH_PROVIDERS_FALLBACK_REGION || "";

async function api(path, params = {}) {
  if (!API_KEY) throw new Error("tmdb: TMDB_API_KEY is not set");
  const qs = new URLSearchParams({ api_key: API_KEY, ...params });
  const res = await fetch(`${API}/${path}?${qs}`, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`tmdb ${res.status} on ${path}`);
  return res.json();
}

// TMDB lists a provider once per offer kind, best kind first.
const KINDS = ["flatrate", "free", "ads", "rent", "buy"];

// The namespaces this addon answers for, and how TMDB's /find calls them.
const EXTERNAL = { imdb: "imdb_id", tvdb: "tvdb_id", tvrage: "tvrage_id" };

// Ids arrive as `<ns>:<value>`, with `:season:episode` appended when an
// episode is meant. Watch providers are per title, so the episode only says
// one thing: the title is a series, even where the URL type says video.
function parseId(raw) {
  const [ns, value, season, episode] = String(raw).split(":");
  return { ns, value, isEpisode: season != null && episode != null };
}

// A foreign id has to be turned into a tmdb one first.
async function resolveTmdb({ ns, value, isEpisode }, type) {
  const series = type === "series" || isEpisode;
  if (ns === "tmdb") return { id: value, series };
  const source = EXTERNAL[ns];
  if (!source) return null;
  const found = await api(`find/${value}`, { external_source: source });
  const hit = series ? found.tv_results?.[0] : found.movie_results?.[0];
  return hit ? { id: String(hit.id), series } : null;
}

async function sources(rawId, type, query) {
  const tmdb = await resolveTmdb(parseId(rawId), type).catch(() => null);
  // Not an id this addon can answer for, let the next prefix try.
  if (!tmdb) return null;

  const data = await api(`${tmdb.series ? "tv" : "movie"}/${tmdb.id}/watch/providers`)
    .catch(() => null);
  if (!data) return null;
  const results = data.results ?? {};

  const wanted = query.get("region") || "";
  const region = results[wanted] || (FALLBACK_REGION ? results[FALLBACK_REGION] : undefined);
  // Looked, and nothing is there: a definitive answer, not "ask the next one".
  if (!region?.link) return { sources: [] };

  // One link per region covers every provider, so the rows are the provider
  // names on that one link, deduplicated across the offer kinds.
  const seen = new Set();
  const out = [];
  for (const kind of KINDS) {
    for (const offer of region[kind] || []) {
      if (seen.has(offer.provider_id)) continue;
      seen.add(offer.provider_id);
      out.push({ url: region.link, name: offer.provider_name, kind: "website" });
    }
  }
  return { sources: out };
}

function manifest() {
  return {
    id: "watch-providers",
    name: "Wo streamen?",
    specVersion: 2,
    version: "2.0.0",
    description:
      "Zeigt an, wo ein Film oder eine Serie verfügbar ist (Netflix, Amazon Prime, Disney+, u.v.m.). Daten von JustWatch über The Movie Database, passend zur eingestellten Region.",
    icon: "https://www.themoviedb.org/assets/apple-touch-icon-57ed4b3b0450fd5e9a0c20f34e814b82adaa1085c79bdde2f00ca8787b63d2c4.png",
    resources: ["source"],
    types: ["video", "series"],
    // The tmdb addon's own ids and the three foreign namespaces it can look
    // up. v1 called them triggers, with the `_id` suffix the bridge drops.
    idPrefixes: ["tmdb", "imdb", "tvdb", "tvrage"],
    // v1 refreshed availability once a day.
    cache: { source: 86400 },
  };
}

export async function get(pathname, query) {
  const [, resource, type, ...rest] = pathname.split("/");
  if (resource === "mhub-addon.json" || pathname === "/mhub-addon.json") return manifest();
  if (resource !== "source") return null;
  if (type !== "video" && type !== "series") return null;
  const id = decodeURIComponent(rest.join("/")).replace(/\.json$/, "");
  if (!id) return null;
  return sources(id, type, query);
}
