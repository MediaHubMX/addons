/**
 * Odysee (LBRY). Ported from the v1 addon.
 *
 * Keyless and no geo-blocks on the metadata side: the catalogue is
 * `claim_search` on the Odysee proxy, full-text search the separate
 * lighthouse index (which only returns claim ids, resolved back through
 * claim_search for titles, thumbnails and stream hashes).
 *
 * The playable URL is built locally: odysee.com's own player hands out
 * `player.odycdn.com/api/v3/streams/free/<name>/<claim_id>/<sd_hash[:6]>.mp4`
 * (its JSON-LD contentUrl), and every part of it is already on the claim.
 * The CDN answers 401 to datacenter IPs, so streams cannot be probed from
 * a server: from a client network they play.
 */

const RPC = "https://api.na-backend.odysee.com/api/v1/proxy";
const LIGHTHOUSE = "https://lighthouse.odysee.tv/search";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

const PAGE = 50;

// Never surface adult content: claim_search applies this server-side.
const NOT_TAGS = ["porn", "nsfw", "mature", "xxx", "sex"];

const SORTS = [
  { id: "trending", name: "Trending", order: ["trending_group", "trending_mixed"] },
  { id: "newest", name: "Neu", order: ["release_time"] },
  { id: "top", name: "Top", order: ["effective_amount"] },
];
const SORT_BY_ID = Object.fromEntries(SORTS.map((s) => [s.id, s]));

// Odysee's own topic tags, verified to filter server-side.
const TAGS = [
  "technology", "gaming", "news", "science", "education", "music", "art",
  "comedy", "sports", "nature", "finance", "health", "food", "travel",
  "diy", "spirituality", "pets", "automotive", "history", "movies",
];
const LANGUAGES = [
  ["en", "Englisch"], ["de", "Deutsch"], ["fr", "Französisch"], ["es", "Spanisch"],
  ["it", "Italienisch"], ["pl", "Polnisch"], ["pt", "Portugiesisch"], ["nl", "Niederländisch"],
];

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
  });
  if (!res.ok) throw new Error(`odysee ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || "odysee error");
  return json.result;
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`odysee ${res.status} on ${url}`);
  return res.json();
}

// The playable url is claim name + claim_id + the first 6 chars of the
// source's sd_hash: the same string the SDK's own `get` method returns
// (as /v6/streams/…), so no extra RPC per playback.
const streamUrl = (claim) => {
  const sd = claim?.value?.source?.sd_hash;
  const name = claim?.normalized_name;
  if (!sd || !name) return undefined;
  return `https://player.odycdn.com/api/v3/streams/free/${encodeURIComponent(name)}/${claim.claim_id}/${sd.slice(0, 6)}.mp4`;
};

const isoDate = (unixSeconds) => {
  const n = Number(unixSeconds);
  if (!n) return undefined;
  const d = new Date(n * 1000);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
};

function toItem(claim) {
  const v = claim?.value || {};
  const channel = claim.signing_channel?.value?.title || claim.signing_channel?.name;
  const item = {
    id: String(claim.claim_id),
    type: "video",
    name: v.title || claim.name || String(claim.claim_id),
    ids: { odysee: String(claim.claim_id) },
  };
  // The schema has no channel field: keep the uploader visible in the text.
  const description = [channel && `▶ ${channel}`, v.description].filter(Boolean).join("\n\n");
  if (description) item.description = description;
  const date = isoDate(v.release_time);
  if (date) item.releaseDate = date;
  if (v.video?.duration) item.runtime = v.video.duration;
  if (v.thumbnail?.url) item.images = { poster: v.thumbnail.url };
  return item;
}

const csv = (query, key) => (query.get(key) || "").split(",").filter(Boolean);

