/**
 * SomaFM: listener-supported, commercial-free internet radio. Ported from
 * the v1 addon.
 *
 * One public channel list (~46 channels, no key, not geo-restricted). A
 * channel's best MP3 playlist (.pls) is resolved to the direct stream it
 * points at when the list loads, so the item IS the channel and there is
 * nothing left to ask: no source resource. The genre filter values and the
 * dashboard's genre rows are whatever the list currently has, so the manifest
 * is computed from it too.
 */

const CHANNELS_URL = "https://somafm.com/channels.json";

// v1 cached a catalog answer for 30 minutes; the resolved list is the same
// work for every parameter combination, so the list itself carries the TTL.
const TTL_MS = 30 * 60 * 1000;

const fetchJson = async (url) => {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
  return res.json();
};

// A channel's genre string is a "|"-separated list of tags.
const genresOf = (ch) =>
  String(ch.genre || "").split("|").map((g) => g.trim()).filter(Boolean);

// Resolve a channel's best MP3 .pls playlist to a direct stream URL.
const resolveStream = async (ch) => {
  const pls =
    (ch.playlists || []).find((p) => p.format === "mp3" && p.quality === "highest") ||
    (ch.playlists || []).find((p) => p.format === "mp3") ||
    (ch.playlists || [])[0];
  if (!pls?.url) return null;
  try {
    const txt = await (await fetch(pls.url)).text();
    const m = txt.match(/^File1=(.*)$/m);
    return m ? m[1].trim() : pls.url;
  } catch {
    return pls.url; // fall back to the playlist url itself
  }
};

const toItem = (ch, url) => {
  const item = {
    id: ch.id,
    type: "live",
    name: ch.title || ch.id,
    url,
    countries: ["US"],
    // For the filter and the sorts; not the client's business.
    _genre: String(ch.genre || ""),
    _genres: genresOf(ch),
    _listeners: Number(ch.listeners) || 0,
  };
  // Square station art. v1 channels read only the logo; v2 clients the poster.
  const logo = ch.xlimage || ch.largeimage || ch.image;
  if (logo) item.images = { logo, poster: logo };
  if (ch.description) item.description = ch.description;
  return item;
};

// The internal fields are for us, not for the client.
const publish = ({ _genre, _genres, _listeners, ...item }) => item;

// Stale-while-revalidate: after the first load requests get the list in
// memory, and an expired TTL only starts a background refresh. A failed
// refresh keeps serving what we have.
let list = null;
let loadedAt = 0;
let loading = null;

async function load() {
  const channels = (await fetchJson(CHANNELS_URL)).channels || [];
  if (!channels.length) throw new Error("somafm: channel list is empty");

  // SomaFM has ~46 channels, so resolving every stream up front is cheap and
  // the whole filtered list fits one page, no cursor needed.
  const items = (
    await Promise.all(channels.map(async (ch) => toItem(ch, await resolveStream(ch))))
  ).filter((it) => it.url);

  // The genre filter counts every channel, even one whose stream did not
  // resolve: that is what v1's manifest did.
  const counts = {};
  channels.forEach((ch) => genresOf(ch).forEach((g) => (counts[g] = (counts[g] || 0) + 1)));
  const genres = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);

  return { items, genres };
}

async function getList() {
  if (!list) {
    // Nothing to serve yet, so this one waits. Reset on failure, otherwise
    // every later request would be served the same rejection.
    loading = loading || load().finally(() => { loading = null; });
    list = await loading;
    loadedAt = Date.now();
    return list;
  }
  if (Date.now() - loadedAt > TTL_MS && !loading) {
    loading = load().then(
      (built) => { list = built; loadedAt = Date.now(); },
      (err) => { console.warn("somafm: refresh failed:", err?.message || err); }
    ).finally(() => { loading = null; });
  }
  return list;
}

const SORTS = [
  { id: "listeners", name: "Beliebt" },
  { id: "name", name: "Name A–Z" },
];

async function catalog(query) {
  const { items } = await getList();
  const search = (query.get("search") || "").toLowerCase();
  const sort = query.get("sort") || "listeners";
  const genre = query.get("filter[genre]") || "";

  let out = items;
  if (genre) out = out.filter((it) => it._genres.includes(genre));
  if (search) {
    out = out.filter(
      (it) => it.name.toLowerCase().includes(search) || it._genre.toLowerCase().includes(search)
    );
  }
  if (sort === "name") out = [...out].sort((a, b) => a.name.localeCompare(b.name));
  else out = [...out].sort((a, b) => b._listeners - a._listeners);

  return { items: out.map(publish), nextCursor: null };
}

export async function get(pathname, query) {
  if (pathname === "/mhub-addon.json") return manifest();
  const [, resource, type, ...rest] = pathname.split("/");
  if (type !== "live") return null;
  const segment = decodeURIComponent(rest.join("/"));
  if (!segment) return null;

  if (resource === "catalog") return segment === "stations.json" ? catalog(query) : null;

  if (resource === "item") {
    const id = segment.replace(/\.json$/, "");
    const { items } = await getList();
    const found = items.find((it) => it.id === id);
    return found ? publish(found) : null;
  }
  return null;
}

async function manifest() {
  let genres = [];
  try {
    ({ genres } = await getList());
  } catch (err) {
    // A manifest without its genre filter is still an addon: the catalog
    // works, and the next fetch will have them.
    console.warn("somafm: no channel list yet:", err?.message || err);
  }

  return {
    id: "somafm",
    name: "SomaFM",
    specVersion: 2,
    version: "2.0.0",
    description:
      "SomaFM: hörerfinanziertes, werbefreies Internetradio aus San Francisco. Handverlesene Sender (Ambient, Electronic, Indie u.v.m.). Kostenlos, ohne API-Key.",
    icon: "https://somafm.com/apple-touch-icon.png",
    resources: ["catalog", "item"],
    types: ["live"],
    catalogs: [
      {
        id: "stations",
        name: "SomaFM",
        type: "live",
        options: { shape: "square", displayName: true },
        features: {
          search: true,
          sort: SORTS,
          ...(genres.length
            ? {
                filter: [
                  {
                    id: "genre",
                    name: "Genre",
                    multiselect: false,
                    // v1 showed the 24 most common genres.
                    values: genres.slice(0, 24).map((g) => ({ id: g, name: g })),
                  },
                ],
              }
            : {}),
        },
      },
    ],
    // As in v1: the popular row, then the eight biggest genres.
    dashboard: [
      { name: "Beliebt", catalog: "stations", sort: "listeners" },
      ...genres.slice(0, 8).map((g) => ({ name: g, catalog: "stations", filter: { genre: g } })),
    ],
    cache: { catalog: 1800, item: 1800 },
  };
}
