/**
 * Podcasts. Ported from the v1 addon.
 *
 * Discovery rides the open, keyless gpodder.net directory (top list, genre
 * tags, search); episodes and the audio itself come straight from each
 * podcast's own RSS feed. No auth, no API key, no region.
 *
 * A podcast is an `audio` item whose episodes are its children, what v1
 * modelled as a series. An episode's enclosure URL is the playable source and
 * rides inline on the child. The `source` resource stays for v1 clients:
 * their episode play asks for the series id with `:season:episode` appended,
 * which is what the bridge hands here.
 */

const BASE = "https://gpodder.net";
const UA = "MediaHubMX-Podcasts/1.0";
const PAGE = 30;
const MAX_EPISODES = 150;

// Ids are what v1 used minus the colon a v2 id cannot keep: `f:`/`e:` become
// `f-`/`e-`, over the same base64url encoding of feed and enclosure urls.
const b64 = {
  enc: (s) => Buffer.from(s, "utf8").toString("base64url"),
  dec: (s) => Buffer.from(s, "base64url").toString("utf8"),
};
const feedId = (url) => `f-${b64.enc(url)}`;
const episodeId = (url) => `e-${b64.enc(url)}`;

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!res.ok) throw new Error(`gpodder ${res.status} on ${url}`);
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`feed ${res.status} on ${url}`);
  return res.text();
}

// ─── Caches ───
// Opening a podcast parses its feed, and every v1 episode play asks for that
// same feed again (addressed as <feed-id>:<season>:<episode>). What keeps is
// the parsed feed: a few KB, not the MB of XML it came from.
const FEED_TTL_MS = 3600 * 1000;
const FEED_CACHE_MAX = 200;
const feeds = new Map();

async function feed(url) {
  const hit = feeds.get(url);
  if (hit && Date.now() - hit.at < FEED_TTL_MS) return hit.parsed;
  const parsed = parseFeed(await fetchText(url));
  if (feeds.size >= FEED_CACHE_MAX) feeds.delete(feeds.keys().next().value);
  feeds.set(url, { at: Date.now(), parsed });
  return parsed;
}

// gpodder's lists are slow-moving; search keeps v1's shorter TTL.
const LIST_TTL_MS = 3600 * 1000;
const SEARCH_TTL_MS = 30 * 60 * 1000;
const LIST_CACHE_MAX = 200;
const lists = new Map();

async function listPodcasts({ search, tag }) {
  let url;
  if (search) url = `${BASE}/search.json?q=${encodeURIComponent(search)}`;
  else if (tag) url = `${BASE}/api/2/tag/${encodeURIComponent(tag)}/100.json`;
  else url = `${BASE}/toplist/100.json`;
  const hit = lists.get(url);
  if (hit && Date.now() - hit.at < (search ? SEARCH_TTL_MS : LIST_TTL_MS)) return hit.items;
  const data = await fetchJson(url);
  const items = Array.isArray(data) ? data : [];
  if (lists.size >= LIST_CACHE_MAX) lists.delete(lists.keys().next().value);
  lists.set(url, { at: Date.now(), items });
  return items;
}

// ─── Minimal RSS parsing (podcast feeds are standard enough for this) ───
const unescape = (s) =>
  s
    ? s
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
        .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"')
        .replace(/\s+/g, " ").trim()
    : undefined;

const tag1 = (block, re) => {
  const m = block.match(re);
  return m ? m[1] : null;
};

const durationMs = (s) => {
  if (!s) return undefined;
  const t = s.trim();
  if (t.includes(":")) {
    const secs = t.split(":").map(Number).reduce((a, n) => a * 60 + (n || 0), 0);
    return secs ? secs * 1000 : undefined;
  }
  const n = Number(t);
  return n ? n * 1000 : undefined;
};

const isoDate = (s) => {
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
};

