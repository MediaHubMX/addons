/**
 * NASA Image and Video Library: keyless, no geo restrictions.
 * Docs: https://images.nasa.gov/docs/images.nasa.gov_api_docs.pdf
 *
 * Ported from the v1 addon. Everything here is a live
 * query, which is why this addon is code and not a folder of files: search,
 * filters and paging are the API's, and the playable files of a video are only
 * known from its asset listing.
 */

const API = "https://images-api.nasa.gov";

// Asset URLs come back as plain http, and NASA leaves the spaces in its own
// file names unencoded. The host serves https just fine, and a space in a URL
// is a coin flip on whether a player will load it.
const clean = (u) => u.replace(/^http:\/\//, "https://").replaceAll(" ", "%20");

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`NASA API ${res.status} on ${url}`);
  return res.json();
}

function mapVideo(entry) {
  const d = entry?.data?.[0];
  if (!d?.nasa_id) return null;
  const preview = (entry.links || []).find((l) => l.rel === "preview");
  const item = {
    id: d.nasa_id,
    type: "video",
    name: d.title || d.nasa_id,
    // Its own namespace, so source and subtitle requests find their way back
    // here after the item has travelled through a catalog and a watchlist.
    ids: { nasa: d.nasa_id },
  };
  if (d.description) item.description = d.description;
  if (d.date_created) item.releaseDate = d.date_created.slice(0, 10);
  if (preview?.href) item.images = { poster: clean(preview.href) };
  return item;
}

async function searchVideos({ search, topic, center, page }) {
  const p = new URLSearchParams({ media_type: "video", page: String(page) });
  if (search) p.set("q", search);
  if (topic) p.set("keywords", topic);
  if (center) p.set("center", center);

  const { collection = {} } = await fetchJson(`${API}/search?${p}`);
  const items = (collection.items || []).map(mapVideo).filter(Boolean);
  const hasNext = (collection.links || []).some((l) => l.rel === "next");
  return { items, nextCursor: hasNext ? String(page + 1) : null };
}

async function getVideo(id) {
  const p = new URLSearchParams({ media_type: "video", nasa_id: id });
  const { collection } = await fetchJson(`${API}/search?${p}`);
  return mapVideo(collection?.items?.[0]);
}

// Quality suffixes NASA cuts for each video, best first. Some assets only have
// a subset; a plain ".mp4" without suffix is a single unsuffixed file.
const QUALITY = [
  ["orig", "Original"],
  ["large", "Large"],
  ["medium", "Medium"],
  ["small", "Small"],
  ["mobile", "Mobile"],
  ["preview", "Preview"],
];
const QUALITY_ORDER = [...QUALITY.map(([q]) => q), "mp4"];
const QUALITY_LABELS = Object.fromEntries(QUALITY);

// The authoritative file list for a video: MP4s in several qualities plus
// caption files (.vtt/.srt). The search response's `~thumb.jpg` naming trick
// is NOT reliable for this: always resolve here.
async function getAssets(id) {
  const data = await fetchJson(`${API}/asset/${encodeURIComponent(id)}`);
  const seen = new Set();
  const sources = new Map();
  const captions = [];

  for (const entry of data.collection?.items || []) {
    const href = clean(String(entry.href));
    if (seen.has(href)) continue;
    seen.add(href);

    const quality = /~(\w+)\.mp4$/.exec(href)?.[1];
    if (quality && QUALITY_LABELS[quality] && !sources.has(quality)) {
      sources.set(quality, { url: href, name: `NASA ${QUALITY_LABELS[quality]}` });
    } else if (href.endsWith(".mp4") && !quality && !sources.has("mp4")) {
      sources.set("mp4", { url: href, name: "NASA MP4" });
    } else if (href.endsWith(".vtt") && !captions.some((c) => c.format === "vtt")) {
      captions.push({ url: href, language: "en", name: "English (CC)", format: "vtt" });
    } else if (href.endsWith(".srt") && !captions.some((c) => c.format === "srt")) {
      captions.push({ url: href, language: "en", name: "English (CC)", format: "srt" });
    }
  }

  const ordered = [...sources.entries()]
    .sort(([a], [b]) => QUALITY_ORDER.indexOf(a) - QUALITY_ORDER.indexOf(b))
    .map(([, source]) => source);

  // Most videos ship English closed captions as .vtt; .srt is the fallback.
  const subtitle = captions.find((c) => c.format === "vtt") || captions[0];
  return { sources: ordered, subtitles: subtitle ? [subtitle] : [] };
}

// An item of this addon arrives either as its own id (a client that came from
// our catalog) or as `nasa:<id>` (a client asking everyone who declared the
// namespace). Both are this addon's own id.
const itemId = (segment) => segment.replace(/\.json$/, "").replace(/^nasa:/, "");

export async function get(pathname, query) {
  const [, resource, type, ...rest] = pathname.split("/");
  const segment = rest.join("/");
  if (type !== "video") return null;

  if (resource === "catalog") {
    if (segment !== "videos.json") return null;
    return searchVideos({
      search: query.get("search") || undefined,
      topic: query.get("filter[topic]") || undefined,
      center: query.get("filter[center]") || undefined,
      page: Number(query.get("cursor")) || 1,
    });
  }

  const id = itemId(segment);
  if (!id) return null;

  if (resource === "item") {
    const video = await getVideo(id);
    if (!video) return null;
    // The files are one request away and the item view needs them straight
    // after, so they ride along. v1 clients read them off the item.
    const { sources } = await getAssets(id);
    if (sources.length) video.sources = sources;
    return video;
  }
  if (resource === "source") return { sources: (await getAssets(id)).sources };
  if (resource === "subtitle") return { subtitles: (await getAssets(id)).subtitles };

  return null;
}
