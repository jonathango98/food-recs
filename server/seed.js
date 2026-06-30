// Seeds the curated CSV lists into Postgres as approved entries.
//
//   - Imported: seedIfEmpty() / seed() are called by the server on boot.
//   - CLI:      `node server/seed.js`        seed only if no approved rows exist
//               `FORCE_SEED=1 node server/seed.js`  seed regardless
require('./env');
const { buildCities } = require('../build');
const { pool, init } = require('./db');

async function countApproved() {
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM entries WHERE status = 'approved'`);
  return rows[0].n;
}

// Insert every CSV place as an approved entry. Returns the number inserted.
async function seed({ quiet = false } = {}) {
  const cities = buildCities({ quiet: true });
  let inserted = 0;
  for (const city of cities) {
    for (const p of city.places) {
      await pool.query(
        `INSERT INTO entries
           (city, name, cuisine, description, location, price, yelp, tried, status, submitted_by, reviewed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'approved','seed', now())`,
        [city.id, p.name, p.cuisine, p.description, p.location, p.price, p.yelp, p.tried]
      );
      inserted++;
    }
    if (!quiet) console.log(`${city.name}: seeded ${city.places.length}`);
  }
  return inserted;
}

// Seed only when there are no approved entries yet. Safe to call on every boot.
async function seedIfEmpty({ quiet = false } = {}) {
  const n = await countApproved();
  if (n > 0) return 0;
  if (!quiet) console.log('Empty database — seeding from data/*.csv …');
  return seed({ quiet });
}

module.exports = { seed, seedIfEmpty, countApproved };

// CLI entry point.
if (require.main === module) {
  (async () => {
    await init();
    if (!process.env.FORCE_SEED && (await countApproved()) > 0) {
      console.log('Skip: approved entries already exist. Use FORCE_SEED=1 to seed anyway.');
    } else {
      const n = await seed();
      console.log(`Done. Inserted ${n} approved entries.`);
    }
  })()
    .then(() => pool.end())
    .catch((err) => { console.error('Seed failed:', err); process.exit(1); });
}