function parseFeed(xml) {
  const head = xml.split(/<item[\s>]/)[0];
  const channelImage =
    tag1(head, /<itunes:image[^>]*\bhref=["']([^"']+)["']/i) ||
    tag1(head, /<image>[\s\S]*?<url>([\s\S]*?)<\/url>/i) ||
    undefined;
  const channelTitle = unescape(tag1(head, /<title>([\s\S]*?)<\/title>/i));
  const channelDesc = unescape(tag1(head, /<description>([\s\S]*?)<\/description>/i));

  const episodes = xml
    .split(/<item[\s>]/)
    .slice(1)
    .map((b) => {
      const url = tag1(b, /<enclosure[^>]*\burl=["']([^"']+)["']/i);
      if (!url) return null;
      return {
        title: unescape(tag1(b, /<title>([\s\S]*?)<\/title>/i)) || "Episode",
        url,
        date: isoDate(tag1(b, /<pubDate>([\s\S]*?)<\/pubDate>/i)),
        duration: durationMs(tag1(b, /<itunes:duration>([\s\S]*?)<\/itunes:duration>/i)),
        image: tag1(b, /<itunes:image[^>]*\bhref=["']([^"']+)["']/i) || channelImage,
      };
    })
    .filter(Boolean)
    .slice(0, MAX_EPISODES);

  return { channelImage, channelTitle, channelDesc, episodes };
}

// ─── Item mapping ───

// A gpodder podcast -> an audio item. The feed url is the id: episodes and
// sources are derived from it on every later request.
function podcastItem(p) {
  if (!p?.url) return null;
  const id = feedId(p.url);
  const item = { id, type: "audio", name: p.title || p.url, ids: { podcasts: id } };
  const description = [p.author, p.description].filter(Boolean).join(", ");
  if (description) item.description = description;
  const poster = p.scaled_logo_url || p.logo_url;
  if (poster) item.images = { poster };
  return item;
}

// Feeds carry no season/episode of their own: an episode is season 1 and its
// position in the feed. The enclosure is the source, so it rides along.
function episodeItem(e, i) {
  const id = episodeId(e.url);
  const item = {
    id,
    type: "audio",
    name: e.title,
    ids: { podcasts: id },
    season: 1,
    episode: i + 1,
    sources: [{ url: e.url, name: "Podcast (Audio)" }],
  };
  if (e.date) item.releaseDate = e.date;
  if (e.duration) item.runtime = Math.round(e.duration / 1000);
  if (e.image) item.images = { poster: e.image };
  return item;
}

// ─── Endpoints ───

async function catalog(query) {
  const search = query.get("search") || "";
  const tag = (query.get("filter[genre]") || "").split(",")[0].trim();
  const page = Number(query.get("cursor")) || 1;
  try {
    const all = (await listPodcasts({ search, tag })).map(podcastItem).filter(Boolean);
    const start = (page - 1) * PAGE;
    return {
      items: all.slice(start, start + PAGE),
      nextCursor: start + PAGE < all.length ? String(page + 1) : null,
    };
  } catch (err) {
    console.warn("podcasts: catalog failed:", err?.message || err);
    return { items: [], nextCursor: null };
  }
}

