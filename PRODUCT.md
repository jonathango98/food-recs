# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
Primary: friends of the owner who get the link texted to them when asking "where should I eat in X?". They open it on a phone, often on the street or about to decide, pick a city, and want the exact dish to order. Secondary: the owner, tracking what's tried vs. still on the list, and reviewing submissions in /admin.

## Product Purpose
A hand-built guide to the exact dishes worth ordering in Los Angeles, San Francisco, New York and Seattle. Not reviews: each spot leads with one dish to order. Success means a friend finds a place and a dish in under a minute on their phone.

## Positioning
A personal, curated hit-list from someone who actually eats there, with the specific order, and an honest "tried" vs. "on the list" status. Not a ratings aggregator.

## Operating Context
- Shared by text message; opened mostly on phones.
- Friends can recommend spots at /entry (all fields required, goes to pending review).
- /contributors credits people who submitted spots (with opt-out / anonymous).
- /admin (Basic Auth) approves/rejects submissions and toggles each spot's "tried" flag.

## Capabilities and Constraints
- Static frontend in `app/` (plain HTML/CSS/JS, no framework), hosted on Netlify; API on Railway (Node/Express + Postgres). `app/data.js` is an offline fallback.
- Per spot: name, city, cuisine, dish to order, neighborhood, price ($–$$$$), Yelp link, tried flag.
- Must keep: tried / on-the-list status and the "eaten through" progress, the order-this-dish focus, city switcher + cuisine/price filters + search.
- Open: the product name. "The List" may be renamed with the new identity.

## Evidence on Hand
- Real spot data: `data/*.csv`, ~170 spots across 4 cities.
- No photos of dishes or places, no logo, no testimonials. Do not fabricate any.

## Product Principles
- The dish is the headline; the restaurant is context.
- Phone-first: one-handed, fast, readable outside.
- Honest status: tried vs. not yet is never blurred.
- Personal, not corporate: reads like a friend's notes, not a template.
