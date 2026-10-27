# AGENTS.md

Guidance for AI coding agents working in this repository.

## What this is

WIS 2.0 Live is a single-page, static web app that shows real-time weather
observations as they are published through the WMO Information System (WIS2).
It subscribes to the public WIS2 Global Brokers over MQTT-over-WebSockets,
plots each notification on a MapLibre map, lists incoming messages in a
sidebar, and can decode BUFR data in the browser with Pyodide + pybufrkit.

It is served as-is (canonical URL: https://benwebb.com/wis-live/). The page is
not affiliated with WMO.

## Layout

```
index.html                 Page shell: meta tags, analytics, CDN scripts, #map
assets/js/wis.js           All application logic (no modules, no build)
assets/css/style.css       All custom styles
assets/py/pybufrkit-*.whl  Pure-Python wheel of pybufrkit loaded by Pyodide
assets/data/centre-id.json Snapshot of the WMO centre-id register (fallback)
assets/data/wis2box-deployments.json  Centre -> wis2box URL, from the wis2box
                           deployments list (not fetchable from a browser)
assets/images/             Favicons
```

There is no build step, package manager, bundler, linter, or test suite. Do
not add one unless asked.

## Running locally

Serve the repo root over HTTP and open it in a browser:

```sh
python3 -m http.server 8000
# then open http://localhost:8000/
```

Opening `index.html` via `file://` mostly works, but the local wheel fetch
fails there and the decoder falls back to the jsDelivr copy on `main`.

Verify changes in a real browser: watch for points appearing on the map,
open the sidebar (☰), click a point, and try **Decode**. Check the console for
errors.

## External dependencies (all from CDNs, pinned versions)

- MapLibre GL JS `5.24.0` (unpkg) — globe projection needs v5
- MQTT.js `5.0.1` (unpkg)
- Bootstrap CSS `5.1.3` (unpkg) — CSS only, used for buttons/forms/tables
- Pyodide `v0.26.4` (jsDelivr), loaded lazily on first decode
- Basemap: Esri World Light Gray raster tiles
- Google Analytics and Simple Analytics in `index.html`

Data services called from the browser (all public, no keys): ECCC GeoMet
(model fields), the dynamical.org point API (model forecasts), the WIS2
Global Replay and Global Discovery Catalogues (ECCC, CMA, DWD; fastest
first, see `rankGdcs`), and the Iowa Environmental Mesonet (airport METARs).

Keep versions pinned. When bumping one, check the API still matches how
`wis.js` uses it.

## How `wis.js` is organized

It is one large file (~6,600 lines). Read top to bottom; the core comes
first, roughly in this order:

1. **Map** — constants (`MAX_POINTS`, `FADE_MS`, `PULSE_MS`, `COLORS`), map
   setup, `points` and `pulses` GeoJSON sources/layers. Points are batched in
   `toAdd`/`toRemove` and flushed every 500 ms (`flushPoints`) via
   `source.updateData`; avoid per-message `setData`. The style has a
   `background` layer under the `basemap` raster. The projection choice is
   kept in `localStorage` (`wis-projection`).
2. **De-duplication** — the origin and every global cache republish the same
   observation. `byDataId` keeps one point per `data_id`; a cache copy replaces
   an origin copy, later copies are skipped.
3. **Controls** — `ProjectionControl` (Flat/Globe),
   `LegendControl`, `MapKey` (style panel and key of what is drawn),
   `QueueControl` (MapLibre `IControl` classes).
4. **Popup** — `buildPopup`, decode flow, `renderDecoded` with headline
   `KEY_VALUES` tiles keyed by BUFR descriptor id. Popups have Data, Model
   forecast and Message tabs, plus the dataset's catalogue record.
5. **Sidebar + filters** — the sidebar has Layers, Datasets and Messages
   tabs (`selectQueueTab`). `filters` is shared by the map (via
   `applyMapFilter` → layer filter expressions), the message list (via
   `matchesFilters`) and the dataset list (via `datasetMatchesFilters`).
   Keep all three in sync when adding a filter. Filters, styling and a shown
   dataset are mirrored in the URL (`readFiltersFromUrl`/`writeFiltersToUrl`).
6. **MQTT** — `connectFastest` races the brokers in `hosts` and keeps the
   first one that connects and subscribes to `origin/a/wis2/#` and
   `cache/a/wis2/#`. The `everyone/everyone` credentials are public.
7. **Message handling** — `onMessage` parses the WIS2 notification (GeoJSON),
   skips `ignoredTopics`, reduces geometry to a point with `pointFor` (large
   areas are dropped), and builds a record.
8. **BUFR decoding** — `loadDecoder` lazily starts Web Workers
   (`DECODER_WORKER`) that load Pyodide, install `bitstring==3.1.9` and
   `six`, unpack the bundled wheel, and run the embedded `DECODE_PY`.
   `fetchData` tries inline base64 content, then every canonical link seen
   for the `data_id`, preferring CORS-friendly hosts.

After the core, each feature is its own section headed `// ---------- <name>`
(grep for that to list them): GeoMet model fields, Environment Canada
citypage forecasts, satellite reports, model forecasts and observation vs
forecast, the sounding viewer (Skew-T with a wind chart beside it) and
radar wind profiles (time-height barbs, sharing `drawBarb` with the
soundings), URL state, weather radar, text SYNOPs, lightning, colouring by
measured value (origin stations too, via `isColourable`), per-satellite layers, station
merging, Global Replay, the Global Discovery Catalogue (Datasets tab: rows
are kept sorted by when each dataset was last seen, via `sortDatasetRows`),
airport METARs, satellite coverage and tracks.

Topic structure: `<channel>/a/wis2/<centre>/data/core/<discipline>/...`, where
channel is `origin` or `cache`.

## Conventions

- Plain browser JavaScript in one script loaded with `defer`; globals are
  fine. Match the existing style: 4-space indent, single quotes, semicolons,
  `var` inside functions and `const`/`let` at top level, short comments that
  explain *why*.
- **Escape untrusted text.** Message content comes from third parties. Use
  `esc()` in template strings or set `textContent`; never interpolate raw
  message fields into `innerHTML`.
- Keep memory bounded: everything that grows with incoming messages has a cap
  (`MAX_POINTS`, `QUEUE_MAX`, `RECENT_MAX`, `DATA_LINKS_MAX`, `REPLAY_MAX`,
  `DATASETS_SEEN_MAX` and the other `*_MAX` constants, the Python `_cache`).
  New collections need one too.
- Respect `prefers-reduced-motion` (see `reduceMotion`).
- CSS: flat class selectors with prefixes per component (`queue-*`,
  `legend-*`, `pp-*` for popups). Mobile breakpoint is `max-width: 600px`.
- If you change the wheel filename, update `PYBUFRKIT_WHEEL`. The CDN
  fallback points at `main`, so it only picks up the change once pushed.

## Git

- Default branch is `main`; it is what gets deployed.
- Commit messages are short and imperative (e.g. "Reduce number of callbacks").
