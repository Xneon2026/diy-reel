// DIY Reels — aggregates DIY project videos from official embeds and the YouTube Data API.
// Node 18+ (built-in fetch). Accounts/saved videos use Postgres via auth.js. Run: npm install && node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const { handleAuth } = require('./auth');

const PORT = Number(process.env.PORT || 8787);
const REFRESH_MIN = Number(process.env.REFRESH_MINUTES || 30);
const YT_TTL_MS = Number(process.env.YOUTUBE_CACHE_MINUTES || 360) * 60 * 1000; // default 6 hours
const YT_QUOTA_LIMIT = 10000;
const YT_QUOTA_SOFT_CAP = 8000; // leave headroom for live user searches
const ROOT = __dirname;
const CACHE_FILE = path.join(ROOT, 'data', 'cache.json');
const YT_CACHE_FILE = path.join(ROOT, 'data', 'yt-cache.json');
const KEY_FILE = path.join(ROOT, '.youtube_key');
const UA = 'DIYReels/0.1 (prototype aggregator; contact: owner)';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const loadSources = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'sources.json'), 'utf8'));

const DEFAULT_YT_QUERIES = {
  cricut: ['cricut project', 'cricut tumbler', 'vinyl decal tutorial', 'cricut svg'],
  home: ['diy home improvement', 'shiplap', 'tile backsplash diy'],
  wood: ['woodworking project beginner'],
  crafts: ['diy crafts', 'resin craft'],
  recipes: ['easy dinner recipes', 'family meals', 'sheet pan dinner', 'crockpot slow cooker recipes', 'one pot meals', '30 minute dinner recipes'],
  mealplan: ['weekly meal plan', 'family weekly meal plan', 'meal planning on a budget', '7 day meal plan', 'how to meal plan for the week', 'grocery haul meal plan'],
  mealprep: ['budget meal prep', 'healthy meal prep for the week', 'high protein meal prep', 'meal prep sunday', 'beginner meal prep lunches', 'chicken meal prep bowls'],
  yard: ['landscaping diy backyard', 'paver patio diy', 'retaining wall diy', 'fire pit backyard diy', 'raised garden bed diy']
};

// ---- YouTube API key: env or .youtube_key, never logged or sent to the client ----
function youtubeKey() {
  const fromEnv = (process.env.YOUTUBE_API_KEY || '').trim();
  if (fromEnv) return fromEnv;
  try { return fs.readFileSync(KEY_FILE, 'utf8').trim(); } catch { return ''; }
}
function hasYoutubeKey() { return !!youtubeKey(); }
function redact(s) {
  const k = youtubeKey();
  let out = String(s ?? '');
  if (k) out = out.split(k).join('[redacted]');
  return out.replace(/([?&]key=)[^&\s"'\\]+/gi, '$1[redacted]');
}

fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// ---- persistent cache: last good result per source survives restarts and outages ----
let cache = { sources: {}, status: {}, lastRefresh: null };
try { cache = Object.assign(cache, JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))); } catch {}
const saveCache = () => fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 1));

