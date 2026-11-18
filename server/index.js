// Foodie Guide server.
//   - Serves the static guide in ../app (so /admin and /entry work as routes).
//   - Public  POST /api/entries        : submit a recommendation (status=pending).
//   - Admin   GET   /api/entries        : list submissions (Basic Auth).
//   - Admin   PATCH /api/entries/:id    : approve / reject / edit (Basic Auth).
//   - Public  POST /api/entries/:id/suggestions : suggest a dish for a "chef's choice" place.
//   - Admin   DELETE /api/entries/:id   : remove a submission (Basic Auth).
require('./env');
const path = require('path');
const express = require('express');
const db = require('./db');
const { pool, init } = db;
const { seedIfEmpty } = require('./seed');
const { CITY_META, ORDER, cleanCuisine } = require('../build');

const app = express();
const PORT = process.env.PORT || 3000;
const APP_DIR = path.join(__dirname, '..', 'app');

// City id -> display metadata, derived from build.js's CITY_META.
const CITY_BY_ID = {};
for (const meta of Object.values(CITY_META)) CITY_BY_ID[meta.id] = meta;

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

// Railway sits one proxy hop in front of us; this makes req.ip the real client IP.
app.set('trust proxy', 1);
app.use(express.json({ limit: '64kb' }));

// Per-IP fixed-window rate limit for public endpoints.
// shortcut: in-memory, resets on restart and isn't shared across instances; swap for
// express-rate-limit + a shared store if the API ever runs on more than one instance.
function rateLimit(max, windowMs) {
  const hits = new Map(); // ip -> { n, reset }
  return (req, res, next) => {
    const now = Date.now();
    if (hits.size > 10000) for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
    let h = hits.get(req.ip);
    if (!h || h.reset <= now) hits.set(req.ip, (h = { n: 0, reset: now + windowMs }));
    if (++h.n > max) {
      res.set('Retry-After', String(Math.ceil((h.reset - now) / 1000)));
      return res.status(429).json({ error: 'Too many requests. Try again later.' });
    }
    next();
  };
}
const HOUR = 60 * 60 * 1000;

// --- CORS (lets a separately-hosted frontend, e.g. Netlify, call the API) ---
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
app.use('/api', (req, res, next) => {
  res.set('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.set('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// --- Basic Auth for admin-only routes ---
function isAdmin(req) {
  if (!ADMIN_PASSWORD) return false;
  const header = req.get('authorization') || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme !== 'Basic' || !encoded) return false;
  const [user, pass] = Buffer.from(encoded, 'base64').toString('utf8').split(':');
  return user === ADMIN_USER && pass === ADMIN_PASSWORD;
}

function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) {
    return res.status(500).json({ error: 'ADMIN_PASSWORD is not configured on the server.' });
  }
  if (isAdmin(req)) return next();
  res.set('WWW-Authenticate', 'Basic realm="Foodie Admin"');
  return res.status(401).json({ error: 'Unauthorized' });
}

const VALID_CITIES = new Set(Object.keys(CITY_BY_ID));

