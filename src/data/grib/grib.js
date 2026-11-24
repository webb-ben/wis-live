// Forecast products on the map, each outlined over the area its files cover: GRIB files
// from the first 16 KB of the file (fetchHead; the headers are read by gribHeader.js,
// no values decoded), and files whose notification gives an area (the Met Office's
// NetCDF) from the notification. A product is a centre's model and one variable at one
// level (with its statistic or probability, if any); its lead times, ensemble members and
// runs are its files. The forecasts page lists the products by model in its sidebar,
// each switched on and off there, and a click on the map lists the products under it.
// A forecast message clicked in the message list outlines its area too (showGribArea)
import maplibregl from 'maplibre-gl';
import { fetchHead, fetchData } from '../download.js';
import { viaWorker } from '../caches.js';
import { originCentre } from '../../messages/gtsOrigin.js';
import { OPEN_MODELS, openModelSteps } from './openData.js';
import { esc } from '../../lib/util.js';
import { disciplineOf, formatOf, FORMATS, isDataLink } from '../../messages/messages.js';
import { parseGribHeader, gribSummary, latLonOutline, gridLocator } from './gribHeader.js';
import { callDecoder } from '../decoder.js';
import { decodeField, renderFields, fieldDrawable, packingName, JPEG_MAX_BITS, colourScale, colourOn, rgbOn } from './gribField.js';

// Where a forecast file can be downloaded from: every copy its notification links, whatever
// its size. (bufrSource leaves out files over 5 MB, as the BUFR decoder would download them
// whole; forecasts only ever have their headers or one field read, by range, so ECMWF's
// 16 GB ensembles, CMA's 88 MB and the Met Office's NetCDF have to be let through)
function forecastSource(feature, topic) {
    var props = feature.properties || {};
    var urls = (feature.links || []).filter(isDataLink).map((l) => l.href);
    if (!urls.length) return null;
    return { content: null, dataId: props.data_id, urls, topic, pubtime: props.pubtime || null, format: formatOf(feature, topic), feature };
}

// A file's series: its topic and file name without its run, lead time and other long numbers.
// A level's stays: ECCC's 20261123T18Z_MSC_RDPS_AirTemp_IsbL-0850_RLatLon0.09_PT025H.grib2 is a
// series of its own for each level (stripping every number made all of RDPS's levels one series)
export function productOf(topic, feature) {
    var link = (feature.links || []).find((l) => l.rel === 'canonical' || l.rel === 'update') || {};
    var file = (link.href || '').split(/[?#]/)[0].split('/').pop();
    var series = file.replace(/\d{8}(T\d{2,6}Z?)?/g, '#').replace(/PT\d+H(\d+M)?/gi, '#').replace(/\d{6,}/g, '#');
    // A GTS bulletin's copy number (JMA's …_20261124213322_191.grib) isn't part of its series
    if (GATEWAY_GRIB.test(topic)) series = series.replace(/_\d{1,5}(\.[a-z0-9]+)?$/i, '_#$1');
    return `${topic.replace(/^(cache|origin)\//, '')}/${series}`.toLowerCase();
}
import { FORECAST_PAGE, GATEWAY_GRIB } from '../../page.js';
import { track } from '../../lib/analytics.js';

export const GRIB_LAYERS = ['grib-fill', 'grib-line'];

// The forecasts page, which has nothing else to do, reads far more, and more often
const FILE_GAP_MS = (FORECAST_PAGE ? 2 : 10) * 60e3;  // A series of files (same name but its numbers) read at most this often
const PRODUCTS_MAX = FORECAST_PAGE ? 400 : 60;  // The longest unchanged goes first
const FILES_PER_PRODUCT_MAX = 600;  // Tiles count one each
// Files read at once. Each is a run of small range requests one after another (a field's
// header, then the next's), so more at once keeps the network busy; a browser opens at most
// 6 connections to one HTTP/1.1 host (the S3 caches), so past that some wait their turn
const FETCHES = FORECAST_PAGE ? 8 : 2;
const WAITING_MAX = FORECAST_PAGE ? 1000 : 200;
const LIST_MAX = 100;  // Products listed for a click (in the info panel)

const products = new Map();  // product key -> { key, name, model, centre, grid, tiles: Map, files: Map, format, topic, updated }
const taken = new Map();  // file series -> when last read

// Two queues, each with readers of its own: WIS2's forecasts (multi-field files up to
// gigabytes, read field by field), and the GTS's GRIB bulletins (GATEWAY_GRIB), which come by
// the thousand each run (JMA's: every variable, level, octant and lead time a file of its own,
// one field of a few KB, read in one request). Apart, a run of bulletins neither holds up
// WIS2's readers nor pushes its files off the waiting list. The bulletins' list is long, as
// each is quick to read; their readers few, as more would only queue at the S3 cache, whose
// 6 connections a browser shares with WIS2's files there
const lanes = {
    wis2: { waiting: new Map(), max: WAITING_MAX, fetches: FETCHES, fetching: 0 },  // file series -> newest job not yet read
    gts: { waiting: new Map(), max: FORECAST_PAGE ? 20000 : 0, fetches: 4, fetching: 0 },
};
const laneOf = (job) => (GATEWAY_GRIB.test(job.topic) ? lanes.gts : lanes.wis2);
const waitingCount = () => lanes.wis2.waiting.size + lanes.gts.waiting.size;
let map = null;
let deps = null;
let popup = null;
let listTimer = null;

// map: the MapLibre map. enabled(): whether the GRIB row is on. plotted(): counts a
// file read. changed(): the map key has something new. pointAt(point): whether an
// observation point is under the pointer
export function initGrib(options) {
    map = options.map;
    deps = options;
    // The forecasts page also lists open model data (loadOpenModels), once the page has started
    if (FORECAST_PAGE) {
        setTimeout(loadOpenModels, 2500);
        setInterval(loadOpenModels, OPEN_REFRESH_MS);
    }
}

export function addGribLayers(before) {
    var empty = { type: 'FeatureCollection', features: [] };
    map.addSource('grib', { type: 'geojson', data: empty });
    map.addLayer({ id: 'grib-fill', type: 'fill', source: 'grib', paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.05 } }, before);
    map.addSource('grib-edges', { type: 'geojson', data: empty });
    map.addLayer({ id: 'grib-line', type: 'line', source: 'grib-edges',
        paint: { 'line-color': ['get', 'color'], 'line-width': 1.5, 'line-opacity': 0.8, 'line-dasharray': [3, 2] } }, before);
    // A product picked from the list, a message or a click
    map.addSource('grib-selected', { type: 'geojson', data: empty });
    map.addLayer({ id: 'grib-selected', type: 'line', source: 'grib-selected',
        paint: { 'line-color': '#212529', 'line-width': 3 } }, before);
    // A GeoJSON forecast drawn: its points, each in its value's colour (drawGeojson)
    map.addSource('grib-points', { type: 'geojson', data: empty });
    map.addLayer({ id: 'grib-points', type: 'circle', source: 'grib-points',
        paint: { 'circle-color': ['get', 'color'], 'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 2.5, 6, 6],
            'circle-stroke-color': '#ffffff', 'circle-stroke-width': 0.5 } });
    map.on('click', 'grib-points', (e) => {
        if (deps.pointAt(e.point)) return;
        var props = JSON.parse(e.features[0].properties.props || '{}');
        if (popup) popup.remove();
        popup = new maplibregl.Popup({ maxWidth: '360px', className: 'grib-popup' }).setLngLat(e.lngLat)
            .setHTML(`<table class="grib-products">${Object.entries(props).map(([k, v]) =>
                `<tr><th>${esc(k)}</th><td>${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</td></tr>`).join('')}</table>`)
            .addTo(map);
        e.originalEvent.stopPropagation();
    });
    map.on('mousemove', 'grib-points', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'grib-points', () => { map.getCanvas().style.cursor = ''; });
    map.on('click', 'grib-fill', (e) => {
        // A point of a drawn GeoJSON forecast takes the click
        if (map.getLayer('grib-points') && map.queryRenderedFeatures(e.point, { layers: ['grib-points'] }).length) return;
        if (deps.pointAt(e.point)) return;
        // The products of each kind of forecast whose area is under the click
        var models = new Set(e.features.map((f) => f.properties.model));
        var hit = [...products.values()].filter((p) => models.has(p.model));
        if (hit.length) showProducts(hit, e.lngLat);
    });
    map.on('mousemove', 'grib-fill', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'grib-fill', () => { map.getCanvas().style.cursor = ''; });
    showActivity();  // "Waiting for forecast files" until the first arrives
    // The drawn field's value under the pointer, in the legend's units
    var valueLabel = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: 'hover-label', offset: 12 });
    var pending = null, frame = 0;
    map.on('mousemove', (e) => {
        pending = e.lngLat;
        if (frame) return;  // Once a frame, at the latest place
        frame = requestAnimationFrame(() => {
            frame = 0;
            var at = pending;
            var text = valueAt(at.lat, at.lng);
            if (text) valueLabel.setLngLat(at).setText(text).addTo(map);
            else valueLabel.remove();
        });
    });
    map.getCanvas().addEventListener('mouseleave', () => valueLabel.remove());
}

// The map's filters (applyMapFilter's expression)
export function filterGrib(expr) {
    if (!map || !map.getLayer('grib-fill')) return;
    GRIB_LAYERS.forEach((id) => map.setFilter(id, expr.length > 1 ? expr : null));
}

// Which part of the globe a notification's geometry covers, rounded: the tile a file is
// of where a centre splits a field into several (the Met Office's, side by side). '' for none
export function areaKey(geometry) {
    var ring = geometry && geometry.type === 'Polygon' ? geometry.coordinates[0]
        : geometry && geometry.type === 'MultiPolygon' ? geometry.coordinates[0][0] : null;
    if (!ring || ring.length < 3) return '';
    var xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
    return [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)].map((v) => Math.round(v)).join(',');
}

