# mHub Addons

The real (non-fictional) v2 addons. Own repo, sibling of `../protocol` (spec and
packages) and `../site` (mhub.mx itself).

## Rules that matter

- **A folder with an `mhub-addon.json` or an `addon.mjs` is an addon**, and its
  folder name is its path on mhub.mx. Nothing lists the addons, `serve.mjs`
  finds them. Keep it that way: a list would be a second place to forget.
- **The folder name must match the entry in `../site/addons.json`.** That file
  is what hands the addons out, and it addresses them by path (`./nasa`).
- **Redis is optional, always.** `REDIS_URL` comes from the environment. An
  addon may cache in it, and must still answer without it.
- **Caching is one declaration, and the host does the rest.** `cache` in the
  manifest (seconds per resource, `CacheHints` in the spec) is read by
  `serve.mjs`: it caches the whole answer under the request, and `Cache-Control`
  comes out of the same number, so what this process keeps and what the client
  is told can never disagree. Redis when `REDIS_URL` is there, memory when it
  is not, and no addon can tell which. Declare nothing and nothing is cached.
- **The declared number is a freshness, not an expiry.** A stale answer is
  served immediately while the new one is fetched behind it, so a generous
  number costs nobody a wait, and an upstream sees one request per key per
  window however many clients ask. A failed refresh keeps the old answer:
  an upstream having a bad day must not empty the cache.
- **Everything the answer depends on is in the key**, and the query is the key.
  So an addon that varies its answer by something NOT in the query has a bug
  that only shows up once caching is on.
- **A declared number is checked against `/cache-stats.json`, not argued
  about.** It counts fresh, stale, miss and failed per addon and resource, so
  "this is buying nothing" and "this could be longer" are things you read
  rather than guess. It needs `CACHE_STATS_TOKEN` in the environment AND the
  same string back as `?token=`: setting the variable alone leaves the route a
  404, which reads exactly like the endpoint not existing.
- **Nothing is declared for an answer that is minted per request.** An addon
  whose urls carry a per-request session or device id (some ad-stitched live
  services do that, catalog items included) declares no hints at all: handing
  one session to everybody for an hour is what the upstream throttles.
- **An item that carries its sources inline must not outlive them.** francetv
  gets an Akamai-signed url that runs out after six hours, and its item used to
  declare a day, which would have meant a dead url for eighteen hours of every
  twenty four. Decode what the upstream hands you before trusting a long
  number: `exp=`, `hdnts`, `~hmac=` and a `token` in the query are the ones
  seen here.
- **Live is not a resource, so no hint can say it.** An item that carries what
  is running right now (dw's channels, iptv-org's EPG) needs a short number,
  and the same addon's on-demand rows do not. That is what `ctx.freshness` is
  for, and dw uses it: five minutes when the type is `live`, the declared hour
  otherwise.
- **`ctx.freshness(ms)` is for the answer that knows better than the manifest
  could.** tmdb uses it: a title released years ago settles for a week, one
  from this month and any series stay at six hours. Reach for it when one
  number per resource is a lie, not to avoid writing one.
- **What an addon refuses to show is configured, never compiled in.** A
  blocked item is a decision about this deployment, not a property of the
  upstream, so it belongs in an env var (`TMDB_BLOCKED_ITEMS`,
  `IA_EXCLUDE_IDS`) that is empty by default. A list of titles baked into a
  public repo is a statement nobody asked this repo to make.
- **Anything that eats memory runs in its own process.** The host serves every
  addon, so a parse that peaks at hundreds of megabytes belongs in a child
  that exits, not in the process everything else lives in.
- **A dynamic addon answers first, files second.** That is how a computed
  manifest is possible at all: a file cannot read `?language=`. An addon that
  has no `addon.mjs` is found by its `mhub-addon.json` as before.
- **An upstream a server cannot reach is the client's job.** Export
  `clientFetch(result)` next to `get()`, answer with
  `{ clientFetch: { id, url } }`, and put everything the second half needs into
  that id. The host keeps no state between the two halves, and neither should
  an addon: it may be a different pod answering.
- **An addon is files, unless it cannot be.** A live search or a per-item
  lookup needs code: `addon.mjs` exporting `get(pathname, query, ctx)`, next to
  a real `mhub-addon.json`. Everything the addon can answer from a file stays a
  file, because files are served without running anything.
