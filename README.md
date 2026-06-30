# The List — a personal eating guide

A small static webapp that turns the curated CSV food lists in `data/` into a
browsable guide for **Los Angeles, San Francisco, New York, and Seattle**. Each
place is shown as a kitchen-style order ticket: the dish to order, price, the
neighborhood, a Yelp link, and a stamp for whether it's been **tried** or is
still **on the list**. Filter by city, cuisine, price, and status, or search.

## Run it

```bash
node build.js                 # parse data/*.csv  ->  app/data.js
cd app && python3 -m http.server 8731
# open http://localhost:8731
```

There's no framework and no build toolchain — `app/index.html` is plain
HTML/CSS/JS and loads `app/data.js` directly, so you can also just open the file.

## Updating the food lists

Edit the CSVs in `data/` (columns: `TRIED, Name, Cuisine, Description,
Location, Price, Yelp`) and re-run `node build.js`. The parser handles quoted
fields, Seattle's swapped Price/Location columns, and normalizes messy cuisine
labels (casing + known typos) so the filter chips stay clean.