// A GRIB file announced. Files of one series (the same name but for its numbers: run,
// lead time, member) are read at most every FILE_GAP_MS, the newest first; each tile of a
// field split across several files is a series of its own, so every tile is read
export function queueGrib(job) {
    var series = `${productOf(job.topic, job.feature)}@${areaKey(job.feature.geometry)}`;
    if (Date.now() - (taken.get(series) || 0) < FILE_GAP_MS) return false;
    var lane = laneOf(job);
    if (!lane.max) return false;
    lane.waiting.delete(series);
    lane.waiting.set(series, job);
    if (lane.waiting.size > lane.max) lane.waiting.delete(lane.waiting.keys().next().value);
    pump();
    showActivity();
    return true;
}

export function clearGrib() {
    for (var lane of Object.values(lanes)) lane.waiting.clear();
    products.clear();
    redraw();
    if (popup) popup.remove();
}

// Each queue's readers take its newest file waiting
function pump() {
    for (var lane of Object.values(lanes)) {
        while (lane.fetching < lane.fetches && lane.waiting.size) {
            var [series, job] = [...lane.waiting].pop();
            lane.waiting.delete(series);
            taken.set(series, Date.now());
            if (taken.size > 30000) taken.delete(taken.keys().next().value);
            lane.fetching++;
            let done = lane;
            readFile(job).finally(() => {
                done.fetching--;
                pump();
            });
        }
    }
}

// The header of a message's file: { header, href }
export async function readGribHead(feature, topic) {
    var source = forecastSource(feature, topic);
    var { bytes, url } = await fetchHead(source);
    return { header: parseGribHeader(bytes), href: url };
}

// The WIS2 centre that made a forecast: its topic's, or for a GTS bulletin (…/H/V/M/Y/03/RJTD,
// relayed by jp-jma-gts-to-wis2) the one its CCCC is (RJTD: JMA's Tokyo; gtsOrigin.js), so
// it's listed with that centre's own forecasts. A CCCC not known stays as it is
export function forecastCentre(topic) {
    var centre = (topic.split('/a/wis2/')[1] || '').split('/', 1)[0];
    if (!GATEWAY_GRIB.test(topic)) return centre;
    return originCentre(topic.split('/').pop()) || centre;
}

// Which model a topic is: …/prediction/forecast/medium-range/deterministic/global reads
// "Medium-range deterministic, global"
export function modelOf(topic) {
    // Open model data (openData.js): its own name ("GFS 0.25°, global (NOAA open data)")
    if (topic.startsWith('open/')) return (OPEN_MODELS[topic.split('/').pop()] || {}).label || 'Open model data';
    // A GTS GRIB bulletin: listed under the centre that made it (forecastCentre), as its GTS model
    if (GATEWAY_GRIB.test(topic)) return 'Forecasts from the GTS';
    var parts = (topic.split('/prediction/')[1] || '').split('/').filter((p) => p && p !== 'forecast');
    if (!parts.length) return 'Forecast';
    var scope = parts.length > 1 ? parts.pop() : null;
    var name = parts.join(' ').replace(/-/g, ' ');
    name = name[0].toUpperCase() + name.slice(1).replace(/ range/, '-range');
    return scope ? `${name}, ${scope.replace(/-/g, ' ')}` : name;
}

// A GRIB file can hold many fields back to back (CMA's GEPS: every variable and level of a
// lead time, 88 MB). Each field's header is read in turn, from where the one before ends
// (its length is in its section 0), and each field is a product of its own, drawn from
// just its bytes. At most this many fields of a file, each header from this many bytes
const FIELDS_PER_FILE_MAX = 600;
const FIELD_HEAD_BYTES = 8192;
// Each field is a request of its own, so a file only the Worker can fetch (DWD's, KMA's,
// CMA's, a centre's own server) has at most this many of its fields read
const FIELDS_VIA_WORKER_MAX = 12;