async function catalog(query) {
  const page = Number(query.get("cursor")) || 1;
  const sortDef = SORT_BY_ID[query.get("sort")] || SORT_BY_ID.trending;
  const tags = csv(query, "filter[tag]");
  const language = csv(query, "filter[language]")[0];
  const search = String(query.get("search") || "").trim();

  // Search runs on the lighthouse index, which only returns claim ids,
  // resolve them through claim_search to get titles, thumbnails and hashes.
  if (search) {
    const hits = await fetchJson(
      `${LIGHTHOUSE}?s=${encodeURIComponent(search)}&size=${PAGE}&from=${(page - 1) * PAGE}` +
        `&mediaType=video&nsfw=false`,
    );
    const ids = (Array.isArray(hits) ? hits : []).map((h) => h.claimId).filter(Boolean);
    if (!ids.length) return { items: [], nextCursor: null };
    const res = await rpc("claim_search", { claim_ids: ids, page: 1, page_size: ids.length, no_totals: true });
    const byId = new Map((res?.items || []).map((c) => [c.claim_id, c]));
    return {
      items: ids.map((id) => byId.get(id)).filter(Boolean).map(toItem),
      nextCursor: ids.length === PAGE ? String(page + 1) : null,
    };
  }

  const res = await rpc("claim_search", {
    claim_type: ["stream"],
    stream_types: ["video"],
    order_by: sortDef.order,
    page,
    page_size: PAGE,
    not_tags: NOT_TAGS,
    ...(tags.length ? { any_tags: tags } : {}),
    ...(language ? { any_languages: [language] } : {}),
  });

  const items = (res?.items || []).map(toItem);
  return {
    items,
    nextCursor: items.length === PAGE && page < (res?.total_pages || 1) ? String(page + 1) : null,
  };
}

async function loadClaim(id) {
  const res = await rpc("claim_search", { claim_ids: [id], page: 1, page_size: 1, no_totals: true });
  return res?.items?.[0] || null;
}

async function item(id) {
  const claim = await loadClaim(id);
  if (!claim) return null;
  const out = toItem(claim);
  // The stream is known the moment the claim is, so it sits on the item and
  // the client never has to ask again.
  const url = streamUrl(claim);
  if (url) out.sources = [{ url, name: "Odysee" }];
  return out;
}

// Same claim again for the source resource: the v1 addon answered the source
// action, and dropping it would leave v1 clients without a play URL.
async function sources(id) {
  const url = streamUrl((await loadClaim(id)) || {});
  return { sources: url ? [{ url, name: "Odysee" }] : [] };
}

const valueOf = (segment) => {
  const raw = segment.replace(/\.json$/, "");
  return raw.startsWith("odysee:") ? raw.slice(7) : raw;
};

export async function get(pathname, query) {
  if (pathname === "/mhub-addon.json") return manifest();
  const [, resource, , ...rest] = pathname.split("/");
  const segment = decodeURIComponent(rest.join("/"));
  if (!segment) return null;

  if (resource === "catalog") return catalog(query);
  const id = valueOf(segment);
  if (resource === "item") return item(id);
  if (resource === "source") return sources(id);
  return null;
}

function manifest() {
  return {
    id: "odysee",
    name: "Odysee",
    specVersion: 2,
    version: "2.0.0",
    description:
      "Odysee (LBRY): dezentrale Video-Plattform. Trending, Neu und Themen-Kanäle, Suche über den Lighthouse-Index. Kostenlos, ohne API-Key, keine Geosperre. Nicht jugendfreie Inhalte sind ausgefiltert.",
    icon: "https://odysee.com/public/favicon_128.png",
    resources: ["catalog", "item", "source"],
    types: ["video"],
    idPrefixes: ["odysee"],
    catalogs: [
      {
        id: "videos",
        name: "Videos",
        type: "video",
        options: { shape: "landscape", displayName: true },
        features: {
          search: true,
          sort: SORTS.map(({ id, name }) => ({ id, name })),
          filter: [
            { id: "tag", name: "Thema", multiselect: true, values: TAGS.map((t) => ({ id: t, name: t })) },
            { id: "language", name: "Sprache", values: LANGUAGES.map(([id, name]) => ({ id, name })) },
          ],
        },
      },
    ],
    // Single-catalog addon -> the homescreen rows are declared explicitly.
    dashboard: [
      { name: "Trending", sort: "trending" },
      { name: "Neu", sort: "newest" },
      { name: "Technik", sort: "trending", filter: { tag: "technology" } },
      { name: "Gaming", sort: "trending", filter: { tag: "gaming" } },
      { name: "Wissenschaft", sort: "trending", filter: { tag: "science" } },
      { name: "Musik", sort: "trending", filter: { tag: "music" } },
      { name: "Natur", sort: "trending", filter: { tag: "nature" } },
      { name: "Deutsch", sort: "newest", filter: { language: "de" } },
    ].map((r) => ({ ...r, catalog: "videos" })),
    cache: { catalog: 1800, item: 86400, source: 86400 },
  };
}
