#!/usr/bin/env node
// Parses the per-city CSV food lists in ./data.
//   - Run directly (`node build.js`)  -> writes app/data.js (offline fallback).
//   - Required as a module            -> exports buildCities() for seeding Postgres.
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const OUT = path.join(__dirname, 'app', 'data.js');

// Minimal RFC-4180-ish CSV parser (handles quoted fields & embedded commas).
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else if (c === '\r') {
      // ignore
    } else {
      field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Normalize messy source cuisine labels: fix casing and known typos so the
// filter chips don't show duplicates like "Italian" / "Itallian".
const CUISINE_FIXES = {
  'itallian': 'Italian',
  'mediterranian': 'Mediterranean',
  'caribean': 'Caribbean',
};
function cleanCuisine(raw) {
  let s = (raw || '').trim();
  if (!s) return 'Other';
  const key = s.toLowerCase();
  if (CUISINE_FIXES[key]) return CUISINE_FIXES[key];
  if (/^[a-z]+$/.test(key)) return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  return s;
}

const CITY_META = {
  'BAY AREA':     { id: 'sf',  name: 'San Francisco', region: 'Bay Area', emoji: '🌉' },
  'LOS ANGELES':  { id: 'la',  name: 'Los Angeles',   region: 'SoCal',    emoji: '🌴' },
  'NEW YORK':     { id: 'ny',  name: 'New York',      region: 'NYC',      emoji: '🗽' },
  'SEATTLE':      { id: 'sea', name: 'Seattle',       region: 'PNW',      emoji: '🌧️' },
};

const ORDER = ['la', 'sf', 'ny', 'sea'];

// Parse every data/*.csv into the same shape the guide renders:
// [{ id, name, region, emoji, count, places: [{ tried, name, cuisine, ... }] }]
function buildCities({ quiet = false } = {}) {
  let YELP_LINKS = {};
  try {
    YELP_LINKS = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'yelp-links.json'), 'utf8'));
  } catch (e) { /* optional file */ }

  const files = fs.readdirSync(DATA_DIR).filter(f => f.toLowerCase().endsWith('.csv'));
  const cities = [];
  let filledFromOverrides = 0;

  for (const file of files) {
    const m = file.match(/USA FOOD LIST - (.+)\.csv$/i);
    if (!m) continue;
    const key = m[1].trim().toUpperCase();
    const meta = CITY_META[key];
    if (!meta) { if (!quiet) console.warn('Skipping unknown city file:', file); continue; }

    const rows = parseCSV(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
    let headerIdx = rows.findIndex(r => r.some(c => c.trim().toLowerCase() === 'name'));
    if (headerIdx === -1) continue;
    const header = rows[headerIdx].map(c => c.trim().toLowerCase());
    const col = (label) => header.indexOf(label);
    const idx = {
      tried: col('tried'), name: col('name'), cuisine: col('cuisine'),
      description: col('description'), location: col('location'),
      price: col('price'), yelp: col('yelp'),
    };

    const places = [];
    for (let r = headerIdx + 1; r < rows.length; r++) {
      const row = rows[r];
      const get = (i) => (i >= 0 && row[i] != null ? row[i].trim() : '');
      const name = get(idx.name);
      if (!name) continue;
      let yelp = get(idx.yelp);
      if (!yelp) {
        const k = `${meta.id}|${name}`;
        if (YELP_LINKS[k]) { yelp = YELP_LINKS[k]; filledFromOverrides++; }
      }
      places.push({
        tried: /true/i.test(get(idx.tried)),
        name,
        cuisine: cleanCuisine(get(idx.cuisine)),
        description: get(idx.description),
        location: get(idx.location),
        price: get(idx.price),
        yelp,
      });
    }

    cities.push({ ...meta, count: places.length, places });
    if (!quiet) console.log(`${meta.name}: ${places.length} places`);
  }

  cities.sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
  if (!quiet && filledFromOverrides) {
    console.log(`Filled ${filledFromOverrides} missing Yelp links from yelp-links.json`);
  }
  return cities;
}

function writeDataJs() {
  const cities = buildCities();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, 'window.FOODIE_DATA = ' + JSON.stringify({ cities }, null, 2) + ';\n');
  console.log('Wrote', OUT);
}

module.exports = { buildCities, parseCSV, cleanCuisine, CITY_META, ORDER };

if (require.main === module) writeDataJs();