async function readFile(job) {
    var props = job.feature.properties || {};
    var link = (job.feature.links || []).find((l) => l.rel === 'canonical' || l.rel === 'update') || {};
    var total = link.length || 0;
    var source = forecastSource(job.feature, job.topic);
    // Shown in the sidebar while it's read (renderActivity)
    var file = decodeURIComponent((link.href || '').split(/[?#]/)[0].split('/').pop()) || 'GRIB file';
    // Its × in the sidebar stops it (abort): the fields read so far stay listed
    var progress = { id: ++readingIds, file, centre: forecastCentre(job.topic), fields: 0, offset: 0, total,
        abort: new AbortController() };
    var signal = progress.abort.signal;
    reading.add(progress);
    showActivity();
    try {
        // Read unasked, so it counts against the page's Worker allowance (drawing a field later,
        // from a click, doesn't)
        var { bytes, url } = await fetchHead({ ...source, background: true }, 16384, 0, false, signal);
        // Less than was asked for is the whole file (a GTS bulletin's one field, a few KB): no
        // asking past its end for a next field, when the notification gives no length
        if (!total && bytes.length < 16384) total = bytes.length;
        // The later fields come from the copy that answered
        var pinned = { urls: [url], dataId: null, topic: null };
        var offset = 0;
        var most = viaWorker(url) ? FIELDS_VIA_WORKER_MAX : FIELDS_PER_FILE_MAX;
        progress.most = most;  // Fields it reads at most, for the estimate (fieldsText)
        progress.total = total;
        for (var n = 0; n < most; n++) {
            var header = parseGribHeader(bytes);
            if (!deps.enabled() || signal.aborted) return;
            if (header.grid && header.grid.outline) addField(job, header, url, n ? pinned : source, offset);
            progress.fields = n + 1;
            showActivity();
            if (!header.length || (total && offset + header.length >= total)) break;
            offset += header.length;
            progress.offset = offset;
            ({ bytes } = await fetchHead({ ...pinned, background: true }, FIELD_HEAD_BYTES, offset, false, signal));
        }
    } catch (err) {
        if (err.name !== 'AbortError' && !offset) console.debug(`Could not read the GRIB header of ${job.href}: ${err.message}`);
    } finally {
        reading.delete(progress);
        showActivity();
    }
}

// The drawn field's value at a point, as the legend shows it ("12.4 °C"), or null where it has none
function valueAt(lat, lon) {
    if (!fieldShown || !fieldShown.tiles) return null;
    var lng = ((lon + 180) % 360 + 360) % 360 - 180;
    for (var tile of fieldShown.tiles) {
        var k = tile.locate(lat, lng);
        var v = k >= 0 ? tile.values[k] : NaN;
        if (v === v) {
            var s = fieldShown.scale;
            return `${fmt(s.convert(v))}${s.unit ? ` ${s.unit}` : ''}`;
        }
    }
    return null;
}

// ---------- What's being read now, at the top of the sidebar's product list: a spinner and
// each file in progress (its fields read, and how far into it), and how many are waiting

const reading = new Set();  // { id, file, centre, fields, offset, total, abort } of each file being read
let readingIds = 0;
let activityTimer = null;

// How many fields of a file are read, and roughly how many it has: its size over the average
// size of the fields read so far (a file's fields are mostly alike in size: one grid, one
// packing). "12 of ~140 fields read", and where it has more than are read, how many will be
function fieldsText(r) {
    var read = `${r.fields} field${r.fields === 1 ? '' : 's'}`;
    if (!r.total || r.fields < 1 || !r.offset || r.offset >= r.total) return `${read} read`;
    var estimate = Math.max(r.fields, Math.round(r.total / (r.offset / r.fields)));
    if (estimate <= r.fields) return `${read} read`;
    var cap = r.most && estimate > r.most ? ` (the first ${r.most} are read)` : '';
    return `${r.fields} of ~${estimate.toLocaleString()} fields read${cap}`;
}

function showActivity() {
    if (FORECAST_PAGE && !activityTimer) activityTimer = setTimeout(renderActivity, 300);
}

const size = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`);

function renderActivity() {
    activityTimer = null;
    var section = document.querySelector('.legend-section-forecast');
    if (!section) return;
    var box = section.querySelector('.forecast-activity');
    if (!box) {
        box = document.createElement('div');
        box.className = 'forecast-activity';
        box.setAttribute('role', 'status');
        section.insertBefore(box, section.querySelector('.forecast-products'));
        // × stops reading a file (what it has read stays); Skip waiting drops the files not started
        box.addEventListener('click', (e) => {
            var stop = e.target.closest('[data-reading]');
            if (stop) {
                var r = [...reading].find((x) => x.id === Number(stop.dataset.reading));
                if (r) r.abort.abort();
            }
            if (e.target.closest('.forecast-skip')) {
                for (var lane of Object.values(lanes)) lane.waiting.clear();
                showActivity();
            }
        });
    }
    var busy = reading.size > 0;
    box.classList.toggle('busy', busy);
    var lines = [...reading].map((r) => `<li><span class="forecast-activity-file" title="${esc(r.file)}"><strong>${esc(r.centre)}</strong> ${esc(r.file)}`
        + `<small>${fieldsText(r)}${r.total > FIELD_HEAD_BYTES * 2 ? ` · ${size(r.offset)} of ${size(r.total)}` : ''}</small></span>`
        + `<button type="button" class="forecast-cancel" data-reading="${r.id}" title="Stop reading this file (what it has read stays)" aria-label="Stop reading ${esc(r.file)}">×</button></li>`);
    var waits = waitingCount(), gtsWaits = lanes.gts.waiting.size;
    // How many of those waiting are GTS bulletins, which have readers of their own
    var waitText = waits ? `${waits.toLocaleString()} waiting${gtsWaits ? ` (${gtsWaits === waits ? 'all' : gtsWaits.toLocaleString()} GTS)` : ''}` : '';
    var skip = waits ? ` <button type="button" class="btn btn-sm btn-link forecast-skip" title="Drop the files not started (later ones still come)">Skip waiting</button>` : '';
    box.innerHTML = busy
        ? `<div class="forecast-activity-head"><span class="forecast-spinner" aria-hidden="true"></span>Reading ${reading.size} file${reading.size === 1 ? '' : 's'}`
            + `${waits ? ` · ${waitText}` : ''}${skip}</div><ul>${lines.join('')}</ul>`
        : `<div class="forecast-activity-head">${waits ? `${waitText[0].toUpperCase()}${waitText.slice(1)}${skip}` : 'Waiting for forecast files'}</div>`;
}

// One field of a GRIB file, as a file of its product (offset: where it starts in the file)
// extra: more for the file (an open model's step: resolve, which finds its bytes when drawn)
function addField(job, header, href, source, offset, extra = null) {
    var g = header.grid;
    // Tiles of one field share a grid type and resolution, but not their size or place
    var grid = `${g.name}${g.resolution ? ` · ${g.resolution}` : ''}`;
    var tile = g.geo ? `${Math.round(g.geo.la1 * 100) / 100},${Math.round(g.geo.lo1 * 100) / 100},${g.ni}x${g.nj}` : areaKey(job.feature.geometry);
    // The members of an ensemble are one product: "Member 12 of 21" is a file of "Ensemble members (21)"
    var ensemble = header.ensemble && header.ensemble.replace(/^Member \d+ of (\d+)$/, 'Ensemble members ($1)');
    // And so are a variable's pressure levels ("850 hPa") and layers between them ("400 hPa to
    // 800 hPa", "800 hPa to Surface"): picked in the legend, like the lead time. hPa orders them
    // (a layer by its lower edge, the surface as 1013 hPa) and picks where a product opens
    var lvl = header.level || '';
    var single = /^[\d.]+ hPa$/.test(lvl);
    var layer = / to /.test(lvl) && /hPa/.test(lvl);
    var grouped = single || layer;
    var hPa = grouped ? Math.max(...(lvl.match(/[\d.]+(?= hPa)/g) || []).map(Number), /Surface/i.test(lvl) ? 1013 : -Infinity) : null;
    var level = single ? 'pressure levels' : layer ? 'pressure layers' : header.level;
    var name = [header.parameter, level, ensemble, header.probability, header.statisticName || header.statistic].filter(Boolean).join(', ');
    addFile(job.topic, g.outline, grid, name, 'grib', {
        group: `${header.run}|${header.leadHours}|${header.ensemble || ''}|${grouped ? lvl : ''}`, tile, summary: gribSummary(header),
        level: grouped ? lvl : null, hPa,
        run: header.run && `${header.run.slice(0, 13).replace('T', ' ')}Z`, leadHours: header.leadHours, href,
        valid: header.valid, ensemble: header.ensemble, length: header.length, offset,
        // Kept to draw its values (gribField.js), where its packing allows
        header, source, ...extra });
}

// A forecast notification that gives its area (the Met Office's NetCDF, a 146 MB file
// at most): outlined from the notification, nothing downloaded. Only on the forecasts page
export function addNotificationArea(topic, feature) {
    var g = feature.geometry;
    var ring = g && g.type === 'Polygon' ? g.coordinates[0] : g && g.type === 'MultiPolygon' ? g.coordinates[0][0] : null;
    if (!ring || ring.length < 4 || !deps.enabled()) return false;
    var info = fileDetails(feature, topic);
    var format = formatOf(feature, topic);
    addFile(topic, ring.map((p) => p.slice(0, 2)), 'Area given by the notifications', info.variable, format, {
        group: `${info.run}|${info.hours}`, tile: areaKey(g), summary: info.summary, run: info.run, leadHours: info.hours, href: info.href,
        valid: info.valid, length: info.length,
        // NetCDF (the Met Office's) is drawn by the decoder's netcdf_field, if it isn't too big
        // Whatever its name ends in: a link announced as NetCDF or HDF is read as one
        netcdf: format === 'hdf', source: forecastSource(feature, topic) });
    return true;
}

// ---------- GeoJSON forecasts (ECCC's station forecasts, e.g. GDPS-PROGNOS: 2,000 points a
// file, 1.5 to 2.3 MB): each file is a forecast of its product, known from its name, and
// downloaded only to draw it, as points coloured by their value (drawGeojson)

const GEOJSON_MAX_BYTES = 20e6;

// What a GeoJSON forecast holds, from its name: 20261123T12Z_MSC_GDPS-PROGNOS-MLR_AirTemp_AGL-1.5m_PT135H.json
// reads run 2026-11-23 12Z, model GDPS-PROGNOS-MLR, variable AirTemp, level AGL-1.5m, +135 h
export function geojsonDetails(feature, topic) {
    var info = fileDetails(feature, topic);
    var m = /^(\d{8})T(\d{2})Z_[A-Z]+_([^_]+)_(.+?)_(?:(.+?)_)?PT(\d+)H(?:\d+M)?\.(?:geo)?json$/i.exec(info.file);
    if (!m) return { ...info, name: info.variable };
    var run = `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)} ${m[2]}Z`;
    var hours = Number(m[6]);
    var valid = new Date(Date.UTC(+m[1].slice(0, 4), +m[1].slice(4, 6) - 1, +m[1].slice(6, 8), +m[2]) + hours * 3600e3).toISOString();
    // CamelCase to words: AirTemp reads "Air temp"
    var variable = m[4].replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
    variable = variable[0].toUpperCase() + variable.slice(1).toLowerCase();
    // The level, without the grid that follows it (MSL_RLatLon0.09 reads MSL)
    var level = (m[5] || '').replace(/_?R?LatLon[\d.]+/i, '');
    return { ...info, model: m[3], name: [variable, level].filter(Boolean).join(', '), variable: m[4], run, hours, valid,
        summary: `${variable} · +${hours} h` };
}

// A GeoJSON forecast announced (forecasts page only): listed under its product, not downloaded
export function addGeojsonFile(topic, feature) {
    if (!deps || !deps.enabled()) return false;
    var info = geojsonDetails(feature, topic);
    addFile(topic, null, `Stations (GeoJSON)${info.model ? ` · ${info.model}` : ''}`, info.name, 'json', {
        group: `${info.run}|${info.hours}`, tile: '', summary: info.summary, run: info.run, leadHours: info.hours,
        valid: info.valid, href: info.href, length: info.length, geojson: true, variable: info.variable,
        source: forecastSource(feature, topic) });
    return true;
}

// What a forecast file holds, from its notification alone: its name (the Met Office's
// 20261127T1200Z-PT0096H00M-wind_gust_at_10m.nc), the run and the lead time
export function fileDetails(feature, topic) {
    var props = feature.properties || {};
    var link = (feature.links || []).find((l) => l.rel === 'canonical' || l.rel === 'update') || {};
    var file = decodeURIComponent((link.href || props.data_id || '').split(/[?#]/)[0].split('/').pop());
    var lead = /PT(\d+)H/i.exec(file) || /T\+(\d+)/.exec(props.timestep || '');
    // The variable: the name without its times (20261124T120000Z, 24T12, 00Z, PT0096H00M), plain
    // numbers, or words the model's name already says (the Met Office's "global analysis")
    var name = file.replace(/\.[a-z0-9]+$/i, '').split(/[-_.]/)
        .filter((part) => part && !/^\d{8}T\d{4,6}Z?$|^\d{1,2}T\d{2}Z?$|^\d{2}Z$|^PT\d+H\d*M?$|^T\+\d+$|^\d+$/i.test(part)
            && !/^(global|regional|uk|analysis|forecast|deterministic|ensemble)$/i.test(part)).join(' ').replace(/\s+/g, ' ').trim();
    var run = props.datetime && !isNaN(Date.parse(props.datetime)) ? new Date(props.datetime).toISOString().slice(0, 13).replace('T', ' ') + 'Z' : null;
    var hours = lead ? Number(lead[1]) : null;
    var variable = name ? name[0].toUpperCase() + name.slice(1) : file;
    var valid = run && hours !== null ? new Date(Date.parse(props.datetime) + hours * 3600e3).toISOString() : null;
    return {
        variable,
        summary: [variable, hours !== null ? `+${hours} h` : null].filter(Boolean).join(' · '),
        sub: [forecastCentre(topic), run && `run ${run}`].filter(Boolean).join(' · '),
        href: link.href, file, run, hours, valid, length: link.length || null,
    };
}

// A colour for each model, so products of one model match on the map and in the list
const PALETTE = ['#7048e8', '#1c7ed6', '#0ca678', '#f08c00', '#e8590c', '#c2255c', '#5c940d', '#1098ad', '#862e9c', '#495057'];
const modelColours = new Map();
function modelColour(model) {
    if (!modelColours.has(model)) modelColours.set(model, PALETTE[modelColours.size % PALETTE.length]);
    return modelColours.get(model);
}

// A file of a product (made the first time one of its files is read). A file is one tile
// (file.tile, '' for a whole field) of one forecast (file.group: run, lead time, member);
// the product's area is all its tiles' outlines
function addFile(topic, outline, grid, name, format, file) {
    var centre = forecastCentre(topic);
    var model = `${centre} · ${modelOf(topic)}`;
    var key = `${model}|${grid}|${name}`;
    var product = products.get(key) || { key, name, model, centre, grid, tiles: new Map(), files: new Map(), format, topic };
    products.delete(key);  // Re-inserted, so the longest unchanged is first
    products.set(key, product);
    // A GeoJSON forecast's area is known only once it's drawn (see drawGeojson)
    if (outline) product.tiles.set(file.tile || '', outline);
    product.topic = topic;
    product.updated = Date.now();
    var fileKey = `${file.group}|${file.tile || ''}`;
    product.files.delete(fileKey);
    product.files.set(fileKey, { ...file, updated: Date.now() });
    if (product.files.size > FILES_PER_PRODUCT_MAX) product.files.delete(product.files.keys().next().value);
    while (products.size > PRODUCTS_MAX) products.delete(products.keys().next().value);
    if (bulk) return;  // A model's whole run being listed: drawn once at the end (loadOpenModels)
    redraw();
    deps.plotted();
    deps.changed();
    if (drawable(product)) drawFirstForecast();
}

// ---------- Open model data (openData.js: NOAA's GFS and HRRR, ECMWF's IFS), listed with WIS2's
// products under their centres. Each model's latest run as the page opens, and again every
// half hour; a step's field is found in its file's index only when it's drawn (readTile)

let bulk = false;
const OPEN_REFRESH_MS = 30 * 60e3;
const GLOBE_OUTLINE = latLonOutline(-90, -180, 90, 180, 1, 360);  // A global model's area

export async function loadOpenModels() {
    if (!FORECAST_PAGE) return;
    for (var id of Object.keys(OPEN_MODELS)) {
        try {
            var steps = await openModelSteps(id);
        } catch (err) {
            console.debug(`Could not list ${id}: ${err.message}`);
            continue;
        }
        if (!steps || !steps.length) continue;
        // A topic of WIS2's shape, so it's listed and filtered like WIS2's own (modelOf names it)
        var topic = `open/a/wis2/${OPEN_MODELS[id].centre}/data/core/weather/prediction/${id}`;
        bulk = true;
        try {
            for (var s of steps) {
                var run = s.run.toISOString();
                // A NetCDF file (the Met Office's): drawn whole by the decoder's reader, its size asked
                // for first (a placeholder until then, so it's listed as drawable)
                if (s.netcdf) {
                    addFile(topic, GLOBE_OUTLINE, 'Latitude/longitude · 10 km', s.name, 'hdf', {
                        group: `${run}|${s.step}`, tile: '', summary: `${s.name} · +${s.step} h`,
                        run: `${run.slice(0, 13).replace('T', ' ')}Z`, leadHours: s.step, href: s.url,
                        valid: new Date(s.run.getTime() + s.step * 3600e3).toISOString(), length: 1,
                        netcdf: true, source: { urls: [s.url], dataId: null, topic: null }, resolve: s.resolve });
                    continue;
                }
                var header = { ...s.header, run, leadHours: s.step, valid: new Date(s.run.getTime() + s.step * 3600e3).toISOString(), length: undefined };
                var source = { urls: [s.url], dataId: null, topic: null };
                // One field: found when drawn; wind speed: its two components, read and combined
                addField({ topic, feature: {} }, header, s.url, source, undefined,
                    s.parts.length === 1 ? { resolve: s.parts[0].resolve, factor: s.factor } : { combine: s.parts });
            }
        } finally {
            bulk = false;
        }
        redraw();
        deps.changed();
        drawFirstForecast();
    }
}

// ---------- A forecast drawn by itself as the page opens, so the legend shows one rather
// than a note: once something can be drawn, after a moment for more to arrive, the most
// telling product there is. Only once, and not after one has been picked or cleared

let firstDrawn = false;
let firstTimer = null;

function drawFirstForecast() {
    if (!FORECAST_PAGE || firstDrawn || firstTimer || fieldShown || fieldProduct) return;
    firstTimer = setTimeout(() => {
        firstTimer = null;
        if (firstDrawn || fieldShown || fieldProduct) return;
        var p = defaultProduct();
        if (!p) return;
        firstDrawn = true;
        showGribArea(outlinesOf(p), false);
        drawProduct(p);
    }, 3000);
}

// 2 m temperature, else sea-level pressure, else any temperature, else the first by name;
// GRIB before NetCDF and GeoJSON (NetCDF waits for Python to load)
function defaultProduct() {
    var list = [...products.values()].filter(drawable).sort((a, b) => a.name.localeCompare(b.name));
    var grib = list.filter((p) => p.format === 'grib');
    var pool = grib.length ? grib : list;
    return [/^Temperature, 2 m above ground$/, /^Pressure reduced to MSL/, /^Temperature/]
        .map((re) => pool.find((p) => re.test(p.name))).find(Boolean) || pool[0];
}

function redraw() {
    var source = map && map.getSource('grib');
    if (source) {
        // One layer for each kind of forecast (a centre's model): all its products' areas, each
        // once. While a product is drawn, only its own area is outlined
        var only = fieldShown ? products.get(fieldShown.product) : null;
        var byModel = new Map();
        for (var p of only ? [only] : products.values()) {
            var m = byModel.get(p.model) || { p, rings: new Map() };
            byModel.set(p.model, m);
            for (var ring of outlinesOf(p)) m.rings.set(JSON.stringify(ring.filter((_, i) => i % 12 === 0)), ring);
        }
        var models = [...byModel.values()].filter((m) => m.rings.size);
        var properties = (p) => {
            var t = p.topic.split('/a/wis2/')[1];
            return { model: p.model, layer: 'grib', format: p.format, channel: p.topic.split('/', 1)[0], centre: p.centre,
                discipline: disciplineOf(t), topic: p.topic.toLowerCase(), color: modelColour(p.model) };
        };
        source.setData({ type: 'FeatureCollection', features: models.map((m) => (
            { type: 'Feature', geometry: { type: 'MultiPolygon', coordinates: [...m.rings.values()].map((ring) => [ring]) }, properties: properties(m.p) })) });
        // The edges drawn without the run to a pole that closes an area round one (see edges)
        map.getSource('grib-edges').setData({ type: 'FeatureCollection', features: models.map((m) => (
            { type: 'Feature', geometry: { type: 'MultiLineString', coordinates: [...m.rings.values()].flatMap(edges) }, properties: properties(m.p) })) });
    }
    // The sidebar's list, at most once a second
    if (FORECAST_PAGE && !listTimer) listTimer = setTimeout(renderProductList, 1000);
}

// A product's area: its tiles' outlines (one for a field that isn't split)
function outlinesOf(p) {
    return [...p.tiles.values()];
}

// An outline's edges as lines: an area round a pole (ECCC's RDPS) is closed by running up
// to the pole and back (unwrap, gribHeader.js), which fills right but would draw as a seam
// down a meridian. The points at the pole, and the jump across 360° they bridge, are left out,
// and so is a global grid's edge along ±180° (where it meets itself, not an edge at all)
function edges(ring) {
    return edgeRuns(ring).filter((line) => !line.every((p) => Math.abs(p[0]) >= 179.999));
}

function edgeRuns(ring) {
    var lines = [], line = [];
    for (var p of ring) {
        var prev = line[line.length - 1];
        if (Math.abs(p[1]) >= 89.999 || (prev && Math.abs(p[0] - prev[0]) > 180)) {
            if (line.length > 1) lines.push(line);
            line = Math.abs(p[1]) >= 89.999 ? [] : [p];
            continue;
        }
        line.push(p);
    }
    if (line.length > 1) lines.push(line);
    return lines;
}

// How many forecasts (run, lead time, member) a product has, however many tiles each
function forecastCount(p) {
    // Levels of one forecast count once (the group's last part is its level)
    return new Set([...p.files.values()].map((f) => f.group.split('|').slice(0, 3).join('|'))).size;
}

// The level a product opens on (its name): 500 hPa where it has it, else the nearest to it
function defaultLevel(groups) {
    var levels = groups.map(([, g]) => g).filter((g) => g.level != null);
    if (!levels.length) return null;
    return levels.reduce((best, g) => (Math.abs(g.hPa - 500) < Math.abs(best.hPa - 500) ? g : best)).level;
}

// The lead times a product's files cover, its tiles, and its latest run
// As HTML: the counts, then when it's valid on a line of its own
function coverage(product) {
    var span = validSpan([...product.files.values()]);
    return `<small>${esc(counts(product))}</small>${span ? `<small>${esc(span)}</small>` : ''}`;
}

// How many forecasts a product has, of how many levels (its name no longer says "pressure
// levels", label), and tiles: "4 forecasts · 8 levels · 2 tiles"
function counts(p) {
    var n = forecastCount(p);
    var levels = new Set([...p.files.values()].map((f) => f.level).filter(Boolean)).size;
    var layers = / pressure layers/.test(p.name);
    return [`${n} forecast${n === 1 ? '' : 's'}`, levels > 1 && `${levels} ${layers ? 'layers' : 'levels'}`,
        p.tiles.size > 1 && `${p.tiles.size} tiles`].filter(Boolean).join(' · ');
}

// When its forecasts are valid, in UTC, rather than their lead from a run: "valid 11/24 03Z–12/05 06Z"
function validSpan(files) {
    var times = files.map((f) => Date.parse(f.valid)).filter((t) => !isNaN(t));
    if (!times.length) return '';
    var first = new Date(Math.min(...times)).toISOString(), last = new Date(Math.max(...times)).toISOString();
    return first === last ? `valid ${hour(first)}` : `valid ${hour(first)}–${hour(last)}`;
}

// The products under a click, each with what its files cover and its latest file
// A product's name as shown: without "Ensemble members (51)" (its members are picked in the
// legend) or a code number for a variable with no name ("Sub-surface (parameter 7)"). The
// full name stays its key, so two such variables are still two products
function label(p) {
    // Pressure levels and layers aren't named: how many there are follows the count of forecasts (counts)
    var plain = (name) => name.replace(/, Ensemble members \(\d+\)/, '').replace(/, pressure (levels|layers)/, '');
    var short = (name) => plain(name).replace(/ \((?:[^()]* )?parameter \d+\)/, '');
    var name = short(p.name);
    // Two of a model that would read the same (two moisture variables WMO's table doesn't
    // name, or a variable's levels and its layers) keep what tells them apart
    var twin = [...products.values()].some((o) => o !== p && o.model === p.model && short(o.name) === name);
    if (!twin) return name;
    var numbered = plain(p.name).replace(/ \((?:[^()]* )?parameter (\d+)\)/, ' (#$1)');
    return numbered !== name ? numbered : p.name.replace(/, Ensemble members \(\d+\)/, '');
}

// A model on two lines: its centre in bold (with the model's colour), the kind of forecast
// under it ("Medium-range deterministic, global"), and a count after the centre if given
function modelLabel(model, count) {
    var [centre, ...kind] = model.split(' · ');
    // Where it came from, at a glance: WIS2, or open data read from outside it (openData.js)
    var tag = openModel(model) ? '<span class="grib-source-tag open" title="Read straight from the model’s open data server, not through WIS2">open data</span>'
        : '<span class="grib-source-tag" title="Announced through WIS2">WIS2</span>';
    return `<span class="grib-model"><span class="grib-model-centre"><span class="grib-swatch" style="--color: ${modelColour(model)}"></span>`
        + `<strong>${esc(centre)}</strong>${tag}${count != null ? `<small class="grib-model-count">${count}</small>` : ''}</span>`
        + `<span class="grib-model-kind">${esc(kind.join(' · '))}</span></span>`;
}

// The products under a click, in the info panel: each with its model, what its files cover
// and a link to its latest file; a click on one draws it (or says why it can't be)
function showProducts(list, lngLat) {
    var row = (p) => {
        var latest = [...p.files.values()].pop();
        var files = [...p.files.values()];
        var span = validSpan(files).replace(/^valid /, '');
        var active = fieldShown && fieldShown.product === p.key;
        // The row draws it (the one drawn highlighted); one that can't be drawn is greyed,
        // with why on hover. Its latest file opens from the small link under its forecasts
        var cls = drawable(p) ? `grib-pick${active ? ' active' : ''}` : 'grib-static';
        var title = drawable(p) ? (active ? 'Drawn on the map' : `Draw ${label(p)}`) : `${whyNot(p)}.`;
        return `<tr class="${cls}"${drawable(p) ? ` data-product="${esc(p.key)}"` : ''} title="${esc(title)}">`
            + `<td>${esc(label(p))}</td>`
            + `<td>${esc(span)}<small>${esc(counts(p))}`
            + ` <span class="grib-latest">· <a href="${esc(latest.href || '')}" target="_blank" rel="noopener" title="The latest file: ${esc(latest.summary)}">latest file</a></span></small></td></tr>`;
    };
    // A heading row for each model, its products under it
    var byModel = new Map();
    list.slice(0, LIST_MAX).forEach((p) => {
        if (!byModel.has(p.model)) byModel.set(p.model, []);
        byModel.get(p.model).push(p);
    });
    var rows = [...byModel].map(([model, ps]) => `<tr class="grib-model-row"><th colspan="2">${modelLabel(model)}</th></tr>`
        + ps.sort((a, b) => label(a).localeCompare(label(b))).map(row).join('')).join('');
    if (popup) popup.remove();
    // In the info panel on the right, where a point's details open, rather than over the map:
    // it stays open as products are drawn, the one drawn marked
    var lat = lngLat.lat.toFixed(2), lon = (((lngLat.lng + 540) % 360) - 180).toFixed(2);
    var div = document.createElement('div');
    div.className = 'pp grib-panel';
    div.innerHTML = `
        <header class="pp-head">
            <span class="pp-dot grib-panel-dot" aria-hidden="true"></span>
            <div>
                <div class="pp-title">Forecasts here</div>
                <div class="pp-sub">${lat}, ${lon} · ${list.length} product${list.length === 1 ? '' : 's'}: click one to draw it</div>
            </div>
        </header>
        <table class="grib-products"><thead><tr><th>Product</th><th>Valid</th></tr></thead><tbody>${rows}</tbody></table>
        ${list.length > LIST_MAX ? `<small class="legend-note">and ${list.length - LIST_MAX} more</small>` : ''}`;
    div.addEventListener('click', (e) => {
        if (e.target.closest('a')) return;  // The product's latest file
        var row = e.target.closest('.grib-pick');
        var p = row && products.get(row.dataset.product);
        if (!p) return;
        div.querySelectorAll('.grib-pick.active').forEach((r) => r.classList.remove('active'));
        row.classList.add('active');
        drawProduct(p);
    });
    deps.showInfo(div);
    if (list.length === 1) showGribArea(outlinesOf(list[0]), false);
}

// Why a product's values can't be drawn: its packing, or it isn't GRIB
function whyNot(p) {
    var header = [...p.files.values()].map((f) => f.header).find(Boolean);
    if ([...p.files.values()].some((f) => f.netcdf)) return `Its files are too big to draw here (over ${NETCDF_MAX_BYTES / 1e6} MB)`;
    if (!header) return `${FORMATS[p.format] || 'These'} files aren't drawn here, only outlined`;
    if (header.packing === 40 && header.bits > JPEG_MAX_BITS) {
        return `Its values are ${header.bits}-bit JPEG 2000, wider than the decoder reads (${JPEG_MAX_BITS} bits)`;
    }
    return `Its values are packed with ${packingName(header.packing)}, which isn't drawn here`;
}