// Accept only Yelp business pages, trimmed to https://www.yelp.com/biz/<slug>
// (drops ?osq=…, #…, /photos; /biz_photos/ and /menu/<slug> map to /biz/<slug>). yelp.to app-share links are followed to that page.
// Returns '' when it isn't a business page. Can't confirm it's a *restaurant*:
// yelp.com blocks server fetches (403), so admin review covers that.
const YELP_ERROR = 'Paste the Yelp page for the place (yelp.com/biz/…).';
function cleanYelpBiz(s) {
  try {
    const u = new URL(s);
    const m = u.pathname.match(/^\/(?:biz|biz_photos|menu)\/([^/]+)/);
    if (!/^https?:$/.test(u.protocol) || !/(^|\.)yelp\.com$/i.test(u.hostname) || !m) return '';
    return `https://www.yelp.com/biz/${m[1]}`;
  } catch { return ''; }
}
async function yelpLink(s) {
  try {
    let url = s;
    for (let hop = 0; hop < 3; hop++) {
      const clean = cleanYelpBiz(url);
      if (clean) return clean;
      const u = new URL(url);
      if (!/^yelp\.to$/i.test(u.hostname)) return ''; // only ever fetch yelp.to
      const r = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
      const next = r.headers.get('location');
      if (!next) return '';
      url = new URL(next, u).href;
    }
  } catch { /* bad URL or network error */ }
  return '';
}
const str = (v, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// The original crew, already in {first}.{last initial} form. Public submitters
// join this roster (once their entry is approved) below.
const FOUNDERS = ['jonathan.g', 'sharon.g', 'euginia.w', 'jeremy.t', 'joshua.r'];

// Turn a free-form "submitted_by" into a {first}.{last initial} handle.
//   "Jane Doe" -> "jane.d" ; "Cher" -> "cher" ; "Mary Jane Watson" -> "mary.w"
function contributorHandle(name) {
  const parts = String(name || '')
    .toLowerCase()
    .replace(/[^a-z\s'-]/g, '')
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return '';
  const first = parts[0];
  const last = parts.length > 1 ? parts[parts.length - 1] : '';
  return last ? `${first}.${last[0]}` : first;
}

// How similar two names must be to count as the same place (0–1). Higher = stricter.
const DUP_THRESHOLD = 0.4;

// Find an existing place in the same city that looks like `name`, ignoring rejected
// ones. Uses pg_trgm fuzzy matching (catches typos / "Cafe" / "LA" variants) when the
// extension is available, otherwise falls back to exact case-insensitive matching.
// Prefers an approved match (already on the guide) over a still-pending one.
function findDuplicate(city, name) {
  if (db.hasTrgm) {
    return pool.query(
      `SELECT name, location, status FROM entries
         WHERE city = $1 AND status <> 'rejected' AND similarity(name, $2) > $3
         ORDER BY (status = 'approved') DESC, similarity(name, $2) DESC
         LIMIT 1`,
      [city, name, DUP_THRESHOLD]
    );
  }
  return pool.query(
    `SELECT name, location, status FROM entries
       WHERE city = $1 AND lower(name) = lower($2) AND status <> 'rejected'
       ORDER BY (status = 'approved') DESC
       LIMIT 1`,
    [city, name]
  );
}

// --- Public: has this place already been suggested / added? ---
app.get('/api/entries/check', rateLimit(60, 60 * 1000), async (req, res) => {
  try {
    const city = str(req.query.city, 8);
    const name = str(req.query.name, 200);
    if (!VALID_CITIES.has(city) || !name) return res.json({ exists: false });
    const { rows } = await findDuplicate(city, name);
    if (!rows.length) return res.json({ exists: false });
    res.json({ exists: true, status: rows[0].status, name: rows[0].name, location: rows[0].location });
  } catch (err) {
    console.error('GET /api/entries/check', err);
    res.json({ exists: false });
  }
});

// --- Public: submit a recommendation (neighborhood and note optional) ---
const submitLimit = rateLimit(15, HOUR);
app.post('/api/entries', (req, res, next) => (isAdmin(req) ? next() : submitLimit(req, res, next)), async (req, res) => {
  try {
    const b = req.body || {};
    const admin = isAdmin(req);
    // Honeypot filled in = bot. Pretend success so it doesn't retry.
    if (!admin && b.website) return res.status(201).json({ ok: true });

    const row = {
      city: str(b.city, 8),
      name: str(b.name, 200),
      cuisine: str(b.cuisine, 80),
      description: str(b.description, 300),
      location: str(b.location, 120),
      price: ['$', '$$', '$$$'].includes(b.price) ? b.price : '',
      yelp: str(b.yelp, 500),
      submitted_by: str(b.submitted_by, 120),
      note: str(b.note, 500),
      anonymous: b.anonymous === true,
    };

    if (!VALID_CITIES.has(row.city)) return res.status(400).json({ error: 'Pick a valid city.' });
    // Free text allowed via "Other"; cleanCuisine folds known labels (e.g. "ramen") onto the list.
    if (row.cuisine) row.cuisine = cleanCuisine(row.cuisine);
    // Every field except neighborhood (location) and note is required.
    const required = ['name', 'cuisine', 'description', 'price', 'yelp', 'submitted_by'];
    const missing = required.filter((f) => !row[f]);
    if (missing.length) return res.status(400).json({ error: `Missing required field(s): ${missing.join(', ')}.` });
    row.yelp = await yelpLink(row.yelp);
    if (!row.yelp) return res.status(400).json({ error: YELP_ERROR });

    // Note: possible duplicates are surfaced to the submitter as a warning via
    // GET /api/entries/check, not blocked here — fuzzy matching can false-positive,
    // and the admin review queue is the backstop.

    // Public submissions are always pending. Admin may set tried / approve directly.
    const tried = admin ? b.tried === true : false;
    const status = admin && b.status === 'approved' ? 'approved' : 'pending';

    const { rows } = await pool.query(
      `INSERT INTO entries
         (city, name, cuisine, description, location, price, yelp, tried, status, submitted_by, note, anonymous, reviewed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, CASE WHEN $9 = 'approved' THEN now() ELSE NULL END)
       RETURNING id, created_at`,
      [row.city, row.name, row.cuisine, row.description, row.location,
       row.price, row.yelp, tried, status, row.submitted_by, row.note, row.anonymous]
    );
    res.status(201).json({ ok: true, id: rows[0].id });
  } catch (err) {
    console.error('POST /api/entries', err);
    res.status(500).json({ error: 'Could not save your recommendation.' });
  }
});

// --- Public: the guide data (approved entries), grouped by city ---
app.get('/api/places', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, city, name, cuisine, description, location, price, yelp, tried
         FROM entries WHERE status = 'approved'
        ORDER BY name ASC`
    );
    const byCity = {};
    for (const r of rows) (byCity[r.city] = byCity[r.city] || []).push({
      id: r.id, tried: r.tried, name: r.name, cuisine: r.cuisine, description: r.description,
      location: r.location, price: r.price, yelp: r.yelp,
    });

    const cities = ORDER.filter((id) => CITY_BY_ID[id]).map((id) => {
      const places = byCity[id] || [];
      return { ...CITY_BY_ID[id], count: places.length, places };
    });
    res.set('Cache-Control', 'no-store');
    res.json({ cities });
  } catch (err) {
    console.error('GET /api/places', err);
    res.status(500).json({ error: 'Could not load the guide.' });
  }
});

// --- Public: contributors (founders + everyone whose entry made the guide) ---
app.get('/api/contributors', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT submitted_by, MIN(created_at) AS first_at
         FROM entries
        WHERE status = 'approved' AND anonymous = FALSE
          AND submitted_by IS NOT NULL AND submitted_by NOT IN ('', 'seed')
        GROUP BY submitted_by
        ORDER BY first_at ASC`
    );
    const contributors = [...FOUNDERS];
    for (const r of rows) {
      const handle = contributorHandle(r.submitted_by);
      if (handle && !contributors.includes(handle)) contributors.push(handle);
    }
    res.set('Cache-Control', 'no-store');
    res.json({ contributors });
  } catch (err) {
    console.error('GET /api/contributors', err);
    res.json({ contributors: FOUNDERS });
  }
});

