# 🅿️ ParkCompare

Find and compare nearby car parks by **price** and **distance**, then drive there with one tap.

ParkCompare is a free, installable web app (PWA). It auto-detects your location and works **anywhere in the world** — showing nearby car parks on a map. In **curated cities** (Birmingham first) it also shows accurate, verified prices.

## How it works

- **Your location** is detected by the browser (with your permission).
- **Car park locations** come from [OpenStreetMap](https://www.openstreetmap.org/) (free, global).
- **Verified prices** come from a hand-curated data file for supported cities — these cards show a ✓ Verified badge.
- **Navigate** opens Google Maps with your location and the car park already filled in.

Sort by **Nearest** (default) or **Cheapest**. Car parks without a known price sort last.

## The honest bit about prices

There is no free worldwide source of accurate parking prices, so:

- In **curated cities**, prices are accurate but hand-maintained (see `lastChecked` in the data file).
- **Everywhere else**, prices come from OpenStreetMap and are often missing — those cards say "Price not listed."

## Run it locally

It's a static site — no build step. Serve the folder over HTTP (needed for location + service worker):

```
cd parkcompare
python3 -m http.server 8000
# then open http://localhost:8000
```

## Add a new curated city

1. Copy `data/curated/birmingham.json` to `data/curated/<city>.json`.
2. Update `city`, `bounds`, `lastChecked`, and the `carParks` list.
3. Add the city name to `CURATED_CITIES` in `app.js`.

## Files

| File | Purpose |
|---|---|
| `index.html` | App shell |
| `app.js` | Location, map, data merge, sorting, navigation |
| `style.css` | Styling |
| `data/curated/*.json` | Verified prices per city |
| `manifest.webmanifest` / `service-worker.js` | PWA install + auto-update |

## Tech

Plain HTML/CSS/JS · [Leaflet](https://leafletjs.com/) + OpenStreetMap tiles · OpenStreetMap Overpass API · no backend, no API keys, $0 to run.