// The forecasts page's list of products, by centre and kind of forecast, under the Forecasts
// layers: each outlined (and gone to), and drawn, with a click on its name
function renderProductList() {
    listTimer = null;
    var section = document.querySelector('.legend-section-forecast');
    if (!section) return;
    var box = section.querySelector('.forecast-products');
    if (!box) {
        box = document.createElement('div');
        box.className = 'forecast-products';
        section.appendChild(box);
        box.addEventListener('click', (e) => {
            var button = e.target.closest('button[data-product]');
            var p = button && products.get(button.dataset.product);
            if (!p) return;
            showGribArea(outlinesOf(p));
            if (drawable(p)) drawProduct(p);
        });
        // The field drawn is shown in the map's legend (its place made by StyleControl)
        var panel = document.querySelector('.map-key .forecast-field');
        if (panel) {
            panel.addEventListener('change', (e) => {
                var p = products.get(fieldProduct);
                if (!p) return;
                // A time or a member: each option is the key of the forecast to draw
                if (e.target.matches('.forecast-lead, .forecast-member')) return drawProduct(p, e.target.value);
                var shown = drawableFiles(p).find(([k]) => k === (fieldShown && fieldShown.product === p.key ? fieldShown.file : panelFile));
                var current = shown && shown[1];
                // Another pressure level: at the same run and lead time where it has one, else the nearest now
                if (e.target.matches('.forecast-level')) {
                    var levelName = e.target.value;
                    var atLevel = drawableFiles(p).filter(([, f]) => f.level === levelName);
                    var sameTime = current && (atLevel.find(([, f]) => f.run === current.run && f.leadHours === current.leadHours && f.member === current.member)
                        || atLevel.find(([, f]) => f.run === current.run && f.leadHours === current.leadHours));
                    var now = Date.now(), away = (f) => Math.abs((Date.parse(f.valid) || now) - now);
                    var pick = sameTime || atLevel.reduce((best, f) => (!best || away(f[1]) < away(best[1]) ? f : best), null);
                    return pick && drawProduct(p, pick[0]);
                }
                // Another variable of the model: at the same run, lead time and level where it has them
                var other = e.target.matches('.forecast-variable') && products.get(e.target.value);
                if (!other) return;
                var sameAt = (f) => f.run === current.run && f.leadHours === current.leadHours && (f.level ?? null) === (current.level ?? null);
                var same = current && (drawableFiles(other).find(([, f]) => sameAt(f) && f.member === current.member)
                    || drawableFiles(other).find(([, f]) => sameAt(f)));
                showGribArea(outlinesOf(other), false);
                drawProduct(other, same ? same[0] : undefined);
            });
            panel.addEventListener('click', (e) => {
                e.stopPropagation();  // Not the legend's own tap (which opens it on phones)
                if (e.target.closest('.forecast-field-clear')) clearField();
                if (e.target.closest('.forecast-field-cancel')) cancelDraw();
                if (e.target.closest('.forecast-play')) {
                    if (loop) stopLoop(true);
                    else playLoop();
                }
            });
        }
    }
    // WIS2's products, then the open model data read from outside it (openData.js), apart and titled
    var all = [...products.values()];
    var wis2 = all.filter((p) => !isOpen(p)), open = all.filter(isOpen);
    var section = (title, note, list) => (list.length ? `<div class="forecast-source"><div class="forecast-source-title">${title}</div>`
        + `${note ? `<div class="legend-note forecast-source-note">${note}</div>` : ''}${productListHtml(list)}</div>` : '');
    var html = section('From WIS2', '', wis2)
        + section('Open model data, outside WIS2', 'Read straight from NOAA’s, ECMWF’s and the Met Office’s open data servers, not through WIS2', open);
    // Rebuilt only when it changed, keeping which kinds of forecast were folded
    if (html === box.dataset.html) return;
    var folded = new Set([...box.querySelectorAll('details.forecast-model:not([open])')].map((d) => d.dataset.model));
    box.innerHTML = box.dataset.html = html || '<p class="legend-note">Forecast products appear here as their files arrive.</p>';
    box.querySelectorAll('details.forecast-model').forEach((d) => { if (folded.has(d.dataset.model)) d.open = false; });
}