// --- Admin: list submissions (optional ?status=pending|approved|rejected) ---
app.get('/api/entries', requireAdmin, async (req, res) => {
  try {
    const status = req.query.status;
    const where = ['pending', 'approved', 'rejected'].includes(status) ? 'WHERE e.status = $1'
      : status === 'suggested' ? 'WHERE EXISTS (SELECT 1 FROM suggestions s WHERE s.entry_id = e.id)'
      : '';
    const { rows } = await pool.query(
      `SELECT e.*, COALESCE((SELECT json_agg(json_build_object('id', s.id, 'dish', s.dish, 'submitted_by', s.submitted_by) ORDER BY s.created_at)
                               FROM suggestions s WHERE s.entry_id = e.id), '[]') AS suggestions
         FROM entries e ${where} ORDER BY e.created_at DESC`,
      where.includes('$1') ? [status] : []
    );
    res.json({ entries: rows });
  } catch (err) {
    console.error('GET /api/entries', err);
    res.status(500).json({ error: 'Could not load submissions.' });
  }
});

// --- Admin: approve / reject and/or set the "tried" flag ---
app.patch('/api/entries/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const b = req.body || {};

    const sets = [];
    const vals = [];
    if (b.status !== undefined) {
      if (!['pending', 'approved', 'rejected'].includes(b.status)) {
        return res.status(400).json({ error: 'Invalid status.' });
      }
      vals.push(b.status); sets.push(`status = $${vals.length}`);
      sets.push(`reviewed_at = now()`);
    }
    if (b.tried !== undefined) {
      vals.push(b.tried === true); sets.push(`tried = $${vals.length}`);
    }
    // Content edits. Only fields present in the body change.
    const limits = { name: 200, cuisine: 80, description: 300, location: 120, yelp: 500 };
    for (const [f, max] of Object.entries(limits)) {
      if (b[f] === undefined) continue;
      let v = str(b[f], max);
      if ((f === 'name' || f === 'cuisine') && !v) return res.status(400).json({ error: `${f} can't be empty.` });
      if (f === 'yelp' && v && !(v = await yelpLink(v))) return res.status(400).json({ error: YELP_ERROR });
      vals.push(v); sets.push(`${f} = $${vals.length}`);
    }
    if (b.price !== undefined) {
      if (!['', '$', '$$', '$$$'].includes(b.price)) return res.status(400).json({ error: 'Invalid price.' });
      vals.push(b.price); sets.push(`price = $${vals.length}`);
    }
    if (b.city !== undefined) {
      if (!VALID_CITIES.has(b.city)) return res.status(400).json({ error: 'Invalid city.' });
      vals.push(b.city); sets.push(`city = $${vals.length}`);
    }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update.' });

    vals.push(id);
    const { rows } = await pool.query(
      `UPDATE entries SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`,
      vals
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found.' });
    // Once a place has a dish, its pending dish suggestions are moot.
    if (rows[0].description) await pool.query('DELETE FROM suggestions WHERE entry_id = $1', [id]);
    res.json({ ok: true, entry: rows[0] });
  } catch (err) {
    console.error('PATCH /api/entries/:id', err);
    res.status(500).json({ error: 'Could not update submission.' });
  }
});

