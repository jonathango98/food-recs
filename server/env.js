// Minimal .env loader (no dependency). Loads repo-root .env into process.env
// for local dev. On Railway, real env vars are already set and win over this.
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', '.env');
try {
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
} catch (e) { /* no .env — fine in production */ }
