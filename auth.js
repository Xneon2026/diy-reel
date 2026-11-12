// DIY Reels accounts: username/password login, sessions, and per-user saved videos.
// Needs DATABASE_URL (Postgres, e.g. Neon) and SESSION_SECRET in the environment. Neither is ever logged.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { neon } = require('@neondatabase/serverless'); // queries over HTTPS, so no long-lived DB connections

const DB_URL = (process.env.DATABASE_URL || '').trim();
const SECRET = (process.env.SESSION_SECRET || '').trim() || crypto.randomBytes(32).toString('hex');
const SESSION_DAYS = 60;
const COOKIE = 'sid';

let pool = null;
let ready = null;
if (DB_URL) {
  const sql = neon(DB_URL);
  pool = { query: async (text, params = []) => ({ rows: await sql.query(text, params) }) };
  ready = migrate().then(() => true).catch(e => { console.error('[db] migrate failed:', safe(e)); ready = null; return false; });
}
function safe(e) { return String(e && e.message || e).replace(/postgres(ql)?:\/\/\S+/gi, '[db-url]'); }
const enabled = () => !!pool;

async function migrate() {
  await pool.query(`CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY,
    username TEXT NOT NULL,
    username_lower TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    email TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS saves (
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    video_id TEXT NOT NULL,
    item JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, video_id))`);
  await pool.query(`DELETE FROM sessions WHERE expires_at < now()`);
}
async function db() {
  if (!pool) throw Object.assign(new Error('accounts not configured'), { status: 503 });
  if (ready === null) ready = migrate().then(() => true).catch(e => { console.error('[db] migrate failed:', safe(e)); ready = null; return false; });
  if (!(await ready)) throw Object.assign(new Error('database unavailable'), { status: 503 });
  return pool;
}

