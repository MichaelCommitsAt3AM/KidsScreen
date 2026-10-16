# KidsScreen

A self-hosted Stremio-compatible metadata add-on and Nuvio parental-policy service. It supplies movie and TV catalogs, search, posters, backdrops, title artwork when available, and series episodes. It never supplies or hosts video streams. Existing user-installed stream providers supply authorized playback sources.

KidsScreen is a separate project from Nuvio. Nuvio connects over HTTP; neither repository imports the other's source code.

## Run locally

Install Node.js 22 or newer, then run in this folder:

```powershell
npm ci
npm run build
npm start
```

Open [http://127.0.0.1:7879](http://127.0.0.1:7879) to create a standalone add-on configuration. Enter your **personal TMDB API key**, choose G, PG or PG-13, and save the returned manifest URL. The separate management token can revoke that configuration; save it privately. Keys never appear in manifest URLs or response bodies.

Alternatively, use Nuvio's profile editor: enable **Kids account**, choose the maximum rating, enter the TMDB API key and main profile's PIN, then save. The default connection is `http://127.0.0.1:7879`. The Nuvio backend calls this service directly, so localhost means the computer running Nuvio. On other computers/devices, use a reachable HTTPS deployment.

Nuvio's database must first have `20261016120000_kids_profiles.sql` from its `supabase/migrations/` directory installed. Set a PIN on the main profile before enrolling a secondary profile. Nuvio automatically adds the configured KidsScreen catalog to that secondary profile and keeps its stream providers. Kids profiles have independent add-ons. Exiting a kids profile requires the main profile's PIN, including switches to a different kids profile.

## Rating policy

All classifications use **United States** ratings, independently of interface language. Every returned title is checked using TMDB's movie release certifications or TV content ratings. Search results receive the same checks; `include_adult=false` alone is not considered an age restriction.

| Maximum movie rating | Movies permitted | TV classifications permitted |
| --- | --- | --- |
| G | G | TV-Y, TV-G |
| PG | G, PG | TV-Y, TV-G, TV-Y7, TV-Y7-FV, TV-PG |
| PG-13 | G, PG, PG-13 | TV-Y, TV-G, TV-Y7, TV-Y7-FV, TV-PG |

TV-14 and TV-MA are excluded for every tier; TV-14 is above a strict 13-and-under ceiling. This is a conservative product policy, not an official equivalence between movie and TV classifications. Missing/unknown ratings, adult flags, and conflicting higher US ratings are denied. Specials are omitted from series metadata. Unavailable verification never grants access. Series ratings are show-level because TMDB does not supply authoritative US episode ratings; they do not guarantee uniform episode suitability.

G means general audiences, not an editorial promise of toddler suitability. Metadata and classifications can be incomplete or inaccurate. This is a ratings filter, not a curated educational service. See [MPA guidance](https://www.filmratings.com/ratings-guide/) and the [TV Parental Guidelines](https://www.tvguidelines.org/ratings.html).

Nuvio checks Home/featured titles, search, library and related titles before sending content to the interface, checks direct details and stream requests, and checks again before playback. It restricts settings, external links, cloud/local-download browsing and unguarded profile actions while a kids profile is active. It waits for profile identity before opening offline Downloads. Other Stremio clients do **not** inherit Nuvio's app-wide controls merely by installing this add-on. Older Nuvio builds do not enforce these new profile flags; use the updated desktop rewrite.

## HTTP integration contract

| Method and route | Purpose |
| --- | --- |
| `GET /health` | Readiness/version, no credentials |
| `POST /v1/configurations` | Validate `{apiKey,maxRating,language?}`; return `{id,managementToken,manifestPath,maxRating}` |
| `DELETE /v1/configurations/:id` | Revoke using `Authorization: Bearer <managementToken>` |
| `GET /:id/manifest.json` | Six catalogs: popular, animation and family, for movies and series |
| `GET /:id/catalog/:type/kids-:kind.json` | Filtered catalog |
| `GET /:id/catalog/:type/kids-popular/search=:query&skip=:offset.json` | Filtered search/pagination |
| `GET /:id/meta/:type/:mediaId.json` | Allowed metadata or `{meta:null}` |
| `POST /:id/check` | Check `{items:[{type,id}]}`; return `{items:[{type,id,allowed}]}` |

Types are `movie` and `series`. IDs are IMDb `tt...` IDs or `tmdb:<number>` (typed TMDB IDs are also accepted). IMDb IDs are preferred in responses for stream-provider compatibility. Checks accept at most 200 references per request and deny unrecognized IDs. No route accepts an arbitrary upstream URL. The service implements the [Stremio HTTP protocol](https://stremio.github.io/stremio-addon-sdk/protocol.html) directly with Node's HTTP server; it has no runtime npm dependencies.

Catalog offsets count eligible results, with deduplication and bounded backfill across up to three TMDB pages per call. Strict filters can produce sparse or empty catalogs. TMDB requests use bounded concurrency, timeouts, request deduplication and bounded caches. Nuvio caches positive checks for up to five minutes and negative checks for fifteen seconds, keyed to account, server and configuration. Changing a policy produces a fresh configuration and invalidates the app's prior media state.

## Deploy to Vercel

Follow [VERCEL.md](VERCEL.md) for the GitHub import, Upstash Redis connection, encryption secret, deployment checks and Nuvio connection steps. The included serverless adapter uses durable encrypted Redis storage; local development keeps the existing file store.

## Storage and deployment

Configurations are encrypted using AES-256-GCM in `.data/`. Local development generates a private `master.key` there. Production **requires** `KIDSSCREEN_ENCRYPTION_KEY` containing 32 base64-encoded random bytes; generate one with:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Keep the key out of Git. Back up the key and encrypted configuration directory separately. Losing the key makes existing configurations unreadable. The configuration ID is an unguessable read capability; keep manifest URLs private too. Management tokens are hashed at rest. Nuvio retains the revocation token locally, and never stores the entered TMDB key in its profile or cloud policy. Editing a policy from a different Nuvio device can require entering the key again; that device may not have the old revocation token.

For Docker, build the included `Dockerfile`, bind a persistent volume to `/data`, supply the encryption key as an environment secret, and expose the service through an HTTPS reverse proxy. Set `HOST=0.0.0.0` outside loopback development. The default is loopback-only. See `.env.example`; environment files are optional and must be explicitly loaded, for example `node --env-file=.env dist/server.js`.

Run one service instance against each configuration directory. The file-backed mode has no shared multi-instance database; the Vercel/Upstash mode shares encrypted configurations across instances. In-process limits use the direct peer address; a reverse proxy should enforce provisioning/request limits per client and must disable sensitive URL/body logging. No production deployment, domain or GitHub remote has been created by this work.

## Checks

```powershell
npm run check
npm test
npm run build
```

Tests use a fake TMDB transport, exercise the real local HTTP server, encrypted storage/restart/revocation, rating failures, manifests, metadata and filtered search. They need no real API key. The Vercel adapter test uses a fake Redis/TMDB transport to check encrypted cross-instance persistence, parsed request bodies, errors and revocation. A real-TMDB browsing/playback acceptance pass still requires the user's key and a migrated Nuvio backend. GitHub Actions runs these checks on pushes and pull requests.

## Attribution

This product uses the TMDB API but is not endorsed or certified by TMDB. TMDB supplies metadata and images, not streams. Non-commercial API use requires attribution; commercial use requires separate arrangements with TMDB. See [TMDB's API FAQ](https://developer.themoviedb.org/docs/faq), [movie certifications](https://developer.themoviedb.org/reference/movie-release-dates), and [TV content ratings](https://developer.themoviedb.org/reference/tv-series-content-ratings).