function pacificDate() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}
const YT_SEED_FILE = path.join(ROOT, 'seed', 'yt-cache.json');
let ytCache = { quotaDate: pacificDate(), quotaUsed: 0, searches: {}, channelsFetchedAt: null, lastRefreshUnits: 0 };
// Prefer the bundled seed if the writable data/ cache is missing or thinner
// (Render's build cache can leave behind an empty or stale data/ directory).
function mergeYtCaches(a, b) {
  a = a || {}; b = b || {};
  const out = Object.assign({}, a, b);
  const mergeMap = (left, right, count) => {
    const merged = Object.assign({}, left || {});
    for (const [k, rec] of Object.entries(right || {})) {
      if (!merged[k] || count(rec) >= count(merged[k])) merged[k] = rec;
    }
    return merged;
  };
  const searchCount = rec => ((rec && rec.items) || []).length;
  const chanCount = items => (items || []).length;
  out.searches = mergeMap(a.searches, b.searches, searchCount);
  out.channelItems = mergeMap(a.channelItems, b.channelItems, chanCount);
  const ta = Date.parse(a.channelsFetchedAt || '') || 0;
  const tb = Date.parse(b.channelsFetchedAt || '') || 0;
  out.channelsFetchedAt = (tb >= ta ? (b.channelsFetchedAt || a.channelsFetchedAt) : a.channelsFetchedAt) || null;
  if (a.quotaDate && b.quotaDate && a.quotaDate === b.quotaDate) {
    out.quotaDate = a.quotaDate;
    out.quotaUsed = Math.max(Number(a.quotaUsed) || 0, Number(b.quotaUsed) || 0);
  } else if ((Date.parse(b.quotaDate || '') || 0) >= (Date.parse(a.quotaDate || '') || 0) && b.quotaDate) {
    out.quotaDate = b.quotaDate;
    out.quotaUsed = Number(b.quotaUsed) || 0;
  } else if (a.quotaDate) {
    out.quotaDate = a.quotaDate;
    out.quotaUsed = Number(a.quotaUsed) || 0;
  }
  return out;
}
(function loadYtCache() {
  const seed = readJson(YT_SEED_FILE) || {};
  const disk = readJson(YT_CACHE_FILE) || {};
  ytCache = Object.assign(ytCache, mergeYtCaches(seed, disk));
})();
function rollQuota() {
  const d = pacificDate();
  if (ytCache.quotaDate !== d) { ytCache.quotaDate = d; ytCache.quotaUsed = 0; }
}
function addQuota(units) { rollQuota(); ytCache.quotaUsed += units; }
function saveYtCache() {
  rollQuota();
  // Never write the API key into this file.
  fs.writeFileSync(YT_CACHE_FILE, JSON.stringify(ytCache, null, 1));
}

const decode = s => (s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n));

async function get(url, opts = {}) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
  try { return await fetch(url, { ...opts, signal: ctl.signal, headers: { 'User-Agent': UA, ...(opts.headers || {}) } }); }
  finally { clearTimeout(t); }
}

// Cricut/vinyl keyword tagger: anything mentioning these also shows under Cricut & Vinyl
const CRICUT_RE = /\b(cricut|vinyl|htv|iron[- ]on|sublimation|decal|silhouette cameo|design space|infusible ink)\b/i;
const HOME_RE = /\b(shiplap|backsplash|tile|drywall|home improvement|home reno|renovation|baseboard|wainscot|framing a)\b/i;
const WOOD_RE = /\b(woodwork|cutting board|joinery|table saw|tablesaw|router table|hardwood|charcuterie|beginner wood)\b/i;
const CRAFTS_RE = /\b(resin|diy craft|crafts? project|scrapbook|polymer clay|embroidery)\b/i;
const MEALPREP_RE = /\b(meal prep|meal-prep|mealprep|prep(?:ped)? meals|lunch prep|sunday meal prep|prep for the week)\b/i;
const MEALPLAN_RE = /\b(meal plan|meal-plan|mealplan|weekly menu|weekly plan|menu plan|grocery list|plan your meals|7[- ]day meal|meal planning)\b/i;
const RECIPES_RE = /\b(dinner recipe|easy recipe|healthy recipe|family meal|weeknight dinner|crock[- ]?pot|slow cooker|sheet pan dinner|one[- ]pot (?:dinner|meal)|30[- ]minute (?:dinner|meal)|recipes?)\b/i;
const YARD_RE = /\b(landscap(?:e|ing)|yard (?:work|project|makeover|design|diy)|backyard (?:makeover|diy|patio|project)|raised (?:garden )?bed|garden bed|paver patio|pavers?|retaining wall|fire pit|lawn care|fence (?:install|post|build)|hardscape|outdoor (?:kitchen|living|diy))\b/i;

function categorize(text, base) {
  const c = new Set();
  if (base) c.add(base);
  if (CRICUT_RE.test(text || '')) c.add('cricut');
  if (HOME_RE.test(text || '')) c.add('home');
  if (WOOD_RE.test(text || '')) c.add('wood');
  if (CRAFTS_RE.test(text || '')) c.add('crafts');
  if (MEALPREP_RE.test(text || '')) c.add('mealprep');
  if (MEALPLAN_RE.test(text || '')) c.add('mealplan');
  if (RECIPES_RE.test(text || '')) c.add('recipes');
  if (YARD_RE.test(text || '')) c.add('yard');
  return [...c];
}
const tagCats = (base, text) => categorize(text, base);

