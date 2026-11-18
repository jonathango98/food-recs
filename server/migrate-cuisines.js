// One-off: remap every entry's cuisine onto the current list in app/cuisines.js.
//   node server/migrate-cuisines.js          dry run, prints planned changes
//   node server/migrate-cuisines.js --apply  writes them
require('./env');
const { cleanCuisine } = require('../build');
const CUISINES = require('../app/cuisines');
const { pool } = require('./db');

(async () => {
  const apply = process.argv.includes('--apply');
  const { rows } = await pool.query('SELECT id, name, cuisine FROM entries ORDER BY id');
  const changes = rows.map((r) => ({ ...r, next: cleanCuisine(r.cuisine) })).filter((r) => r.next !== r.cuisine);
  for (const c of changes) console.log(`#${c.id} ${c.name}: ${c.cuisine || '(empty)'} -> ${c.next}`);
  if (apply) {
    for (const c of changes) await pool.query('UPDATE entries SET cuisine = $1 WHERE id = $2', [c.next, c.id]);
  }
  console.log(`${changes.length} change(s) ${apply ? 'applied' : 'planned (dry run, pass --apply to write)'}.`);
  const left = rows.map((r) => ({ ...r, final: cleanCuisine(r.cuisine) })).filter((r) => !CUISINES.includes(r.final));
  for (const r of left) console.log(`Not on list, fix in admin: #${r.id} ${r.name} (${r.final})`);
})()
  .then(() => pool.end())
  .catch((err) => { console.error('Migration failed:', err); process.exit(1); });