- **`ctx` is the request, and almost no addon needs it.** `ctx.headers` are the
  incoming headers; `await ctx.identity()` is the signed client identity or
  `null`, read once per request and only if asked. Never verify a signature in
  an addon: `@mediahubmx/identity` accepts both protocols, so an addon written
  against it survives the day the v1 credential is replaced. Hardcoding the v1
  verifier is why that credential can never change.
- **Every addon answers both protocols**, because v1 clients still exist and
  they must not notice a conversion. The v1 side is `@mediahubmx/v1-bridge`
  reading the same files, not a second implementation.
- **A bundle is a manifest and nothing else.** `resources: []`, `types: []` and
  a `requires` list of sibling paths (`../tmdb`). The client installs what it
  names, transitively, and skips what is already there, so bundles may overlap.
  It provides nothing itself, which means `requires` IS the addon: a bundle
  that loses that list installs an addon that does nothing.
- **Fictional examples belong in `../protocol/examples/`**, real addons here.
  The protocol repo is meant to be published and stays free of them.
- `serve.mjs` imports the bridge from `../protocol/packages/v1-bridge`, so the
  Docker build context is the `mhub-v2` directory, not this repo.

## Addons here

- `nasa`: NASA Image and Video Library. Dynamic: search, filters and paging
  are the API's, and a video's playable files only come from its asset
  listing. Ported from the v1 addon.
- `tmdb`: The Movie Database. The metadata addon the others lean on: it
  answers for imdb, tvdb and tvrage ids as well as its own, which is what
  `idPrefixes` is for. Everything it says is localized, so its manifest is
  computed too (catalog names, genre values). Seasons and a person's works are
  catalogs on the item, not inline lists. Ported from the v1 addon.
- `ard-mediathek`: ARD. Everything is addressed by gateway URL, so an id is
  that URL minus the prefix and the catalogs are whatever the home page
  currently offers (computed manifest). Series answered with `seasoned` carry
  every season's episodes in one request.
- `arte`: ARTE (de/fr only, the request language folds onto one of the two).
  The player API answers metadata and streams in one payload, so sources sit
  on the item; a `source` resource stays for series episodes.
- `dw`: Deutsche Welle. Live channels with EPG, shows and video on demand, in
  five languages. Two APIs on purpose: the public GraphQL is the only one that
  knows the channels and can page and filter by title, but it sits behind bot
  protection, so it serves only the cached row and channel queries and the
  per-item detail runs over REST. Ported from the v1 addon.
- `funk`: the ARD/ZDF youth network, riding the ARD page-gateway with org
  `funk` (like kika). Flat on-demand clips, no series.
- `francetv`: France.tv. Yatta catalog API plus the player service (DASH,
  Akamai-signed when it has to be). Category teasers are directory items into
  `genre/<slug>` catalogs; collections and events carry no fetchable id and
  are dropped (v1 turned them into videos that answered nothing).
- `kika`: the children's channel, on the ARD page-gateway with org `kika`;
  items resolve through the universal `pages/ard/item/<crid>` endpoint.
- `nrk`: NRK TV (Norway). One keyless API ("psapi"): the frontpage list is
  the categories, a page's plugs the catalog. Streams geo-restricted to
  Norway.
- `raiplay`: RAI Play (Italy). No separate API: every raiplay.it page has a
  .json variant. Streams come from the relinker (XML-wrapped or redirect),
  which answers 403 outside Italy.
- `srg`: SRG SSR (Switzerland): one catalog per business unit (srf/rts/rsi/
  rtr), Play v3 API per BU, streams from the Integration Layer by URN. v1's
  colon-carrying ids and episode urns are dashed. Note: the deployed v1
  answers every action but the manifest with a signature error.
- `svt`: SVT Play (Sweden). Keyless GraphQL for catalogs/search/title pages,
  a REST video endpoint for streams. Geo-restricted to Sweden.
- `tvmaze`: TVmaze metadata, keyless. Series-only; episodes inline as
  children. Answers for imdb and tvdb ids as well, that is its reason to
  exist, so `idPrefixes` carries them.
- `anilist`: AniList (anime), keyless GraphQL. AniList has no episode
  entities, so a series' children are synthesized 1..n and enriched from its
  streamingEpisodes. Also answers `mal:` ids.
- `watch-providers`: "where does this stream": a `source` resource over
  TMDB's watch/providers (JustWatch data), per `?region=`. Same optional env
  as v1, `TMDB_API_KEY` required and `WATCH_PROVIDERS_FALLBACK_REGION`
  optional. No catalogs.