function inferCategory(text) {
  if (CRICUT_RE.test(text || '')) return 'cricut';
  if (HOME_RE.test(text || '')) return 'home';
  if (WOOD_RE.test(text || '')) return 'wood';
  if (CRAFTS_RE.test(text || '')) return 'crafts';
  if (MEALPREP_RE.test(text || '')) return 'mealprep';
  if (MEALPLAN_RE.test(text || '')) return 'mealplan';
  if (RECIPES_RE.test(text || '')) return 'recipes';
  if (YARD_RE.test(text || '')) return 'yard';
  return null;
}

function isShortVideo(title, durationISO) {
  if (/#shorts?\b/i.test(title || '')) return true;
  if (!durationISO) return false;
  const m = String(durationISO).match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return false;
  const sec = (Number(m[1]) || 0) * 3600 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0);
  return sec > 0 && sec <= 60;
}

function ytCard(vid, { title, description, channelTitle, channelId, published, duration, category }) {
  const text = `${title || ''} ${description || ''}`;
  const isShort = isShortVideo(title, duration);
  const categories = categorize(text, category);
  return {
    id: `yt:${vid}`, platform: 'youtube', categories,
    title: title || 'YouTube video', creator: channelTitle || 'YouTube',
    creatorUrl: channelId ? `https://www.youtube.com/channel/${channelId}` : 'https://www.youtube.com',
    url: isShort ? `https://www.youtube.com/shorts/${vid}` : `https://www.youtube.com/watch?v=${vid}`,
    published: published || null,
    thumb: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
    embed: `https://www.youtube-nocookie.com/embed/${vid}?autoplay=1&rel=0`,
    aspect: isShort ? '9/16' : '16/9',
    isShort
  };
}

// ---------------- YouTube Data API v3 (server-side only) ----------------
const YT_API = 'https://www.googleapis.com/youtube/v3';
const ytInflight = new Map();