// Whether a product (or a model's name) is open model data rather than WIS2's
function isOpen(p) {
    return (typeof p === 'string' ? p : p.topic || '').startsWith('open/') || (typeof p === 'string' && openModel(p));
}
function openModel(model) {
    return Object.values(OPEN_MODELS).some((m) => model.endsWith(` · ${m.label}`));
}

// A list of products, as HTML: each centre once, in bold, and under it each of its kinds of
// forecast, folded and unfolded on its own line ("Medium-range deterministic, limited area  37")
function productListHtml(list) {
    var byModel = new Map();
    list.sort((a, b) => label(a).localeCompare(label(b))).forEach((p) => {
        if (!byModel.has(p.model)) byModel.set(p.model, []);
        byModel.get(p.model).push(p);
    });
    var byCentre = new Map();
    [...byModel].sort(([a], [b]) => a.localeCompare(b)).forEach(([model, ps]) => {
        var [centre, ...kind] = model.split(' · ');
        if (!byCentre.has(centre)) byCentre.set(centre, []);
        byCentre.get(centre).push([model, kind.join(' · '), ps]);
    });
    return [...byCentre].map(([centre, models]) => `<div class="forecast-centre"><strong>${esc(centre)}</strong>${models.map(([model, kind, list]) =>
        `<details class="forecast-model" data-model="${esc(model)}" open><summary><span class="grib-swatch" style="--color: ${modelColour(model)}"></span>`
        + `${esc(kind)}<small class="grib-model-count">${list.length}</small></summary><ul>${list.map((p) =>
            // One that can't be drawn is plain text, greyed, with why on hover
            (drawable(p)
                ? `<li><button type="button" data-product="${esc(p.key)}"${fieldShown && fieldShown.product === p.key ? ' class="active"' : ''}`
                    + ` title="${esc(p.grid)}: click to draw its values">${esc(label(p))} ${scaleSwatch(p)}`
                    + `${coverage(p)}</button></li>`
                : `<li><span class="forecast-static" title="${esc(whyNot(p))}">${esc(label(p))}${coverage(p)}</span></li>`)).join('')}</ul></details>`).join('')}</div>`).join('');
}

// ---------- A product's values, drawn (gribField.js): one field at a time, the file
// whose valid time is nearest now unless one is picked