// --- Admin: delete ---
app.delete('/api/entries/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { rowCount } = await pool.query('DELETE FROM entries WHERE id = $1', [id]);
    if (!rowCount) return res.status(404).json({ error: 'Not found.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/entries/:id', err);
    res.status(500).json({ error: 'Could not delete submission.' });
  }
});

// --- Public: suggest a dish for an approved place ---
app.post('/api/entries/:id/suggestions', rateLimit(20, HOUR), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const dish = str((req.body || {}).dish, 300);
    const by = str((req.body || {}).submitted_by, 120);
    if (!dish) return res.status(400).json({ error: 'Enter a dish.' });
    if (!by) return res.status(400).json({ error: 'Enter your name.' });
    const { rowCount } = await pool.query(
      `INSERT INTO suggestions (entry_id, dish, submitted_by)
         SELECT id, $2, $3 FROM entries WHERE id = $1 AND status = 'approved'`,
      [id, dish, by]
    );
    if (!rowCount) return res.status(404).json({ error: 'Not found.' });
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error('POST /api/entries/:id/suggestions', err);
    res.status(500).json({ error: 'Could not save your suggestion.' });
  }
});

// --- Admin: dismiss a dish suggestion ---
app.delete('/api/suggestions/:id', requireAdmin, async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM suggestions WHERE id = $1', [parseInt(req.params.id, 10)]);
    if (!rowCount) return res.status(404).json({ error: 'Not found.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/suggestions/:id', err);
    res.status(500).json({ error: 'Could not delete suggestion.' });
  }
});

// --- Static guide (also gives /admin and /entry via their index.html) ---
app.use(express.static(APP_DIR, { extensions: ['html'] }));

init()
  .then(async () => {
    // First boot against an empty DB seeds the curated CSV lists. Idempotent —
    // skips once approved rows exist. Disable with AUTO_SEED=0.
    if (process.env.AUTO_SEED !== '0') {
      try {
        const n = await seedIfEmpty();
        if (n) console.log(`Seeded ${n} approved entries.`);
      } catch (err) {
        console.error('Auto-seed skipped:', err.message);
      }
    }
    app.listen(PORT, () => console.log(`Foodie Guide server on :${PORT}`));
  })
  .catch((err) => {
    console.error('Startup failed:', err.message);
    process.exit(1);
  });