async function item(id) {
  // An episode id encodes its enclosure URL and nothing else, so the answer
  // is the playable minimum.
  if (id.startsWith("e-")) {
    const url = b64.dec(id.slice(2));
    if (!/^https?:\/\//.test(url)) return null;
    return {
      id,
      type: "audio",
      name: "Episode",
      ids: { podcasts: id },
      sources: [{ url, name: "Podcast (Audio)" }],
    };
  }
  if (!id.startsWith("f-")) return null;
  const feedUrl = b64.dec(id.slice(2));
  if (!/^https?:\/\//.test(feedUrl)) return null;
  let parsed;
  try {
    parsed = await feed(feedUrl);
  } catch (err) {
    console.warn("podcasts: feed failed:", err?.message || err);
    return null;
  }
  const out = {
    id,
    type: "audio",
    name: parsed.channelTitle || "Podcast",
    ids: { podcasts: id },
  };
  if (parsed.channelDesc) out.description = parsed.channelDesc;
  if (parsed.channelImage) out.images = { poster: parsed.channelImage };
  const children = parsed.episodes.map(episodeItem);
  if (children.length) out.children = children;
  return out;
}

async function sources(id) {
  // A v1 episode play arrives through the bridge as <feed-id>:<s>:<e>. There
  // are no seasons here; the episode number is the position in the feed.
  const m = /^(f-.+):(\d+):(\d+)$/.exec(id);
  if (m) {
    const ep = await feed(b64.dec(m[1].slice(2)))
      .then((parsed) => parsed.episodes[Number(m[3]) - 1])
      .catch(() => null);
    return { sources: ep ? [{ url: ep.url, name: ep.title }] : [] };
  }
  if (id.startsWith("e-")) {
    const url = b64.dec(id.slice(2));
    return { sources: /^https?:\/\//.test(url) ? [{ url, name: "Podcast (Audio)" }] : [] };
  }
  // A bare podcast id ("play the podcast") is the newest episode.
  if (id.startsWith("f-")) {
    const ep = await feed(b64.dec(id.slice(2)))
      .then((parsed) => parsed.episodes[0])
      .catch(() => null);
    return { sources: ep ? [{ url: ep.url, name: ep.title }] : [] };
  }
  return { sources: [] };
}

// ─── Manifest ───

// The genre filter and the dashboard rows are built from the gpodder tags
// that actually return podcasts, probed once, an empty row is worse than a
// missing one. v1 did the same at startup.
const CANDIDATE_TAGS = [
  "technology", "science", "news", "comedy", "business", "music", "sports",
  "history", "education", "health", "politics", "society", "arts", "gaming",
  "true-crime", "fiction", "religion", "film",
];

let tagsPromise = null;
function activeTags() {
  tagsPromise ||= Promise.all(
    CANDIDATE_TAGS.map(async (t) => {
      try {
        const a = await fetchJson(`${BASE}/api/2/tag/${t}/1.json`);
        return Array.isArray(a) && a.length ? t : null;
      } catch {
        return null;
      }
    }),
  ).then((all) => all.filter(Boolean));
  return tagsPromise;
}

const cap = (s) => s.replace(/(^|[\s-])\w/g, (m) => m.toUpperCase());

async function manifest() {
  const tags = await activeTags();
  return {
    id: "podcasts",
    name: "Podcasts",
    specVersion: 2,
    version: "2.0.0",
    description:
      "Podcasts: Entdecken über das offene Verzeichnis gpodder.net, Wiedergabe direkt aus dem RSS-Feed. Kostenlos, ohne API-Key. Suche, Genre-Filter, Top-Listen.",
    icon: "https://gpodder.net/favicon.png",
    resources: ["catalog", "item", "source"],
    types: ["audio"],
    idPrefixes: ["podcasts"],
    catalogs: [
      {
        id: "podcasts",
        name: "Podcasts",
        type: "audio",
        options: { shape: "square", displayName: true },
        features: {
          search: true,
          ...(tags.length
            ? {
                filter: [
                  {
                    id: "genre",
                    name: "Genre",
                    multiselect: false,
                    values: tags.map((t) => ({ id: t, name: cap(t) })),
                  },
                ],
              }
            : {}),
        },
      },
    ],
    dashboard: [
      { name: "Top", catalog: "podcasts" },
      ...tags.slice(0, 10).map((t) => ({ name: cap(t), catalog: "podcasts", filter: { genre: t } })),
    ],
    cache: { catalog: 3600, item: 86400, source: 3600 },
  };
}

// Ids arrive bare (our own catalog's items) or under the addon's namespace
// (a fan-out to everyone who declared `podcasts`). The type in the path is
// the asker's guess, the bridge tries v1's "series" before "audio", so the
// id alone decides.
const bareId = (segment) =>
  decodeURIComponent(segment).replace(/\.json$/, "").replace(/^podcasts:/, "");

export async function get(pathname, query) {
  if (pathname === "/mhub-addon.json") return manifest();
  const [, resource, , ...rest] = pathname.split("/");
  const segment = rest.join("/");

  if (resource === "catalog") {
    return bareId(segment) === "podcasts" ? catalog(query) : { items: [], nextCursor: null };
  }

  const id = bareId(segment);
  if (!id) return null;
  if (resource === "item") return item(id);
  if (resource === "source") return sources(id);
  return null;
}