let fieldShown = null;  // { product, file, url }
let fieldIds = 0;  // Each field drawn, so the world overview knows when to paint it again
let fieldProduct = null;  // The product being drawn, or last picked
let panelFile = null;  // The forecast the legend shows (being drawn, or drawn)
let fieldRequest = 0;  // So a slow download doesn't replace a later pick

// Whether a product's values can be drawn: GRIB packed in a way gribField.js reads
// NetCDF files bigger than this aren't drawn (the Met Office's on pressure levels run to 146 MB)
const NETCDF_MAX_BYTES = 40e6;

// Whether a file's values can be drawn: GRIB packed in a way gribField.js reads, or NetCDF small enough
function canDraw(f) {
    return !!f.source && (fieldDrawable(f.header)
        || (f.netcdf && f.length > 0 && f.length <= NETCDF_MAX_BYTES)
        || (f.geojson && !(f.length > GEOJSON_MAX_BYTES)));
}

function drawable(p) {
    return [...p.files.values()].some(canDraw);
}

// A product's forecasts that can be drawn, earliest valid first: [group key, { files (its
// tiles), valid, leadHours, run, ensemble, length (all its tiles) }]
function drawableFiles(p) {
    var groups = new Map();
    for (var f of p.files.values()) {
        if (!canDraw(f)) continue;
        var g = groups.get(f.group);
        if (!g) groups.set(f.group, g = { files: [], valid: f.valid, leadHours: f.leadHours, run: f.run, ensemble: f.ensemble,
            level: f.level || null, hPa: f.hPa ?? null,
            // An ensemble member's number ("Member 11 of 51"), picked in the legend apart from the time
            member: /^Member (\d+)/.test(f.ensemble || '') ? Number(/^Member (\d+)/.exec(f.ensemble)[1]) : null, length: 0 });
        g.files.push(f);
        g.length += f.length || 0;
    }
    return [...groups].sort(([, a], [, b]) => (a.valid || '').localeCompare(b.valid || '') || (a.leadHours ?? 0) - (b.leadHours ?? 0));
}

// One tile's values: { header, field }
async function readTile(file, signal) {
    // Wind speed from an open model's two components (openData.js), read side by side
    if (file.combine) {
        var [u, v] = await Promise.all(file.combine.map((part) => readTile(part, signal)));
        var values = new Float32Array(u.field.values.length), min = Infinity, max = -Infinity;
        for (var i = 0; i < values.length; i++) {
            var s = Math.hypot(u.field.values[i], v.field.values[i]);
            values[i] = s;
            if (s < min) min = s;
            if (s > max) max = s;
        }
        return { header: file.header, field: { values, min, max } };
    }
    // An open model's step: where its field is in the file, from the file's index, the first time
    if (file.resolve && !file.resolved) {
        Object.assign(file, await file.resolve(signal));
        file.resolved = true;
        if (file.netcdf && file.length > NETCDF_MAX_BYTES) throw new Error(`its file is ${(file.length / 1e6).toFixed(0)} MB, more than is drawn here`);
    }
    // Values in other units than the scale's (ECMWF's precipitation in metres, made mm)
    if (file.factor) {
        var plain = await readTile({ ...file, factor: null }, signal);
        var scaled = plain.field.values.map((x) => x * file.factor);
        return { header: plain.header, field: { values: scaled, min: plain.field.min * file.factor, max: plain.field.max * file.factor } };
    }
    // A GRIB field from the copy its header was read from, where its offset is known to be
    // right: another copy under the same data_id can hold its fields in another order (or be
    // another version), and the bytes there are another field
    var source = file.header && file.href ? { urls: [file.href], dataId: null, topic: null } : file.source;
    var { bytes } = await fetchHead(source, file.length || 50e6, file.offset || 0, !!file.length, signal);
    if (file.netcdf) {
        var read = JSON.parse(await callDecoder('netcdf_field', bytes, 1280));
        if (read.error) throw new Error(read.error);
        return netcdfField(read);
    }
    return { header: file.header, field: await decodeField(bytes, file.header.grid.points) };
}

async function drawProduct(p, fileKey) {
    stopLoop();  // Any pick stops a loop (the frame showing stays until this one's drawn)
    var files = drawableFiles(p);
    if (!files.length) return;
    var now = Date.now();
    var away = (f) => Math.abs((Date.parse(f.valid) || now) - now);
    // Unless one is picked, the lead time nearest now, at the product's opening level (500 hPa)
    var level = defaultLevel(files);
    var atLevel = level == null ? files : files.filter(([, g]) => g.level === level);
    var [key, forecast] = files.find(([k]) => k === fileKey) || atLevel.reduce((best, f) => (away(f[1]) < away(best[1]) ? f : best));
    var mine = ++fieldRequest;
    fieldProduct = p.key;
    // A download still going for an earlier pick stops: only the latest is wanted
    if (fieldAbort) fieldAbort.abort();
    var abort = fieldAbort = new AbortController();
    var mb = forecast.length ? ` (${(forecast.length / 1e6).toFixed(1)} MB)` : '';
    var tiles = forecast.files.length > 1 ? ` ${forecast.files.length} tiles` : '';
    renderFieldPanel(p, files, key, `Downloading${tiles}${mb}…`, false, true);
    var about = { centre: p.centre, model: modelOf(p.topic || ''), variable: p.name, format: p.format };
    var started = performance.now();
    track('forecast_draw', { ...about, mb: forecast.length ? Math.round(forecast.length / 1e5) / 10 : null });
    if (forecast.files[0].geojson) return drawGeojson(p, files, key, forecast.files[0], mine, abort.signal);
    try {
        // The tiles one after another, so they don't all hold memory at once while downloading
        var parts = [];
        for (var file of forecast.files) {
            parts.push(await readTile(file, abort.signal));
            if (mine !== fieldRequest) return;
        }
        renderFieldPanel(p, files, key, 'Drawing…');
        var image = await renderFields(parts);
        if (mine !== fieldRequest) return URL.revokeObjectURL(image.url);
        showFieldImage(image);
        if (fieldShown && fieldShown.url) URL.revokeObjectURL(fieldShown.url);
        fieldShown = { product: p.key, file: key, url: image.url, coordinates: image.coordinates, scale: image.scale, parts, id: ++fieldIds,  // parts: for the world overview
            // Each tile's grid, to look up the value under the pointer (showValue)
            tiles: parts.map((part) => ({ locate: gridLocator(part.header.grid.geo), values: part.field.values })) };
        renderFieldPanel(p, files, key, null);
        redraw();  // Only this product's outline now, and the list marks it
        track('forecast_drawn', { ...about, seconds: Math.round((performance.now() - started) / 100) / 10 });
    } catch (err) {
        if (err.name === 'AbortError') return;  // Cancelled (cancelDraw puts the legend back)
        track('forecast_error', { ...about, message: err.message });
        if (mine === fieldRequest) renderFieldPanel(p, files, key, `Could not draw it: ${err.message}`, true);
    }
}

let fieldAbort = null;  // Cancels the download of the field being drawn

// The legend's Cancel while a field downloads: the download stops, and the legend goes back
// to the field already drawn (or to its note when none is)
function cancelDraw() {
    stopLoop();
    track('forecast_cancel', {});
    fieldRequest++;
    if (fieldAbort) fieldAbort.abort();
    fieldAbort = null;
    var shown = fieldShown && products.get(fieldShown.product);
    if (shown) {
        fieldProduct = shown.key;
        renderFieldPanel(shown, drawableFiles(shown), fieldShown.file, null);
    } else {
        var panel = document.querySelector('.forecast-field');
        if (panel) panel.innerHTML = '<div class="legend-note">Pick a forecast product from the list in the sidebar, or click the map and Style one.</div>';
    }
}

// CF standard names to the variable names whose colour scales gribField.js knows
const CF_NAMES = { air_temperature: 'Temperature', dew_point_temperature: 'Dew point', relative_humidity: 'Relative humidity',
    air_pressure_at_sea_level: 'Pressure reduced to MSL', wind_speed: 'Wind speed', wind_speed_of_gust: 'Wind gust',
    precipitation_amount: 'Total precipitation', thickness_of_rainfall_amount: 'Total precipitation',
    sea_surface_temperature: 'Sea surface temperature', sea_surface_wave_significant_height: 'Significant wave height' };

// What the decoder read from a NetCDF file (netcdf_field), as a GRIB header and field
// for renderField: a regular latitude/longitude grid, the values on it
function netcdfField(read) {
    var bin = atob(read.data);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    var values = new Float32Array(bytes.buffer);
    var name = read.standard_name || read.name || '';
    var min = read.min, max = read.max;
    // Fractions (units "1") of what the scales show as a percentage
    if (read.units === '1' && /humidity|fraction|cloud/.test(name)) {
        for (var k = 0; k < values.length; k++) values[k] *= 100;
        min *= 100;
        max *= 100;
    }
    var la1 = read.lat0, lo1 = read.lon0, la2 = read.lat0 + read.dlat * (read.nlat - 1), lo2 = read.lon0 + read.dlon * (read.nlon - 1);
    var di = Math.abs(read.dlon), dj = Math.abs(read.dlat);
    var header = {
        parameter: CF_NAMES[name] || (name.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())),
        grid: {
            ni: read.nlon, nj: read.nlat, points: read.nlon * read.nlat,
            outline: latLonOutline(Math.min(la1, la2), Math.min(lo1, lo2), Math.max(la1, la2), Math.max(lo1, lo2), read.nlon, di),
            geo: { kind: 'latlon', la1, lo1, di, dj, scan: (read.dlat > 0 ? 0x40 : 0) | (read.dlon < 0 ? 0x80 : 0), ni: read.nlon, nj: read.nlat },
        },
    };
    return { header, field: { values, min, max } };
}

function showFieldImage({ url, coordinates }) {
    var source = map.getSource('grib-field');
    if (source) {
        source.updateImage({ url, coordinates });
        map.setLayoutProperty('grib-field', 'visibility', 'visible');
    } else {
        map.addSource('grib-field', { type: 'image', url, coordinates });
        map.addLayer({ id: 'grib-field', type: 'raster', source: 'grib-field',
            paint: { 'raster-opacity': 0.75, 'raster-fade-duration': 0, 'raster-resampling': 'nearest' } }, 'grib-fill');
    }
}

