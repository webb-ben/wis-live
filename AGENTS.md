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

- MapLibre GL JS `4.7.1` (unpkg)
- MQTT.js `5.0.1` (unpkg)
- Bootstrap CSS `5.1.3` (unpkg) — CSS only, used for buttons/forms/tables
- Pyodide `v0.26.4` (jsDelivr), loaded lazily on first decode
- Basemap: Esri World Light Gray raster tiles
- Google Analytics and Simple Analytics in `index.html`

Keep versions pinned. When bumping one, check the API still matches how
`wis.js` uses it.

## How `wis.js` is organized

Read top to bottom; sections are separated by comments:

1. **Map** — constants (`MAX_POINTS`, `FADE_MS`, `PULSE_MS`, `COLORS`), map
   setup, `points` and `pulses` GeoJSON sources/layers. Points are batched in
   `toAdd`/`toRemove` and flushed every 500 ms via `source.updateData`; avoid
   per-message `setData`.
2. **De-duplication** — the origin and every global cache republish the same
   observation. `byDataId` keeps one point per `data_id`; a cache copy replaces
   an origin copy, later copies are skipped.
3. **Controls** — `LegendControl`, `InfoControl`, `QueueControl` (MapLibre
   `IControl` classes).
4. **Popup** — `buildPopup`, decode flow, `renderDecoded` with headline
   `KEY_VALUES` tiles keyed by BUFR descriptor id.
5. **Sidebar queue + filters** — `filters` is shared by the map (via
   `applyMapFilter` → layer filter expressions) and the sidebar (via
   `matchesFilters`). Keep both in sync when adding a filter.
6. **MQTT** — `connectFastest` races the brokers in `hosts` and keeps the
   first one that connects and subscribes to `origin/a/wis2/#` and
   `cache/a/wis2/#`. The `everyone/everyone` credentials are public.
7. **Message handling** — `onMessage` parses the WIS2 notification (GeoJSON),
   skips `ignoredTopics`, reduces geometry to a point with `pointFor` (large
   areas are dropped), and builds a record.
8. **BUFR decoding** — `loadDecoder` lazily loads Pyodide, installs
   `bitstring==3.1.9` and `six`, unpacks the bundled wheel, and runs the
   embedded `DECODE_PY`. `fetchData` tries inline base64 content, then every
   canonical link seen for the `data_id`, preferring CORS-friendly hosts.

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
  (`MAX_POINTS`, `QUEUE_MAX`, `RECENT_MAX`, `DATA_LINKS_MAX`, the Python
  `_cache`). New collections need one too.
- Respect `prefers-reduced-motion` (see `reduceMotion`).
- CSS: flat class selectors with prefixes per component (`queue-*`,
  `legend-*`, `pp-*` for popups). Mobile breakpoint is `max-width: 600px`.
- If you change the wheel filename, update `PYBUFRKIT_WHEEL`. The CDN
  fallback points at `main`, so it only picks up the change once pushed.

## Git

- Default branch is `main`; it is what gets deployed.
- Commit messages are short and imperative (e.g. "Reduce number of callbacks").
