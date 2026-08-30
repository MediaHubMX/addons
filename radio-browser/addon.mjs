/**
 * radio-browser.info: free, keyless community radio directory. Ported from
 * the v1 addon.
 *
 * One search endpoint serves everything: catalog pages, the dashboard rows
 * and search all ask /json/stations/search and differ only in parameters.
 * A station's stream URL is already in the listing, so items carry it
 * directly and there is no source resource: the item endpoint exists for a
 * saved station whose uuid needs looking up again.
 */

// Public API mirrors; tried in order for resilience (all.* is DNS round-robin).
const MIRRORS = [
  "https://all.api.radio-browser.info",
  "https://de2.api.radio-browser.info",
  "https://de1.api.radio-browser.info",
  "https://nl1.api.radio-browser.info",
  "https://at1.api.radio-browser.info",
];

const UA = "MediaHubMX-RadioBrowser/2";
const LIMIT = 200;

// The manifest's sort ids -> radio-browser "order" param.
const SORT_ORDER = { votes: "votes", clicks: "clickcount", name: "name" };

const api = async (path) => {
  let lastErr;
  for (const mirror of MIRRORS) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      try {
        const resp = await fetch(mirror + path, {
          headers: { "User-Agent": UA },
          signal: ctrl.signal,
        });
        if (resp.ok) return resp.json();
        lastErr = new Error(`HTTP ${resp.status}`);
      } finally {
        clearTimeout(t);
      }
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`radio-browser unreachable: ${String(lastErr)}`);
};

// radio-browser sometimes returns junk in url/favicon (empty, or the literal
// string "null"), accept only real http(s) URLs so the response stays schema-valid.
const isUrl = (u) => typeof u === "string" && /^https?:\/\//i.test(u);

const toItem = (st) => {
  const url = st.url_resolved || st.url;
  if (!isUrl(url)) return null;
  const tags = String(st.tags || "").split(",").map((t) => t.trim()).filter(Boolean);
  return {
    id: st.stationuuid,
    type: "live",
    name: st.name?.trim() || "Radio",
    url,
    // The station logo as images.logo: v2 clients read it from there, and the
    // v1-bridge turns it into the IptvItem.logo a v1 client reads, a live
    // item without it is a tile with no picture.
    ...(isUrl(st.favicon) ? { images: { logo: st.favicon } } : {}),
    ...(st.countrycode ? { countries: [st.countrycode] } : {}),
    ...(tags.length ? { tags } : {}),
  };
};

const list = (stations) => (Array.isArray(stations) ? stations : []).map(toItem).filter(Boolean);

// Unified station search with server-side filter/sort + offset pagination.
const searchStations = async ({ name, country, genres, order, offset }) => {
  const p = new URLSearchParams({
    hidebroken: "true",
    order: order || "votes",
    reverse: "true",
    limit: String(LIMIT),
    offset: String(offset || 0),
  });
  if (name) p.set("name", name);
  if (country) p.set("countrycode", country);
  if (genres && genres.length) p.set("tagList", genres.join(","));
  return list(await api(`/json/stations/search?${p}`));
};

const getByUuid = async (uuid) => {
  const arr = await api(`/json/stations/byuuid/${encodeURIComponent(uuid)}`);
  return arr?.[0] ? toItem(arr[0]) : null;
};

async function catalog(query) {
  const order = SORT_ORDER[query.get("sort")] || "votes";
  const country = query.get("filter[country]") || "";
  // A multiselect arrives comma-separated, from a v1 client's array as from a
  // v2 dashboard row.
  const genres = (query.get("filter[genre]") || "").split(",").filter(Boolean);
  const page = Number(query.get("cursor")) || 1;

  const items = await searchStations({
    name: query.get("search") || undefined,
    country: country || undefined,
    genres,
    order,
    offset: (page - 1) * LIMIT,
  });
  // A full page likely means there are more results.
  return { items, nextCursor: items.length === LIMIT ? String(page + 1) : null };
}

export async function get(pathname, query) {
  const [, resource, type, ...rest] = pathname.split("/");
  if (type !== "live") return null;
  const segment = rest.join("/");

  if (resource === "catalog") return segment === "radio.json" ? catalog(query) : null;

  if (resource === "item") {
    const uuid = segment.replace(/\.json$/, "");
    return uuid ? getByUuid(uuid) : null;
  }
  return null;
}
