// Postgres connection + schema bootstrap for the submission inbox.
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;

// Railway's managed Postgres needs SSL; local dev usually doesn't. Enable SSL
// (without strict cert checking) whenever we're talking to a non-local host.
function sslOption(url) {
  if (!url) return false;
  if (/localhost|127\.0\.0\.1/.test(url)) return false;
  return { rejectUnauthorized: false };
}

const pool = new Pool({
  connectionString,
  ssl: sslOption(connectionString),
});

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS entries (
    id           SERIAL PRIMARY KEY,
    city         TEXT NOT NULL,
    name         TEXT NOT NULL,
    cuisine      TEXT,
    description  TEXT,
    location     TEXT,
    price        TEXT,
    yelp         TEXT,
    tried        BOOLEAN NOT NULL DEFAULT FALSE,
    status       TEXT NOT NULL DEFAULT 'pending',
    submitted_by TEXT,
    note         TEXT,
    anonymous    BOOLEAN NOT NULL DEFAULT FALSE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    reviewed_at  TIMESTAMPTZ
  );
  CREATE INDEX IF NOT EXISTS entries_status_idx ON entries (status, created_at DESC);
  -- Backfill for tables created before the opt-out flag existed.
  ALTER TABLE entries ADD COLUMN IF NOT EXISTS anonymous BOOLEAN NOT NULL DEFAULT FALSE;
`;

async function init() {
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set — add the Railway Postgres plugin and set the env var.');
  }
  await pool.query(SCHEMA);
  // pg_trgm powers fuzzy duplicate detection (similarity()). Best-effort: if the
  // DB user can't create extensions, fall back to exact name matching.
  try {
    await pool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    module.exports.hasTrgm = true;
  } catch (err) {
    console.warn('pg_trgm unavailable — duplicate check falls back to exact match:', err.message);
    module.exports.hasTrgm = false;
  }
}

module.exports = { pool, init, hasTrgm: false };
