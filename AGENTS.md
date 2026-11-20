# AGENTS.md

Guidance for AI coding agents working in this repository.

## What this is

WIS 2.0 Live is a single-page, static web app that shows real-time weather
observations as they are published through the WMO Information System (WIS2).
It subscribes to the public WIS2 Global Brokers over MQTT-over-WebSockets,
plots each notification on a MapLibre map, lists incoming messages in a
sidebar, and can decode BUFR data in the browser with Pyodide + pybufrkit.

It is built with Vite and published to GitHub Pages (canonical URL:
https://benwebb.com/wis-live/). The page is not affiliated with WMO.

## Layout

```
index.html                 Page shell: meta tags, analytics, the app module, #map
gbon.html                  The GBON page: the same app, <html data-page="gbon">
metocean.html              The metocean page: the same app, <html data-page="metocean">
gts.html                   The GTS gateways page: the same app, <html data-page="gts">
satellites.html            The satellite page: the same app, <html data-page="satellites">
src/page.js                Which page this is (PAGE): index.html (home) takes every
                           notification but space-based ones, satellites.html only those;
                           gbon.html only surface stations and upper-air soundings, and
                           metocean.html only ships and buoys (PAGE_CLASSES: by topic in
                           topicOnPage, then by each report's kind in addPoint); gts.html
                           only the GTS gateways' topics (both ways). Each lists its own
                           layer groups (layers.js) and Style by measures (metricOnPage),
                           and links to the others
src/main.js                Both pages' wiring: map, sidebar, popups (being split up; see below)
src/state.js               The shared state: state.colourBy, colouredOnly, modelFieldOn,
                           filters, filterModes, hiddenLayers; setState / notify / subscribe
src/config.js              COLORS, OBS_CLASSES (kinds of observation), METRICS (Style by
                           measures, with their colour scales), the layer lists they colour
src/messages/messages.js   parseMessage and what a notification says: topicClass,
                           disciplineOf, formatOf, GATEWAY_* headings, stationId, pointFor
src/messages/mqtt.js       connectFastest({ onMessage, onState }): races the Global Brokers
src/data/caches.js         The global caches seen and how fast each answers: downloadOrder
                           (fastest first; hosts that blocked a browser download are skipped
                           for good), canDownload; download.js's fetchTracked reports each
                           download. Caches are timed again every minute; the fastest is
                           state.cache (the GDC in use, re-ranked every minute: state.catalogue)
src/data/download.js       Downloading a notification's file (fetchData): every cache's
                           copy (rememberLinks), fastest first, then the copies caches
                           that didn't announce it likely have (guessedCopies); bufrSource,
                           fetchTracked, decodeHref; bufrPart / isText on what came back
src/data/reports.js        What a decoded report is: reportClass (its GTS sublayer),
                           reportId, reportTime
src/data/aviation/aircraft.js  Aircraft reports: altitude, route and flight-phase tiles,
                           and each aircraft's track as shapes in the air (aircraftTrack)
src/data/aviation/airports.js  Airport METARs from the Iowa Environmental Mesonet, a
                           network at a time (initAirports, queueAirports)
src/data/satellite/names.js  satellite and instrument names from BUFR code tables
src/data/satellite/spectrum.js  CrIS/IASI infrared spectra (showSpectrum)
src/data/satellite/coverage.js  Satellite files as coverage on H3 grids: the global grid
                           (resolution 2, keeps each file's share) and the view's finer one
                           (rebuilds a file's share when wanted, see fileShare); cell
                           estimates (swathMeans), the cell summary, the satellite outline
src/data/satellite/coverageLayers.js  The coverage's map layers and their hover and click
src/data/ocean/profile.js  Ocean profiles (Argo and BGC floats, XBT/CTD, gliders): T, S and
                           BGC against depth, T–S diagram with σt, tiles, expanded view;
                           levels come from _ocean in DECODE_PY (decode_bufr's 'ocean')
src/data/ocean/wavespec.js Wave spectra (waveSpectrum): the polar plot in the info panel
                           with wind and wave arrows (renderWaveSpectrum), the small one
                           drawn on the map when styled by wave spectrum (miniWaveSpectrum),
                           and the sea-state compass (marineCompass). The map style that
                           uses it (WAVE_STYLE, ?style=waves) isn't in Style by yet
src/data/radar/radar.js    Weather radar scans drawn as images (initRadar, plotRadar)
src/data/gts/synop.js      Text SYNOPs (FM 12/13) read into BUFR-style rows and plotted
                           (plotSynopBulletin; land stations wait for their position)
src/data/lightning/lightning.js  Met Office lightning flashes from CSV (plotLightningText),
                           each flash once across the BUFR and CSV copies (seenFlash)
src/data/alerts/cap.js     CAP warnings as a card, with their area on the map (renderCap)
src/data/alerts/citypage.js  Environment Canada citypage forecasts on the map (plotCitypage)
src/data/decoder.js        callDecoder(fn, ...args): Pyodide + pybufrkit in Web Workers
                           (DECODE_PY); onDecoderSettled(fn) once it has started or failed
src/lib/util.js            esc, darken, svgEl, knots
src/lib/geo.js             distances, hulls, lines across ±180, H3 cells (h3Cell, cellRing)
src/lib/format.js          formatValue, formatLabel, timeAgo, stationName, highlightJson...
src/plots/sounding.js      Skew-T, the sounding dialog, wind-profile barbs (drawBarb)
src/plots/forecast.js      dynamical.org forecasts at a point, compared with the observation
src/plots/citypage.js      Environment Canada citypage weather and its hourly chart
src/map/points.js          The points as data modules see them: records, byDataId,
                           latestByStation, newId, observedAt, and addPoint / removePoint /
                           linkDecoded / countPlotted / decoding, which main.js supplies
                           (initPoints). A module plots through here, not through main.js
src/map/symbols.js         The point symbols as signed distance fields (diamond, square, arrow)
src/lib/ui/overview.js     The Equal Earth world map in the bottom-right panel (D3 canvas;
                           createOverview: sea, land, the view's frame, hover and selection
                           marks; the page draws the points and coverage via drawContent)
src/lib/ui/panels.js       Minimizing part of a map panel (makeMinimizable), and key rows
                           that hide their layers with a click (keyToggle, hiddenKeyRows)
src/style.css              All custom styles
public/assets/py/pybufrkit-*.whl  Pure-Python wheel of pybufrkit loaded by Pyodide
public/assets/data/centre-id.json Snapshot of the WMO centre-id register (fallback)
public/assets/data/wis2box-deployments.json  Centre -> wis2box URL, from the
                           wis2box deployments list (not fetchable from a browser)
public/assets/images/      Favicons
vite.config.js             base /wis-live/; each page is an entry in rollupOptions.input
proxy/                     The CORS proxy, a Cloudflare Worker (cors-worker.js, deployed
                           with wrangler from that folder, not by Vite): the global caches
                           that send no CORS headers (DWD, KMA, CMA, NCM) are downloaded
                           through it when CORS_PROXY is set in src/data/caches.js (off for now)
.github/workflows/pages.yml  Builds and deploys to Pages on every push to main
```

`public/` is copied to the site as-is: files the app fetches at runtime (the
wheel, the JSON) and the icons live there, at the same paths as before.

The plan is to split `src/main.js` into modules (MQTT, decoder, satellites,
map, UI) so further pages, such as one for satellites or an MQTT explorer, can
reuse them; each page is an HTML file at the root plus its own entry module.

**Move things out of `src/main.js`; always aim for a negative diff there.** New
features go in their own module, in a folder by subject rather than at the top
of `src/`: kinds of data under `src/data/` (`ocean/`, `aviation/`, `satellite/`,
`radar/`, `gts/`, `alerts/`, and the decoder), notifications and the brokers in
`src/messages/`, charts in `src/plots/`, map pieces in `src/map/`, shared helpers
in `src/lib/` (panels in `src/lib/ui/`), with
only the wiring (map layers, state, the popup hooks) left in `main.js`. When
you change code in `main.js` that could live elsewhere, move it out at the
same time, so each change leaves the file smaller than it found it.

There is no linter or test suite. Do not add one unless asked.

## Running locally

```sh
npm install
npm run dev       # http://localhost:5173/wis-live/
npm run build     # into dist/
npm run preview   # serves dist/ at http://localhost:4173/wis-live/
```

Verify changes in a real browser: watch for points appearing on the map,
open the sidebar (the tab on its edge, halfway down the left), click a point, and try **Decode**. Check the console for
errors.

## External dependencies (pinned in `package.json`, bundled by Vite)

- MapLibre GL JS `5.24.0` — globe projection needs v5
- MQTT.js `5.15.2` — its browser module build (`dist/mqtt.esm.js`)
- h3-js `4.2.1`: the H3 hexagons satellite coverage is drawn in (`H3_RESOLUTION`)
- Bootstrap `5.1.3` — CSS only, and only the parts used: `src/bootstrap.scss`
  builds base styles, buttons, close, forms and tables from its Sass (with
  `sass`, a build-time dependency). Using another part's classes means adding it there
- d3-geo `3.1.1`, d3-scale `4.0.2`, topojson-client `3.1.0` and world-atlas
  `2.0.2` (land outlines), for the Equal Earth world map in the key; loaded with
  `import()` so they're a separate bundle
- `vite.config.js` gives MapLibre, MQTT.js and h3-js a file each (`manualChunks`),
  so app deploys leave them cached

Not bundled:

- Pyodide `v0.26.4` (jsDelivr), the Python runtime the decoder workers load on first decode
- `public/assets/py/pybufrkit-*.whl` (4 MB, most of the published site: the BUFR
  tables for every WMO table version), fetched by the decoder
- Basemap: Esri World Light Gray raster tiles
- Google Analytics and Simple Analytics in `index.html`

Data services called from the browser (all public, no keys): ECCC GeoMet
(model fields), the dynamical.org point API (model forecasts), the WIS2
Global Replay and Global Discovery Catalogues (ECCC, CMA, DWD; fastest
first, see `rankGdcs`), and the Iowa Environmental Mesonet (airport METARs).

Build tooling: Vite `6.4.6` and sass `1.77.8` (dev dependencies; with
`package-lock.json`, and the workflow runs `npm ci`).

Keep versions pinned. When bumping one, check the API still matches how
`src/main.js` uses it.

## How `src/main.js` is organized

It is one large file (~6,900 lines), the former `wis.js`, loaded as an ES
module (so strict mode, and nothing it declares is a global). Read top to
bottom; the core comes first, roughly in this order:

1. **Map** — constants (`MAX_POINTS`, `FADE_MS`, `PULSE_MS`; colours are in
   `src/config.js`), map setup, `points` and `pulses` GeoJSON sources/layers. Points are batched in
   `toAdd`/`toRemove` and flushed every 500 ms (`flushPoints`) via
   `source.updateData`; avoid per-message `setData`. The style has a
   `background` layer under the `basemap` raster. The projection choice is
   kept in `localStorage` (`wis-projection`).
2. **De-duplication** — the origin and every global cache republish the same
   observation. `byDataId` keeps one point per `data_id`; a cache copy replaces
   an origin copy, later copies are skipped.
3. **Controls** — `StyleControl` (top right: the key of what is drawn
   (`updateMapKey`), then Style by; the zoom buttons are top left, and
   `ProjectionControl`'s Flat/Globe isn't shown for now),
   `MapKey` (bottom right: the world map and the broker status). `QueueControl` builds the sidebar and `LegendControl`
   its Layers tab; neither is on the map itself (MapLibre `IControl` classes).
4. **Popup** — `buildPopup`, decode flow, `renderDecoded` with headline
   `KEY_VALUES` tiles keyed by BUFR descriptor id. Popups have Data, Model
   forecast and Message tabs, plus the dataset's catalogue record.
5. **Sidebar + filters** — the sidebar has Layers, Datasets and Messages
   tabs (`selectQueueTab`). `filters` is shared by the map (via
   `applyMapFilter` → layer filter expressions), the message list (via
   `matchesFilters`) and the dataset list (via `datasetMatchesFilters`).
   Keep all three in sync when adding a filter. Filters, styling, a shown
   dataset and the Global Replay (`?replay=2h`, `90m`, or a URL-encoded ISO time;
   it turns the layer on) are mirrored in the URL (`readFiltersFromUrl`/`writeFiltersToUrl`).
   The first visit's welcome (`src/lib/ui/welcome.js`) is never shown in an iframe;
   `?welcome=0` turns it off elsewhere and `?welcome=1` forces it.
6. **MQTT** (`src/messages/mqtt.js`) — `connectFastest` races the brokers in `hosts`
   and keeps the first one that connects and subscribes to `origin/a/wis2/#`
   and `cache/a/wis2/#`; the page passes `onMessage` and `onState`. It stays
   on that broker (switching would drop messages) and times a round trip every
   minute (`brokerState.ms`). The
   `everyone/everyone` credentials are public.
7. **Message handling** — `onMessage` takes the parsed WIS2 notification
   (GeoJSON), skips `ignoredTopics`, reduces geometry to a point with `pointFor`
   (large areas are dropped), and builds a record. What a notification says
   (`topicClass`, `formatOf`, `disciplineOf`, ...) is in `src/messages/messages.js`.
8. **BUFR decoding** (`src/data/decoder.js`) — `callDecoder` lazily starts Web
   Workers (`DECODER_WORKER`, a classic worker built from a string) that load
   Pyodide, install `bitstring==3.1.9` and `six`, unpack the bundled wheel, and
   run the embedded `DECODE_PY`.
   `fetchData` (`src/data/download.js`) tries inline base64 content, then every canonical link seen
   for the `data_id`, fastest cache first. Downloads go through `fetchTracked`, so
   a host that refuses a browser (no CORS headers, e.g. `gc.wis.cma.cn`) is not
   asked again, and a host not yet tried gets one background request at a time.
   A popup's Retry also tries the browser-readable caches that never announced the
   file, at the address each would keep it (`guessedCopies`).
   Background files wait in `decodeQueues`: one for satellites and one for
   everything else, each with its own downloads and cap, taking turns on the
   decoder. A satellite swath keeps only the values the map can be styled by
   (`file.metrics`); its popups decode the report again. On a slow network
   (`checkNetwork`, every minute: broker round trip over `SLOW_BROKER_MS` or the
   fastest cache over `SLOW_CACHE_MS`) Satellites, then GTS gateways, are
   switched off as if by hand, and the map key says so (`state.slowNetwork`).

After the core, each feature is its own section headed `// ---------- <name>`
(grep for that to list them): GeoMet model fields, Environment Canada
citypage forecasts, satellite reports, model forecasts and observation vs
forecast, infrared spectra from CrIS and IASI (`radianceSpectrum`; satellite
reports keep only `SATELLITE_ROWS_MAX` values, so the popup decodes the full
report again for every channel), the sounding viewer (Skew-T with a wind chart beside it) and
radar wind profiles (time-height barbs, sharing `drawBarb` with the
soundings), URL state, weather radar, text SYNOPs, lightning, colouring by
measured value (origin stations too, via `isColourable`), per-satellite layers, station
merging, Global Replay, the Global Discovery Catalogue (Datasets tab: rows
are kept sorted by when each dataset was last seen, via `sortDatasetRows`),
what the Equal Earth world map shows (`drawOverviewContent`, which
filters with `passesFilters` like the key; the map itself is `src/lib/ui/overview.js`),
satellite coverage (each swath file is packed into `swathFiles`
and adds to running totals per H3 cell, not points; a report becomes a record only
when clicked, via `swathRecord`. Cells are kept in grids: `globalGrid` at
`H3_RESOLUTION` (2) for the whole globe, which the overview and key use, and from
zoom 3 a finer `viewGrid` over the area in view, built a slice at a time
(`syncSwathGrid`). One-cell gaps are filled from their neighbours' files
(`refreshSatelliteHoles`); a file's mean fills its empty cells only when its values
agree (`FILL_SPREAD_MAX`); cloud-motion wind files stay points) and tracks (`buildTracks`: aircraft float at their
altitude; ships, joined by call sign or WIGOS id via `shipTrackKey`, are lines on
the Tracks rows under Cache and GTS Ships).

Topic structure: `<channel>/a/wis2/<centre>/data/core/<discipline>/...`, where
channel is `origin` or `cache`.

## Conventions

- Plain browser JavaScript in ES modules. Match the existing style: 4-space
  indent, single quotes, semicolons, `var` inside functions and `const`/`let`
  at top level, short comments that explain *why*.
- **Shared state lives in `src/state.js`**, not in module-level variables. Read
  `state.x`; change it with `setState({ x })`, or change a Set/object in place
  and call `notify('x')`, so `subscribe(['x'], fn)` listeners (other modules,
  other pages) hear about it. In `npm run dev` it's on `window.wisState` to
  inspect or watch from the console. New state that more than one place reads
  goes there too.
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
  fallback points at `public/` on `main`, so it only picks up the change once pushed.

## Git

- Default branch is `main`; every push to it is built and deployed by
  `.github/workflows/pages.yml`.
- Commit messages are short and imperative (e.g. "Reduce number of callbacks").
