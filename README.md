# DIY Reels (prototype)

A feed that shows **only DIY project videos** — Cricut & vinyl, home improvement, woodworking, crafts, landscaping & yard, recipes, and meal planning/prep —
pulled from YouTube, TikTok, Instagram, Pinterest (and Reddit once API access is approved).
Every video plays inline in the platform's **official embed player**; every card links back to the original post.

## Run

```bash
cd /workspace/diy-video-app
npm install && node server.js   # Node 18+
# open http://localhost:8787
```

Env vars (all optional except YouTube search): `PORT` (default 8787), `REFRESH_MINUTES` (default 30),
`YOUTUBE_API_KEY` (YouTube Data API v3 key — see below),
`REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` (enables Reddit via the official OAuth API).

Accounts (optional): set `DATABASE_URL` (Neon Postgres; queried over HTTPS with `@neondatabase/serverless`) and
`SESSION_SECRET` (random string). Users sign up with a username + password (bcrypt-hashed, optional email, no verification),
get a ♡ save button on every video and a **♥ Saved** tab. Tables (`users`, `sessions`, `saves`) are created on startup.
Login is rate-limited in memory. Endpoints: `GET /api/auth/me`, `POST /api/auth/signup|login|logout`,
`GET|POST|DELETE /api/saved` (JSON bodies). Without `DATABASE_URL` the feed works and accounts return 503.

Endpoints: `/` app · `/api/feed?cat=all|cricut|home|wood|crafts|yard|recipes|mealplan|mealprep&q=text&platform=youtube|tiktok|instagram|pinterest|reddit`
· `/api/status` (per-source health + counts) · `POST /api/refresh` (force refresh).

## How it works

- `server.js` refreshes every 30 min (TikTok / Instagram / Pinterest / Reddit) and stores the last good
  result for every source in `data/cache.json`, so a source outage (or a restart) never empties the feed.
  YouTube Data API responses are cached separately in `data/yt-cache.json` for **6 hours** to stay well
  inside the free 10,000 unit/day quota (a search costs 100 units). Log: `data/server.log` (quota used
  is logged; the API key is never logged).
- Categories come from the source's category, plus a keyword tagger: anything mentioning
  cricut / vinyl / HTV / iron-on / sublimation / decal / Design Space also shows under **Cricut & Vinyl**.
- The feed is interleaved by creator so one channel never floods the top.
- `public/` is a single-page app (dark + warm theme, category tabs, search, platform filter) and is an
  installable **PWA** (manifest + service worker) — "Add to Home Screen" on a phone once hosted on HTTPS.

## Sources & what works without keys

| Platform | Method | Key needed? | Status |
|---|---|---|---|
| YouTube | YouTube Data API v3, server-side only: `search.list` for category queries and the search box, plus `channels.list` → uploads playlist → `playlistItems` for curated channels in `sources.json`. Official `youtube-nocookie.com/embed` player (including Shorts). | **Yes** (free key, 10k units/day) | Works when `YOUTUBE_API_KEY` or `.youtube_key` is set. Responses cached 6 hours. If no key is configured, falls back to public channel RSS. |
| TikTok | Official oEmbed `tiktok.com/oembed?url=…` (validates the post is public/embeddable) + official `tiktok.com/player/v1/<id>` iframe (tap to load) | No | Works for a curated list of post URLs. In Nov 2026 TikTok's oEmbed returns only the player HTML (no title/author/thumbnail), so titles live in `sources.json` and the creator comes from the URL. TikTok has no open search/hashtag API. |
| Instagram | Official public embed iframe `instagram.com/reel/<code>/embed/` | No (for the iframe) | Works for curated reel URLs. Instagram's oEmbed *metadata* API officially needs a Meta app token, so titles/creators for IG are typed into `sources.json`. No public search/hashtag API. |
| Pinterest | Official oEmbed `pinterest.com/oembed.json` + `assets.pinterest.com/ext/embed.html?id=` widget | No | Works for curated pin URLs. Search needs the Pinterest API (app approval). |
| Reddit | Official Data API (OAuth app-only) or public `.json` | **Yes** (approval) | **Blocked from this server**: Reddit returns 403 for unauthenticated requests from cloud IPs, and since late 2025 new API clients need approval under Reddit's Responsible Builder Policy. Code is ready: set `REDDIT_CLIENT_ID`/`SECRET` and r/cricut, r/DIY, r/HomeImprovement, r/woodworking, r/crafts video posts (and YouTube links posted there) appear automatically. Running from a home connection, the public `.json` path may work for light personal use. |
| X | — | Yes (X API key) | Not included at runtime. |

