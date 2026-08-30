# mHub Addons

The mHub addons in Addon Protocol v2. One folder per addon, and the folder name
is its path on mhub.mx.

```
nasa/
  mhub-addon.json
  catalog/video/latest.json
  item/video/<id>.json
```

```
npm start   # http://localhost:3000, serves every folder here
            # REDIS_URL=redis://… enables the caches that want one
npm run dev # with --watch
npm test    # the host, against fixtures in test/
```

An addon that cannot be files (live search, per-item lookups) ships an
`addon.mjs` next to its manifest instead:

```
nasa/
  mhub-addon.json   ← still a real file, that is how the addon is found
  addon.mjs         ← answers the paths there is no file for
```

```js
export async function get(pathname, query) { ... }  // JSON, or null for 404
export async function clientFetch(result) { ... }   // optional, see below
```

The handler is asked first and the files are the fallback, so a dynamic addon
can answer `/mhub-addon.json` itself. It has to, if its catalog names are
localized: a file cannot read `?language=`.

## Upstreams a server cannot reach

Some sites answer a datacenter with a redirect and a user with content. Such an
addon fetches nothing itself: it answers with what it wants fetched, the client
fetches it with its own IP, and the addon finishes the job.

```js
export async function get(pathname) {
  return { clientFetch: { id: "src:1138", url: "https://oz.example/videos/1138" } };
}
export async function clientFetch(result) {
  return { sources: [{ url: JSON.parse(result.body).url }] };
}
```

The id carries what the answer is for. Nothing is remembered between the two
halves, because the second one may reach a different pod. v1 clients get this
as the task chain they always had, translated by the bridge.

## Tests

```
npm test    # the host itself, against the fixtures in test/
```

Offline and fast: what it covers is discovery, both protocols reaching the same
addon, and the client-fetch round trip. It does not touch a real upstream, so a
broadcaster having a bad day cannot turn it red.

## Caching

An addon says how long its answers stay good, once, in its manifest:

```json
"cache": { "catalog": 21600, "item": 86400, "source": 3600 }
```

Seconds per resource. The host caches the whole answer under the request that
asked for it, and builds `Cache-Control` from the same number. Redis when
`REDIS_URL` is set, this process otherwise, and nothing about an addon changes
either way. An addon that declares nothing is not cached.

The number is a freshness, not an expiry. Past it, the stored answer still goes
out immediately and the new one is fetched behind it, so an upstream sees one
request per key per window no matter how many clients ask, and nobody waits for
a refresh. If that refresh fails, the old answer stays: an upstream having a bad
day is not a reason to have no cache.

For an answer that ages differently than its neighbours, a dynamic addon can say
so per answer with `ctx.freshness(ms)`.

## Environment

Everything here runs without configuration except the two that need a key.

| | |
|---|---|
| `TMDB_API_KEY` | Required by `tmdb` and `watch-providers`. Without it both answer their manifest and fail every catalog and item, loudly. |
| `REDIS_URL` | Optional everywhere. The response cache uses it when it is there and this process when it is not, and `iptv-org` builds no EPG without it. |
| `CACHE_STATS_TOKEN` | Optional. Turns on `/cache-stats.json`, which is a 404 without it, and is the `?token=` that route wants: set here and sent with the request, or it stays a 404. |
| `TMDB_BLOCKED_ITEMS` | Optional, comma separated `movie/123,tv/456`. Items `tmdb` will not list. Empty means nothing is held back. |
| `IA_EXCLUDE_IDS` | Optional, comma separated archive.org identifiers `internet-archive` will not list. |
| `WATCH_PROVIDERS_FALLBACK_REGION` | Optional. The region to fall back to when an item has no offers in the one that was asked for. |
| `PORT` | The port to listen on, 3000 by default. |
| `ADDONS_DIR` | Where to look for addons, this directory by default. |

## Is it working

```
curl http://localhost:3000/health.json
```

```json
{ "ok": true }
```

`200` while it is true, `503` when it is not, so an uptime monitor needs no
rule beyond the status code. Public, and that is why it says nothing else:
what is wrong, how long the host has been up, how much it is asked and what it
keeps its cache in are all somebody's business and none of the public's. The
reason a check failed goes to the log, when it changes rather than once per
poll, and a second thing going wrong while the first one is still wrong counts
as a change:

```
mhub addons: UNHEALTHY, addons no longer on disk: dw
mhub addons: UNHEALTHY, the addon directory is gone
mhub addons: healthy again
```

What it checks is this host, not the internet: addons loaded, and their
directories still on disk. The addons are found once at startup, so a volume
that goes away afterwards leaves a process that is up, answers, and serves
nothing, which is the kind of broken a monitor exists to catch. It asks no
upstream anything, because a host that decides its own health by calling
thirty APIs reports their bad days as its own and wakes someone up over a
Mediathek being slow. Those show up as failures in the log and in the
heartbeat instead, where a human can weigh them.

Named after no protocol, because none asks for it. (`/mediahubmx-selftest.json`
is the v1 action of that name and answers the string `"ok"` from the same
check, for anything old enough to still ask.)

The log says how it is going on its own every five minutes, because a log that
only ever speaks up when something breaks cannot be told apart from a log
nobody is writing to:

```
mhub addons: healthy, up 3h, 31 addons, 12408 requests, 3 failed, 86% from cache, redis
mhub addons: UNHEALTHY (the addon directory is gone), up 3h, 31 addons, ...
```

That line runs the health check itself rather than repeating whatever the last
caller triggered, so a monitor that is paused, misconfigured or not built yet
cannot leave the log saying nothing about health at all. While something is
wrong it goes to stderr and carries the reason with it, so an outage is legible
without scrolling back to find where it started.

## What the cache did

```
CACHE_STATS_TOKEN=... npm start
curl 'http://localhost:3000/cache-stats.json?token=...'
```

Counted per addon and resource, per process, since it started. No token in the
environment and the path is a 404, because how often an addon is asked is
nobody else's business.

```json
"tmdb/catalog": { "fresh": 4, "stale": 0, "miss": 1, "asked": 5, "upstream": 1, "served": 0.8 }
```

`upstream` is what the API on the other end saw: a miss plus every stale serve
that triggered a refresh. `served` is the share answered out of the store. A
group that is nearly all `miss` has entries aging out before anyone asks again,
so its declared number is buying nothing. One that is nearly all `fresh` could
carry a longer one. The numbers in the manifests were reasoned about, and this
is how they get checked.

To exercise the shared path while developing:

```
docker run -d --name mhub-redis -p 6380:6379 redis
REDIS_URL=redis://127.0.0.1:6380 npm start
```

Without it everything still works, one process at a time. What the shared cache
buys is what a second process sees: a restarted one finds the answers the last
one fetched instead of fetching them again.

## Both protocols, same files

`serve.mjs` serves each folder as static JSON for v2 clients, and answers
`POST /<addon>/mediahubmx-<action>.json` for v1 clients through
`@mediahubmx/v1-bridge`. For a dynamic addon the bridge reads this server over
loopback, so the v1 answers come from the same endpoints a v2 client uses
instead of a second implementation of them. An addon converted to v2 therefore keeps working for
clients that never heard of v2, at the same URL they always used.

Adding a folder with an `mhub-addon.json` adds an addon. There is no list to
keep in sync.

## What this is not

These addons read publicly reachable APIs of the services they are named after
and hand the answers to a client in one shape. They host nothing, they store no
media, and they are not affiliated with, endorsed by or connected to any of
those services. Whether a given stream may be played where you are is between
you and whoever operates it.

The code is MIT. What it reaches out to is not, and nothing here grants any
right to it.