// ---- helpers ----
const tokenHash = t => crypto.createHmac('sha256', SECRET).update(t).digest('hex');
function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('='); if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const isHttps = req => String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
function setCookie(req, res, value, maxAge) {
  const parts = [`${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
  if (isHttps(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}
function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(Object.assign(new Error('bad json'), { status: 400 })); } });
    req.on('error', reject);
  });
}
function clientIp(req) { return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(); }

// ---- basic rate limiting (in memory): login/sign-up attempts per IP and per username ----
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now(); let h = hits.get(key);
  if (!h || h.reset < now) { h = { n: 0, reset: now + windowMs }; hits.set(key, h); }
  h.n++; return h.n > max;
}
setInterval(() => { const now = Date.now(); for (const [k, h] of hits) if (h.reset < now) hits.delete(k); }, 10 * 60 * 1000).unref();

async function currentUser(req) {
  if (!pool) return null;
  const t = cookies(req)[COOKIE]; if (!t || t.length < 20) return null;
  const p = await db();
  const r = await p.query(`SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now()`, [tokenHash(t)]);
  return r.rows[0] || null;
}
async function startSession(req, res, userId) {
  const t = crypto.randomBytes(32).toString('base64url');
  const p = await db();
  await p.query(`INSERT INTO sessions(token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '${SESSION_DAYS} days')`, [tokenHash(t), userId]);
  setCookie(req, res, t, SESSION_DAYS * 86400);
}

// Keep only known, safe fields of a saved video so the Saved tab can show it even after it leaves the feed.
const httpsUrl = v => (typeof v === 'string' && /^https:\/\//i.test(v) && v.length <= 1000) ? v : '';
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
function cleanItem(it) {
  if (!it || typeof it !== 'object') return null;
  const id = str(it.id, 300); if (!id) return null;
  return {
    id, platform: str(it.platform, 20), title: str(it.title, 400), creator: str(it.creator, 200),
    creatorUrl: httpsUrl(it.creatorUrl), url: httpsUrl(it.url), embed: httpsUrl(it.embed), thumb: httpsUrl(it.thumb),
    aspect: /^[0-9.]+\s*\/\s*[0-9.]+$/.test(String(it.aspect || '')) ? String(it.aspect) : '16/9',
    published: str(it.published, 40), via: str(it.via, 20), clickToLoad: !!it.clickToLoad,
    categories: Array.isArray(it.categories) ? it.categories.filter(c => typeof c === 'string').slice(0, 12).map(c => c.slice(0, 30)) : []
  };
}

const USER_RE = /^[A-Za-z0-9_.-]{3,30}$/;

// Returns true when it handled the request.
async function handleAuth(req, res, u, findItem) {
  const p = u.pathname;
  if (!p.startsWith('/api/auth/') && p !== '/api/saved') return false;
  try {
    if (req.method !== 'GET' && !String(req.headers['content-type'] || '').includes('application/json')) return send(res, 415, { error: 'Send JSON.' }), true;

    if (p === '/api/auth/me' && req.method === 'GET') {
      if (!pool) return send(res, 200, { enabled: false, user: null }), true;
      const user = await currentUser(req);
      return send(res, 200, { enabled: true, user: user && { username: user.username } }), true;
    }

    if ((p === '/api/auth/signup' || p === '/api/auth/login') && req.method === 'POST') {
      const ip = clientIp(req);
      const b = await readBody(req);
      const username = String(b.username || '').trim();
      const password = String(b.password || '');
      if (p === '/api/auth/signup') {
        if (limited('su:' + ip, 10, 60 * 60 * 1000)) return send(res, 429, { error: 'Too many sign-ups from here. Try again later.' }), true;
        if (!USER_RE.test(username)) return send(res, 400, { error: 'Username: 3–30 letters, numbers, dots, dashes or underscores.' }), true;
        if (password.length < 8 || password.length > 200) return send(res, 400, { error: 'Password must be at least 8 characters.' }), true;
        let email = String(b.email || '').trim();
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return send(res, 400, { error: 'That email doesn’t look right (or leave it blank).' }), true;
        email = email ? email.slice(0, 200) : null;
        const pg = await db();
        const hash = await bcrypt.hash(password, 12);
        const r = await pg.query(`INSERT INTO users(username, username_lower, password_hash, email) VALUES ($1, $2, $3, $4) ON CONFLICT (username_lower) DO NOTHING RETURNING id, username`, [username, username.toLowerCase(), hash, email]);
        if (!r.rows[0]) return send(res, 409, { error: 'That username is taken.' }), true;
        await startSession(req, res, r.rows[0].id);
        return send(res, 200, { user: { username: r.rows[0].username } }), true;
      }
      if (limited('li:' + ip, 20, 15 * 60 * 1000) || limited('lu:' + username.toLowerCase(), 10, 15 * 60 * 1000))
        return send(res, 429, { error: 'Too many tries. Wait 15 minutes and try again.' }), true;
      const pg = await db();
      const r = await pg.query(`SELECT id, username, password_hash FROM users WHERE username_lower = $1`, [username.toLowerCase()]);
      const row = r.rows[0];
      const ok = row ? await bcrypt.compare(password, row.password_hash) : (await bcrypt.compare(password, '$2b$12$LK803o3XDGCp/WfKAhzB9e4rxrZ0b2NsjID4QjV.0k.909vM4hDH.'), false);
      if (!ok) return send(res, 401, { error: 'Wrong username or password.' }), true;
      await startSession(req, res, row.id);
      return send(res, 200, { user: { username: row.username } }), true;
    }

    if (p === '/api/auth/logout' && req.method === 'POST') {
      const t = cookies(req)[COOKIE];
      if (t && pool) { const pg = await db(); await pg.query(`DELETE FROM sessions WHERE token_hash = $1`, [tokenHash(t)]); }
      setCookie(req, res, '', 0);
      return send(res, 200, { ok: true }), true;
    }

    if (p === '/api/saved') {
      const user = await currentUser(req);
      if (!user) return send(res, 401, { error: 'Log in to save videos.' }), true;
      const pg = await db();
      if (req.method === 'GET') {
        const r = await pg.query(`SELECT item FROM saves WHERE user_id = $1 ORDER BY created_at DESC`, [user.id]);
        return send(res, 200, { count: r.rows.length, items: r.rows.map(x => x.item) }), true;
      }
      if (req.method === 'POST') {
        const b = await readBody(req);
        const id = str(b.id || (b.item && b.item.id), 300);
        const item = cleanItem(findItem(id) || Object.assign({}, b.item, { id }));
        if (!item) return send(res, 400, { error: 'Missing video.' }), true;
        const n = await pg.query(`SELECT count(*)::int AS n FROM saves WHERE user_id = $1`, [user.id]);
        if (n.rows[0].n >= 2000) return send(res, 400, { error: 'Saved list is full (2,000 videos).' }), true;
        await pg.query(`INSERT INTO saves(user_id, video_id, item) VALUES ($1, $2, $3) ON CONFLICT (user_id, video_id) DO NOTHING`, [user.id, item.id, JSON.stringify(item)]);
        return send(res, 200, { ok: true, id: item.id }), true;
      }
      if (req.method === 'DELETE') {
        const b = await readBody(req);
        const id = str(b.id || u.searchParams.get('id'), 300);
        await pg.query(`DELETE FROM saves WHERE user_id = $1 AND video_id = $2`, [user.id, id]);
        return send(res, 200, { ok: true, id }), true;
      }
    }
    return send(res, 404, { error: 'not found' }), true;
  } catch (e) {
    if (e.status) return send(res, e.status, { error: e.status === 503 ? 'Accounts are temporarily unavailable.' : e.message }), true;
    console.error('[auth]', safe(e));
    return send(res, 500, { error: 'Something went wrong. Try again.' }), true;
  }
}

module.exports = { handleAuth, enabled };