No scraping: only RSS, oEmbed, official embed players and official APIs.

**Testing note:** from this cloud box, the YouTube and TikTok players load but refuse to *play*
("Video unavailable" / "Server error") — both block playback from datacenter IPs / headless browsers.
On a normal phone or home browser they play normally. Instagram reels and Pinterest pins rendered fine here.

## Add or change sources

Edit `sources.json` (no restart needed for the feed list; new sources are fetched on the next refresh,
or `curl -X POST localhost:8787/api/refresh`):

- **YouTube channel:** `{"category":"cricut","name":"Channel Name","channelId":"UC…"}`.
  Find the `UC…` id: open the channel page → *Share channel → Copy channel ID*, or view source and search `externalId`.
- **TikTok / Instagram / Pinterest post:** `{"category":"crafts","url":"https://www.tiktok.com/@user/video/123…"}`
  (Instagram: add `"title"` and `"author"` too). Dead/private posts are dropped automatically.
- **Subreddit:** `{"category":"wood","subreddit":"BeginnerWoodWorking"}`.
- **New category:** add it to `categories` in `sources.json` and to the `CATS` list at the top of the script in `public/index.html`.

## What API keys / approvals would unlock

- **YouTube Data API v3 key** — already wired in (see below). Live search, category queries, Shorts, and curated channel uploads.
- **Reddit Data API approval**: the five DIY subreddits' video posts.
- **TikTok Research API / Display API** (approval): hashtag discovery (#cricut, #diyhome) instead of curated URLs.
- **Meta app (Instagram oEmbed / Graph API)**: IG titles & thumbnails; hashtag search needs a Business account + app review.
- **Pinterest API (app approval)**: search Idea Pins / video pins by keyword.
- **X API key**: DIY video posts from X.


## YouTube Data API key (required for search)

The key is read **only on the server**, from the `YOUTUBE_API_KEY` environment variable or from a one-line
`.youtube_key` file in the app directory. It is never sent to the browser, never written into `data/`, and
never printed in logs. `.youtube_key` is gitignored — do not commit it.

Enable **YouTube Data API v3** in a Google Cloud project, create an API key, and optionally restrict it to
that API and to your host's IPs.

**Local / VPS**

```bash
# option A: environment variable
export YOUTUBE_API_KEY='your_key_here'
node server.js

# option B: one-line file (same directory as server.js)
printf '%s' "$YOUTUBE_API_KEY" > .youtube_key
chmod 600 .youtube_key
node server.js
```

**Hosting (Render, Railway, Fly.io)**

Set a secret environment variable named `YOUTUBE_API_KEY` in the service's dashboard (or `fly secrets set`,
Railway Variables, Render Environment). Do not put the key in the repo, a Dockerfile, or client-side JS.
The start command stays `node server.js`. The free quota is 10,000 units/day and resets at midnight Pacific
Time. Category search uses 10 queries × 100 units = 1,000 units per refresh, plus ~30 units for curated
channel uploads. With a 6-hour cache that is about 4,000–4,200 units/day, leaving room for live searches
(100 units per unique query, also cached 6 hours). `/api/status` reports `youtube.quotaUsedToday`.

Category queries (edit under `youtubeSearch` in `sources.json`):

- Cricut & Vinyl: `cricut project`, `cricut tumbler`, `vinyl decal tutorial`, `cricut svg`
- Home Improvement: `diy home improvement`, `shiplap`, `tile backsplash diy`
- Woodworking: `woodworking project beginner`
- Crafts: `diy crafts`, `resin craft`

The search box on the page sends the typed query to `/api/feed?q=…`, which calls `search.list` (type=video,
videoEmbeddable=true, safeSearch=moderate, relevanceLanguage=en) and merges those hits with matching
TikTok / Instagram / Pinterest / Reddit cards. YouTube Shorts are included and shown in 9:16 when detected.

## Next steps

1. Host it publicly (HTTPS needed for PWA install on phones): Render / Railway / Fly.io run `node server.js` as-is;
   or a $5 VPS. Free tiers sleep when idle — fine for a prototype.
2. Install on phone as a PWA (Add to Home Screen) → feels like an app. Later wrap with Capacitor for App Store / Play Store.
3. ~~Saved/favorite videos~~ (done: accounts + Saved tab). Still to do: password reset by email, a Cricut-only mode for her Etsy shop inspiration.
