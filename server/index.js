// Foodie Guide server.
//   - Serves the static guide in ../app (so /admin and /entry work as routes).
//   - Public  POST /api/entries        : submit a recommendation (status=pending).
//   - Admin   GET   /api/entries        : list submissions (Basic Auth).
//   - Admin   PATCH /api/entries/:id    : approve / reject (Basic Auth).
//   - Admin   DELETE /api/entries/:id   : remove a submission (Basic Auth).
require('./env');
const path = require('path');
const express = require('express');
const db = require('./db');
const { pool, init } = db;
const { seedIfEmpty } = require('./seed');
const { CITY_META, ORDER } = require('../build');

const app = express();
const PORT = process.env.PORT || 3000;
const APP_DIR = path.join(__dirname, '..', 'app');

// City id -> display metadata, derived from build.js's CITY_META.
const CITY_BY_ID = {};
for (const meta of Object.values(CITY_META)) CITY_BY_ID[meta.id] = meta;

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

app.use(express.json({ limit: '64kb' }));

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

const VALID_CITIES = new Set(['la', 'sf', 'ny', 'sea']);
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
app.get('/api/entries/check', async (req, res) => {
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

// --- Public: submit a recommendation (all fields required) ---
app.post('/api/entries', async (req, res) => {
  try {
    const b = req.body || {};
    const admin = isAdmin(req);

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
    // Every field is required.
    const required = ['name', 'cuisine', 'description', 'location', 'price', 'yelp', 'submitted_by', 'note'];
    const missing = required.filter((f) => !row[f]);
    if (missing.length) return res.status(400).json({ error: `Missing required field(s): ${missing.join(', ')}.` });
    if (!/^https?:\/\//i.test(row.yelp)) return res.status(400).json({ error: 'Yelp must be a valid URL.' });

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
      tried: r.tried, name: r.name, cuisine: r.cuisine, description: r.description,
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
    const valid = ['pending', 'approved', 'rejected'].includes(status);
    const { rows } = valid
      ? await pool.query('SELECT * FROM entries WHERE status = $1 ORDER BY created_at DESC', [status])
      : await pool.query('SELECT * FROM entries ORDER BY created_at DESC');
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
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update.' });

    vals.push(id);
    const { rows } = await pool.query(
      `UPDATE entries SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`,
      vals
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found.' });
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