async function ytGet(endpoint, params, units) {
  const key = youtubeKey();
  if (!key) throw new Error('YouTube API key not configured (set YOUTUBE_API_KEY or .youtube_key)');
  rollQuota();
  if (ytCache.quotaUsed + units > YT_QUOTA_LIMIT) {
    throw new Error(`YouTube quota exhausted for the day (${ytCache.quotaUsed} of ${YT_QUOTA_LIMIT} used)`);
  }
  const u = new URL(`${YT_API}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') u.searchParams.set(k, String(v));
  u.searchParams.set('key', key);
  let r, text;
  try { r = await get(u.toString()); text = await r.text(); }
  catch (e) { throw new Error(redact(e.message || e)); }
  let body;
  try { body = JSON.parse(text); } catch { body = { error: { message: `HTTP ${r.status} non-JSON response` } }; }
  if (!r.ok || body.error) {
    throw new Error(redact(body.error?.message || `HTTP ${r.status}`));
  }
  addQuota(units);
  return body;
}

async function hydrateVideos(ids, category) {
  const unique = [...new Set((ids || []).filter(Boolean))];
  const out = new Map();
  for (let i = 0; i < unique.length; i += 50) {
    const batch = unique.slice(i, i + 50);
    const j = await ytGet('videos', { part: 'snippet,contentDetails,status', id: batch.join(','), maxResults: '50' }, 1);
    for (const v of j.items || []) {
      if (v.status && v.status.embeddable === false) continue;
      if (v.status && (v.status.privacyStatus === 'private' || v.status.privacyStatus === 'privacyStatusUnspecified')) continue;
      const sn = v.snippet || {};
      const text = `${sn.title || ''} ${sn.description || ''}`;
      const cat = category || inferCategory(text);
      out.set(v.id, ytCard(v.id, {
        title: sn.title,
        description: (sn.description || '').slice(0, 400),
        channelTitle: sn.channelTitle,
        channelId: sn.channelId,
        published: sn.publishedAt,
        duration: v.contentDetails && v.contentDetails.duration,
        category: cat
      }));
    }
  }
  return out;
}

async function searchYouTubeUniq(query, { category, maxResults = 25 } = {}) {
  const qn = String(query || '').trim().toLowerCase();
  if (qn.length < 3) return [];
  const cached = ytCache.searches[qn];
  const fresh = cached && (Date.now() - Date.parse(cached.fetchedAt) < YT_TTL_MS);
  if (fresh) return cached.items || [];
  rollQuota();
  if (cached && ytCache.quotaUsed + 100 > YT_QUOTA_SOFT_CAP) return cached.items || [];
  const j = await ytGet('search', {
    part: 'snippet',
    type: 'video',
    videoEmbeddable: 'true',
    safeSearch: 'moderate',
    relevanceLanguage: 'en',
    maxResults: String(maxResults),
    q: query
  }, 100);
  const ids = (j.items || []).map(it => it.id && it.id.videoId).filter(Boolean);
  const hydrated = await hydrateVideos(ids, category);
  const items = ids.map(id => hydrated.get(id)).filter(Boolean);
  if (category) items.forEach(it => { if (!it.categories.includes(category)) it.categories.unshift(category); });
  ytCache.searches[qn] = {
    fetchedAt: new Date().toISOString(),
    items,
    units: 100 + Math.ceil(ids.length / 50),
    query: qn
  };
  saveYtCache();
  return items;
}

function searchYouTube(query, opts) {
  const qn = String(query || '').trim().toLowerCase();
  if (!qn) return Promise.resolve([]);
  if (ytInflight.has(qn)) return ytInflight.get(qn);
  const p = searchYouTubeUniq(query, opts).finally(() => ytInflight.delete(qn));
  ytInflight.set(qn, p);
  return p;
}

async function fetchChannelUploads(channels) {
  const list = channels || [];
  if (!list.length) return {};
  const fresh = ytCache.channelsFetchedAt && (Date.now() - Date.parse(ytCache.channelsFetchedAt) < YT_TTL_MS);
  if (fresh && ytCache.channelItems) return ytCache.channelItems;
  const metaOf = Object.fromEntries(list.map(ch => [ch.channelId, ch]));
  const ids = list.map(ch => ch.channelId);
  const uploads = {};
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const j = await ytGet('channels', { part: 'contentDetails', id: batch.join(',') }, 1);
    for (const ch of j.items || []) {
      const pl = ch.contentDetails && ch.contentDetails.relatedPlaylists && ch.contentDetails.relatedPlaylists.uploads;
      if (pl) uploads[ch.id] = pl;
    }
  }
  const collected = []; // { channelId, videoIds }
  for (const [channelId, playlistId] of Object.entries(uploads)) {
    try {
      const j = await ytGet('playlistItems', { part: 'snippet,contentDetails', playlistId, maxResults: '8' }, 1);
      const videoIds = (j.items || []).map(it => (it.contentDetails && it.contentDetails.videoId) || (it.snippet && it.snippet.resourceId && it.snippet.resourceId.videoId)).filter(Boolean);
      collected.push({ channelId, videoIds });
    } catch (e) {
      const meta = metaOf[channelId];
      cache.status[`yt:${channelId}`] = {
        label: `YouTube · ${meta ? meta.name : channelId}`, ok: false, error: redact(e.message),
        at: new Date().toISOString(), servingCached: !!(cache.sources[`yt:${channelId}`] && cache.sources[`yt:${channelId}`].items),
        count: (cache.sources[`yt:${channelId}`] && cache.sources[`yt:${channelId}`].items || []).length
      };
    }
  }
  const hydrated = await hydrateVideos(collected.flatMap(c => c.videoIds));
  const byChannel = {};
  for (const { channelId, videoIds } of collected) {
    const meta = metaOf[channelId];
    const items = videoIds.map(id => {
      const it = hydrated.get(id);
      if (!it) return null;
      if (meta && meta.category && !it.categories.includes(meta.category)) it.categories.unshift(meta.category);
      if (meta && meta.name) it.creator = meta.name;
      return it;
    }).filter(Boolean);
    byChannel[channelId] = items;
    cache.sources[`yt:${channelId}`] = { items, fetchedAt: new Date().toISOString() };
    cache.status[`yt:${channelId}`] = {
      label: `YouTube · ${meta ? meta.name : channelId}`, ok: true, count: items.length,
      at: new Date().toISOString()
    };
  }
  // Merge into any seeded/cached channel items; never replace a richer cache with a thinner fetch.
  const merged = Object.assign({}, ytCache.channelItems || {});
  for (const [channelId, items] of Object.entries(byChannel)) {
    if (items && items.length && (!(merged[channelId] || []).length || items.length >= merged[channelId].length)) {
      merged[channelId] = items;
    }
  }
  ytCache.channelItems = merged;
  ytCache.channelsFetchedAt = new Date().toISOString();
  saveYtCache();
  saveCache();
  return merged;
}

// Fallback when no API key is configured: public channel RSS (can 404/500 for hours)
async function fetchYouTubeRss(ch) {
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${ch.channelId}`;
  let err;
  for (const wait of [0, 4000, 15000]) {
    if (wait) await sleep(wait);
    try {
      const r = await get(url);
      if (r.status !== 200) { err = `HTTP ${r.status}`; continue; }
      const xml = await r.text();
      const entries = xml.split('<entry>').slice(1);
      return entries.slice(0, 8).map(e => {
        const vid = (e.match(/<yt:videoId>([^<]+)/) || [])[1];
        const title = decode((e.match(/<title>([^<]*)/) || [])[1]);
        const desc = decode((e.match(/<media:description>([\s\S]*?)<\/media:description>/) || [])[1] || '');
        return ytCard(vid, { title, description: desc.slice(0, 400), channelTitle: ch.name, channelId: ch.channelId, published: (e.match(/<published>([^<]+)/) || [])[1], category: ch.category });
      });
    } catch (e) { err = e.message; }
  }
  throw new Error(err || 'failed');
}

// ---------------- Reddit: official API (OAuth if creds) else public JSON ----------------
let redditToken = null, redditTokenExp = 0;
async function redditAuth() {
  const id = process.env.REDDIT_CLIENT_ID, secret = process.env.REDDIT_CLIENT_SECRET;
  if (!id || !secret) return null;
  if (redditToken && Date.now() < redditTokenExp) return redditToken;
  const r = await get('https://www.reddit.com/api/v1/access_token', {
    method: 'POST', body: 'grant_type=client_credentials',
    headers: { Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  const j = await r.json(); if (!j.access_token) throw new Error('Reddit auth failed');
  redditToken = j.access_token; redditTokenExp = Date.now() + (j.expires_in - 60) * 1000; return redditToken;
}
async function fetchReddit(src) {
  const token = await redditAuth();
  const base = token ? 'https://oauth.reddit.com' : 'https://www.reddit.com';
  const r = await get(`${base}/r/${src.subreddit}/hot${token ? '' : '.json'}?limit=100&raw_json=1`,
    token ? { headers: { Authorization: `Bearer ${token}` } } : {});
  if (r.status !== 200) throw new Error(`HTTP ${r.status}${r.status === 403 ? ' (Reddit blocks unauthenticated requests from this server IP; add REDDIT_CLIENT_ID/SECRET)' : ''}`);
  const j = await r.json(); const out = [];
  for (const { data: p } of j.data.children) {
    if (p.over_18 || p.stickied) continue;
    const link = `https://www.reddit.com${p.permalink}`;
    const common = { categories: tagCats(src.category, p.title), title: p.title, creator: `u/${p.author} · r/${src.subreddit}`,
      creatorUrl: `https://www.reddit.com/r/${src.subreddit}`, url: link, published: new Date(p.created_utc * 1000).toISOString() };
    const yt = (p.url || '').match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|shorts\/))([\w-]{11})/);
    if (p.is_video && p.media && p.media.reddit_video) {
      out.push({ id: `rd:${p.id}`, platform: 'reddit', ...common,
        thumb: (p.preview && p.preview.images && p.preview.images[0] && p.preview.images[0].source && p.preview.images[0].source.url) || null,
        embed: `https://embed.reddit.com${p.permalink}?embed=true&theme=dark`, aspect: '4/5' });
    } else if (yt) {
      out.push({ id: `rd:${p.id}`, platform: 'reddit', via: 'youtube', ...common,
        thumb: `https://i.ytimg.com/vi/${yt[1]}/hqdefault.jpg`,
        embed: `https://www.youtube-nocookie.com/embed/${yt[1]}?autoplay=1&rel=0`, aspect: '16/9' });
    }
  }
  return out.slice(0, 25);
}

// ---------------- TikTok / Instagram / Pinterest: official embeds ----------------
async function fetchEmbed(e) {
  const u = e.url;
  if (/tiktok\.com/.test(u)) {
    const vid = u.match(/video\/(\d+)/)[1];
    const r = await get(`https://www.tiktok.com/oembed?url=${encodeURIComponent(u.split('?')[0])}`);
    if (r.status !== 200) throw new Error(`oEmbed HTTP ${r.status}`);
    const j = await r.json(); if (!j.html) throw new Error('not embeddable');
    const handle = (u.match(/@([\w.]+)/) || [])[1];
    const title = j.title || e.title || 'TikTok video';
    return [{ id: `tt:${vid}`, platform: 'tiktok', categories: tagCats(e.category, title), title,
      creator: '@' + (j.author_unique_id || handle || j.author_name), creatorUrl: j.author_url || `https://www.tiktok.com/@${handle}`,
      url: u.split('?')[0], thumb: j.thumbnail_url || null, clickToLoad: true,
      embed: `https://www.tiktok.com/player/v1/${vid}?autoplay=1&description=0&music_info=0&rel=0`, aspect: '9/16' }];
  }
  if (/instagram\.com/.test(u)) {
    const code = u.match(/\/(?:reel|p)\/([\w-]+)/)[1];
    const r = await get(`https://www.instagram.com/reel/${code}/embed/`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (r.status !== 200) throw new Error(`embed HTTP ${r.status}`);
    return [{ id: `ig:${code}`, platform: 'instagram', categories: tagCats(e.category, e.title), title: e.title || 'Instagram reel',
      creator: e.author || 'Instagram', creatorUrl: u, url: u, thumb: null,
      embed: `https://www.instagram.com/reel/${code}/embed/`, aspect: '9/16', tall: true }];
  }
  if (/pinterest\./.test(u)) {
    const pin = u.match(/pin\/(?:[^/]*--)?(\d+)/)[1];
    const r = await get(`https://www.pinterest.com/oembed.json?url=${encodeURIComponent(`https://www.pinterest.com/pin/${pin}/`)}`);
    if (r.status !== 200) throw new Error(`oEmbed HTTP ${r.status}`);
    const j = await r.json();
    return [{ id: `pin:${pin}`, platform: 'pinterest', categories: tagCats(e.category, j.title), title: (j.title || '').trim() || e.title || 'Pinterest idea pin',
      creator: j.author_name || 'Pinterest', creatorUrl: j.author_url, url: `https://www.pinterest.com/pin/${pin}/`, thumb: null,
      embed: `https://assets.pinterest.com/ext/embed.html?id=${pin}`, aspect: `${j.width || 450}/${(j.height || 800) + 20}`, tall: true }];
  }
  throw new Error('unsupported embed URL');
}

// ---------------- refresh loop ----------------
let refreshing = false;
async function run(key, label, fn) {
  try {
    const items = await fn();
    cache.sources[key] = { items, fetchedAt: new Date().toISOString() };
    cache.status[key] = { label, ok: true, count: items.length, at: new Date().toISOString() };
  } catch (e) {
    cache.status[key] = { label, ok: false, error: redact(e.message), at: new Date().toISOString(),
      servingCached: !!cache.sources[key], count: (cache.sources[key] && cache.sources[key].items || []).length };
  }
}

async function refreshYouTube(S) {
  if (!hasYoutubeKey()) {
    console.log('[youtube] no API key configured (set YOUTUBE_API_KEY or .youtube_key); falling back to channel RSS');
    for (const ch of S.youtube || []) {
      await run(`yt:${ch.channelId}`, `YouTube · ${ch.name}`, () => fetchYouTubeRss(ch));
      await sleep(2000);
    }
    return 0;
  }
  rollQuota();
  const unitsBefore = ytCache.quotaUsed;
  const queries = S.youtubeSearch || DEFAULT_YT_QUERIES;
  let searchOk = 0, searchFail = 0;
  for (const [cat, qs] of Object.entries(queries)) {
    for (const q of qs) {
      try {
        const items = await searchYouTube(q, { category: cat, maxResults: 25 });
        searchOk += 1;
        cache.status[`ytsearch:${cat}:${q}`] = {
          label: `YouTube search · ${q}`, ok: true, count: items.length, at: new Date().toISOString()
        };
      } catch (e) {
        searchFail += 1;
        cache.status[`ytsearch:${cat}:${q}`] = {
          label: `YouTube search · ${q}`, ok: false, error: redact(e.message), at: new Date().toISOString(),
          servingCached: !!(ytCache.searches[q.trim().toLowerCase()] && ytCache.searches[q.trim().toLowerCase()].items),
          count: ((ytCache.searches[q.trim().toLowerCase()] || {}).items || []).length
        };
        console.error('[youtube] search failed:', redact(e.message));
      }
      await sleep(120);
    }
  }
  try { await fetchChannelUploads(S.youtube || []); }
  catch (e) { console.error('[youtube] channel uploads failed:', redact(e.message)); }
  const used = ytCache.quotaUsed - unitsBefore;
  cache.status['yt:api'] = {
    label: 'YouTube Data API v3', ok: searchFail === 0, count: searchOk,
    at: new Date().toISOString(), quotaUnitsThisRefresh: used
  };
  return used;
}

async function refresh() {
  if (refreshing) return; refreshing = true;
  const S = loadSources(); const t0 = Date.now();
  rollQuota();
  const unitsBefore = ytCache.quotaUsed;
  try {
    await Promise.all([
      refreshYouTube(S),
      (async () => { for (const s of S.reddit) { await run(`rd:${s.subreddit}`, `Reddit · r/${s.subreddit}`, () => fetchReddit(s)); await sleep(1500); } })(),
      (async () => { for (const e of S.embeds) { await run(`em:${e.url}`, `Embed · ${e.url}`, () => fetchEmbed(e)); await sleep(300); } })(),
    ]);
  } finally {
    const used = ytCache.quotaUsed - unitsBefore;
    ytCache.lastRefreshUnits = used;
    cache.lastRefresh = new Date().toISOString();
    saveYtCache(); saveCache(); refreshing = false;
    const bad = Object.values(cache.status).filter(s => !s.ok).length;
    console.log(`[${new Date().toISOString()}] refresh done in ${((Date.now() - t0) / 1000) | 0}s, ${bad} source(s) failing; YouTube quota this refresh: ${used} units, today: ${ytCache.quotaUsed}/${YT_QUOTA_LIMIT}`);
  }
}

function buildFeed() {
  const S = loadSources(); const seen = new Set(); const items = [];
  const push = it => { if (it && !seen.has(it.id)) { seen.add(it.id); items.push(it); } };
  const queries = S.youtubeSearch || DEFAULT_YT_QUERIES;
  for (const qs of Object.values(queries)) {
    for (const q of qs) {
      const rec = ytCache.searches[String(q).trim().toLowerCase()];
      (rec && rec.items || []).forEach(push);
    }
  }
  for (const ch of S.youtube || []) {
    const c = cache.sources[`yt:${ch.channelId}`];
    if (c && c.items && c.items.length) c.items.forEach(push);
    else if (ytCache.channelItems && ytCache.channelItems[ch.channelId]) ytCache.channelItems[ch.channelId].forEach(push);
  }
  for (const s of S.reddit) (cache.sources[`rd:${s.subreddit}`] && cache.sources[`rd:${s.subreddit}`].items || []).forEach(push);
  for (const e of S.embeds) (cache.sources[`em:${e.url}`] && cache.sources[`em:${e.url}`].items || []).forEach(push);
  return items;
}

function mix(items) {
  const groups = {}; for (const it of items) (groups[it.creator] ||= []).push(it);
  Object.values(groups).forEach(g => g.sort((a, b) => (b.published || '').localeCompare(a.published || '')));
  const out = []; const lists = Object.values(groups);
  for (let i = 0; out.length < items.length; i++) for (const g of lists) if (g[i]) out.push(g[i]);
  return out;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

async function handle(req, res) {
  const u = new URL(req.url, 'http://x');
  if (await handleAuth(req, res, u, id => id ? buildFeed().find(i => i.id === id) : null)) return;
  if (u.pathname === '/api/feed') {
    const cat = u.searchParams.get('cat') || 'all';
    const q = (u.searchParams.get('q') || '').trim();
    const plat = u.searchParams.get('platform') || 'all';
    let items = buildFeed();
    if (q.length >= 3 && hasYoutubeKey() && (plat === 'all' || plat === 'youtube')) {
      try {
        const extra = await searchYouTube(q, { maxResults: 25 });
        const seen = new Set(items.map(i => i.id));
        for (const it of extra) if (!seen.has(it.id)) { seen.add(it.id); items.push(it); }
      } catch (e) {
        console.error('[youtube] live search failed:', redact(e.message));
      }
    }
    if (cat !== 'all') items = items.filter(i => i.categories && i.categories.includes(cat));
    if (plat !== 'all') items = items.filter(i => i.platform === plat);
    if (q) {
      const ql = q.toLowerCase();
      const ytHits = new Set(((ytCache.searches[ql] || {}).items || []).map(i => i.id));
      items = items.filter(i => ytHits.has(i.id) || `${i.title} ${i.creator}`.toLowerCase().includes(ql));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ lastRefresh: cache.lastRefresh, count: items.length, items: mix(items) }));
  }
  if (u.pathname === '/api/status') {
    const all = buildFeed(); const S = loadSources(); const counts = {};
    for (const k of ['all', ...Object.keys(S.categories)]) counts[k] = k === 'all' ? all.length : all.filter(i => i.categories && i.categories.includes(k)).length;
    const byPlatform = {}; all.forEach(i => byPlatform[i.platform] = (byPlatform[i.platform] || 0) + 1);
    rollQuota();
    const youtube = {
      configured: hasYoutubeKey(),
      quotaUsedToday: ytCache.quotaUsed,
      quotaLimit: YT_QUOTA_LIMIT,
      quotaDatePacific: ytCache.quotaDate,
      lastRefreshUnits: ytCache.lastRefreshUnits || 0,
      cacheTtlHours: YT_TTL_MS / 3600000,
      cachedSearches: Object.keys(ytCache.searches || {}).length,
      channelsFetchedAt: ytCache.channelsFetchedAt || null
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ lastRefresh: cache.lastRefresh, refreshing, counts, byPlatform, categories: S.categories, youtube, sources: cache.status }, null, 1));
  }
  if (u.pathname === '/api/refresh' && req.method === 'POST') { refresh(); res.writeHead(202); return res.end('{"started":true}'); }
  let f = path.normalize(path.join(ROOT, 'public', u.pathname === '/' ? 'index.html' : u.pathname));
  if (!f.startsWith(path.join(ROOT, 'public'))) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const headers = { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' };
    // Serve the service worker from the site root so it can control the whole app.
    if (u.pathname === '/' || u.pathname === '/index.html') headers['Cache-Control'] = 'no-cache';
    if (u.pathname === '/sw.js') {
      headers['Service-Worker-Allowed'] = '/';
      headers['Cache-Control'] = 'no-cache';
    }
    res.writeHead(200, headers); res.end(buf);
  });
}

http.createServer((req, res) => {
  Promise.resolve(handle(req, res)).catch(err => {
    console.error('[http]', redact(err && err.message));
    if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"error":"internal"}'); }
  });
}).listen(PORT, () => console.log(`DIY Reels on http://localhost:${PORT}`));

refresh();
setInterval(refresh, REFRESH_MIN * 60 * 1000);