// ECCC's GeoJSON variable names to the names whose colour scales gribField.js knows
const GEOJSON_NAMES = [[/^AirTemp|^Temp/i, 'Temperature'], [/^DewPoint/i, 'Dew point'], [/^RelativeHumidity|^RH$/i, 'Relative humidity'],
    [/^WindSpeed|^WindSpd/i, 'Wind speed'], [/^WindGust/i, 'Wind gust'], [/^Pressure.*MSL|^MSLP/i, 'Pressure reduced to MSL'],
    [/^Precip/i, 'Total precipitation']];

// The number a GeoJSON feature is coloured by: a value property (forecast_value, value…), or its only number
function valueOf(properties) {
    var p = properties || {};
    var named = Object.keys(p).find((k) => /(^|_)(value|val)$/i.test(k) && typeof p[k] === 'number');
    if (named) return p[named];
    var numbers = Object.values(p).filter((v) => typeof v === 'number');
    return numbers.length === 1 ? numbers[0] : null;
}

// A GeoJSON forecast drawn: its points coloured by value on the variable's scale (°C for
// air temperature, given in K or °C), the product's area set from where they are
async function drawGeojson(p, files, key, file, mine, signal) {
    try {
        var data = await fetchData(file.source, signal);
        if (mine !== fieldRequest) return;
        renderFieldPanel(p, files, key, 'Drawing…');
        var json = JSON.parse(new TextDecoder().decode(data.bytes));
        var list = (json.type === 'FeatureCollection' ? json.features : [json]).filter((f) => f && f.geometry && f.geometry.type === 'Point');
        if (!list.length) throw new Error('no points in the file');
        // Kelvin for the temperature scale, whatever the file gives
        var toK = (v, props) => (/^(°?C|deg ?C|celsius)$/i.test(props.unit || props.units || '') ? v + 273.15 : v);
        var values = list.map((f) => toK(valueOf(f.properties), f.properties || {})).filter((v) => v != null && isFinite(v));
        var parameter = (GEOJSON_NAMES.find(([re]) => re.test(file.variable || '')) || [])[1] || null;
        var scale = colourScale(parameter, Math.min(...values), Math.max(...values));
        // Without one of the app's scales, the file's own unit (the pressure centres' hPa)
        if (!parameter) scale.unit = (list[0].properties || {}).unit || (list[0].properties || {}).units || scale.unit;
        var colour = colourOn(scale);
        map.getSource('grib-points').setData({ type: 'FeatureCollection', features: list.map((f) => {
            var v = valueOf(f.properties);
            return { type: 'Feature', geometry: f.geometry, properties: {
                color: v == null ? '#adb5bd' : colour(toK(v, f.properties || {})), props: JSON.stringify(f.properties || {}) } };
        }) });
        if (map.getLayer('grib-field')) map.setLayoutProperty('grib-field', 'visibility', 'none');
        // Its area, now that it's known: around its points
        var lons = list.map((f) => f.geometry.coordinates[0]), lats = list.map((f) => f.geometry.coordinates[1]);
        p.tiles.set('', latLonOutline(Math.min(...lats), Math.min(...lons), Math.max(...lats), Math.max(...lons), 0, 0));
        if (fieldShown && fieldShown.url) URL.revokeObjectURL(fieldShown.url);
        fieldShown = { product: p.key, file: key, url: null, scale, id: ++fieldIds,
            points: list.map((f) => { var v = valueOf(f.properties); return [f.geometry.coordinates, v == null ? '#adb5bd' : colour(toK(v, f.properties || {}))]; }) };
        renderFieldPanel(p, files, key, null);
        redraw();
    } catch (err) {
        if (err.name === 'AbortError') return;  // Cancelled (cancelDraw puts the legend back)
        if (mine === fieldRequest) renderFieldPanel(p, files, key, `Could not draw it: ${err.message}`, true);
    }
}

function clearField() {
    stopLoop();
    fieldRequest++;
    if (fieldAbort) fieldAbort.abort();  // A download still going stops too
    fieldAbort = null;
    if (map.getLayer('grib-field')) map.setLayoutProperty('grib-field', 'visibility', 'none');
    if (map.getSource('grib-points')) map.getSource('grib-points').setData({ type: 'FeatureCollection', features: [] });
    if (fieldShown && fieldShown.url) URL.revokeObjectURL(fieldShown.url);
    fieldShown = null;
    var panel = document.querySelector('.forecast-field');
    if (panel) panel.innerHTML = '<div class="legend-note">Pick a forecast product from the list in the sidebar, or click the map and Style one.</div>';
    redraw();
}

