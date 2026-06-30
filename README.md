# The List — a personal eating guide

A guide to the exact dishes to order in **Los Angeles, San Francisco, New York,
and Seattle**. Each place is a kitchen-style order ticket: the dish, price,
neighborhood, a Yelp link, and a stamp for **tried** vs. still **on the list**.
Filter by city, cuisine, price, and status, or search.

The guide is backed by **Postgres** and served by a small **Node/Express**
server. Visitors can recommend spots at `/entry`; you review them at `/admin`.

## Architecture

```
data/*.csv ──(seed once)──▶ Postgres `entries` table ◀── POST /entry (pending)
                                   │
                                   ├─ GET /api/places  → the guide (approved only)
                                   └─ /admin (password) → approve / reject / set "tried"
```

- **`entries`** is the single source of truth. `status='approved'` shows on the
  guide; `status='pending'` waits for review.
- **`app/index.html`** fetches `GET /api/places`. If the API is unreachable it
  falls back to the statically-built `app/data.js`.
- **`/entry`** — public form, all fields required, inserts a `pending` row.
- **`/admin`** — Basic-Auth dashboard (`ADMIN_USER` / `ADMIN_PASSWORD`, checked
  server-side) to approve/reject/delete and toggle each entry's **tried** flag.

## Run it locally

Needs Postgres. Copy `.env.example` → `.env` and set `DATABASE_URL`,
`ADMIN_USER`, `ADMIN_PASSWORD`.

```bash
npm install
node build.js          # (optional) regenerate app/data.js offline fallback
node server/seed.js     # load data/*.csv into Postgres as approved entries (once)
npm start               # http://localhost:3000  (guide, /entry, /admin)
```

`node server/seed.js` only seeds when the table has no approved rows; use
`FORCE_SEED=1 node server/seed.js` to seed again.

## Deploy to Railway

1. New project → **Deploy from repo**, then add the **Postgres** plugin.
   Railway injects `DATABASE_URL` automatically.
2. Set service variables: **`ADMIN_USER`** and **`ADMIN_PASSWORD`**.
3. Railway (Nixpacks) runs `npm run build` then `npm start` from `package.json`.
4. Seed once: open the service shell (or run a one-off) and run
   `node server/seed.js`.

The Express server serves the whole static `app/` directory, so the guide,
`/entry`, and `/admin` are all on the one Railway URL — no CORS needed. If you
host the frontend separately (e.g. Netlify), set `window.API_BASE` to the
Railway URL and set `CORS_ORIGIN` on the server.

## Updating the curated CSVs

The CSVs in `data/` (columns: `TRIED, Name, Cuisine, Description, Location,
Price, Yelp`; Seattle swaps Price/Location) are only the **initial seed** and
the offline fallback. Day-to-day, add places through `/admin` or approve `/entry`
submissions — those write straight to Postgres.