- `opensubtitles`: OpenSubtitles subtitles as a `subtitle` resource for
  `imdb` ids, episodes included (`imdb:tt…:5:14`). The keyless legacy REST
  API, no env to deploy.
- `somafm`: SomaFM radio. Type `live`: the item IS the channel and carries
  its url. The default sort follows SomaFM's live listener counts.
- `radio-browser`: the radio-browser.info directory (keyless, mirror
  fallback list). Type `live`, stream on the item, name search wired.
- `podcasts`: the gpodder.net directory for discovery; each podcast's own
  RSS feed for episodes (parsed in-process, capped and cached). Type `audio`
  with children; the `source` resource resolves a v1 client's
  `<feed-id>:1:<n>` episode play from the cached feed.
- `librivox`: LibriVox public-domain audiobooks. `extended=1` inlines the
  sections with their archive.org mp3s, so chapters carry sources inline.
  Search works around the upstream's silently-ignored `keywords` param (title
  prefix + author instead).
- `internet-archive`: public domain films, keyless, one collection per catalog.
  Every query carries a playable-derivative filter, because items whose video
  files were removed otherwise surface as "no sources found" in the top rows.
  `IA_EXCLUDE_IDS` holds back what must never appear. Ported from the v1 addon.
- `peertube`: PeerTube, federated: discovery through SepiaSearch, item
  details and streams from each video's own hosting instance. The instance
  travels inside the item id (`host|uuid`).
- `ruv`: RÚV (Iceland). Keyless GraphQL; one Program query answers a series
  with episodes, each carrying its HLS file. Open streams play from anywhere,
  locked ones are Iceland-only.
- `ard-audiothek`: ARD Audiothek (radio plays, podcasts). Keyless REST API,
  type `audio`: a programSet is an item with episode children carrying their
  mp3 inline; the `source` resource answers a v1 client's per-episode play.
- `odysee`: Odysee (LBRY). Keyless claim_search + lighthouse search. The v6
  stream path v1 hands out now answers 401 everywhere; the conversion builds
  the `/api/v3/streams/free/` url odysee.com's own player uses today. The CDN
  refuses datacenter IPs, so playback is only decidable on a real device.
- `tvp`: TVP (Poland). Keyless vod.tvp.pl API: the full index is pulled once
  (6h TTL) and search/sort/genre-filter run on it (upstream has none).
  Metadata worldwide, streams Poland-only (403 degrades to no sources, never
  an error).
- `iptv-org`: the public IPTV-ORG channel list, type `live`. One M3U, some
  12.7k channels, re-read every half hour, and search, filters, sorting and the
  country boost all run on that list in memory. The EPG is the expensive half:
  `epg-build.mjs` peaks around 400MB, so it runs as a child process that writes
  into Redis, and without `REDIS_URL` there is no EPG at all. Two soft-adult
  channels that slipped into the SFW master playlist are blocked by name and
  tvg-id stem. Ported from the v1 addon.

### Bundles

Ready-made sets, so that "I want German public TV" is one address instead of
six. Each is a folder like any other, and each is an entry in
`../site/addons.json` like any other.

- `where-to-watch`: tmdb, watch-providers, iptv-org. What a title is, where it
  streams, and what is on live right now. Ported from the v1 bundle, which
  needed a private addon until iptv-org moved here.
- `mediathek-bundle`: ard-mediathek, ard-audiothek, arte, funk, kika, dw. The
  v1 bundle was ARD plus ZDF; the public German set is six addons now.
- `radio-and-podcasts`: somafm, radio-browser, podcasts, librivox. Everything
  to listen to, all keyless, none of it geo blocked.
- `public-domain`: internet-archive, librivox, nasa, peertube. The set that
  works everywhere, because nothing in it is licensed or restricted.

## Checking an addon

`npm test` covers the host against fixtures and needs no network. Checking an
addon against its real upstream is not done from this repo.

## Writing an addon

`../protocol/SKILL.md` is the guide, `../protocol/openapi.yaml` is the truth.
The two traps that cost the most time:

- `idPrefixes` is the opt-in to answering for other addons' items. A catalog
  addon that only describes its own items declares none, and is addressed by
  its own item ids.
- Declare only what works. `search: true` on a static catalog is a lie, the
  file ignores the query.
- An addon that already knows the stream when it answers `/item` puts it in
  `Item.sources` and declares no `source` resource. `source` is for answering
  about items that are not your own, and it costs the client a round trip.