// A valid time as day/month/year and the hour, UTC: 24/11/2026 03Z
const hour = (iso) => iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)} ${iso.slice(11, 13)}Z` : '';

// The forecast legend (in the map's legend): the model, its variables to pick from
// (alphabetical), the lead times of the one drawn, and its colour scale
// cancellable: a download is going, and the status gets a Cancel button (cancelDraw)
function renderFieldPanel(p, files, key, status, failed, cancellable) {
    var panel = document.querySelector('.forecast-field');
    if (!panel) return;
    var scale = fieldShown && fieldShown.product === p.key && !status ? fieldShown.scale : null;
    panelFile = key;
    // Pressure levels, nearest the ground first; the lead times are those of the level picked
    var picked = (files.find(([k]) => k === key) || [])[1] || {};
    // Each level or layer once, by name ("850 hPa", "800 hPa to Surface"), nearest the ground first
    var byLevel = new Map();
    files.forEach(([, f]) => { if (f.level != null) byLevel.set(f.level, f.hPa); });
    var levelList = [...byLevel].sort(([, a], [, b]) => b - a).map(([name]) => name);
    var levels = levelList.length ? `<select class="form-select form-select-sm forecast-level" aria-label="Level">${levelList.map((name) =>
        `<option value="${esc(name)}"${name === picked.level ? ' selected' : ''}>${esc(name)}</option>`).join('')}</select>` : '';
    // Times, each once and in order: picking one keeps the member drawn where that time has it,
    // else its lowest-numbered member (each option is that forecast's key)
    var atLevel = files.filter(([, f]) => (f.level ?? null) === (picked.level ?? null));
    var times = timeSteps(files, key);
    var options = times.map(([t, [k]]) => `<option value="${esc(k)}"${t === (picked.valid || '') ? ' selected' : ''}>`
        + `${esc(t ? t.replace(/\.000Z$/, 'Z') : '')}</option>`).join('');  // The valid time in full, ISO 8601: 2026-11-24T09:00:00Z
    // Members: those there are at the time and level picked
    var memberList = atLevel.filter(([, f]) => f.member != null && f.valid === picked.valid).sort(([, a], [, b]) => a.member - b.member);
    var members = memberList.length ? `<select class="form-select form-select-sm forecast-member" aria-label="Ensemble member">${memberList.map(([k, f]) =>
        `<option value="${esc(k)}"${k === key ? ' selected' : ''}>${esc(f.ensemble)}</option>`).join('')}</select>` : '';
    var siblings = [...products.values()].filter((o) => o.model === p.model && drawable(o)).sort((a, b) => label(a).localeCompare(label(b)));
    var variables = siblings.map((o) => `<option value="${esc(o.key)}"${o.key === p.key ? ' selected' : ''}>${esc(label(o))}</option>`).join('');
    var bar = scale ? `<div class="forecast-scale"><span>${esc(fmt(scale.low))}</span><i style="background: ${scaleGradient(scale)}"></i>`
        + `<span>${esc(fmt(scale.high))}${scale.unit ? ` ${esc(scale.unit)}` : ''}</span></div>` : '';
    // Play loops the time steps (playLoop); while it plays the button pauses it
    var playing = loop && loop.product === p.key;
    var play = times.length > 1 && !status ? `<button type="button" class="btn btn-sm btn-outline-secondary forecast-play" aria-pressed="${playing}"`
        + ` title="${playing ? 'Stop at the time step showing' : 'Loop through the time steps at this level'}">${playing ? '❚❚ Pause' : '▶ Play'}</button>` : '';
    panel.innerHTML = `<div class="forecast-field-head">${modelLabel(p.model)}`
        + `<button type="button" class="btn btn-sm btn-link forecast-field-clear">Clear</button></div>`
        + `<select class="form-select form-select-sm forecast-variable" aria-label="Variable">${variables}</select>${levels}`
        + `<div class="forecast-time"><select class="form-select form-select-sm forecast-lead" aria-label="Lead time">${options}</select>${play}</div>`
        + `${members}${bar}<div class="legend-note forecast-loop-status"${playing ? '' : ' hidden'}></div>`
        + (status ? `<div class="legend-note forecast-status${failed ? ' pp-error' : ''}">${esc(status)}`
            + `${cancellable ? '<button type="button" class="btn btn-sm btn-link forecast-field-cancel">Cancel</button>' : ''}</div>` : '');
}

// A colour scale as a CSS gradient, left to right: the app's scales in steps, a ramp smoothly
function scaleGradient(scale) {
    return `linear-gradient(90deg, ${scale.step
        ? scale.colours.flatMap((c, i, all) => [`${c} ${i / all.length * 100}%`, `${c} ${(i + 1) / all.length * 100}%`]).join(', ')
        : scale.colours.join(', ')})`;
}

// A product's colour scale, small, by its name in the list: what its values will be drawn in
// (its variable's scale, or the ramp for one without; a probability is drawn on the ramp)
function scaleSwatch(p) {
    var header = [...p.files.values()].map((f) => f.header).find(Boolean);
    var parameter = header ? (header.probability ? null : header.parameter) : p.name;
    return `<span class="forecast-drawable" style="background: ${scaleGradient(colourScale(parameter, 0, 1))}" aria-hidden="true"></span>`;
}

// The time steps at the level of the forecast key, each once, in order: [[valid, [key, forecast]]].
// Where a time has several members, the one drawn, else its lowest-numbered
function timeSteps(files, key) {
    var picked = (files.find(([k]) => k === key) || [])[1] || {};
    var byTime = new Map();
    for (var [k, f] of files.filter(([, g]) => (g.level ?? null) === (picked.level ?? null))) {
        var t = f.valid || '';
        var best = byTime.get(t);
        var better = !best || (f.member === picked.member && best[1].member !== picked.member)
            || (best[1].member !== picked.member && (f.member ?? 0) < (best[1].member ?? 0));
        if (better) byTime.set(t, [k, f]);
    }
    return [...byTime].sort(([a], [b]) => a.localeCompare(b));
}

// ---------- Looping the time steps (the legend's Play): each step at the level and member
// shown is read and drawn in turn, all on the scale of the field showing when Play was
// pressed, and the frames shown one after another as soon as two are ready. The legend's
// time follows; the value under the pointer is the frame's. Pause, or any other pick, stops
// it at the frame showing, which stays drawn

const LOOP_FRAMES_MAX = 24;  // Frames kept: each holds its field's values, for the hover
const LOOP_MS = 800;  // Each frame shown this long

let loop = null;  // { product, keys, frames: Map key -> frame, index, timer, abort }

function playLoop() {
    var p = fieldShown && products.get(fieldShown.product);
    if (!p || !fieldShown.parts) return;
    var files = drawableFiles(p);
    var steps = timeSteps(files, fieldShown.file).slice(0, LOOP_FRAMES_MAX);
    if (steps.length < 2) return;
    var keys = steps.map(([, [k]]) => k);
    // Members are combined: each time step is the member drawn where it has that one, else its
    // lowest-numbered (an ensemble's files often hold different members at different times)
    loop = { product: p.key, keys, steps: new Map(steps.map(([, [k, f]]) => [k, f])), frames: new Map(),
        index: Math.max(0, keys.indexOf(fieldShown.file)), timer: null, abort: new AbortController(), scale: fieldShown.scale };
    loop.frames.set(fieldShown.file, fieldShown);  // The one showing is the first frame
    renderFieldPanel(p, files, fieldShown.file, null);
    loopStatus();
    loadFrames(loop, p, files);
    loop.timer = setInterval(nextFrame, LOOP_MS);
}

// Reads and draws the frames not yet ready, one at a time, from the one after that showing
async function loadFrames(mine, p, files) {
    var order = mine.keys.slice(mine.index + 1).concat(mine.keys.slice(0, mine.index));
    for (var key of order) {
        if (loop !== mine || mine.frames.has(key)) continue;
        var forecast = (files.find(([k]) => k === key) || [])[1];
        if (!forecast || forecast.files[0].geojson) continue;
        try {
            var parts = [];
            for (var file of forecast.files) parts.push(await readTile(file, mine.abort.signal));
            var image = await renderFields(parts, mine.scale);
            if (loop !== mine) return URL.revokeObjectURL(image.url);
            mine.frames.set(key, { product: p.key, file: key, url: image.url, coordinates: image.coordinates, scale: mine.scale, parts, id: ++fieldIds,
                tiles: parts.map((part) => ({ locate: gridLocator(part.header.grid.geo), values: part.field.values })) });
            loopStatus();
        } catch (err) {
            if (err.name === 'AbortError') return;
            console.debug(`Could not read a time step to loop: ${err.message}`);
        }
    }
}

// The next frame that's ready, in time order, drawn
function nextFrame() {
    if (!loop) return;
    for (var step = 1; step <= loop.keys.length; step++) {
        var i = (loop.index + step) % loop.keys.length;
        var frame = loop.frames.get(loop.keys[i]);
        if (!frame) continue;
        loop.index = i;
        showFrame(frame);
        return;
    }
}

function showFrame(frame) {
    showFieldImage(frame);
    fieldShown = frame;
    panelFile = frame.file;
    var select = document.querySelector('.forecast-field .forecast-lead');
    if (select) select.value = frame.file;
    loopStatus();
}

function loopStatus() {
    var el = document.querySelector('.forecast-field .forecast-loop-status');
    if (!el || !loop) return;
    var ready = loop.frames.size, all = loop.keys.length;
    // The frame's valid time in full, its lead, and which member it is where members take turns
    var f = loop.steps.get(loop.keys[loop.index]) || {};
    var when = f.valid ? `${f.valid.replace(/\.000Z$/, 'Z')}${f.leadHours != null ? ` (+${f.leadHours} h)` : ''}` : '';
    el.hidden = false;
    el.innerHTML = `${when ? `<strong>${esc(when)}</strong>` : ''}<small>Step ${loop.index + 1} of ${all}${f.ensemble ? ` · ${esc(f.ensemble)}` : ''}`
        + `${ready < all ? ` · reading ${ready} of ${all}` : ''}</small>`;
}

// Stops the loop at the frame showing (it stays drawn, the legend at its time); the other
// frames' images go. redraw: put the legend back as a still field
function stopLoop(redraw = false) {
    if (!loop) return;
    var stopped = loop;
    loop = null;
    clearInterval(stopped.timer);
    stopped.abort.abort();
    for (var frame of stopped.frames.values()) {
        if (frame !== fieldShown && frame.url) URL.revokeObjectURL(frame.url);
    }
    var p = products.get(stopped.product);
    if (redraw && p && fieldShown) renderFieldPanel(p, drawableFiles(p), fieldShown.file, null);
}

// A scale's end: whole above 100, a decimal above 1, and two significant figures below
// (a coefficient of drag's 0.0012), so small ranges don't read as 0 to 0
const fmt = (v) => {
    var a = Math.abs(v);
    if (a >= 100) return Math.round(v).toLocaleString();
    if (a >= 1 || v === 0) return (Math.round(v * 10) / 10).toLocaleString();
    return Number(v.toPrecision(2)).toLocaleString(undefined, { maximumSignificantDigits: 2 });
};

// ---------- The world overview (D3, Equal Earth, bottom right; overviewContent.js) on the
// forecasts page: the drawn field, reprojected pixel by pixel through its tiles' grids (and
// kept until the field or the overview's size changes, as the overview redraws every 2 s),
// a drawn GeoJSON forecast's points, and the products' outlines in their models' colours

let overviewField = null;  // { key, canvas } of the field as last painted

export function overviewForecast(ctx, projection, d3, width) {
    if (!FORECAST_PAGE || !map) return;
    var path = d3.geoPath(projection, ctx);
    if (fieldShown && fieldShown.parts) {
        var w = ctx.canvas.width, h = ctx.canvas.height, dpr = w / width;
        var key = `${fieldShown.id}|${w}|${h}`;
        if (!overviewField || overviewField.key !== key) overviewField = { key, canvas: paintField(fieldShown, projection, w, h, dpr) };
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 0.85;
        ctx.drawImage(overviewField.canvas, 0, 0);
        ctx.restore();
    }
    if (fieldShown && fieldShown.points) {
        var radius = width > 400 ? 1.8 : 1.3;
        for (var [coords, colour] of fieldShown.points) {
            var xy = projection(coords);
            if (!xy) continue;
            ctx.beginPath();
            ctx.arc(xy[0], xy[1], radius, 0, 2 * Math.PI);
            ctx.fillStyle = colour;
            ctx.fill();
        }
    }
    // Outlines: the drawn product's only while one is drawn, as on the map
    var only = fieldShown ? fieldShown.product : null;
    ctx.save();
    ctx.setLineDash([3, 2]);
    ctx.lineWidth = 1;
    for (var p of products.values()) {
        if (only && p.key !== only) continue;
        var lines = outlinesOf(p).flatMap(edges);
        if (!lines.length) continue;
        ctx.beginPath();
        path({ type: 'MultiLineString', coordinates: lines });
        ctx.strokeStyle = modelColour(p.model);
        ctx.stroke();
    }
    ctx.restore();
}

// The field as the overview sees it: each of its pixels (device pixels) back to latitude and
// longitude, and from the first tile with a value there, in the scale's colour
function paintField(shown, projection, w, h, dpr) {
    var canvas = new OffscreenCanvas(w, h);
    var image = new ImageData(w, h), px = image.data;
    var tiles = shown.parts.map((part) => ({ locate: gridLocator(part.header.grid.geo), values: part.field.values }));
    var rgb = rgbOn(shown.scale);
    for (var y = 0; y < h; y++) {
        for (var x = 0; x < w; x++) {
            var ll = projection.invert([(x + 0.5) / dpr, (y + 0.5) / dpr]);
            if (!ll || !(Math.abs(ll[0]) <= 180 && Math.abs(ll[1]) <= 90)) continue;
            // Equal Earth's inverse runs on past the outline of the Earth: only points that come back to the same place count
            var back = projection(ll);
            if (!back || Math.abs(back[0] * dpr - x - 0.5) > 1 || Math.abs(back[1] * dpr - y - 0.5) > 1) continue;
            for (var tile of tiles) {
                var k = tile.locate(ll[1], ll[0]);
                var v = k >= 0 ? tile.values[k] : NaN;
                if (v === v) {
                    var c = rgb(v), o = (y * w + x) * 4;
                    px[o] = c[0];
                    px[o + 1] = c[1];
                    px[o + 2] = c[2];
                    px[o + 3] = 255;
                    break;
                }
            }
        }
    }
    canvas.getContext('2d').putImageData(image, 0, 0);
    return canvas;
}

// Outlines an area on the map (a product's tiles, or a message's one), and goes to it if asked.
// outline: a ring of [lon, lat], or a list of them
export function showGribArea(outline, fit = true) {
    var source = map && map.getSource('grib-selected');
    if (!source) return;
    var rings = !outline || !outline.length ? [] : Array.isArray(outline[0][0]) ? outline : [outline];
    source.setData({ type: 'FeatureCollection', features: rings.length ? [{ type: 'Feature', geometry: { type: 'MultiLineString', coordinates: rings.flatMap(edges) }, properties: {} }] : [] });
    if (!rings.length || !fit) return;
    var lats = rings.flat().map((p) => p[1]);
    // Global grids, or ones round a pole, are left as the view is
    var lons = rings.flat().map((p) => p[0]);
    if (Math.max(...lons) - Math.min(...lons) >= 300) return;
    map.fitBounds([[Math.min(...lons), Math.max(-85, Math.min(...lats))], [Math.max(...lons), Math.min(85, Math.max(...lats))]], { padding: 40, maxZoom: 6 });
}
