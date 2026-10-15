String.prototype.hexDecode = function(){
    var j;
    var hexes = this.match(/.{1,4}/g) || [];
    var back = "";
    for(j = 0; j<hexes.length; j++) {
        back += String.fromCharCode(parseInt(hexes[j], 16));
    }

    return back;
}

// Map
const MAX_POINTS = 50000;        // Oldest points are dropped beyond this...
const MAX_DECODED_POINTS = 30000;  // ...with reports decoded from files capped separately so they can't crowd out the rest
const FADE_MS = 60 * 60 * 1000;  // Points fade over an hour
const PULSE_MS = 1600;           // Length of the ripple on new arrivals
const COLORS = {
    cache: '#38965A',
    webcam: '#F8A700',
    origin: '#6f9fd8',
    gts: '#9b6cd1',
    wis2gts: '#c2255c',
    files: '#83C95D',
};
// GTS-to-WIS2 sublayers. Satellite bulletins are numerous and large, so that
// one is off until asked for (and their bulletins aren't downloaded until then).
const GTS_CLASSES = {
    station: { label: 'Weather stations', color: '#9b6cd1', title: 'Reports with a station name, WMO block and station number, or WIGOS identifier' },
    upperair: { label: 'Upper-air soundings', color: '#5f3dc4', title: 'Reports with a profile of pressure levels (radiosondes, TEMP)' },
    aircraft: { label: 'Aircraft', color: '#1098ad', title: 'Reports with an aircraft registration or flight number (AMDAR, AIREP)' },
    ship: { label: 'Ships', color: '#364fc7', title: 'Reports with a ship or mobile station identifier' },
    buoy: { label: 'Buoys and floats', color: '#e8590c', title: 'Reports with a marine platform or buoy identifier' },
    satellite: { label: 'Satellites', color: '#868e96', optIn: true, title: 'Reports with a satellite identifier (winds, radiances, occultations); downloaded only while this is on' },
    other: { label: 'Other', color: '#c0a8e8', title: 'Reports without any of the identifiers above' },
};

// Legend rows, grouped by source; each can be switched on and off. Rows other
// than opt-in ones stay hidden until a point of that kind has arrived. Opt-in
// rows are decoded in the browser, since their notifications carry no location.
const LAYER_GROUPS = [
    { label: 'WIS2 data', layers: [
        { key: 'obs', label: 'Cache', color: COLORS.cache },
        // A sublayer: shown under its parent, and off whenever the parent is off
        { key: 'files', parent: 'obs', label: 'Decode required', color: COLORS.files, optIn: true,
            title: 'Download and decode small cached files whose notification has no location, and plot the reports inside' },
        { key: 'webcam', label: 'Webcam images', color: COLORS.webcam },
        { key: 'origin', label: 'Origin', color: COLORS.origin, ring: true },
    ] },
    { label: 'GTS gateways', layers: [
        { key: 'gts', label: 'GTS-to-WIS2 (decode required)', color: COLORS.gts, optIn: true,
            title: 'Download and decode the BUFR bulletins republished from the GTS into WIS2 (centres ending -gts-to-wis2), and plot the reports inside' },
        // Each decoded report is sorted by the identifiers it carries (see reportClass)
        ...Object.entries(GTS_CLASSES).map(([key, c]) => ({ key: `gts-${key}`, parent: 'gts', label: c.label, color: c.color,
            optIn: c.optIn, title: c.title })),
        { key: 'wis2gts', label: 'WIS2-to-GTS (decode required)', color: COLORS.wis2gts, optIn: true,
            title: 'Download and decode the BUFR that WIS2 centres pass on to the GTS (centres ending -wis2-to-gts), and plot the reports inside' },
    ] },
];
const hiddenLayers = new Set(['gts', 'wis2gts', 'files', 'gts-satellite']);
const LAYER_PARENTS = Object.fromEntries(LAYER_GROUPS.flatMap((g) => g.layers).filter((l) => l.parent).map((l) => [l.key, l.parent]));

// Layers switched off directly, plus sublayers whose parent is off
function effectiveHidden() {
    return [...new Set([...hiddenLayers, ...Object.keys(LAYER_PARENTS).filter((k) => hiddenLayers.has(LAYER_PARENTS[k]))])];
}
let showSpace = true;  // Satellite products, switched as a group across every layer
const seenLayers = new Set();
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let projection = 'globe';
try {
    projection = localStorage.getItem('wis-projection') === 'mercator' ? 'mercator' : 'globe';
} catch (err) {
    // Storage unavailable; use the default
}

const map = new maplibregl.Map({
    container: 'map',
    style: {
        version: 8,
        sources: {
            basemap: {
                type: 'raster',
                tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}'],
                tileSize: 256,
                maxzoom: 16,
                attribution: 'Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ',
            },
        },
        layers: [{ id: 'basemap', type: 'raster', source: 'basemap' }],
        projection: { type: projection },
        // Atmosphere halo around the globe, fading out as you zoom in, and a
        // pale sky above the horizon when the map is tilted
        sky: {
            'sky-color': '#cfe2f3',
            'horizon-color': '#eef4fa',
            'sky-horizon-blend': 0.6,
            'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 7, 0],
        },
    },
    center: [0, 30],
    zoom: 2,
    minZoom: 0,
    maxZoom: 15,
});

const ALTITUDE_ID = 1e9;     // Altitude bars share the points source, offset from their point's id
const records = new Map();  // id -> record for every point on the map
const pools = { wis2: new Map(), decoded: new Map() };  // Same records, in arrival order per cap
const byDataId = new Map(); // data_id -> record, so each observation is drawn once
let nextId = 1;
let toAdd = [];
let toRemove = [];
let pulses = [];            // Recent arrivals, drawn as expanding rings
let animating = false;

// The selected point's details open in a panel on the right, and a ring marks
// the point on the map
let infobar = null;
const selectedMarker = new maplibregl.Marker({ element: Object.assign(document.createElement('div'), { className: 'selected-marker' }) });
const hoverLabel = new maplibregl.Popup({
    closeButton: false,
    closeOnClick: false,
    className: 'hover-label',
    offset: 10,
});

map.on('load', () => {
    var empty = { type: 'FeatureCollection', features: [] };
    map.addSource('points', { type: 'geojson', data: empty });
    map.addSource('pulses', { type: 'geojson', data: empty });
    map.addSource('alert-area', { type: 'geojson', data: empty });
    map.addLayer({
        id: 'alert-area',
        type: 'fill',
        source: 'alert-area',
        paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.25 },
    });
    map.addLayer({
        id: 'alert-area-line',
        type: 'line',
        source: 'alert-area',
        paint: { 'line-color': ['get', 'color'], 'line-width': 2 },
    });
    map.addLayer({
        id: 'pulses',
        type: 'circle',
        source: 'pulses',
        paint: {
            'circle-color': 'rgba(0, 0, 0, 0)',
            'circle-stroke-color': ['get', 'color'],
            'circle-stroke-width': 1.5,
            'circle-pitch-alignment': 'map',
        },
    });
    // Reports with an altitude (aircraft) rise as bars when the map is tilted.
    // Heights are exaggerated when zoomed out so they stay visible on the globe.
    map.addLayer({
        id: 'altitude',
        type: 'fill-extrusion',
        source: 'points',
        paint: {
            'fill-extrusion-color': ['get', 'color'],
            'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'],
                1, ['*', ['get', 'alt'], 60],
                4, ['*', ['get', 'alt'], 20],
                8, ['*', ['get', 'alt'], 4],
                12, ['get', 'alt']],
            'fill-extrusion-opacity': 0.75,
        },
    });
    map.addLayer({
        id: 'points',
        type: 'circle',
        source: 'points',
        layout: { 'circle-sort-key': ['get', 'order'] },  // Newest on top
        paint: {
            // Origin-only messages are hollow rings; cache copies are filled
            'circle-color': ['get', 'color'],
            'circle-stroke-color': ['case', ['get', 'origin'], ['get', 'color'], '#ffffff'],
            'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 1, 0.75, 6, 1.5],
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 2, 4, 4.5, 8, 8, 15, 16],
            'circle-pitch-alignment': 'map',
        },
    });
    paintAge();
    setInterval(paintAge, 30 * 1000);
    applyMapFilter();
    preloadDecoder();
    flushPoints();
    setInterval(flushPoints, 500);

    map.on('click', 'points', (e) => openPopup(records.get(e.features[0].id)));
    map.on('click', 'altitude', (e) => openPopup(records.get(e.features[0].id - ALTITUDE_ID)));
    map.on('mousemove', 'points', (e) => {
        var record = records.get(e.features[0].id);
        map.getCanvas().style.cursor = 'pointer';
        if (!record) return hoverLabel.remove();
        hoverLabel.setLngLat(record.coords).setText(record.wsi || record.props.metadata_id || record.centre).addTo(map);
    });
    map.on('mouseleave', 'points', () => {
        map.getCanvas().style.cursor = '';
        hoverLabel.remove();
    });
});

// Adds a point, or returns the record already drawn for the same observation.
// The origin and every global cache each republish an observation, so a cache
// copy replaces an origin one but later copies are skipped.
function addPoint(record) {
    var existing = byDataId.get(record.props.data_id);
    if (existing && records.has(existing.id)) {
        if (existing.channel === 'cache' || record.channel !== 'cache') return existing;
        removePoint(existing);
    }
    if (record.props.data_id) byDataId.set(record.props.data_id, record);

    records.set(record.id, record);
    var feature = {
        type: 'Feature',
        id: record.id,
        geometry: { type: 'Point', coordinates: record.coords },
        properties: {
            color: record.color,
            origin: record.channel !== 'cache',
            born: record.born,
            order: record.id,
            layer: layerOf(record),
            format: record.format,
            channel: record.channel,
            centre: record.centre,
            discipline: record.discipline,
            space: isSpaceBased(record.topic) || record.subLayer === 'gts-satellite',
            topic: record.topic.toLowerCase(),
        },
    };
    toAdd.push(feature);
    if (record.alt > 0) toAdd.push(altitudeBar(record, feature.properties));
    if (!reduceMotion) pulses.push(feature);
    if (!seenLayers.has(feature.properties.layer)) showLegendRow(feature.properties.layer);

    var pool = record.decodedLayer ? pools.decoded : pools.wis2;
    pool.set(record.id, record);
    if (pool.size > (record.decodedLayer ? MAX_DECODED_POINTS : MAX_POINTS)) {
        removePoint(pool.values().next().value);
    }
    return record;
}

// A small square column at the report's location, extruded to its altitude
function altitudeBar(record, properties) {
    var [lon, lat] = record.coords;
    var half = 20;  // km
    var dLat = half / 111.32;
    var dLon = half / (111.32 * Math.max(Math.cos(lat * Math.PI / 180), 0.05));
    return {
        type: 'Feature',
        id: record.id + ALTITUDE_ID,
        geometry: {
            type: 'Polygon',
            coordinates: [[
                [lon - dLon, lat - dLat], [lon + dLon, lat - dLat],
                [lon + dLon, lat + dLat], [lon - dLon, lat + dLat], [lon - dLon, lat - dLat],
            ]],
        },
        properties: { ...properties, alt: record.alt },
    };
}

function layerOf(record) {
    if (record.subLayer) return record.subLayer;
    if (record.decodedLayer) return record.decodedLayer;
    if (record.channel !== 'cache') return 'origin';
    return record.webcam ? 'webcam' : 'obs';
}

function removePoint(record) {
    records.delete(record.id);
    pools[record.decodedLayer ? 'decoded' : 'wis2'].delete(record.id);
    if (byDataId.get(record.props.data_id) === record) byDataId.delete(record.props.data_id);
    var ids = record.alt > 0 ? [record.id, record.id + ALTITUDE_ID] : [record.id];
    var queued = toAdd.length;
    toAdd = toAdd.filter((f) => !ids.includes(f.id));
    if (toAdd.length === queued) toRemove.push(...ids);
}

// Batch updates so the map isn't redrawn for every message
function flushPoints() {
    var source = map.getSource('points');
    if (!source) return;
    if (toAdd.length || toRemove.length) {
        source.updateData({ add: toAdd, remove: toRemove });
        toAdd = [];
        toRemove = [];
    }
    var now = Date.now();
    pulses = pulses.filter((f) => now - f.properties.born < PULSE_MS);
    map.getSource('pulses').setData({ type: 'FeatureCollection', features: pulses });
    if (pulses.length && !animating) {
        animating = true;
        requestAnimationFrame(animatePulses);
    }
}

// Rings grow and fade out; driven by the current time since paint
// expressions can't read the clock themselves
function animatePulses() {
    var age = ['-', Date.now(), ['get', 'born']];
    map.setPaintProperty('pulses', 'circle-radius', ['interpolate', ['linear'], age, 0, 3, PULSE_MS, 22]);
    map.setPaintProperty('pulses', 'circle-stroke-opacity', ['interpolate', ['linear'], age, 0, 0.9, PULSE_MS, 0]);
    if (pulses.length) {
        requestAnimationFrame(animatePulses);
    } else {
        animating = false;
    }
}

function paintAge() {
    var opacity = ['interpolate', ['linear'], ['-', Date.now(), ['get', 'born']], 0, 1, FADE_MS, 0.35];
    map.setPaintProperty('points', 'circle-opacity', ['case', ['get', 'origin'], 0, opacity]);
    map.setPaintProperty('points', 'circle-stroke-opacity', opacity);
}

class ProjectionControl {
    onAdd(map) {
        var container = document.createElement('div');
        container.className = 'maplibregl-ctrl maplibregl-ctrl-group';
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'projection-toggle';
        var label = () => {
            var globe = projection === 'globe';
            button.textContent = globe ? 'Flat' : 'Globe';
            button.title = globe ? 'Switch to a flat (Mercator) map' : 'Switch to a globe';
        };
        label();
        button.addEventListener('click', () => {
            projection = projection === 'globe' ? 'mercator' : 'globe';
            map.setProjection({ type: projection });
            label();
            try {
                localStorage.setItem('wis-projection', projection);
            } catch (err) {
                // Storage unavailable; the choice just isn't remembered
            }
        });
        container.appendChild(button);
        return container;
    }

    onRemove() {
        // Nothing to do here
    }
}

class LegendControl {
    onAdd(map) {
        var container = document.createElement('div');
        container.className = 'maplibregl-ctrl legend';
        container.innerHTML = `
            ${LAYER_GROUPS.map((g) => `
            <div class="legend-group">${g.label}</div>
            ${g.layers.map((l) => `
            <label class="legend-toggle${l.parent ? ' legend-sub' : ''}" data-layer="${l.key}"${l.optIn || g.layers.some((c) => c.parent === l.key && c.optIn) ? '' : ' hidden'}${l.title ? ` title="${l.title}"` : ''}>
                <input type="checkbox" class="form-check-input"${hiddenLayers.has(l.key) ? '' : ' checked'}>
                <span class="legend-dot${l.ring ? ' legend-ring' : ''}" style="--color: ${l.color}"></span>${l.label}
            </label>`).join('')}`).join('')}
            <div class="legend-note legend-decode" hidden></div>
            <div class="legend-note">Pulses mark new arrivals; points fade over an hour</div>
            <div class="legend-about">WIS 2.0 Live shows real-time weather observations as they are published through the WMO Information System. This page is not affiliated with WMO.</div>`;

        var status = container.querySelector('.legend-decode');
        container.querySelectorAll('.legend-toggle[data-layer]').forEach((row) => {
            var key = row.dataset.layer;
            row.querySelector('input').addEventListener('change', (e) => {
                e.target.checked ? hiddenLayers.delete(key) : hiddenLayers.add(key);
                // Decoding runs for a layer that is on and whose parent is on too
                var hidden = effectiveHidden();
                Object.keys(DECODE_LAYERS).forEach((k) => {
                    var on = !hidden.includes(k);
                    if (on !== decodeEnabled.has(k)) setDecodeEnabled(k, on);
                });
                status.hidden = !decodeEnabled.size;
                syncSublayers();
                applyMapFilter();
            });
        });
        // Sublayers are greyed out while their parent is off
        var syncSublayers = () => container.querySelectorAll('.legend-sub').forEach((sub) => {
            var parentOff = hiddenLayers.has(LAYER_PARENTS[sub.dataset.layer]);
            sub.querySelector('input').disabled = parentOff;
            sub.classList.toggle('legend-disabled', parentOff);
        });
        syncSublayers();
        setInterval(() => {
            if (!decodeEnabled.size) return;
            var plotted = [...decodeEnabled].reduce((n, key) => n + decodePlotted[key], 0);
            status.textContent = decoderReady || plotted
                ? `${plotted.toLocaleString()} reports plotted · ${decodeQueue.length} files waiting`
                    + (decodeEnabled.has('gts') || decodeEnabled.has('wis2gts') ? ' · tilt to see aircraft altitude' : '')
                : 'Loading decoder…';
        }, 1000);
        return container;
    }

    onRemove() {
        // Nothing to do here
    }
}

function showLegendRow(key) {
    seenLayers.add(key);
    var row = document.querySelector(`.legend-toggle[data-layer="${key}"]`);
    if (row) row.hidden = false;
}

// Info panel
function openPopup(record) {
    if (!record) return;
    hoverLabel.remove();
    if (!infobar) {
        infobar = document.createElement('aside');
        infobar.className = 'infobar';
        infobar.setAttribute('aria-label', 'Selected observation');
        infobar.innerHTML = '<button type="button" class="btn-close infobar-close" aria-label="Close"></button><div class="infobar-body"></div>';
        infobar.querySelector('.infobar-close').addEventListener('click', closeInfo);
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.body.classList.contains('info-open')) closeInfo(); });
        document.body.appendChild(infobar);
    }
    // On narrow screens the two panels can't both fit
    if (window.innerWidth < 760) document.body.classList.remove('queue-open');
    infobar.querySelector('.infobar-body').replaceChildren(buildPopup(record));
    infobar.scrollTop = 0;
    document.body.classList.add('info-open');
    selectedMarker.setLngLat(record.coords).addTo(map);
    keepPopupInView();
}

function closeInfo() {
    document.body.classList.remove('info-open');
    selectedMarker.remove();
}

// Horizontal offset that centres a point in the map area left uncovered by the panels
function panelOffset() {
    var left = document.body.classList.contains('queue-open') ? document.querySelector('.queue').getBoundingClientRect().width : 0;
    var right = infobar && document.body.classList.contains('info-open') ? infobar.getBoundingClientRect().width : 0;
    return [(left - right) / 2, 0];
}

function buildPopup(record) {
    var props = record.props;
    var canonical = record.links.find((l) => l.rel == 'canonical');
    var oscar = record.links.find((l) => l.rel == 'via' && /oscar/.test(l.href));
    var image = record.webcam && canonical;

    var div = document.createElement('div');
    div.className = 'pp';
    div.innerHTML = `
        <header class="pp-head">
            <span class="pp-dot${record.channel !== 'cache' ? ' pp-ring' : ''}" style="--color: ${record.color}"></span>
            <div>
                <div class="pp-title"></div>
                <div class="pp-sub">
                    ${esc(record.centre)}
                    <span class="pp-badge pp-${record.channel}">${esc(record.channel)}</span>
                    ${props.pubtime ? `<span title="${esc(props.pubtime)}">${timeAgo(props.pubtime)}</span>` : ''}
                </div>
            </div>
        </header>
        ${image ? `<a href="${esc(image.href)}" target="_blank" rel="noopener"><img class="pp-image" src="${esc(image.href)}" alt="Webcam image"></a>` : ''}
        <dl class="pp-meta">
            ${record.wsi ? `<dt>Station</dt><dd>${oscar
                ? `<a href="${esc(oscar.href)}" target="_blank" rel="noopener">${esc(record.wsi)}</a>`
                : esc(record.wsi)}</dd>` : ''}
            ${props.datetime ? `<dt>Observed</dt><dd>${esc(new Date(props.datetime).toLocaleString())} (${timeAgo(props.datetime)})</dd>` : ''}
            <dt>Topic</dt><dd class="pp-mono">${esc(record.path)}</dd>
        </dl>
        <div class="pp-actions"></div>
        <div class="pp-tabs" role="tablist">
            <button type="button" role="tab" data-tab="data" aria-selected="true">Data</button>
            <button type="button" role="tab" data-tab="forecast" aria-selected="false">Model forecast</button>
        </div>
        <div class="pp-decoded" data-panel="data"></div>
        <div class="pp-forecast" data-panel="forecast" hidden></div>`;

    var title = div.querySelector('.pp-title');
    title.textContent = record.wsi || props.metadata_id || record.centre;

    var actions = div.querySelector('.pp-actions');
    var out = div.querySelector('.pp-decoded');
    if (canonical && !image) {
        var download = document.createElement('a');
        download.className = 'btn btn-sm btn-outline-secondary';
        download.href = canonical.href;
        download.target = '_blank';
        download.rel = 'noopener';
        download.textContent = `Download ${formatLabel(canonical.type)}${canonical.length ? ` (${formatBytes(canonical.length)})` : ''}`;
        actions.appendChild(download);
    }
    // Data and model forecast tabs; the forecast is only fetched once its tab is opened
    var forecastOut = div.querySelector('.pp-forecast');
    div.querySelectorAll('.pp-tabs button').forEach((button) => button.addEventListener('click', () => {
        var key = button.dataset.tab;
        div.querySelectorAll('.pp-tabs button').forEach((b) => b.setAttribute('aria-selected', b === button));
        div.querySelectorAll('[data-panel]').forEach((panel) => { panel.hidden = panel.dataset.panel !== key; });
        if (key === 'forecast' && !forecastOut.hasChildNodes()) showForecast(forecastOut, record);
        keepPopupInView();
    }));
    if (!record.source && !record.decoded) {
        out.innerHTML = '<div class="pp-status">No data to decode for this message.</div>';
    }
    // Opening a popup means wanting the data, so decode straight away
    if (record.decoded) {
        showDecoded(out, title, record.decoded);
    } else if (record.source) {
        decodeRecord(record, out, title);
    }
    return div;
}

async function decodeRecord(record, out, title) {
    try {
        record.decoded = await decodeSource(record.source, record.wsi, out);
        showDecoded(out, title, record.decoded);
        var forecast = out.parentNode && out.parentNode.querySelector('.pp-forecast');
        if (forecast && forecast.rerender) forecast.rerender();
    } catch (err) {
        showDecodeError(out, err, () => decodeRecord(record, out, title));
    }
    keepPopupInView();
}

function showDecodeError(out, err, retry) {
    out.innerHTML = `<div class="pp-status pp-error">Could not decode: ${esc(err.message)}</div>`;
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-sm btn-outline-primary pp-retry';
    button.textContent = 'Retry';
    button.addEventListener('click', retry);
    out.appendChild(button);
}

// Downloads and decodes a message's data: BUFR is decoded, text (e.g. a GTS
// bulletin) is returned as-is
async function decodeSource(source, wsi, out) {
    out.innerHTML = '<div class="pp-status">Downloading data…</div>';
    try {
        var data = await fetchData(source);
    } catch (err) {
        // CAP servers often block browser downloads; the notification still
        // carries the alert's urgency, severity and certainty
        if (source.cap) return { cap: null, capInfo: source.cap, href: source.urls[0] };
        throw err;
    }
    if (!data.bufr) {
        var text = new TextDecoder(isUtf8(data.bytes) ? 'utf-8' : 'latin1').decode(data.bytes);
        if (/<alert[\s>]/.test(text) && /emergency:cap/.test(text)) return { cap: text, href: data.url };
        if (/^\s*(<\?xml[^>]*\?>\s*)?<[A-Za-z]/.test(text)) return { xml: text, href: data.url };
        return { text: text };
    }

    out.innerHTML = `<div class="pp-status">${decoderReady ? 'Decoding…' : 'Loading decoder (first time only)…'}</div>`;
    var key = source.dataId || data.url || String(Date.now());
    var result = JSON.parse(await callDecoder('decode_bufr', data.bytes, wsi || '', key));
    result.key = key;
    return result;
}

function showDecoded(out, title, decoded) {
    if (decoded.cap !== undefined) {
        renderCap(out, title, decoded);
    } else if (decoded.xml !== undefined) {
        renderXml(out, title, decoded);
    } else if (decoded.text !== undefined) {
        out.innerHTML = '<pre class="pp-text"></pre>';
        out.firstChild.textContent = decoded.text.trim();
    } else {
        renderDecoded(out, title, decoded);
    }
}

// XML: Environment Canada citypage forecasts get their own view; anything else
// is shown as a collapsible tree, with the raw text a click away
function renderXml(out, title, decoded) {
    var doc = new DOMParser().parseFromString(decoded.xml, 'application/xml');
    if (doc.querySelector('parsererror')) {
        out.innerHTML = '<pre class="pp-text"></pre>';
        out.firstChild.textContent = decoded.xml.trim();
        return;
    }
    if (doc.documentElement.nodeName === 'siteData' && doc.querySelector('location > name')) {
        renderCitypage(out, title, doc);
    } else {
        out.innerHTML = '<div class="xml-tree"></div>';
        out.firstChild.appendChild(xmlTree(doc.documentElement, 0, { count: 0 }));
    }
    var raw = document.createElement('details');
    raw.className = 'pp-more';
    raw.innerHTML = '<summary>Raw XML</summary><pre class="pp-text"></pre>';
    raw.querySelector('pre').textContent = decoded.xml.trim();
    out.appendChild(raw);
}

// Elements holding only text are shown as "name: value"; the rest open and close
const XML_TREE_MAX = 3000;  // Nodes drawn before the rest is cut off

function xmlTree(el, depth, drawn) {
    var attrs = [...el.attributes].filter((a) => !/^xmlns|^xsi:/.test(a.name));
    var label = document.createElement('span');
    label.className = 'xml-tag';
    label.textContent = el.localName;
    var attrText = attrs.map((a) => `${a.name}="${a.value}"`).join(' ');
    var children = [...el.children];
    if (++drawn.count > XML_TREE_MAX) {
        var more = document.createElement('div');
        more.className = 'pp-status';
        more.textContent = '… (truncated, see the raw XML)';
        return more;
    }
    if (!children.length) {
        var leaf = document.createElement('div');
        leaf.className = 'xml-leaf';
        var value = document.createElement('span');
        value.className = 'xml-value';
        value.textContent = el.textContent.trim();
        leaf.append(label, value);
        if (attrText) leaf.title = attrText;
        return leaf;
    }
    var node = document.createElement('details');
    node.className = 'xml-node';
    node.open = depth < 3;
    var summary = document.createElement('summary');
    summary.appendChild(label);
    if (attrText) {
        var a = document.createElement('span');
        a.className = 'xml-attrs';
        a.textContent = attrText;
        summary.appendChild(a);
    }
    node.appendChild(summary);
    for (var child of children) {
        if (drawn.count > XML_TREE_MAX) break;
        node.appendChild(xmlTree(child, depth + 1, drawn));
    }
    return node;
}

// ---------- Environment Canada citypage weather (MSC, siteData schema)
function renderCitypage(out, title, doc) {
    var q = (el, sel) => (el ? el.querySelector(sel) : null);
    var tx = (el, sel) => {
        var n = sel ? q(el, sel) : el;
        var t = n && n.textContent.trim();
        return t || null;
    };
    // Local time of a named dateTime, e.g. "11:30 NDT"
    var local = (parent, name) => {
        var all = [...(parent ? parent.querySelectorAll(`:scope > dateTime[name="${name}"]`) : [])];
        var d = all.find((n) => n.getAttribute('zone') !== 'UTC') || all[0];
        return d ? `${tx(d, 'hour')}:${tx(d, 'minute')} ${d.getAttribute('zone')}` : null;
    };
    var unit = (n) => (n && n.getAttribute('units') ? ` ${n.getAttribute('units')}` : '');
    var withUnit = (el, sel) => {
        var n = q(el, sel), t = tx(n);
        return t === null ? null : `${t}${unit(n).replace(' C', ' °C')}`;
    };

    var place = tx(doc, 'location > name');
    var region = [tx(doc, 'location > region'), tx(doc, 'location > province')].filter(Boolean).join(', ');
    if (title && place) title.textContent = place;

    // Warnings and watches in effect
    var warnings = [...doc.querySelectorAll('warnings > event')].map((e) => ({
        type: e.getAttribute('type') || '',
        priority: e.getAttribute('priority') || '',
        text: e.getAttribute('description') || tx(e, 'textSummary') || '',
    }));
    var warningsUrl = q(doc, 'warnings') && q(doc, 'warnings').getAttribute('url');

    // Current conditions
    var cc = q(doc, 'currentConditions');
    var temp = tx(cc, ':scope > temperature');
    var pressure = q(cc, ':scope > pressure');
    var tendency = pressure && pressure.getAttribute('tendency');
    var wind = q(cc, ':scope > wind');
    var windText = wind && tx(wind, 'speed') ? [
        tx(wind, 'direction'), `${tx(wind, 'speed')} km/h`, tx(wind, 'gust') ? `gusting ${tx(wind, 'gust')}` : null,
    ].filter(Boolean).join(' ') : null;
    var station = tx(cc, 'station');

    // Forecast periods
    var periods = [...doc.querySelectorAll('forecastGroup > forecast')].map((f) => {
        var period = q(f, ':scope > period');
        var t = q(f, 'temperatures > temperature');
        return {
            name: (period && period.getAttribute('textForecastName')) || tx(period),
            short: tx(f, 'abbreviatedForecast > textSummary'),
            summary: tx(f, ':scope > textSummary'),
            pop: tx(f, 'abbreviatedForecast > pop'),
            temp: t && tx(t) !== null ? { value: tx(t), cls: t.getAttribute('class') } : null,
        };
    });

    // Hourly forecast, with hours shown in local time
    var issue = [...doc.querySelectorAll('hourlyForecastGroup > dateTime')].find((d) => d.getAttribute('zone') !== 'UTC');
    var offset = issue ? Number(issue.getAttribute('UTCOffset')) || 0 : 0;
    var hours = [...doc.querySelectorAll('hourlyForecastGroup > hourlyForecast')].map((h) => {
        var u = h.getAttribute('dateTimeUTC') || '';
        var time = new Date(Date.UTC(+u.slice(0, 4), +u.slice(4, 6) - 1, +u.slice(6, 8), +u.slice(8, 10), +u.slice(10, 12)));
        var t = tx(h, 'temperature');
        return {
            hour: new Date(time.getTime() + offset * 3600e3).getUTCHours(),
            temp: t === null ? null : Number(t),
            lop: Number(tx(h, 'lop')) || 0,
            condition: tx(h, 'condition'),
            wind: [tx(h, 'wind > direction'), tx(h, 'wind > speed') ? `${tx(h, 'wind > speed')} km/h` : null].filter(Boolean).join(' '),
        };
    }).filter((h) => h.temp !== null);

    var yesterday = q(doc, 'yesterdayConditions');
    var high = q(yesterday, 'temperature[class="high"]'), low = q(yesterday, 'temperature[class="low"]');
    var round = (n) => (tx(n) !== null ? Math.round(Number(tx(n))) : null);
    var sun = [local(q(doc, 'riseSet'), 'sunrise'), local(q(doc, 'riseSet'), 'sunset')];

    // Day and night periods share a row: "Friday  Mainly cloudy  7° / 2°"
    var days = [];
    for (var p of periods) {
        var last = days[days.length - 1];
        if (last && !last.night && p.temp && p.temp.cls === 'low' && (!last.temp || last.temp.cls === 'high')) {
            last.night = p;
        } else {
            days.push({ ...p, night: null });
        }
    }
    var degrees = (t) => (t ? `<span class="citypage-${esc(t.cls)}">${esc(t.value)}°</span>` : '');
    var now = cc && temp !== null ? [
        withUnit(cc, ':scope > dewpoint') ? `Dew point ${withUnit(cc, ':scope > dewpoint')}` : null,
        withUnit(cc, ':scope > relativeHumidity') ? `RH ${withUnit(cc, ':scope > relativeHumidity').replace(' %', '%')}` : null,
        pressure && tx(pressure) ? `${tx(pressure)} kPa${tendency ? ` ${{ rising: '↑', falling: '↓' }[tendency] || '→'}` : ''}` : null,
        windText,
        tx(cc, ':scope > windChill') ? `Wind chill ${tx(cc, ':scope > windChill')}` : null,
        tx(cc, ':scope > humidex') ? `Humidex ${tx(cc, ':scope > humidex')}` : null,
        withUnit(cc, ':scope > visibility') ? `Visibility ${withUnit(cc, ':scope > visibility')}` : null,
    ].filter(Boolean) : [];
    var extras = [
        ['Sunrise', sun[0]], ['Sunset', sun[1]],
        ['Yesterday', high || low ? [round(high) !== null ? `high ${round(high)}°` : null, round(low) !== null ? `low ${round(low)}°` : null].filter(Boolean).join(' · ') : null],
        ['Normals', tx(doc, 'regionalNormals > textSummary')],
        ['Forecast issued', local(q(doc, 'forecastGroup'), 'forecastIssue')],
    ].filter(([, v]) => v);
    var tabs = [
        hours.length > 1 ? ['hourly', 'Next hours'] : null,
        days.length ? ['forecast', 'Forecast'] : null,
        extras.length || periods.length ? ['details', 'Details'] : null,
    ].filter(Boolean);

    out.innerHTML = `
        <div class="citypage">
            ${!title && place ? `<div class="pp-name">${esc(place)}</div>` : ''}
            ${warnings.map((w) => `
            <div class="citypage-warning citypage-type-${esc(w.type.toLowerCase())}">
                <strong>${esc(w.text || w.type)}</strong>
                ${warningsUrl ? `<a href="${esc(warningsUrl)}" target="_blank" rel="noopener">Details</a>` : ''}
            </div>`).join('')}
            ${now.length ? `
            <div class="citypage-now">
                <div class="citypage-temp">${esc(Math.round(Number(temp)))}°</div>
                <div>
                    <div class="citypage-condition">${esc(tx(cc, ':scope > condition') || 'Now')}</div>
                    <div class="pp-status">${esc([station, local(cc, 'observation')].filter(Boolean).join(' · '))}</div>
                </div>
            </div>
            <div class="citypage-stats">${now.map(esc).join(' · ')}</div>` : region ? `<div class="pp-status">${esc(region)}</div>` : ''}
            ${tabs.length ? `
            <div class="citypage-tabs" role="tablist">${tabs.map(([key, label], i) => `
                <button type="button" role="tab" data-tab="${key}" aria-selected="${i === 0}">${label}</button>`).join('')}
            </div>
            <div class="citypage-panel" data-panel="hourly"><div class="citypage-hourly"></div></div>
            <div class="citypage-panel" data-panel="forecast">
                <ol class="citypage-periods">${days.map((d) => `
                    <li title="${esc([d.summary, d.night && `${d.night.name}: ${d.night.summary}`].filter(Boolean).join('\n\n'))}">
                        <span class="citypage-period">${esc(d.name || '')}</span>
                        <span class="citypage-short">${esc(d.short || '')}${d.pop ? ` <em>${esc(d.pop)}%</em>` : ''}</span>
                        <span class="citypage-hilo">${[degrees(d.temp), d.night ? degrees(d.night.temp) : ''].filter(Boolean).join(' / ')}</span>
                    </li>`).join('')}
                </ol>
            </div>
            <div class="citypage-panel" data-panel="details">
                ${extras.length ? `<dl class="citypage-extra">${extras.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : ''}
                ${periods.length ? `
                <details class="pp-more">
                    <summary>Full forecast text</summary>
                    <dl class="citypage-text">${periods.map((p) => `<dt>${esc(p.name || '')}</dt><dd>${esc(p.summary || '')}</dd>`).join('')}</dl>
                </details>` : ''}
            </div>` : ''}
        </div>`;
    if (hours.length > 1) renderHourly(out.querySelector('.citypage-hourly'), hours.slice(0, 24), { width: 300, height: 100 });
    var show = (key) => {
        out.querySelectorAll('.citypage-tabs button').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === key));
        out.querySelectorAll('.citypage-panel').forEach((panel) => { panel.hidden = panel.dataset.panel !== key; });
        keepPopupInView();
    };
    out.querySelectorAll('.citypage-tabs button').forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));
    if (tabs.length) show(tabs[0][0]);
}

// Temperature line over bars for the likelihood of precipitation, one per hour
function renderHourly(container, hours, opts) {
    var W = opts.width, H = opts.height;
    var m = { top: 14, right: 8, bottom: 18, left: 8 };
    var w = W - m.left - m.right, h = H - m.top - m.bottom;
    var temps = hours.map((p) => p.temp);
    var tMin = Math.min(...temps), tMax = Math.max(...temps);
    if (tMax - tMin < 4) { tMin -= 2; tMax += 2; }
    var step = w / hours.length;
    var x = (i) => m.left + step * (i + 0.5);
    var yT = (t) => m.top + h * 0.7 * (tMax - t) / (tMax - tMin);
    var yL = (l) => m.top + h - h * 0.35 * l / 100;

    var svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'hourly', role: 'img',
        'aria-label': 'Hourly temperature and chance of precipitation' });
    hours.forEach((p, i) => {
        if (p.lop) svgEl('rect', { x: x(i) - step / 2 + 1, y: yL(p.lop), width: step - 2, height: m.top + h - yL(p.lop), class: 'hourly-lop' }, svg);
        if (i % 3 === 0) svgEl('text', { x: x(i), y: H - 4, class: 'skewt-label', 'text-anchor': 'middle' }, svg).textContent = `${p.hour}h`;
    });
    svgEl('line', { x1: m.left, x2: m.left + w, y1: m.top + h, y2: m.top + h, class: 'skewt-tick' }, svg);
    svgEl('polyline', { points: hours.map((p, i) => `${x(i).toFixed(1)},${yT(p.temp).toFixed(1)}`).join(' '), class: 'hourly-temp' }, svg);
    // Label the warmest and coldest hours
    [temps.indexOf(Math.max(...temps)), temps.indexOf(Math.min(...temps))].forEach((i, k) => {
        svgEl('circle', { cx: x(i), cy: yT(hours[i].temp), r: 2.5, class: 'hourly-dot' }, svg);
        svgEl('text', { x: x(i), y: yT(hours[i].temp) + (k ? 12 : -5), class: 'skewt-label', 'text-anchor': 'middle' }, svg).textContent = `${hours[i].temp}°`;
    });

    var readout = svgEl('text', { x: W - m.right, y: 10, class: 'skewt-readout', 'text-anchor': 'end' }, svg);
    var guide = svgEl('line', { y1: m.top, y2: m.top + h, class: 'skewt-guide', visibility: 'hidden' }, svg);
    svg.addEventListener('mousemove', (e) => {
        var box = svg.getBoundingClientRect();
        var i = Math.max(0, Math.min(hours.length - 1, Math.floor(((e.clientX - box.left) * W / box.width - m.left) / step)));
        var p = hours[i];
        guide.setAttribute('x1', x(i));
        guide.setAttribute('x2', x(i));
        guide.setAttribute('visibility', 'visible');
        readout.textContent = [`${p.hour}h`, `${p.temp}°`, p.condition, p.lop ? `${p.lop}% precip.` : null, p.wind].filter(Boolean).join(' · ');
    });
    svg.addEventListener('mouseleave', () => {
        guide.setAttribute('visibility', 'hidden');
        readout.textContent = '';
    });
    container.replaceChildren(svg);
}

const SEVERITY_COLORS = {
    Extreme: '#8b1a1a',
    Severe: '#d9363e',
    Moderate: '#f08c00',
    Minor: '#e6b800',
    Unknown: '#868e96',
};

// Common Alerting Protocol: a readable card instead of raw XML. Without the
// XML (blocked download), falls back to the notification's cap_info.
function renderCap(out, title, decoded) {
    var alert = decoded.cap ? parseCap(decoded.cap) : { info: decoded.capInfo || {}, areas: [] };
    var info = alert.info;
    var severity = SEVERITY_COLORS[info.severity] ? info.severity : 'Unknown';
    var when = (v) => v ? esc(new Date(v).toLocaleString()) : '';
    if (title && info.event) title.textContent = info.event;

    out.innerHTML = `
        <div class="cap" style="--severity: ${SEVERITY_COLORS[severity]}">
            ${!title && info.event ? `<div class="cap-event">${esc(info.event)}</div>` : ''}
            <div class="cap-badges">
                <span class="cap-severity">${esc(severity)}</span>
                ${info.urgency ? `<span>${esc(info.urgency)}</span>` : ''}
                ${info.certainty ? `<span>${esc(info.certainty)}</span>` : ''}
            </div>
            ${info.headline ? `<div class="cap-headline">${esc(info.headline)}</div>` : ''}
            <dl class="pp-meta">
                ${alert.areaDesc ? `<dt>Area</dt><dd>${esc(alert.areaDesc)}</dd>` : ''}
                ${info.onset || info.effective ? `<dt>From</dt><dd>${when(info.onset || info.effective)}</dd>` : ''}
                ${info.expires ? `<dt>Until</dt><dd>${when(info.expires)}</dd>` : ''}
                ${info.senderName ? `<dt>Issued by</dt><dd>${esc(info.senderName)}</dd>` : ''}
            </dl>
            ${info.description ? `<p class="cap-text">${esc(info.description)}</p>` : ''}
            ${info.instruction ? `<p class="cap-text cap-instruction">${esc(info.instruction)}</p>` : ''}
            <div class="pp-actions"></div>
            ${decoded.cap ? '' : '<div class="pp-status">The full alert can\'t be downloaded in the browser; open it to read the details.</div>'}
            ${decoded.cap ? `<details class="pp-more"><summary>Alert XML</summary><pre class="pp-text"></pre></details>` : ''}
        </div>`;
    if (decoded.cap) out.querySelector('pre').textContent = decoded.cap;

    var actions = out.querySelector('.pp-actions');
    if (alert.areas.length) {
        var show = document.createElement('button');
        show.type = 'button';
        show.className = 'btn btn-sm btn-outline-secondary';
        show.textContent = 'Show area on map';
        show.addEventListener('click', () => showAlertArea(alert.areas, SEVERITY_COLORS[severity]));
        actions.appendChild(show);
    }
    var link = info.web || decoded.href;
    if (link) {
        var open = document.createElement('a');
        open.className = 'btn btn-sm btn-outline-secondary';
        open.href = link;
        open.target = '_blank';
        open.rel = 'noopener';
        open.textContent = info.web ? 'Issuer\'s page' : 'Open alert';
        actions.appendChild(open);
    }
}

function parseCap(xml) {
    var doc = new DOMParser().parseFromString(xml, 'application/xml');
    var child = (el, name) => el && el.getElementsByTagNameNS('*', name)[0];
    var text = (el, name) => { var c = child(el, name); return c ? c.textContent.trim() : ''; };
    // Prefer English when the alert is issued in several languages
    var infos = [...doc.getElementsByTagNameNS('*', 'info')];
    var infoEl = infos.find((i) => /^en/i.test(text(i, 'language'))) || infos[0];
    var info = {};
    ['event', 'urgency', 'severity', 'certainty', 'effective', 'onset', 'expires', 'senderName',
        'headline', 'description', 'instruction', 'web'].forEach((k) => { info[k] = text(infoEl, k); });

    var areaEls = infoEl ? [...infoEl.getElementsByTagNameNS('*', 'area')] : [];
    var areas = [];
    for (var area of areaEls) {
        // "lat,lon lat,lon ..." rings
        for (var poly of area.getElementsByTagNameNS('*', 'polygon')) {
            var ring = poly.textContent.trim().split(/\s+/).map((p) => p.split(',').map(Number).reverse());
            if (ring.length >= 4 && ring.every((c) => c.length === 2 && c.every(isFinite))) areas.push(ring);
        }
    }
    return {
        info: info,
        areaDesc: areaEls.map((a) => text(a, 'areaDesc')).filter(Boolean).join('; '),
        areas: areas,
    };
}

function showAlertArea(rings, color) {
    map.getSource('alert-area').setData({
        type: 'FeatureCollection',
        features: rings.map((ring) => ({
            type: 'Feature',
            geometry: { type: 'Polygon', coordinates: [ring] },
            properties: { color: color },
        })),
    });
    var bounds = new maplibregl.LngLatBounds();
    rings.flat().forEach((c) => bounds.extend(c));
    var sidebar = document.body.classList.contains('queue-open')
        ? document.querySelector('.queue').getBoundingClientRect().width : 0;
    map.fitBounds(bounds, { padding: { top: 60, bottom: 60, left: sidebar + 60, right: 60 }, maxZoom: 9 });
}

function isUtf8(bytes) {
    try {
        new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        return true;
    } catch (err) {
        return false;
    }
}

async function showReport(out, title, key, index) {
    try {
        var result = JSON.parse(await callDecoder('decode_bufr', null, '', key, index));
        result.key = key;
        renderDecoded(out, title, result);
    } catch (err) {
        out.innerHTML = `<div class="pp-status pp-error">Could not decode: ${esc(err.message)}</div>`;
    }
}

// Pan so the selected point isn't hidden under the sidebar or the info panel
function keepPopupInView() {
    var lngLat = selectedMarker.getLngLat();
    if (!lngLat || !document.body.classList.contains('info-open')) return;
    var point = map.project(lngLat);
    var view = map.getContainer().getBoundingClientRect();
    var left = document.body.classList.contains('queue-open') ? document.querySelector('.queue').getBoundingClientRect().right - view.left : 0;
    var right = infobar.getBoundingClientRect().left - view.left;
    var margin = 40;
    var dx = point.x < left + margin ? point.x - (left + margin) : point.x > right - margin ? point.x - (right - margin) : 0;
    var dy = point.y < margin ? point.y - margin : point.y > view.height - margin ? point.y - (view.height - margin) : 0;
    if (!dx && !dy) return;
    try {
        map.panBy([dx, dy]);
    } catch (err) {
        // On the zoomed-out globe a large pan can run past a pole; leave the view as is
    }
}

// Headline values shown as tiles, by BUFR descriptor
const KEY_VALUES = [
    { label: 'Altitude', ids: [7010, 10070] },
    { label: 'Temperature', ids: [12101, 12001] },
    { label: 'Dew point', ids: [12103, 12003] },
    { label: 'Humidity', ids: [13003] },
    { label: 'Pressure (MSL)', ids: [10051] },
    { label: 'Station pressure', ids: [10004], unless: [10051] },
    { label: 'Wind', ids: [11002], wind: true },
    { label: 'Visibility', ids: [20001] },
    { label: 'Cloud cover', ids: [20010] },
    { label: 'Precipitation', ids: [13011] },
];

function renderDecoded(out, title, result) {
    var values = new Map();
    for (var [id, name, value, unit] of result.rows) {
        if (!values.has(id)) values.set(id, [value, unit]);
    }
    // Station or site name (001015), falling back to the long name (001019)
    var name = [1015, 1019].map((id) => stationName(values.get(id))).find(Boolean);
    if (name && title) title.textContent = name;

    var profile = result.profile && result.profile.filter((l) => l[0] > 0);
    var sounding = profile && profile.length >= 2;
    var marine = sounding ? null : marineDetails(result.rows);
    var tiles = sounding ? soundingTiles(profile) : [];
    for (var key of sounding ? [] : KEY_VALUES) {
        var id = key.ids.find((i) => values.has(i));
        if (!id || (key.unless && key.unless.some((i) => values.has(i)))) continue;
        var text = formatValue(...values.get(id)).join(' ');
        if (key.wind && marine) text += ` (${knots(values.get(id)[0])} kn)`;
        if (key.wind && values.has(11001)) text += ` from ${values.get(11001)[0]}°`;
        tiles.push(`<div class="pp-tile"><div>${esc(key.label)}</div><strong>${esc(text)}</strong></div>`);
    }

    out.innerHTML = `
        ${result.subsets > 1 ? `
        <div class="pp-pager">
            <button type="button" class="btn btn-sm btn-outline-secondary" data-step="-1" aria-label="Previous report"${result.index > 0 ? '' : ' disabled'}>&lsaquo;</button>
            <span class="pp-status">Report ${result.index + 1} of ${result.subsets}</span>
            <button type="button" class="btn btn-sm btn-outline-secondary" data-step="1" aria-label="Next report"${result.index < result.subsets - 1 ? '' : ' disabled'}>&rsaquo;</button>
        </div>` : ''}
        ${name && !title ? `<div class="pp-name">${esc(name)}</div>` : ''}
        ${sounding ? `
        <div class="sounding"></div>
        <button type="button" class="btn btn-sm btn-outline-secondary sounding-expand">Expand sounding</button>` : ''}
        ${tiles.length ? `<div class="pp-tiles">${tiles.join('')}</div>` : ''}
        ${marine ? `
        <div class="pp-section">${marine.ship ? 'Sea state and ship' : 'Sea state'}</div>
        <div class="pp-marine">
            ${marine.compass}
            <div class="pp-tiles">${marine.tiles.join('')}</div>
        </div>
        ${marine.spectrum ? `<div class="pp-section">Wave spectrum</div>
        ${marine.spectrum.peak ? '<div class="wave-spectrum"></div>'
            : '<div class="pp-status">Calm: every band is below the 0.1 m²/Hz the buoy reports to</div>'}` : ''}` : ''}
        <details class="pp-more"${tiles.length ? '' : ' open'}>
            <summary>All decoded fields (${result.rows.length})</summary>
            <table class="table table-sm">${result.rows.map(([id, name, value, unit]) => `
                <tr><td>${esc(titleCase(name))}</td><td>${esc(formatValue(value, unit).join(' ').trim())}</td></tr>`).join('')}
            </table>
        </details>`;
    out.querySelectorAll('.pp-pager button').forEach((button) => button.addEventListener('click', () => {
        showReport(out, title, result.key, result.index + Number(button.dataset.step));
    }));
    if (marine && marine.spectrum && marine.spectrum.peak) {
        renderWaveSpectrum(out.querySelector('.wave-spectrum'), marine.spectrum, { width: 300, height: 190 });
    }
    if (sounding) {
        var label = name || (title && title.textContent) || 'Sounding';
        renderSkewT(out.querySelector('.sounding'), profile, { width: 300, height: 390, time: soundingTime(values) });
        out.querySelector('.sounding-expand').addEventListener('click', () => openSounding(profile, label, values));
    }
}

// Ships, buoys and other marine reports: sea temperature, waves, swell, ice and
// the platform's own motion. Wave and swell groups can repeat (e.g. a first and
// second swell system), so every occurrence is kept. Returns null when the
// report has none of these.
function marineDetails(rows) {
    var all = new Map();
    for (var [id, , value] of rows) {
        if (typeof value !== 'number') continue;
        all.has(id) ? all.get(id).push(value) : all.set(id, [value]);
    }
    var first = (...ids) => ids.map((id) => all.get(id)).find(Boolean)?.[0];
    var nth = (id, i) => (all.get(id) || [])[i];
    var tile = (label, text) => `<div class="pp-tile"><div>${esc(label)}</div><strong>${esc(text)}</strong></div>`;
    var wave = (height, period, from) => [
        height !== undefined ? `${Number(height.toFixed(1))} m` : null,
        period !== undefined ? `${period} s` : null,
        from !== undefined ? `from ${from}°` : null,
    ].filter(Boolean).join(' · ');

    var tiles = [];
    var sea = first(22043, 22049, 22042);
    if (sea !== undefined) tiles.push(tile('Sea temperature', `${(sea - 273.15).toFixed(1)} °C`));
    var salinity = first(22062);
    if (salinity !== undefined) tiles.push(tile('Salinity', `${salinity} ‰`));
    // Wave buoys: significant and maximum height, mean period and the direction
    // of the dominant waves; the peak period comes from the spectrum when there
    // is one, since the reported value is often unset
    var spectrum = waveSpectrum(rows);
    var peak = spectrum && spectrum.peak ? 1 / spectrum.peak.f : first(22071) > 1 ? first(22071) : undefined;
    var dominant = first(22076);
    if (all.has(22070)) {
        tiles.push(tile('Wave height', [`${first(22070)} m significant`, all.has(22073) ? `max ${first(22073)} m` : null].filter(Boolean).join(' · ')));
    }
    if (all.has(22074) || peak !== undefined) {
        tiles.push(tile('Wave period', [all.has(22074) ? `mean ${first(22074)} s` : null, peak !== undefined ? `peak ${peak.toFixed(1)} s` : null,
            dominant !== undefined ? `from ${dominant}°` : null].filter(Boolean).join(' · ')));
    }
    // Instrumental waves (022021/022011), then estimated wind waves (022022/022012)
    if (all.has(22021) || all.has(22011)) tiles.push(tile('Waves (measured)', wave(first(22021), first(22011))));
    if (all.has(22022) || all.has(22012)) tiles.push(tile('Wind waves', wave(first(22022), first(22012))));
    var swells = Math.max(...[22003, 22013, 22023].map((id) => (all.get(id) || []).length));
    var swellDirs = [];
    for (var i = 0; i < swells; i++) {
        swellDirs.push(nth(22003, i));
        tiles.push(tile(swells > 1 ? `Swell ${i + 1}` : 'Swell', wave(nth(22023, i), nth(22013, i), nth(22003, i))));
    }
    var course = first(1012), speed = first(1013);
    if (course !== undefined || speed !== undefined) {
        tiles.push(tile('Ship heading', speed === 0 ? 'Stopped'
            : [course !== undefined ? `${course}°` : null, speed !== undefined ? `${speed} m/s (${knots(speed)} kn)` : null].filter(Boolean).join(' at ')));
    }
    var ice = first(20031);
    if (ice !== undefined) tiles.push(tile('Ice on deck', `${Math.round(ice * 100)} cm`));
    if (!tiles.length) return null;

    var waveDirs = [dominant, ...swellDirs].filter((d) => d !== undefined);
    return { tiles, spectrum, ship: course !== undefined || speed !== undefined, compass: marineCompass(first(11001), waveDirs, speed ? course : undefined) };
}

function knots(ms) {
    return Math.round(ms * 1.943844);
}

// Directional wave spectrum: one entry per frequency band with its energy
// density (022069) and the direction the waves come from, from the first-order
// directional Fourier coefficients (042011 a1, 042012 b1). Returns null when the
// report has no spectrum.
function waveSpectrum(rows) {
    var bands = [], band = null;
    for (var [id, , value] of rows) {
        if (id === 22080) bands.push(band = { f: value, e: null, a1: null, b1: null });
        else if (!band) continue;
        else if (id === 22069) band.e = value;
        else if (id === 42011) band.a1 = value;
        else if (id === 42012) band.b1 = value;
    }
    bands = bands.filter((b) => b.f > 0 && b.e !== null);
    if (bands.length < 3) return null;
    for (var b of bands) {
        b.dir = b.a1 !== null && b.b1 !== null && (b.a1 || b.b1)
            ? (Math.atan2(b.b1, b.a1) * 180 / Math.PI + 360) % 360 : null;
    }
    var peak = bands.reduce((a, b) => (b.e > a.e ? b : a));
    return { bands, peak: peak.e > 0 ? peak : null };
}

// Energy against frequency (labelled as period), with a strip above showing
// where each band's waves come from
function renderWaveSpectrum(container, spectrum, opts) {
    var W = opts.width, H = opts.height;
    var m = { top: 8, right: 10, bottom: 30, left: 36 };
    var stripH = 46, gap = 10;
    var w = W - m.left - m.right;
    var dirTop = m.top, dirBottom = m.top + stripH;
    var eTop = dirBottom + gap, eBottom = H - m.bottom;
    var bands = spectrum.bands;
    // Log frequency, so long-period swell isn't squeezed against the axis
    var fMin = Math.min(0.03, bands[0].f * 0.9), fMax = Math.max(0.5, bands[bands.length - 1].f * 1.05);
    var eMax = Math.max(...bands.map((b) => b.e)) * 1.1 || 1;
    var x = (f) => m.left + w * Math.log(f / fMin) / Math.log(fMax / fMin);
    var yE = (e) => eBottom - (eBottom - eTop) * e / eMax;
    var yD = (d) => dirTop + stripH * d / 360;

    var svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'wavespec', role: 'img',
        'aria-label': 'Wave energy spectrum by period, with wave direction for each band' });
    svgEl('rect', { x: 0, y: 0, width: W, height: H, class: 'skewt-bg' }, svg);

    // Bars span halfway to each neighbouring band
    bands.forEach((b, i) => {
        var lo = i ? (bands[i - 1].f + b.f) / 2 : b.f - (bands[1].f - b.f) / 2;
        var hi = i < bands.length - 1 ? (b.f + bands[i + 1].f) / 2 : b.f + (b.f - bands[i - 1].f) / 2;
        b.lo = lo;
        b.hi = hi;
        if (b.e > 0) svgEl('rect', { x: x(lo) + 0.5, y: yE(b.e), width: Math.max(1, x(hi) - x(lo) - 1), height: eBottom - yE(b.e),
            class: b === spectrum.peak ? 'wavespec-bar wavespec-peak' : 'wavespec-bar' }, svg);
    });

    // Direction strip: a dot per band with energy, sized by its share of the peak
    for (var d of [0, 90, 180, 270, 360]) {
        svgEl('line', { x1: m.left, x2: m.left + w, y1: yD(d), y2: yD(d), class: 'skewt-isobar' }, svg);
        if (d < 360) svgEl('text', { x: m.left - 5, y: yD(d) + 3.5, class: 'skewt-label', 'text-anchor': 'end' }, svg).textContent = 'NESW'[d / 90];
    }
    var maxE = spectrum.peak ? spectrum.peak.e : 0;
    for (var b of bands) {
        if (b.dir === null || !(b.e > 0)) continue;
        svgEl('circle', { cx: x(b.f), cy: yD(b.dir), r: 1.5 + 3 * Math.sqrt(b.e / maxE), class: 'wavespec-dir' }, svg);
    }
    svgEl('rect', { x: m.left, y: dirTop, width: w, height: stripH, class: 'skewt-frame' }, svg);

    // Energy axis
    var step = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100].find((s) => eMax / s <= 4) || 200;
    for (var e = step; e < eMax; e += step) {
        svgEl('line', { x1: m.left, x2: m.left + w, y1: yE(e), y2: yE(e), class: 'skewt-isobar' }, svg);
        svgEl('text', { x: m.left - 5, y: yE(e) + 3.5, class: 'skewt-label', 'text-anchor': 'end' }, svg).textContent = Number(e.toFixed(1));
    }
    svgEl('text', { x: 0, y: 0, class: 'skewt-label', 'text-anchor': 'middle',
        transform: `translate(9 ${(eTop + eBottom) / 2}) rotate(-90)` }, svg).textContent = 'm²/Hz';
    // Period labels along the frequency axis
    for (var period of [25, 15, 10, 7, 5, 4, 3, 2]) {
        var f = 1 / period;
        if (f > fMax) continue;
        svgEl('line', { x1: x(f), x2: x(f), y1: eBottom, y2: eBottom + 4, class: 'skewt-tick' }, svg);
        svgEl('text', { x: x(f), y: eBottom + 14, class: 'skewt-label', 'text-anchor': 'middle' }, svg).textContent = period;
    }
    svgEl('text', { x: m.left + w / 2, y: H - 3, class: 'skewt-axis', 'text-anchor': 'middle' }, svg).textContent = 'Wave period (s)';
    svgEl('rect', { x: m.left, y: eTop, width: w, height: eBottom - eTop, class: 'skewt-frame' }, svg);

    // Hover readout for the band under the pointer
    var readout = svgEl('text', { x: m.left + w - 4, y: eTop + 12, class: 'skewt-readout', 'text-anchor': 'end' }, svg);
    svg.addEventListener('mousemove', (e) => {
        var box = svg.getBoundingClientRect();
        var px = (e.clientX - box.left) * W / box.width;
        var band = bands.find((b) => px >= x(b.lo) && px < x(b.hi));
        readout.textContent = band ? [`${(1 / band.f).toFixed(1)} s`, `${band.e} m²/Hz`,
            band.dir !== null && band.e > 0 ? `from ${Math.round(band.dir)}°` : null].filter(Boolean).join(' · ') : '';
    });
    svg.addEventListener('mouseleave', () => { readout.textContent = ''; });

    container.replaceChildren(svg);
}

// Compass showing where the wind and swell come from (arrows pointing in) and
// where the ship is heading (arrow pointing out)
function marineCompass(windFrom, swellFrom, heading) {
    if (windFrom === undefined && !swellFrom.length && heading === undefined) return '';
    var c = 50;
    var at = (deg, r) => [c + r * Math.sin(deg * Math.PI / 180), c - r * Math.cos(deg * Math.PI / 180)];
    var arrow = (deg, from, to, cls) => {
        var [x1, y1] = at(deg, from), [x2, y2] = at(deg, to);
        var a = Math.atan2(y2 - y1, x2 - x1);
        var head = [a + 2.6, a - 2.6].map((b) => `${(x2 + 7 * Math.cos(b)).toFixed(1)},${(y2 + 7 * Math.sin(b)).toFixed(1)}`);
        return `<g class="${cls}"><line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`
            + `<polygon points="${x2.toFixed(1)},${y2.toFixed(1)} ${head.join(' ')}"/></g>`;
    };
    var key = [
        windFrom !== undefined ? '<span><i class="pp-key-wind"></i>Wind</span>' : '',
        swellFrom.length ? '<span><i class="pp-key-swell"></i>Waves</span>' : '',
        heading !== undefined ? '<span><i class="pp-key-ship"></i>Ship</span>' : '',
    ].join('');
    return `
        <figure class="pp-compass">
            <svg viewBox="0 0 100 100" width="100" height="100" role="img" aria-label="Wind, swell and ship heading">
                <circle cx="${c}" cy="${c}" r="38" class="pp-compass-ring"/>
                ${['N', 'E', 'S', 'W'].map((d, i) => {
                    var [x, y] = at(i * 90, 46);
                    return `<text x="${x}" y="${y + 3.5}" text-anchor="middle">${d}</text>`;
                }).join('')}
                ${swellFrom.map((d) => arrow(d, 38, 8, 'pp-compass-swell')).join('')}
                ${windFrom !== undefined ? arrow(windFrom, 38, 8, 'pp-compass-wind') : ''}
                ${heading !== undefined ? arrow(heading, 0, 30, 'pp-compass-ship') : ''}
            </svg>
            <figcaption>${key}</figcaption>
        </figure>`;
}

// ---------- Model forecasts at a point, from the dynamical.org point API
// GFS and ECMWF's AIFS (its AI model) are both deterministic runs; an ensemble
// model would be drawn as its median with the 10th-90th percentile spread.
// Fetched only when asked for, one batch for all models.
const FORECAST_API = 'https://api.dynamical.org/v1/forecasts';
const FORECAST_HOURS = 168;
// Each model is asked only for variables it has (the API rejects the rest);
// together they cover every observed quantity the popup compares against
const FORECAST_COMMON = ['temperature_2m', 'wind_u_10m', 'wind_v_10m', 'precipitation_surface', 'pressure_reduced_to_mean_sea_level',
    'pressure_surface', 'total_cloud_cover_atmosphere', 'downward_short_wave_radiation_flux_surface'];
const FORECAST_MODELS = [
    // GFS precipitation and radiation are averaged since the last 6-hourly reset rather than over each step
    { id: 'noaa-gfs-forecast', label: 'GFS', cls: 'gfs', source: 'NOAA GFS', precipReset: 6,
        variables: [...FORECAST_COMMON, 'relative_humidity_2m', 'maximum_temperature_2m', 'minimum_temperature_2m'] },
    { id: 'ecmwf-aifs-single-forecast', label: 'ECMWF AIFS', cls: 'ecmwf', source: 'ECMWF AIFS Single',
        variables: [...FORECAST_COMMON, 'dew_point_temperature_2m', 'temperature_850hpa', 'temperature_925hpa',
            'geopotential_height_500hpa', 'geopotential_height_850hpa', 'geopotential_height_925hpa'] },
];
const FORECAST_CACHE_MS = 15 * 60 * 1000;
const forecastCache = new Map();  // rounded "lat,lon" -> { time, promise }

async function showForecast(out, record) {
    out.innerHTML = `<div class="pp-status">Loading ${FORECAST_MODELS.map((m) => m.label).join(' and ')} forecasts…</div>`;
    keepPopupInView();
    try {
        var models = await fetchForecast(record.coords);
        renderForecast(out, models, observedNow(record));
        // Redrawn when the observation finishes decoding, to add the comparison
        out.rerender = () => renderForecast(out, models, observedNow(record));
    } catch (err) {
        out.innerHTML = `<div class="pp-status pp-error">${esc(err.message)}</div>`;
        var retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'btn btn-sm btn-outline-primary pp-retry';
        retry.textContent = 'Retry';
        retry.addEventListener('click', () => showForecast(out, record));
        out.appendChild(retry);
    }
    keepPopupInView();
}

// Nearby points share a grid cell, so reuse a recent answer rather than asking again
function fetchForecast([lon, lat]) {
    var key = `${(Math.round(lat * 4) / 4).toFixed(2)},${(Math.round(lon * 4) / 4).toFixed(2)}`;
    var hit = forecastCache.get(key);
    if (hit && Date.now() - hit.time < FORECAST_CACHE_MS) return hit.promise;
    var promise = (async () => {
        var response = await fetch(FORECAST_API, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ queries: FORECAST_MODELS.map((m) => ({
                dataProductId: m.id,
                location: { latitude: lat, longitude: lon },
                variables: m.variables,
                maxLeadTimeHours: FORECAST_HOURS,
            })) }),
        });
        if (response.status === 429) throw new Error('The forecast service is busy; try again in a few seconds.');
        if (!response.ok) throw new Error(`The forecast service answered ${response.status}.`);
        var body = await response.json();
        return FORECAST_MODELS.map((m, i) => parseForecast(m, body.results[i])).filter(Boolean);
    })();
    promise.catch(() => forecastCache.delete(key));
    forecastCache.set(key, { time: Date.now(), promise });
    if (forecastCache.size > 50) forecastCache.delete(forecastCache.keys().next().value);
    return promise;
}

// Chart steps ({ t (ms), temp, dew, wind, precip (mm/h) }, with ensemble
// percentiles when the model has members) and every variable as its own series
// (the ensemble median) for comparing with observations
function parseForecast(model, result) {
    var run = result && result.forecasts && result.forecasts[0];
    if (!run) return null;
    var times = run.validTimes.map((t) => Date.parse(t));
    var members = run.ensembleMembers ? run.ensembleMembers.map((m) => m.data) : [run.data];
    var median = (name) => times.map((t, i) => quantile(members.map((d) => (d[name] || [])[i]).filter((v) => v !== null && v !== undefined && isFinite(v)), 0.5));
    var series = {};
    for (var name of model.variables) series[name] = median(name);
    var perMember = (data) => times.map((t, i) => {
        var u = (data.wind_u_10m || [])[i], v = (data.wind_v_10m || [])[i], p = (data.precipitation_surface || [])[i];
        return {
            temp: (data.temperature_2m || [])[i] ?? null,
            wind: u === null || v === null || u === undefined ? null : Math.hypot(u, v),
            precip: p === null || p === undefined ? null : p * 3600,  // kg m-2 s-1 to mm/h
        };
    });
    var all = members.map(perMember);
    var pick = (key, q) => times.map((t, i) => quantile(all.map((m) => m[i][key]).filter((v) => v !== null && isFinite(v)), q));
    var forecast = { ...model, init: run.initTime, ensemble: members.length > 1, members: members.length, times, series,
        point: result.point && result.point.selected };
    forecast.steps = times.map((t, i) => ({
        t,
        temp: pick('temp', 0.5)[i], tempLo: pick('temp', 0.1)[i], tempHi: pick('temp', 0.9)[i],
        dew: forecastAt(forecast, 'dew', t),
        wind: pick('wind', 0.5)[i], windLo: pick('wind', 0.1)[i], windHi: pick('wind', 0.9)[i],
        precip: mean(all.map((m) => m[i].precip).filter((v) => v !== null && isFinite(v))),
    }));
    return forecast;
}

// ---------- Observation vs forecast. Each quantity says which BUFR elements hold
// the observation and how a model gives the same thing, so a report is compared
// on everything it has that a model also forecasts.
const MAGNUS_A = 17.625, MAGNUS_B = 243.04;

function dewPoint(t, rh) {
    if (t === null || rh === null || !(rh > 0)) return null;
    var g = Math.log(rh / 100) + MAGNUS_A * t / (MAGNUS_B + t);
    return MAGNUS_B * g / (MAGNUS_A - g);
}

function relHumidity(t, td) {
    if (t === null || td === null) return null;
    return Math.min(100, 100 * Math.exp(MAGNUS_A * td / (MAGNUS_B + td) - MAGNUS_A * t / (MAGNUS_B + t)));
}

// Linear interpolation of a series at time t; null outside the run
function seriesAt(forecast, name, t) {
    var values = forecast.series[name], times = forecast.times;
    if (!values || t < times[0] || t > times[times.length - 1]) return null;
    var i = times.findIndex((x) => x >= t);
    if (times[i] === t || i === 0) return values[i];
    var a = values[i - 1], b = values[i];
    if (a === null || b === null) return a === null ? b : a;
    return a + (b - a) * (t - times[i - 1]) / (times[i] - times[i - 1]);
}

// Instantaneous quantities, derived where a model lacks the variable itself
function forecastAt(forecast, key, t) {
    var get = (name) => seriesAt(forecast, name, t);
    var has = (name) => !!forecast.series[name];
    switch (key) {
        case 'temp': return get('temperature_2m');
        case 'dew': return has('dew_point_temperature_2m') ? get('dew_point_temperature_2m') : dewPoint(get('temperature_2m'), get('relative_humidity_2m'));
        case 'rh': return has('relative_humidity_2m') ? get('relative_humidity_2m') : relHumidity(get('temperature_2m'), get('dew_point_temperature_2m'));
        case 'mslp': return get('pressure_reduced_to_mean_sea_level') === null ? null : get('pressure_reduced_to_mean_sea_level') / 100;
        case 'pres': return get('pressure_surface') === null ? null : get('pressure_surface') / 100;
        case 'wind':
        case 'dir': {
            var u = get('wind_u_10m'), v = get('wind_v_10m');
            if (u === null || v === null) return null;
            return key === 'wind' ? Math.hypot(u, v) : (Math.atan2(-u, -v) * 180 / Math.PI + 360) % 360;
        }
        case 'cloud': return get('total_cloud_cover_atmosphere');
        case 't850': return get('temperature_850hpa');
        case 't925': return get('temperature_925hpa');
        case 'z500': return get('geopotential_height_500hpa');
        case 'z850': return get('geopotential_height_850hpa');
        case 'z925': return get('geopotential_height_925hpa');
    }
    return null;
}

// Running total of a rate variable (kg m-2 s-1 or W m-2) at each step, so any
// window's total is a difference. GFS averages since its last 6-hourly reset;
// otherwise each step's rate covers the time since the step before.
function cumulative(forecast, name) {
    var values = forecast.series[name], times = forecast.times;
    if (!values) return null;
    var init = Date.parse(forecast.init), out = [0], base = 0, prevBlock = 0, prevAccum = 0;
    for (var i = 1; i < times.length; i++) {
        var rate = values[i] || 0;
        if (forecast.precipReset) {
            var lead = (times[i] - init) / 3600e3, block = Math.floor((lead - 1e-6) / forecast.precipReset);
            if (block !== prevBlock) { base += prevAccum; prevBlock = block; }
            prevAccum = rate * (lead - block * forecast.precipReset) * 3600;
            out.push(base + prevAccum);
        } else {
            out.push(out[i - 1] + rate * (times[i] - times[i - 1]) / 1000);
        }
    }
    return out;
}

function windowTotal(forecast, name, start, end) {
    var c = cumulative(forecast, name), times = forecast.times;
    if (!c || start < times[0] || end > times[times.length - 1]) return null;
    var at = (t) => {
        var i = times.findIndex((x) => x >= t);
        if (i <= 0) return c[0];
        return c[i - 1] + (c[i] - c[i - 1]) * (t - times[i - 1]) / (times[i] - times[i - 1]);
    };
    return at(end) - at(start);
}

// Highest or lowest 2 m temperature in a window, from hourly or 6-hourly
// samples plus GFS's own max/min fields
function windowExtreme(forecast, start, end, max) {
    var times = forecast.times;
    if (start < times[0] || end > times[times.length - 1]) return null;
    var values = [forecastAt(forecast, 'temp', start), forecastAt(forecast, 'temp', end)];
    var extra = forecast.series[max ? 'maximum_temperature_2m' : 'minimum_temperature_2m'];
    times.forEach((t, i) => {
        if (t > start && t <= end) {
            values.push(forecast.series.temperature_2m[i]);
            if (extra) values.push(extra[i]);
        }
    });
    values = values.filter((v) => v !== null && v !== undefined && isFinite(v));
    return values.length ? (max ? Math.max(...values) : Math.min(...values)) : null;
}

// Every comparable quantity in a decoded report: instantaneous elements by
// descriptor, period elements (precipitation, max/min temperature, solar
// radiation) with the period given by the 004024/004025 before them, and
// sounding levels from the profile
function observedNow(record) {
    var decoded = record.decoded, rows = decoded && decoded.rows;
    if (!rows) return null;
    var first = new Map();
    for (var [id, , value] of rows) {
        if (!first.has(id) && typeof value === 'number') first.set(id, value);
    }
    var t = Date.parse(record.props.datetime || reportTime(first) || '');
    if (!isFinite(t)) return null;

    var items = [];
    var add = (key, label, unit, value, digits, extra) => {
        if (value !== null && value !== undefined && isFinite(value)) items.push({ key, label, unit, value, digits, ...extra });
    };
    var pick = (...ids) => ids.map((id) => first.get(id)).find((v) => v !== undefined);
    var kelvin = (v) => (v === undefined ? null : v - 273.15);
    add('temp', 'Temperature', '°C', kelvin(pick(12101, 12001)), 1);
    add('dew', 'Dew point', '°C', kelvin(pick(12103, 12003)), 1);
    add('rh', 'Humidity', '%', pick(13003), 0);
    add('mslp', 'Pressure (MSL)', 'hPa', pick(10051) / 100, 1);
    add('pres', 'Station pressure', 'hPa', pick(10004) / 100, 1);
    add('wind', 'Wind speed', 'm/s', pick(11002), 1);
    add('dir', 'Wind direction', '°', pick(11001), 0);
    add('cloud', 'Cloud cover', '%', pick(20010), 0);

    // Period elements: 004024 (hours) or 004025 (minutes) give the window, as a
    // start offset, optionally followed by an end offset
    var start = null, end = 0, prevId = null, seen = new Set();
    for (var [id, , value] of rows) {
        if ((id === 4024 || id === 4025) && typeof value === 'number') {
            var offset = value * (id === 4024 ? 3600e3 : 60e3);
            if (prevId === id) { end = offset; } else { start = offset; end = 0; }
        } else if (start !== null && start < end && typeof value === 'number') {
            var from = t + start, to = t + end, hours = (to - from) / 3600e3;
            var span = hours >= 1 ? `${Number(hours.toFixed(1))} h` : `${Math.round(hours * 60)} min`;
            var key = `${id}:${from}:${to}`;
            if (!seen.has(key)) {
                seen.add(key);
                if (id === 13011) add('precip', `Precipitation (${span})`, 'mm', value, 1, { from, to });
                if (id === 12111) add('tmax', `Max temperature (${span})`, '°C', value - 273.15, 1, { from, to });
                if (id === 12112) add('tmin', `Min temperature (${span})`, '°C', value - 273.15, 1, { from, to });
                if (id === 14021 || id === 14028) add('solar', `Mean solar radiation (${span})`, 'W/m²', value / ((to - from) / 1000), 0, { from, to });
            }
        }
        prevId = id;
    }

    // Soundings: standard levels the AI model also forecasts
    var profile = decoded.profile || [];
    var level = (p) => profile.find((l) => Math.abs(l[0] - p) < 0.5);
    [[925, 't925', 'z925'], [850, 't850', 'z850'], [500, null, 'z500']].forEach(([p, tk, zk]) => {
        var l = level(p);
        if (!l) return;
        if (tk) add(tk, `Temperature at ${p} hPa`, '°C', l[2], 1);
        add(zk, `Height of ${p} hPa`, 'm', l[1], 0);
    });

    var value = (key) => (items.find((i) => i.key === key) || {}).value ?? null;
    return { t, items, temp: value('temp'), dew: value('dew'), wind: value('wind') };
}

// A model's value for an observed item, or null when it doesn't forecast it
function forecastFor(forecast, item, t) {
    if (item.key === 'precip') return windowTotal(forecast, 'precipitation_surface', item.from, item.to);
    if (item.key === 'solar') {
        var joules = windowTotal(forecast, 'downward_short_wave_radiation_flux_surface', item.from, item.to);
        return joules === null ? null : joules / ((item.to - item.from) / 1000);
    }
    if (item.key === 'tmax' || item.key === 'tmin') return windowExtreme(forecast, item.from, item.to, item.key === 'tmax');
    return forecastAt(forecast, item.key, t);
}

function compareTable(models, observed) {
    var rows = observed.items.map((item) => ({ item, values: models.map((m) => forecastFor(m, item, observed.t)) }))
        .filter((r) => r.values.some((v) => v !== null && isFinite(v)));
    if (!rows.length) return '';
    var fmt = (v, d) => Number(v).toFixed(d);
    var diff = (item, v) => {
        var d = item.key === 'dir' ? ((v - item.value + 540) % 360) - 180 : v - item.value;
        var text = `${d >= 0 ? '+' : '−'}${fmt(Math.abs(d), item.digits)}`;
        return `<small class="forecast-diff">${text}</small>`;
    };
    var when = new Date(observed.t).toISOString().slice(11, 16);
    return `
        <table class="table table-sm forecast-compare">
            <thead><tr><th>Observed ${esc(when)} UTC</th><th></th>${models.map((m) => `<th class="forecast-${m.cls}">${esc(m.label)}</th>`).join('')}</tr></thead>
            <tbody>${rows.map(({ item, values }) => `
                <tr>
                    <td>${esc(item.label)}</td>
                    <td><strong>${esc(fmt(item.value, item.digits))}</strong> ${esc(item.unit)}</td>
                    ${values.map((v) => (v === null || !isFinite(v) ? '<td>–</td>' : `<td>${esc(fmt(v, item.digits))} ${diff(item, v)}</td>`)).join('')}
                </tr>`).join('')}
            </tbody>
        </table>`;
}

function quantile(values, q) {
    if (!values.length) return null;
    var sorted = values.slice().sort((a, b) => a - b);
    var pos = (sorted.length - 1) * q, lo = Math.floor(pos);
    return sorted[lo] + (sorted[Math.min(lo + 1, sorted.length - 1)] - sorted[lo]) * (pos - lo);
}

function mean(values) {
    return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

// Precipitation as 6-hour totals, so hourly and 3-hourly steps compare. Each
// step's rate covers the time back to the step before it, except where the
// model averages since a 6-hourly reset: then the step at each reset holds
// the average of the whole 6 hours.
function sixHourly(steps, model) {
    var bins = new Map();
    if (model && model.precipReset) {
        var init = Date.parse(model.init), every = model.precipReset * 3600e3;
        steps.forEach((s) => {
            if (s.t > init && (s.t - init) % every === 0 && s.precip !== null) bins.set(s.t - every, s.precip * model.precipReset);
        });
        return [...bins].map(([t, mm]) => ({ t, mm }));
    }
    steps.forEach((s, i) => {
        if (!i || s.precip === null) return;
        var hours = (s.t - steps[i - 1].t) / 3600e3;
        var bin = Math.floor((s.t - 1) / 21600e3) * 21600e3;
        bins.set(bin, (bins.get(bin) || 0) + s.precip * hours);
    });
    return [...bins].map(([t, mm]) => ({ t, mm }));
}

function renderForecast(out, models, observed) {
    if (!models.length) {
        out.innerHTML = '<div class="pp-status">No forecast for this location.</div>';
        return;
    }
    var runs = models.map((m) => `${m.label} ${m.init.slice(11, 13)}Z ${m.init.slice(5, 10)}`).join(' · ');
    out.innerHTML = `
        ${observed ? compareTable(models, observed) : '<div class="pp-status">Decoded observations will be compared here once the Data tab has loaded.</div>'}
        <div class="pp-status">Next 7 days at this location</div>
        <div class="forecast-chart"></div>
        <div class="forecast-key">
            ${models.map((m) => `<span><i class="forecast-key-${m.cls}"></i>${esc(m.label)}${m.ensemble ? ` median, 10–90% of ${m.members} members` : ''}</span>`).join('')}
            <span><i class="forecast-key-dew"></i>Dew point</span>
            ${observed ? '<span><i class="forecast-key-obs"></i>Observed</span>' : ''}
        </div>
        <div class="pp-status forecast-credit">Runs: ${esc(runs)} UTC. Data: ${esc(models.map((m) => m.source).join(' and '))} via
            <a href="https://dynamical.org/" target="_blank" rel="noopener">dynamical.org</a>, CC BY 4.0.</div>`;
    renderForecastChart(out.querySelector('.forecast-chart'), models, observed, { width: 300, height: 250 });
}

// Temperature, wind and 6-hour precipitation panels on one time axis
function renderForecastChart(container, models, observed, opts) {
    var W = opts.width, H = opts.height;
    var m = { top: 6, right: 8, bottom: 18, left: 30 };
    var w = W - m.left - m.right;
    var gap = 8, panelH = (H - m.top - m.bottom - 2 * gap) / 3;
    var panels = [0, 1, 2].map((i) => ({ top: m.top + i * (panelH + gap), bottom: m.top + i * (panelH + gap) + panelH }));
    var t0 = Math.min(...models.map((mo) => mo.steps[0].t), observed ? observed.t : Infinity);
    var t1 = Math.min(Date.now() + FORECAST_HOURS * 3600e3, Math.max(...models.map((mo) => mo.steps[mo.steps.length - 1].t)));
    var x = (t) => m.left + w * (t - t0) / (t1 - t0);
    var inRange = (s) => s.t >= t0 && s.t <= t1;

    var svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'forecast', role: 'img',
        'aria-label': 'Forecast temperature, wind speed and precipitation from GFS and ECMWF AIFS' });
    svgEl('rect', { x: 0, y: 0, width: W, height: H, class: 'skewt-bg' }, svg);

    // Day boundaries (UTC) with labels along the bottom
    var day = new Date(t0);
    day.setUTCHours(24, 0, 0, 0);
    for (var d = day.getTime(); d < t1; d += 86400e3) {
        svgEl('line', { x1: x(d), x2: x(d), y1: m.top, y2: H - m.bottom, class: 'skewt-isobar' }, svg);
        if (x(d) < m.left + w - 12) {
            svgEl('text', { x: x(d) + 2, y: H - 5, class: 'skewt-label' }, svg)
                .textContent = new Date(d).toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' });
        }
    }
    if (Date.now() > t0 && Date.now() < t1) {
        svgEl('line', { x1: x(Date.now()), x2: x(Date.now()), y1: m.top, y2: H - m.bottom, class: 'forecast-now' }, svg);
    }

    var panel = (i, key, unit, floor) => {
        var { top, bottom } = panels[i];
        var vals = [];
        // The temperature panel also carries dew point
        var keys = key === 'temp' ? [key, 'dew'] : [key];
        models.forEach((mo) => mo.steps.filter(inRange).forEach((s) => keys.forEach((k) => vals.push(s[k], s[k + 'Lo'], s[k + 'Hi']))));
        keys.forEach((k) => observed && observed[k] !== null && observed[k] !== undefined && vals.push(observed[k]));
        vals = vals.filter((v) => v !== null && v !== undefined && isFinite(v));
        if (!vals.length) return null;
        var lo = floor !== undefined ? floor : Math.floor(Math.min(...vals)), hi = Math.ceil(Math.max(...vals));
        if (hi - lo < 4) { hi = lo + 4; }
        var y = (v) => bottom - (bottom - top) * (v - lo) / (hi - lo);
        svgEl('rect', { x: m.left, y: top, width: w, height: bottom - top, class: 'skewt-frame' }, svg);
        [lo, hi].forEach((v) => {
            svgEl('text', { x: m.left - 3, y: y(v) + 3.5, class: 'skewt-label', 'text-anchor': 'end' }, svg).textContent = v;
        });
        svgEl('text', { x: m.left + 3, y: top + 9, class: 'skewt-label forecast-unit' }, svg).textContent = unit;
        return y;
    };
    var line = (steps, key, y, cls) => {
        var pts = steps.filter((s) => inRange(s) && s[key] !== null).map((s) => `${x(s.t).toFixed(1)},${y(s[key]).toFixed(1)}`);
        if (pts.length > 1) svgEl('polyline', { points: pts.join(' '), class: cls }, svg);
    };
    var band = (steps, key, y, cls) => {
        var ok = steps.filter((s) => inRange(s) && s[key + 'Lo'] !== null && s[key + 'Hi'] !== null);
        if (ok.length < 2) return;
        var pts = ok.map((s) => `${x(s.t).toFixed(1)},${y(s[key + 'Hi']).toFixed(1)}`)
            .concat(ok.slice().reverse().map((s) => `${x(s.t).toFixed(1)},${y(s[key + 'Lo']).toFixed(1)}`));
        svgEl('polygon', { points: pts.join(' '), class: cls }, svg);
    };

    [['temp', '°C'], ['wind', 'wind m/s', 0]].forEach(([key, unit, floor], i) => {
        var y = panel(i, key, unit, floor);
        if (!y) return;
        models.filter((mo) => mo.ensemble).forEach((mo) => band(mo.steps, key, y, `forecast-band forecast-${mo.cls}`));
        models.forEach((mo) => line(mo.steps, key, y, `forecast-line forecast-${mo.cls}`));
        if (key === 'temp') models.forEach((mo) => line(mo.steps, 'dew', y, `forecast-line forecast-dew forecast-${mo.cls}`));
        if (observed && observed[key] !== null && observed[key] !== undefined && observed.t >= t0) {
            svgEl('circle', { cx: x(observed.t), cy: y(observed[key]), r: 3, class: 'forecast-obs' }, svg);
        }
        if (key === 'temp' && observed && observed.dew !== null && observed.t >= t0) {
            svgEl('circle', { cx: x(observed.t), cy: y(observed.dew), r: 2.5, class: 'forecast-obs forecast-obs-dew' }, svg);
        }
    });

    // Precipitation: 6-hour totals, one narrow bar per model side by side
    var totals = models.map((mo) => sixHourly(mo.steps, mo).filter((b) => b.t + 21600e3 > t0 && b.t < t1));
    var maxMm = Math.max(1, ...totals.flat().map((b) => b.mm));
    var { top, bottom } = panels[2];
    var yP = (v) => bottom - (bottom - top) * v / maxMm;
    svgEl('rect', { x: m.left, y: top, width: w, height: bottom - top, class: 'skewt-frame' }, svg);
    svgEl('text', { x: m.left - 3, y: top + 6, class: 'skewt-label', 'text-anchor': 'end' }, svg).textContent = Number(maxMm.toFixed(maxMm < 10 ? 1 : 0));
    svgEl('text', { x: m.left - 3, y: bottom + 3, class: 'skewt-label', 'text-anchor': 'end' }, svg).textContent = 0;
    svgEl('text', { x: m.left + 3, y: top + 9, class: 'skewt-label forecast-unit' }, svg).textContent = 'mm / 6 h';
    var barW = Math.max(1, (x(t0 + 21600e3) - x(t0)) / models.length - 0.5);
    totals.forEach((bins, k) => bins.forEach((b) => {
        if (b.mm < 0.05) return;
        var left = Math.max(m.left, x(b.t) + k * barW);
        svgEl('rect', { x: left, y: yP(b.mm), width: barW, height: bottom - yP(b.mm), class: `forecast-bar forecast-${models[k].cls}` }, svg);
    }));

    // Hover readout
    var readout = svgEl('text', { x: W - m.right - 3, y: m.top + 9, class: 'skewt-readout', 'text-anchor': 'end' }, svg);
    var guide = svgEl('line', { y1: m.top, y2: H - m.bottom, class: 'skewt-guide', visibility: 'hidden' }, svg);
    svg.addEventListener('mousemove', (e) => {
        var box = svg.getBoundingClientRect();
        var t = t0 + ((e.clientX - box.left) * W / box.width - m.left) / w * (t1 - t0);
        if (t < t0 || t > t1) return;
        guide.setAttribute('x1', x(t));
        guide.setAttribute('x2', x(t));
        guide.setAttribute('visibility', 'visible');
        var at = (mo) => mo.steps.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a));
        readout.textContent = [
            new Date(t).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', timeZone: 'UTC' }) + ' UTC',
            ...models.map((mo) => {
                var s = at(mo);
                return `${mo.label} ${s.temp !== null ? s.temp.toFixed(0) + '°' : '–'} ${s.wind !== null ? s.wind.toFixed(0) + ' m/s' : ''}`.trim();
            }),
        ].join(' · ');
    });
    svg.addEventListener('mouseleave', () => {
        guide.setAttribute('visibility', 'hidden');
        readout.textContent = '';
    });
    container.replaceChildren(svg);
}

// ---------- Upper-air sounding (TEMP) viewer: Skew-T log-P diagram
// profile levels: [pressure hPa, height gpm, temperature C, dewpoint C, wind dir, wind m/s, dlat, dlon]
const STANDARD_LEVELS = [1000, 925, 850, 700, 500, 400, 300, 250, 200, 150, 100, 70, 50, 30, 20, 10];
const SVG_NS = 'http://www.w3.org/2000/svg';

function soundingTiles(profile) {
    var tile = (label, text) => `<div class="pp-tile"><div>${esc(label)}</div><strong>${esc(text)}</strong></div>`;
    var surface = profile.reduce((a, b) => (b[0] > a[0] ? b : a));
    var top = profile.reduce((a, b) => (b[0] < a[0] ? b : a));
    var windy = profile.filter((l) => l[5] !== null).reduce((a, b) => (!a || b[5] > a[5] ? b : a), null);
    var tiles = [];
    if (surface[2] !== null) tiles.push(tile(`Temperature at ${Math.round(surface[0])} hPa`, `${surface[2].toFixed(1)} °C`));
    if (surface[3] !== null) tiles.push(tile('Dew point', `${surface[3].toFixed(1)} °C`));
    tiles.push(tile('Highest level', top[1] !== null ? `${(top[1] / 1000).toFixed(1)} km (${formatPressure(top[0])} hPa)` : `${formatPressure(top[0])} hPa`));
    if (windy) tiles.push(tile('Strongest wind', `${windy[5].toFixed(0)} m/s at ${formatPressure(windy[0])} hPa`));
    tiles.push(tile('Levels', profile.length.toLocaleString()));
    return tiles;
}

function formatPressure(p) {
    return p >= 10 ? Math.round(p) : p.toFixed(1);
}

function svgEl(name, attrs, parent) {
    var el = document.createElementNS(SVG_NS, name);
    for (var k in attrs) el.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(el);
    return el;
}

// Pressure lines labelled on the chart, and the minor ticks between them
const SKEWT_LABELS = [1000, 850, 700, 500, 300, 200, 100, 50, 20, 10];
const SKEWT_TICKS = [1000, 900, 800, 700, 600, 500, 400, 300, 200, 100, 90, 80, 70, 60, 50, 40, 30, 20, 10];
const SKEWT_SKEW = 16;  // Isotherms lean right by this many °C per e-fold of pressure

function renderSkewT(container, profile, opts) {
    var W = opts.width, H = opts.height;
    var m = { top: 40, right: 10, bottom: 34, left: 46 };
    var w = W - m.left - m.right, h = H - m.top - m.bottom;

    // From just below 1000 hPa (or the surface) up to the highest level reported
    var ps = profile.map((l) => l[0]);
    var pMax = Math.max(1050, Math.max(...ps));
    var pMin = Math.max(1, Math.min(100, Math.min(...ps) * 0.95));
    var y = (p) => m.top + h * (Math.log(p) - Math.log(pMin)) / (Math.log(pMax) - Math.log(pMin));
    var tLeft = -50, tRight = 50;
    var x = (t, p) => m.left + w * (t + SKEWT_SKEW * Math.log(1000 / p) - tLeft) / (tRight - tLeft);

    var svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'skewt', role: 'img',
        'aria-label': 'Skew-T log-P diagram of temperature and dew point against pressure' });
    var clipId = `skewt-clip-${Math.random().toString(36).slice(2)}`;
    svgEl('rect', { x: m.left, y: m.top, width: w, height: h }, svgEl('clipPath', { id: clipId }, svgEl('defs', {}, svg)));
    svgEl('rect', { x: 0, y: 0, width: W, height: H, class: 'skewt-bg' }, svg);
    var plot = svgEl('g', { 'clip-path': `url(#${clipId})` }, svg);

    // Title
    svgEl('text', { x: m.left + w / 2, y: 15, class: 'skewt-title', 'text-anchor': 'middle' }, svg).textContent = 'Skew-T log-P Diagram';
    if (opts.time) {
        var stamp = opts.time.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
        svgEl('text', { x: m.left + w / 2, y: 30, class: 'skewt-title', 'text-anchor': 'middle' }, svg).textContent = stamp;
    }

    // Skewed isotherms, with 0 °C dashed, and the pressure grid
    for (var t = -160; t <= 50; t += 10) {
        svgEl('line', { x1: x(t, pMax), y1: y(pMax), x2: x(t, pMin), y2: y(pMin), class: t === 0 ? 'skewt-zero' : 'skewt-isotherm' }, plot);
    }
    for (var p of SKEWT_LABELS.filter((p) => p <= pMax && p >= pMin)) {
        svgEl('line', { x1: m.left, y1: y(p), x2: m.left + w, y2: y(p), class: 'skewt-isobar' }, plot);
        svgEl('text', { x: m.left - 6, y: y(p) + 3.5, class: 'skewt-label', 'text-anchor': 'end' }, svg).textContent = p;
    }
    for (var p of SKEWT_TICKS.filter((p) => p <= pMax && p >= pMin)) {
        var major = SKEWT_LABELS.includes(p);
        svgEl('line', { x1: m.left - (major ? 4 : 2), y1: y(p), x2: m.left, y2: y(p), class: 'skewt-tick' }, svg);
    }
    for (var t = tLeft; t <= tRight; t += 10) {
        var xb = m.left + w * (t - tLeft) / (tRight - tLeft);
        svgEl('line', { x1: xb, y1: m.top + h, x2: xb, y2: m.top + h + 4, class: 'skewt-tick' }, svg);
        svgEl('text', { x: xb, y: m.top + h + 14, class: 'skewt-label', 'text-anchor': 'middle' }, svg).textContent = t;
    }
    svgEl('text', { x: m.left + w / 2, y: H - 4, class: 'skewt-axis', 'text-anchor': 'middle' }, svg).textContent = 'Temperature (°C)';
    svgEl('text', { x: 0, y: 0, class: 'skewt-axis', 'text-anchor': 'middle',
        transform: `translate(11 ${m.top + h / 2}) rotate(-90)` }, svg).textContent = 'Pressure (hPa)';

    // Temperature and dew point profiles, highest pressure (lowest altitude) first
    var sorted = profile.slice().sort((a, b) => b[0] - a[0]);
    var line = (i, cls) => {
        var pts = sorted.filter((l) => l[i] !== null && l[0] >= pMin).map((l) => `${x(l[i], l[0]).toFixed(1)},${y(l[0]).toFixed(1)}`);
        if (pts.length > 1) svgEl('polyline', { points: pts.join(' '), class: cls }, plot);
    };
    line(3, 'skewt-dewpoint');
    line(2, 'skewt-temperature');
    svgEl('rect', { x: m.left, y: m.top, width: w, height: h, class: 'skewt-frame' }, svg);

    // Legend, top right
    var legend = svgEl('g', { transform: `translate(${m.left + w - 92} ${m.top + 6})` }, svg);
    svgEl('rect', { x: 0, y: 0, width: 86, height: 34, rx: 3, class: 'skewt-legend' }, legend);
    [['Temperature', 'skewt-temperature'], ['Dewpoint', 'skewt-dewpoint']].forEach(([text, cls], i) => {
        svgEl('line', { x1: 6, y1: 11 + i * 13, x2: 22, y2: 11 + i * 13, class: cls }, legend);
        svgEl('text', { x: 27, y: 14.5 + i * 13, class: 'skewt-label skewt-legend-text' }, legend).textContent = text;
    });

    // Hover readout
    var readout = svgEl('text', { x: m.left + 4, y: m.top + h - 6, class: 'skewt-readout' }, svg);
    var guide = svgEl('line', { x1: m.left, x2: m.left + w, class: 'skewt-guide', visibility: 'hidden' }, svg);
    svg.addEventListener('mousemove', (e) => {
        var box = svg.getBoundingClientRect();
        var py = (e.clientY - box.top) * H / box.height;
        var level = sorted.reduce((a, b) => (Math.abs(y(b[0]) - py) < Math.abs(y(a[0]) - py) ? b : a));
        guide.setAttribute('y1', y(level[0]));
        guide.setAttribute('y2', y(level[0]));
        guide.setAttribute('visibility', 'visible');
        readout.textContent = [
            `${formatPressure(level[0])} hPa`,
            level[1] !== null ? `${Math.round(level[1]).toLocaleString()} m` : null,
            level[2] !== null ? `T ${level[2].toFixed(1)}°` : null,
            level[3] !== null ? `Td ${level[3].toFixed(1)}°` : null,
            level[5] !== null ? `${level[5].toFixed(0)} m/s ${level[4] !== null ? level[4] + '°' : ''}` : null,
        ].filter(Boolean).join(' · ');
    });
    svg.addEventListener('mouseleave', () => {
        guide.setAttribute('visibility', 'hidden');
        readout.textContent = '';
    });

    container.replaceChildren(svg);
}

// Launch time from the report's year/month/day/hour/minute, or null
function soundingTime(values) {
    var time = [4001, 4002, 4003, 4004, 4005].map((id) => values.get(id) && values.get(id)[0]);
    return time[0] ? new Date(Date.UTC(time[0], time[1] - 1, time[2], time[3] || 0, time[4] || 0)) : null;
}

// Larger view in a dialog, with a table of the standard levels
function openSounding(profile, label, values) {
    var dialog = document.querySelector('.sounding-dialog');
    if (!dialog) {
        dialog = document.createElement('dialog');
        dialog.className = 'sounding-dialog';
        dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
        document.body.appendChild(dialog);
    }
    var nearest = (p) => profile.reduce((a, b) => (Math.abs(b[0] - p) < Math.abs(a[0] - p) ? b : a));
    var rows = STANDARD_LEVELS
        .map((p) => nearest(p))
        .filter((l, i, all) => Math.abs(l[0] - STANDARD_LEVELS[i]) / STANDARD_LEVELS[i] < 0.03 && all.indexOf(l) === i);
    var cell = (v, digits) => (v === null || v === undefined ? '–' : Number(v).toFixed(digits));
    var launched = soundingTime(values);

    dialog.innerHTML = `
        <div class="sounding-head">
            <div>
                <strong></strong>
                <div class="pp-status">${launched ? `Launched ${esc(launched.toUTCString().replace(':00 GMT', ' UTC'))} · ` : ''}${profile.length.toLocaleString()} levels</div>
            </div>
            <button type="button" class="btn-close" aria-label="Close"></button>
        </div>
        <div class="sounding-body">
            <div class="sounding-chart"></div>
            ${rows.length ? `
            <table class="table table-sm sounding-table">
                <thead><tr><th>hPa</th><th>Height m</th><th>T °C</th><th>Td °C</th><th>Wind</th></tr></thead>
                <tbody>${rows.map((l) => `
                    <tr><td>${formatPressure(l[0])}</td><td>${cell(l[1], 0)}</td><td>${cell(l[2], 1)}</td><td>${cell(l[3], 1)}</td>
                    <td>${l[5] === null ? '–' : `${cell(l[5], 0)} m/s${l[4] === null ? '' : ` ${l[4]}°`}`}</td></tr>`).join('')}
                </tbody>
            </table>` : ''}
        </div>`;
    dialog.querySelector('strong').textContent = label;
    dialog.querySelector('.btn-close').addEventListener('click', () => dialog.close());
    var width = Math.min(480, window.innerWidth - 48);
    renderSkewT(dialog.querySelector('.sounding-chart'), profile, { width: width, height: Math.round(width * 1.3), time: launched });
    dialog.showModal();
}

// Returns a cleaned station name, or null when the decoded value isn't usable:
// not text, padding or control characters only, undecodable bytes, a
// placeholder such as "MISSING", or no letters at all (e.g. "0000", "///")
function stationName(entry) {
    if (!entry || typeof entry[0] !== 'string') return null;
    var name = entry[0].replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (name.length < 2 || name.length > 64) return null;
    if (name.includes('\ufffd')) return null;
    if (!/[a-z]/i.test(name)) return null;
    if (/^(missing|unknown|none|null|n\/?a|test|station)$/i.test(name)) return null;
    return name;
}

function formatValue(value, unit) {
    if (typeof value !== 'number') return [value, ''];
    if (unit === 'K') return [(value - 273.15).toFixed(1), '°C'];
    if (unit === 'Pa') return [(value / 100).toFixed(1), 'hPa'];
    if (unit === 'm' && value >= 1000) return [Number((value / 1000).toFixed(1)), 'km'];
    if (unit === 'KG M-2') return [value, 'mm'];
    if (unit === 'CODE TABLE' || unit === 'FLAG TABLE') return [value, '(code)'];
    if (['Numeric', 'CCITT IA5', 'a', 'mon', 'd', 'h', 'min'].includes(unit)) return [value, ''];
    return [Number(value.toFixed(5)), unit];
}

function formatLabel(type) {
    if (/bufr/.test(type || '')) return 'BUFR';
    if (/grib/.test(type || '')) return 'GRIB';
    return 'data';
}

function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function timeAgo(time) {
    var seconds = Math.round((Date.now() - new Date(time)) / 1000);
    if (isNaN(seconds)) return '';
    if (seconds < 10) return 'just now';
    if (seconds < 60) return `${seconds} sec ago`;
    if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
    if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
    return `${Math.round(seconds / 86400)} d ago`;
}

function hostname(href) {
    try {
        return new URL(href).hostname;
    } catch (err) {
        return href;
    }
}

function titleCase(name) {
    return name.toLowerCase().replace(/(^|[\s(\/-])\w/g, (c) => c.toUpperCase());
}

function esc(value) {
    return String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// Sidebar listing incoming messages, newest first
const QUEUE_MAX = 200;    // Rows shown in the sidebar
const RECENT_MAX = 1000;  // Messages kept for re-filtering
const recent = [];
let pending = [];
let queueTotal = 0;
let queuePaused = false;
let queueList, queueCount, queueFilter, queueMapped, queuePause, queueToggle;

// Filters shared by the map and the sidebar
const DISCIPLINES = {
    'weather': 'Weather',
    'climate': 'Climate',
    'hydrology': 'Hydrology',
    'ocean': 'Ocean',
    'atmospheric-composition': 'Atmos. composition',
    'cryosphere': 'Cryosphere',
    'space-weather': 'Space weather',
    'other': 'Other',
};
const FORMATS = {
    'bufr': 'BUFR',
    'grib': 'GRIB',
    'xml': 'XML / CAP',
    'csv': 'CSV',
    'json': 'JSON',
    'text': 'Text',
    'image': 'Image',
    'hdf': 'HDF / NetCDF',
    'other': 'Other',
};
const filters = { text: '', channel: '', centres: new Set(), format: '', disciplines: new Set() };

// File type of a notification's data, from the canonical link's media type,
// falling back to the file extension for generic types
function formatOf(feature) {
    var link = (feature.links || []).find((l) => l.rel == 'canonical');
    if (!link) return 'other';
    var type = (link.type || '').toLowerCase();
    var ext = ((link.href || '').split(/[?#]/)[0].match(/\.([a-z0-9]+)$/i) || [])[1] || '';
    ext = ext.toLowerCase();
    if (/bufr/.test(type) || /^bufr\d?$/.test(ext)) return 'bufr';
    if (/grib/.test(type) || /^(grib2?|grb2?)$/.test(ext)) return 'grib';
    if (/xml|cap/.test(type) || ext === 'xml') return 'xml';
    if (/csv/.test(type) || ext === 'csv') return 'csv';
    if (/json/.test(type) || /^(geo)?json$/.test(ext)) return 'json';
    if (/^image\//.test(type) || /^(jpe?g|png|gif|webp)$/.test(ext)) return 'image';
    if (/hdf|netcdf/.test(type) || /^(h5|hdf5?|nc)$/.test(ext)) return 'hdf';
    if (/^text\//.test(type) || ext === 'txt') return 'text';
    return 'other';
}
const centres = new Map();  // centre-id -> its item in the picker
let centreList, centreSearch, centreToggle, centreChips;

// GTS gateway centres, in either direction (e.g. de-dwd-gts-to-wis2, uk-metoffice-wis2-to-gts)
const GATEWAY_CENTRE = /-(gts-to-wis2|wis2-to-gts)$/;
const GATEWAY_TOPIC = /\/a\/wis2\/[^/]+-(gts-to-wis2|wis2-to-gts)\//;
const GATEWAY_SATELLITE = /-(gts-to-wis2|wis2-to-gts)\/data\/core\/I\/[NE]\//;

// WIS2 space-based-observations topics, and GTS satellite bulletins (T1T2 = IN, IE)
function isSpaceBased(topic) {
    return /\/space-based-observations\//.test(topic) || GATEWAY_SATELLITE.test(topic);
}

// centre/data/core/<discipline>/...; GTS bulletin topics have none
function disciplineOf(t) {
    var parts = t.split('/');
    if (DISCIPLINES.hasOwnProperty(parts[3])) return parts[3];
    // GTS bulletins: T1 = I (BUFR observations), T2 = S/U (weather) or O (ocean)
    if (GATEWAY_CENTRE.test(parts[0]) && parts[3] === 'I') {
        if (parts[4] === 'S' || parts[4] === 'U') return 'weather';
        if (parts[4] === 'O') return 'ocean';
    }
    return 'other';
}

function matchesFilters(item) {
    return (!filters.channel || item.channel === filters.channel)
        && (!filters.centres.size || filters.centres.has(item.centre))
        && (!filters.format || item.format === filters.format)
        && (!filters.disciplines.size || filters.disciplines.has(item.discipline))
        && (!filters.text || item.topic.toLowerCase().includes(filters.text))
        && (showSpace || !isSpaceBased(item.topic));
}

function filtersActive() {
    return !!(filters.text || filters.channel || filters.centres.size || filters.format || filters.disciplines.size || !showSpace);
}

function applyMapFilter() {
    var expr = ['all'];
    if (filters.channel) expr.push(['==', ['get', 'channel'], filters.channel]);
    if (filters.centres.size) expr.push(['in', ['get', 'centre'], ['literal', [...filters.centres]]]);
    if (filters.format) expr.push(['==', ['get', 'format'], filters.format]);
    if (filters.disciplines.size) expr.push(['in', ['get', 'discipline'], ['literal', [...filters.disciplines]]]);
    if (filters.text) expr.push(['in', filters.text, ['get', 'topic']]);
    if (!showSpace) expr.push(['!', ['get', 'space']]);
    if (hiddenLayers.size) expr.push(['!', ['in', ['get', 'layer'], ['literal', effectiveHidden()]]]);
    if (!map.getLayer('points')) return;
    // The points source also holds altitude bars, so each layer picks its geometry
    map.setFilter('points', [...expr, ['==', ['geometry-type'], 'Point']]);
    map.setFilter('altitude', [...expr, ['==', ['geometry-type'], 'Polygon']]);
    map.setFilter('pulses', expr.length > 1 ? expr : null);
}

function applyFilters() {
    applyMapFilter();
    rebuildQueue();
    var active = filtersActive();
    queueToggle.classList.toggle('filtered', active);
    queueToggle.title = active ? 'Message queue (filters on)' : 'Message queue';
    document.querySelector('.queue-reset').hidden = !active;
}

function zoomToCentres(selected) {
    var bounds = new maplibregl.LngLatBounds();
    for (var record of records.values()) {
        if (selected.has(record.centre)) bounds.extend(record.coords);
    }
    if (bounds.isEmpty()) return;
    var sidebar = document.querySelector('.queue').getBoundingClientRect().width;
    map.fitBounds(bounds, { padding: { top: 60, bottom: 60, left: sidebar + 60, right: 60 }, maxZoom: 7 });
}

// Adds a centre to the picker, or names one already listed
function addCentreOption(centre, name) {
    var item = centres.get(centre);
    if (!item) {
        item = document.createElement('li');
        item.innerHTML = '<label><input type="checkbox" class="form-check-input"><strong></strong><span></span></label>';
        item.dataset.centre = centre;
        item.querySelector('input').value = centre;
        item.querySelector('input').checked = filters.centres.has(centre);
        item.querySelector('strong').textContent = centre;
        var next = [...centreList.children].find((li) => li.dataset.centre > centre);
        centreList.insertBefore(item, next || null);
        centres.set(centre, item);
    }
    if (name) item.querySelector('span').textContent = name;
    item.dataset.search = `${centre} ${item.querySelector('span').textContent}`.toLowerCase();
    item.hidden = !item.dataset.search.includes(centreSearch.value.trim().toLowerCase());
}

function searchCentres() {
    var query = centreSearch.value.trim().toLowerCase();
    for (var item of centres.values()) {
        item.hidden = !item.dataset.search.includes(query);
    }
}

function toggleCentre(centre, on) {
    on ? filters.centres.add(centre) : filters.centres.delete(centre);
    var item = centres.get(centre);
    if (item) item.querySelector('input').checked = on;
    showSelectedCentres();
    applyFilters();
    if (on) zoomToCentres(filters.centres);
}

// Summarises the selection on the picker button and lists it as removable chips
function showSelectedCentres() {
    var selected = [...filters.centres].sort();
    centreToggle.textContent = !selected.length ? 'All centres'
        : selected.length === 1 ? selected[0] : `${selected.length} centres`;
    centreChips.replaceChildren(...selected.map((centre) => {
        var chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'queue-chip';
        chip.setAttribute('aria-pressed', 'true');
        chip.title = `Remove ${centre}`;
        chip.textContent = `${centre} ×`;
        chip.addEventListener('click', () => toggleCentre(centre, false));
        return chip;
    }));
}

// The picker lists every centre in the WMO register; centres seen in messages
// but not registered are still added as they arrive. The register's CORS
// headers are unreliable, so fall back to a bundled snapshot.
const CENTRE_REGISTER = 'https://codes.wmo.int/wis/topic-hierarchy/centre-id?_format=jsonld';
const CENTRE_SNAPSHOT = 'assets/data/centre-id.json';

async function loadCentres() {
    var list;
    try {
        list = parseCentreRegister(await fetchJson(CENTRE_REGISTER));
    } catch (err) {
        console.debug('Could not load the centre-id register, using the snapshot');
        list = await fetchJson(CENTRE_SNAPSHOT).catch(() => []);
    }
    list.forEach(([centre, name]) => addCentreOption(centre, name));
}

// Returns [[centre-id, description], ...] for the centres not retired
function parseCentreRegister(register) {
    var list = (register['@graph'] || [])
        .filter((item) => item['@type'] === 'skos:Concept' && item['skos:notation'])
        .filter((item) => (item['reg:status'] || {})['@id'] !== 'reg:statusRetired')
        .map((item) => [item['skos:notation'], (item['dct:description'] || {})['@value'] || '']);
    if (!list.length) throw new Error('empty centre-id register');
    return list;
}

async function fetchJson(url) {
    var response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: ${response.status}`);
    return response.json();
}

class QueueControl {
    onAdd(map) {
        var container = document.createElement('div');
        container.className = 'maplibregl-ctrl maplibregl-ctrl-group';
        var toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'queue-toggle';
        queueToggle = toggle;
        toggle.title = 'Message queue';
        toggle.innerHTML = '&#9776;';
        container.appendChild(toggle);
        toggle.addEventListener('click', function(){
            document.body.classList.toggle('queue-open');
            flushQueue();
        });

        var sidebar = document.createElement('aside');
        sidebar.className = 'queue';
        sidebar.innerHTML = `
            <div class="queue-header">
                <div class="queue-title"><strong>Messages</strong><span class="queue-count"></span></div>
                <input type="search" class="form-control form-control-sm" placeholder="Filter topics">
                <div class="queue-selects">
                    <select class="form-select form-select-sm queue-channel" aria-label="Channel">
                        <option value="">Cache &amp; origin</option>
                        <option value="cache">Cache</option>
                        <option value="origin">Origin</option>
                    </select>
                    <div class="centre-picker">
                        <button type="button" class="form-select form-select-sm centre-toggle" aria-label="Centres" aria-expanded="false">All centres</button>
                        <div class="centre-menu" hidden>
                            <input type="search" class="form-control form-control-sm" placeholder="Search centres" aria-label="Search centres">
                            <ul class="centre-list" aria-label="Centres"></ul>
                        </div>
                    </div>
                    <select class="form-select form-select-sm queue-format" aria-label="File type">
                        <option value="">All file types</option>
                        ${Object.entries(FORMATS).map(([key, label]) => `<option value="${key}">${label}</option>`).join('')}
                    </select>
                </div>
                <div class="queue-chips centre-chips" aria-label="Selected centres"></div>
                <div class="queue-chips" role="group" aria-label="Earth system discipline">
                    ${Object.entries(DISCIPLINES).map(([key, label]) =>
                        `<button type="button" class="queue-chip" data-discipline="${key}" aria-pressed="false">${label}</button>`).join('')}
                </div>
                <label class="form-check-label queue-space-row" title="Satellite products, on the map and in this list"><input type="checkbox" class="form-check-input queue-space" checked> Include space-based observations</label>
                <div class="queue-controls">
                    <label class="form-check-label"><input type="checkbox" class="form-check-input queue-mapped"> On map only</label>
                    <span>
                        <button type="button" class="btn btn-sm btn-link queue-reset" hidden>Reset filters</button>
                        <button type="button" class="btn btn-sm btn-outline-secondary queue-pause">Pause</button>
                    </span>
                </div>
            </div>
            <ol class="queue-list"></ol>`;
        document.body.appendChild(sidebar);
        queueList = sidebar.querySelector('.queue-list');
        queueCount = sidebar.querySelector('.queue-count');
        queueFilter = sidebar.querySelector('input[type=search]');
        queueMapped = sidebar.querySelector('.queue-mapped');
        var queueSpace = sidebar.querySelector('.queue-space');
        queueSpace.addEventListener('change', function(){
            showSpace = queueSpace.checked;
            if (!showSpace) decodeQueue = decodeQueue.filter((job) => !isSpaceBased(job.topic));
            applyFilters();
        });
        queuePause = sidebar.querySelector('.queue-pause');
        centreList = sidebar.querySelector('.centre-list');
        centreSearch = sidebar.querySelector('.centre-menu input');
        centreToggle = sidebar.querySelector('.centre-toggle');
        centreChips = sidebar.querySelector('.centre-chips');
        var centreMenu = sidebar.querySelector('.centre-menu');
        loadCentres();
        var queueChannel = sidebar.querySelector('.queue-channel');
        var queueFormat = sidebar.querySelector('.queue-format');
        queueFormat.addEventListener('change', function(){
            filters.format = queueFormat.value;
            applyFilters();
        });
        var chips = [...sidebar.querySelectorAll('.queue-chip')];

        queueFilter.addEventListener('input', function(){
            filters.text = queueFilter.value.trim().toLowerCase();
            applyFilters();
        });
        queueChannel.addEventListener('change', function(){
            filters.channel = queueChannel.value;
            applyFilters();
        });
        var openCentreMenu = (open) => {
            centreMenu.hidden = !open;
            centreToggle.setAttribute('aria-expanded', open);
            if (open) centreSearch.focus();
        };
        centreToggle.addEventListener('click', () => openCentreMenu(centreMenu.hidden));
        centreSearch.addEventListener('input', searchCentres);
        centreSearch.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                openCentreMenu(false);
                centreToggle.focus();
            } else if (e.key === 'Enter') {
                // Toggle the only match, or the first one
                var match = [...centreList.children].find((li) => !li.hidden);
                if (match) toggleCentre(match.dataset.centre, !filters.centres.has(match.dataset.centre));
            }
        });
        centreList.addEventListener('change', (e) => toggleCentre(e.target.value, e.target.checked));
        document.addEventListener('click', (e) => {
            if (!centreMenu.hidden && !e.target.closest('.centre-picker')) openCentreMenu(false);
        });
        chips.forEach((chip) => chip.addEventListener('click', function(){
            var key = chip.dataset.discipline;
            filters.disciplines.has(key) ? filters.disciplines.delete(key) : filters.disciplines.add(key);
            chip.setAttribute('aria-pressed', filters.disciplines.has(key));
            applyFilters();
        }));
        sidebar.querySelector('.queue-reset').addEventListener('click', function(){
            filters.text = filters.channel = filters.format = '';
            filters.disciplines.clear();
            filters.centres.clear();
            showSpace = queueSpace.checked = true;
            queueFilter.value = queueChannel.value = queueFormat.value = centreSearch.value = '';
            chips.forEach((chip) => chip.setAttribute('aria-pressed', 'false'));
            centreList.querySelectorAll('input').forEach((input) => { input.checked = false; });
            searchCentres();
            showSelectedCentres();
            applyFilters();
        });
        queueMapped.addEventListener('change', rebuildQueue);
        queuePause.addEventListener('click', function(){
            queuePaused = !queuePaused;
            flushQueue();
        });

        setInterval(flushQueue, 500);
        return container;
    }

    onRemove() {
        // Nothing to do here
    }
}

function queueMessage(topic, message, record, feature) {
    var [channel, t] = topic.split('/a/wis2/');
    var entry = {
        time: new Date(),
        topic: topic,
        channel: channel,
        centre: t.split('/', 1)[0],
        path: t.slice(t.indexOf('/') + 1),
        discipline: disciplineOf(t),
        format: feature ? formatOf(feature) : 'other',
        dataId: feature && feature.properties ? feature.properties.data_id : null,
        // The decode layer this message goes to, when that layer is on
        decodeKind: feature && !record ? Object.keys(DECODE_LAYERS).find((k) => decodeEnabled.has(k) && DECODE_LAYERS[k](topic, feature)) : null,
        message: message,
        record: record,
        row: null,
    };
    queueTotal++;
    if (entry.decodeKind && entry.dataId) awaitDecode(entry);
    if (centreList && !centres.has(entry.centre)) addCentreOption(entry.centre);
    recent.push(entry);
    if (recent.length > RECENT_MAX) recent.shift();
    if (matchesQueueFilter(entry)) {
        pending.push(entry);
        if (pending.length > QUEUE_MAX) pending.shift();
    }
}

function matchesQueueFilter(entry) {
    if (queueMapped && queueMapped.checked && !entry.record) return false;
    return matchesFilters(entry);
}

function flushQueue() {
    if (!queueList || !document.body.classList.contains('queue-open')) return;

    queueCount.textContent = `${queueTotal.toLocaleString()} received`;
    queuePause.textContent = queuePaused ? `Resume (${pending.length} new)` : 'Pause';
    if (queuePaused || !pending.length) return;

    var frag = document.createDocumentFragment();
    for (var i = pending.length - 1; i >= 0; i--) {
        frag.appendChild(renderQueueRow(pending[i]));
    }
    queueList.prepend(frag);
    pending = [];
    while (queueList.childElementCount > QUEUE_MAX) {
        queueList.lastElementChild.remove();
    }
}

function rebuildQueue() {
    queueList.replaceChildren();
    pending = recent.filter(matchesQueueFilter).slice(-QUEUE_MAX);
    var paused = queuePaused;
    queuePaused = false;
    flushQueue();
    queuePaused = paused;
}

// Expanded view of a message that isn't on the map: decode its data or show the raw JSON
function renderQueueDetail(entry) {
    var text = entry.message.toString();
    try {
        var message = JSON.parse(text);
        text = JSON.stringify(message, null, 2);
    } catch (err) {
        message = null;
    }
    var props = (message && message.properties) || {};
    var source = message && bufrSource(message, props);

    var detail = document.createElement('div');
    detail.className = 'queue-detail';
    detail.innerHTML = `
        <div class="pp-actions"></div>
        <div class="pp-decoded"></div>
        <pre hidden></pre>`;
    detail.addEventListener('click', (e) => e.stopPropagation());  // Keep it open
    var actions = detail.querySelector('.pp-actions');
    var out = detail.querySelector('.pp-decoded');
    var pre = detail.querySelector('pre');
    pre.textContent = text;

    // Expanding a row means wanting the data, so decode straight away
    var decode = async () => {
        try {
            showDecoded(out, null, await decodeSource(source, stationId(props), out));
        } catch (err) {
            showDecodeError(out, err, decode);
        }
    };
    if (source) decode();
    var json = document.createElement('button');
    json.type = 'button';
    json.className = 'btn btn-sm btn-outline-secondary';
    json.textContent = 'Show message';
    json.addEventListener('click', () => {
        pre.hidden = !pre.hidden;
        json.textContent = pre.hidden ? 'Show message' : 'Hide message';
    });
    actions.appendChild(json);
    return detail;
}

// The row's dot describes the message itself, matching the map: origin
// messages are rings in the origin colour (even when a cache copy is what's
// drawn), cache messages are filled with their point's colour, and messages
// waiting to be decoded have a dashed ring in their layer's colour; anything
// not on the map gets a small grey dot, so it can't be mistaken for a ring
function paintQueueDot(dot, entry) {
    dot.className = 'queue-dot';
    dot.style.background = dot.style.borderColor = '';
    if (entry.channel !== 'cache' && entry.record) {
        dot.classList.add('queue-dot-ring');
        dot.style.borderColor = COLORS.origin;
    } else if (entry.record) {
        dot.style.background = dot.style.borderColor = entry.record.color;
    } else if (entry.decodeKind) {
        dot.classList.add('queue-dot-pending');
        dot.style.borderColor = COLORS[entry.decodeKind];
    } else {
        dot.classList.add('queue-dot-none');  // Not on the map
    }
}

// The point a message is drawn as now: a cache copy may have replaced the
// origin point it was first linked to
function currentRecord(entry) {
    if (!entry.record) return null;
    if (records.has(entry.record.id)) return entry.record;
    var latest = byDataId.get(entry.record.props.data_id);
    return latest && records.has(latest.id) ? latest : null;
}

// Entries waiting for their file to be decoded, by data_id. Kept apart from
// the recent list, which busy brokers cycle through in seconds, so a row still
// on screen can be linked however long decoding takes.
const DECODE_WAITING_MAX = 5000;
const decodeWaiting = new Map();

function awaitDecode(entry) {
    var list = decodeWaiting.get(entry.dataId) || [];
    list.push(entry);
    decodeWaiting.set(entry.dataId, list);
    if (decodeWaiting.size > DECODE_WAITING_MAX) decodeWaiting.delete(decodeWaiting.keys().next().value);
}

// Once reports decoded from a message are plotted, link its sidebar entries
// to the first of them and repaint their rows
function linkDecoded(dataId, record) {
    var waiting = dataId && decodeWaiting.get(dataId);
    if (!waiting) return;
    decodeWaiting.delete(dataId);
    for (var entry of waiting) {
        if (entry.record) continue;
        entry.record = record;
        if (entry.row) {
            paintQueueDot(entry.row.querySelector('.queue-dot'), entry);
            entry.row.title = 'Show on map';
        }
    }
}

function renderQueueRow(entry) {
    var row = document.createElement('li');
    row.className = 'queue-row';
    row.title = entry.record ? 'Show on map' : 'Not on map: click to decode or view the message';

    var head = document.createElement('div');
    var dot = document.createElement('span');
    paintQueueDot(dot, entry);
    var centre = document.createElement('strong');
    centre.textContent = entry.centre;
    var meta = document.createElement('span');
    meta.className = 'queue-meta';
    meta.textContent = `${entry.channel} · ${entry.time.toLocaleTimeString()}`;
    head.append(dot, centre, meta);

    var path = document.createElement('div');
    path.className = 'queue-topic';
    path.textContent = entry.path;
    row.append(head, path);

    entry.row = row;
    row.addEventListener('click', function(){
        var target = currentRecord(entry);
        if (target) {
            openPopup(target);
            map.flyTo({ center: target.coords, zoom: Math.max(map.getZoom(), 5), offset: panelOffset() });
            return;
        }
        var detail = row.querySelector('.queue-detail');
        if (detail) return detail.remove();
        row.appendChild(renderQueueDetail(entry));
        // Pause so the row isn't pushed out of the list while it's being read
        queuePaused = true;
        flushQueue();
    });
    return row;
}

// Public WIS2 Global Brokers reachable from a browser (WSS only)
const hosts = [
    'wss://globalbroker.meteo.fr:443/mqtt',
    'wss://globalbroker.inmet.gov.br:443/mqtt',
];
const topics = ['origin/a/wis2/#', 'cache/a/wis2/#'];
const options = {
    username: 'everyone',
    password: '00650076006500720079006f006e0065'.hexDecode(),
    keepalive: 60,
    protocolVersion: 5,
    reconnectPeriod: 1000,
    connectTimeout: 30 * 1000,
};

let client = null;

// Race all brokers and keep the first one that connects and subscribes
function connectFastest() {
    console.log('Connecting mqtt client');
    let failures = 0;

    hosts.forEach((host) => {
        const candidate = mqtt.connect(host, { ...options, reconnectPeriod: 0 });
        candidate.setMaxListeners(10);
        let failed = false;

        const fail = () => {
            if (failed || candidate === client) return;
            failed = true;
            candidate.end(true);
            if (!client && ++failures === hosts.length) {
                console.log('All brokers failed, retrying...');
                setTimeout(connectFastest, 5000);
            }
        };

        candidate.once('connect', () => {
            candidate.subscribe(topics, (err, granted) => {
                if (err || granted.some((g) => g.qos >= 128)) {
                    console.log(`Subscribe failed on ${host}`);
                    return fail();
                }
                if (client) return candidate.end(true); // Another broker won

                client = candidate;
                client.options.reconnectPeriod = options.reconnectPeriod;
                client.on('message', (topic, message) => {
                    var feature = parseMessage(topic, message);
                    queueMessage(topic, message, feature && onMessage(topic, feature), feature);
                });
                client.on('reconnect', () => console.log('Reconnecting...'));
                console.log(`Connected to ${host}!`);
            });
        });

        candidate.on('error', (err) => {
            console.log(`Connection error (${host}): `, err.message);
            if (candidate === client) {
                candidate.end(true);
                client = null;
                connectFastest();
            } else {
                fail();
            }
        });

        candidate.on('close', fail);
    });
}

map.addControl(new QueueControl(), 'top-left');
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-left');
map.addControl(new ProjectionControl(), 'top-left');
map.addControl(new LegendControl(), 'bottom-left');

connectFastest();

const ignoredTopics = [
    '/a/wis2/de-dwd-gts-to-wis2/',
    '/a/wis2/ca-eccc-msc/data/core/weather/prediction',
];
const regex = /(?!WIGOS_)(\d-\d+-\d-[\d0-9a-zA-Z]+)/g;

function stationId(props) {
    var match = (props.data_id || '').match(regex);
    return props.wigos_station_identifier || (match ? match.pop() : null);
}

function parseMessage(topic, message) {
    // message is Buffer
    try {
        return JSON.parse(message.toString());
    } catch (err) {
        console.debug(`Message from ${topic} is not valid JSON`);
        return null;
    }
}

// Turns a notification into a map point, returning its record (or nothing)
function onMessage(topic, feature) {
    // Kept for every message so the sidebar can find a downloadable copy
    rememberLinks((feature.properties || {}).data_id, feature.links || []);
    var kind = Object.keys(DECODE_LAYERS).find((key) => DECODE_LAYERS[key](topic, feature));
    if (kind && decodeEnabled.has(kind)) queueDecode(kind, topic, feature);

    if (ignoredTopics.some((t) => topic.includes(t))) {
        return; // Ignore this topic
    }
    if (!feature.geometry || !feature.geometry.hasOwnProperty('type')){
        console.debug(`Message from ${topic} missing geometry`);
        return;
    }

    var coords = pointFor(feature.geometry);
    if (!coords) {
        console.debug(`Message from ${topic} has invalid or too large geometry`);
        return;
    }

    var props = feature.properties || {};
    var links = feature.links || [];

    var [channel, t] = topic.split('/a/wis2/');
    var webcam = t.includes('webcam');
    var record = {
        id: nextId++,
        coords: coords,
        topic: topic,
        channel: channel,
        centre: t.split('/', 1)[0],
        path: t.slice(t.indexOf('/') + 1),
        discipline: disciplineOf(t),
        webcam: webcam,
        props: props,
        links: links,
        wsi: stationId(props),
        format: formatOf(feature),
        color: channel !== 'cache' ? COLORS.origin : webcam ? COLORS.webcam : COLORS.cache,
        source: webcam ? null : bufrSource(feature, props),
        decoded: null,
        born: Date.now(),
    };
    return addPoint(record);
}

// Points as-is; small areas (e.g. station Polygons) at their center.
// Large areas such as model domains are skipped since a center is meaningless.
function pointFor(geometry) {
    var positions = [];
    collectPositions(geometry.type === 'GeometryCollection'
        ? geometry.geometries.map((g) => g.coordinates)
        : geometry.coordinates, positions);
    if (!positions.length) return null;
    if (geometry.type === 'Point') return positions[0].slice(0, 2);

    var xs = positions.map((p) => p[0]);
    var ys = positions.map((p) => p[1]);
    var [west, east, south, north] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    if (east - west > 10 || north - south > 10) return null;
    return [(west + east) / 2, (south + north) / 2];
}

function collectPositions(coords, out) {
    if (!Array.isArray(coords)) return;
    if (typeof coords[0] === 'number') {
        if (isFinite(coords[0]) && isFinite(coords[1])) out.push(coords);
        return;
    }
    coords.forEach((c) => collectPositions(c, out));
}

// BUFR decoding in the browser with Pyodide + pybufrkit, loaded on first use
const PYODIDE_URL = 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/';
const PYBUFRKIT_WHEEL = 'assets/py/pybufrkit-0.2.25-py3-none-any.whl';
const PYBUFRKIT_WHEEL_CDN = 'https://cdn.jsdelivr.net/gh/webb-ben/wis-live@main/' + PYBUFRKIT_WHEEL;
const DATA_LINKS_MAX = 20000;
const dataLinks = new Map();  // data_id -> hrefs seen from every cache
let decoderWorker = null;
let decoderReady = false;
let nextCall = 1;
const decoderCalls = new Map();  // call id -> { resolve, reject }

const DECODE_PY = `
import json
from pybufrkit.decoder import Decoder
from pybufrkit.descriptors import ElementDescriptor

def _value(v):
    if isinstance(v, bytes):
        try:
            v = v.decode('utf-8')
        except UnicodeDecodeError:
            v = v.decode('latin-1')
        return v.strip('\\x00 ')
    return v

def _wsi(rows):
    v = {d: x for d, _, x, _ in rows}
    try:
        if all(k in v for k in (1125, 1126, 1127, 1128)):
            return f"{v[1125]}-{v[1126]}-{v[1127]}-{v[1128]}"
        if 1001 in v and 1002 in v:
            return f"0-20000-0-{int(v[1001]):02d}{int(v[1002]):03d}"
    except (TypeError, ValueError):
        return None

_cache = {}  # key -> decoded subsets, so reports can be paged without re-decoding

def _decode(data):
    msg = Decoder().process(bytes(data.to_py()))
    td = msg.template_data.value
    subsets = []
    for descs, vals in zip(td.decoded_descriptors_all_subsets, td.decoded_values_all_subsets):
        rows = []
        for d, v in zip(descs, vals):
            # Skip sequences, operators, replication factors and missing values
            if not isinstance(d, ElementDescriptor) or v is None or d.id // 1000 == 31:
                continue
            v = _value(v)
            if v == '':
                continue
            rows.append((d.id, d.name, v, d.unit))
        subsets.append(rows)
    return subsets

# Soundings (TEMP) repeat a block per level: time offset and significance,
# then pressure, height, drift, temperature, dewpoint and wind. Rather than
# thousands of rows, return the header rows plus one compact entry per level:
# [pressure hPa, height gpm, temperature C, dewpoint C, wind dir, wind m/s, dlat, dlon]
_LEVEL = {10009: 1, 12101: 2, 12103: 3, 11001: 4, 11002: 5, 5015: 6, 6015: 7}

def _profile(rows):
    if sum(1 for r in rows if r[0] == 7004) < 3:
        return rows, None
    header, levels, level = [], [], None
    for d, name, v, unit in rows:
        if d == 7004:
            level = [v / 100, None, None, None, None, None, None, None]
            levels.append(level)
        elif level is None:
            if d not in (4086, 8042):
                header.append((d, name, v, unit))
        elif d in _LEVEL and level[_LEVEL[d]] is None and isinstance(v, (int, float)):
            level[_LEVEL[d]] = round(v - 273.15, 2) if d in (12101, 12103) else v
    return header, levels

def ready():
    return 'ok'

def decode_subsets(data, limit=0):
    subsets = _decode(data)
    if limit and len(subsets) > limit:
        # Spread the reports kept across the whole file, e.g. a satellite swath
        subsets = subsets[::-(-len(subsets) // limit)]
    return json.dumps([_profile(rows) for rows in subsets])

def decode_bufr(data, wsi, key, index=-1):
    if key not in _cache:
        if data is None:
            raise ValueError('this file is no longer cached, decode it again')
        _cache[key] = _decode(data)
        if len(_cache) > 20:
            _cache.pop(next(iter(_cache)))
    subsets = _cache[key]
    if not 0 <= index < len(subsets):
        index = next((i for i, rows in enumerate(subsets) if _wsi(rows) == wsi), 0)
    rows, profile = _profile(subsets[index])
    return json.dumps({
        'subsets': len(subsets),
        'index': index,
        'rows': rows,
        'profile': profile,
    })
`;

// Pyodide runs in a worker so decoding never blocks the map. The worker is
// built from a string, which also works when the page is opened from file://
const DECODER_WORKER = `
importScripts('${PYODIDE_URL}pyodide.js');
let ready = null;

async function init(wheelUrls) {
    const py = await loadPyodide({ indexURL: '${PYODIDE_URL}' });
    await py.loadPackage('micropip');
    await py.pyimport('micropip').install(['bitstring==3.1.9', 'six']);
    // pybufrkit only ships as an sdist, so we serve our own pure-Python wheel,
    // falling back to the CDN copy when the local one can't be fetched
    let wheel = null;
    for (const url of wheelUrls) {
        try {
            const response = await fetch(url);
            if (response.ok) { wheel = await response.arrayBuffer(); break; }
        } catch (err) {}
    }
    if (!wheel) throw new Error('could not download the BUFR decoder');
    py.unpackArchive(wheel, 'wheel');
    py.runPython(${JSON.stringify(DECODE_PY)});
    return py;
}

onmessage = async (e) => {
    const { id, fn, args, wheelUrls } = e.data;
    try {
        if (!ready) ready = init(wheelUrls);
        const py = await ready;
        postMessage({ id, result: py.globals.get(fn)(...args) });
    } catch (err) {
        ready = null;  // Allow a retry after a failed start
        postMessage({ id, error: err.message });
    }
};
`;

// Warm the decoder up once the map is idle so the first Decode is quick.
// Skipped on data-saver or very slow connections (it's roughly 15 MB on first visit).
function preloadDecoder() {
    var connection = navigator.connection;
    if (connection && (connection.saveData || /2g/.test(connection.effectiveType || ''))) return;
    var start = () => callDecoder('ready').catch((err) => console.debug(`Decoder preload failed: ${err.message}`));
    if ('requestIdleCallback' in window) {
        requestIdleCallback(start, { timeout: 10000 });
    } else {
        setTimeout(start, 3000);
    }
}

function callDecoder(fn, ...args) {
    if (!decoderWorker) {
        decoderWorker = new Worker(URL.createObjectURL(new Blob([DECODER_WORKER], { type: 'text/javascript' })));
        decoderWorker.onmessage = (e) => {
            var call = decoderCalls.get(e.data.id);
            decoderCalls.delete(e.data.id);
            if (e.data.error) return call.reject(new Error(e.data.error));
            decoderReady = true;
            call.resolve(e.data.result);
        };
    }
    var wheelUrls = [new URL(PYBUFRKIT_WHEEL, document.baseURI).href, PYBUFRKIT_WHEEL_CDN];
    return new Promise((resolve, reject) => {
        var id = nextCall++;
        decoderCalls.set(id, { resolve, reject });
        decoderWorker.postMessage({ id, fn, args, wheelUrls });
    });
}

// Optional layers decoded in the background: some notifications carry no
// geometry, but the reports inside the BUFR file do, so download and decode the
// file and plot each report.
// GTS-to-WIS2: every BUFR bulletin series (T1 = I); reports are sorted into
// sublayers once decoded
const GTS_TOPIC = /\/a\/wis2\/[^/]+-gts-to-wis2\/data\/core\/I\//;
// WIS2-to-GTS: whatever BUFR those centres pass on (any size limit the link states applies)
const WIS2_GTS_TOPIC = /\/a\/wis2\/[^/]+-wis2-to-gts\//;
// Files: any other small cached file without geometry that may be BUFR, plus
// XML whose location is inside the file (Environment Canada citypage forecasts)
const DECODE_FILE_MAX_BYTES = 200 * 1024;
const DECODE_FILE_MAX_REPORTS = 300;  // Per file, so a satellite swath can't flood the map
const NOT_BUFR = ['grib', 'xml', 'csv', 'json', 'image', 'hdf', 'text'];
const DECODE_LAYERS = {
    gts: (topic, feature) => topic.startsWith('cache/') && GTS_TOPIC.test(topic),
    wis2gts: (topic, feature) => topic.startsWith('cache/') && WIS2_GTS_TOPIC.test(topic) && !NOT_BUFR.includes(formatOf(feature))
        && !(feature.links || []).some((l) => l.rel == 'canonical' && l.length > DECODE_FILE_MAX_BYTES),
    // Gateway centres belong to their own layers above
    files: (topic, feature) => topic.startsWith('cache/') && !GATEWAY_TOPIC.test(topic) && decodableFile(topic, feature),
};

function decodableFile(topic, feature) {
    return !feature.geometry
        && (!NOT_BUFR.includes(formatOf(feature)) || (formatOf(feature) === 'xml' && /citypage/i.test(topic + JSON.stringify(feature.links || []))))
        && (feature.links || []).some((l) => l.rel == 'canonical' && l.length > 0 && l.length <= DECODE_FILE_MAX_BYTES);
}

const DECODE_FETCH_TIMEOUT_MS = 20000;
const DECODE_QUEUE_MAX = 100;  // Oldest files are dropped when decoding falls behind
const decodeEnabled = new Set();
const decodePlotted = { gts: 0, wis2gts: 0, files: 0 };
let decodeQueue = [];
let decodeBusy = false;
const decodeSeen = new Set();

function queueDecode(kind, topic, feature) {
    var props = feature.properties || {};
    var link = (feature.links || []).find((l) => l.rel == 'canonical' && corsFriendly(l.href));
    // Each cache republishes the file; take the first copy a browser can download
    if (!link || decodeSeen.has(props.data_id) || (!showSpace && isSpaceBased(topic))) return;
    // Satellite bulletin series only while their sublayer is on
    if (kind === 'gts' && GATEWAY_SATELLITE.test(topic) && effectiveHidden().includes('gts-satellite')) return;
    decodeSeen.add(props.data_id);
    if (decodeSeen.size > DATA_LINKS_MAX) decodeSeen.delete(decodeSeen.values().next().value);
    // XML needs no decoder, so it skips the queue rather than waiting behind BUFR
    if (formatOf(feature) === 'xml') {
        fetch(link.href, { signal: AbortSignal.timeout(DECODE_FETCH_TIMEOUT_MS) })
            .then((response) => (response.ok ? response.text() : null))
            .then((xml) => xml && decodeEnabled.has(kind) && plotCitypage({ kind, topic, feature, href: link.href }, xml))
            .catch((err) => console.debug(`Could not fetch ${link.href}: ${err.message}`));
        return;
    }
    decodeQueue.push({ kind, topic, feature, href: link.href });
    if (decodeQueue.length > DECODE_QUEUE_MAX) decodeQueue.shift();
    pumpDecode();
}

async function pumpDecode() {
    if (decodeBusy || !decodeQueue.length) return;
    decodeBusy = true;
    var job = decodeQueue.pop();  // Newest first, to stay close to real time
    try {
        // A stalled server would otherwise hold up the whole queue
        var response = await fetch(job.href, { signal: AbortSignal.timeout(DECODE_FETCH_TIMEOUT_MS) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        var bytes = bufrPart(new Uint8Array(await response.arrayBuffer()));
        if (bytes) {
            var limit = DECODE_FILE_MAX_REPORTS;
            var subsets = JSON.parse(await callDecoder('decode_subsets', bytes, limit));
            subsets.forEach(([rows, profile], i) => plotDecodedReport(job, rows, profile, i));
        }
    } catch (err) {
        console.debug(`Could not decode ${job.href}: ${err.message}`);
    }
    decodeBusy = false;
    pumpDecode();
}

function plotDecodedReport(job, rows, profile, index) {
    var values = new Map();
    for (var [id, name, value] of rows) {
        if (!values.has(id)) values.set(id, value);
    }
    var lat = [5001, 5002].map((id) => values.get(id)).find((v) => typeof v === 'number');
    var lon = [6001, 6002].map((id) => values.get(id)).find((v) => typeof v === 'number');
    if (lat === undefined || lon === undefined || Math.abs(lat) > 90 || Math.abs(lon) > 180) return;

    var props = job.feature.properties || {};
    var [channel, t] = job.topic.split('/a/wis2/');
    var subLayer = job.kind === 'gts' ? `gts-${reportClass(values, profile)}` : null;
    if (subLayer && effectiveHidden().includes(subLayer) && subLayer === 'gts-satellite') return;
    var record = {
        id: nextId++,
        coords: [lon, lat],
        topic: job.topic,
        channel: channel,
        centre: t.split('/', 1)[0],
        path: t.slice(t.indexOf('/') + 1),
        discipline: disciplineOf(t),
        webcam: false,
        decodedLayer: job.kind,
        subLayer: subLayer,
        props: {
            data_id: `${props.data_id}#${index}`,
            pubtime: props.pubtime,
            datetime: reportTime(values),
        },
        links: job.feature.links || [],
        wsi: reportId(values),
        format: 'bufr',
        color: subLayer ? GTS_CLASSES[subLayer.slice(4)].color : COLORS[job.kind],
        source: null,
        decoded: { subsets: 1, index: 0, rows: rows, profile: profile },
        alt: aircraftAltitude(values, t),
        born: Date.now(),
    };
    addPoint(record);
    decodePlotted[job.kind]++;
    if (!index) linkDecoded(props.data_id, record);
}

// Citypage forecasts come in English and French for each site and are reissued
// through the day: keep one point per site, the latest, preferring English
function plotCitypage(job, xml) {
    var doc = new DOMParser().parseFromString(xml, 'application/xml');
    var site = doc.querySelector('siteData > location > name');
    if (!site) return;
    var coord = (v) => {
        var m = /^([\d.]+)([NSEW])$/.exec((v || '').trim());
        return m ? Number(m[1]) * (/[SW]/.test(m[2]) ? -1 : 1) : NaN;
    };
    var lat = coord(site.getAttribute('lat')), lon = coord(site.getAttribute('lon'));
    if (!isFinite(lat) || !isFinite(lon)) return;

    var french = /_fr\.xml$/i.test(job.href);
    var key = `citypage:${site.getAttribute('code') || site.textContent.trim()}`;
    var existing = byDataId.get(key);
    if (existing && records.has(existing.id)) {
        if (french && !existing.french) return;
        removePoint(existing);
    }
    var props = job.feature.properties || {};
    var [channel, t] = job.topic.split('/a/wis2/');
    var record = addPoint({
        id: nextId++,
        coords: [lon, lat],
        topic: job.topic,
        channel: channel,
        centre: t.split('/', 1)[0],
        path: t.slice(t.indexOf('/') + 1),
        discipline: disciplineOf(t),
        webcam: false,
        decodedLayer: job.kind,
        props: { data_id: key, pubtime: props.pubtime, metadata_id: site.textContent.trim() },
        links: job.feature.links || [],
        wsi: null,
        french: french,
        format: 'xml',
        color: COLORS[job.kind],
        source: null,
        decoded: { xml: xml },
        born: Date.now(),
    });
    decodePlotted[job.kind]++;
    linkDecoded(props.data_id, record);
}

// Which GTS sublayer a report belongs to, from the identifiers it carries.
// Order matters: satellite and aircraft reports can also carry station-like ids.
function reportClass(values, profile) {
    if (values.has(1007)) return 'satellite';
    if (values.has(1008) || values.has(1006)) return 'aircraft';
    if (profile && profile.length >= 2) return 'upperair';
    if (values.has(1011)) return 'ship';
    if (values.has(1087) || values.has(1005) || values.has(2149)) return 'buoy';
    if (values.has(1015) || values.has(1001) || values.has(1125)) return 'station';
    return 'other';
}

// Altitude in metres for aircraft reports (AMDAR and similar), else null:
// flight level, height or altitude, or indicated aircraft altitude
function aircraftAltitude(values, t) {
    var aircraft = values.has(1008) || values.has(1006) || /\/data\/core\/I\/U\/A\//.test(t);
    if (!aircraft) return null;
    var alt = [7010, 10053, 7002, 10070, 7007].map((id) => values.get(id)).find((v) => typeof v === 'number');
    return alt > 0 && alt < 25000 ? alt : null;
}

// WIGOS id, WMO block/station, ship, buoy or aircraft identifier
function reportId(values) {
    var text = (id) => typeof values.get(id) === 'string' && values.get(id).trim();
    if (values.has(1125) && text(1128)) {
        return `${values.get(1125)}-${values.get(1126)}-${values.get(1127)}-${text(1128)}`;
    }
    if (typeof values.get(1001) === 'number' && typeof values.get(1002) === 'number') {
        return `0-20000-0-${String(values.get(1001)).padStart(2, '0')}${String(values.get(1002)).padStart(3, '0')}`;
    }
    return text(1011) || text(1008) || (values.has(1087) && String(values.get(1087)))
        || (values.has(1005) && String(values.get(1005))) || null;
}

function reportTime(values) {
    var [y, mo, d, h, mi] = [4001, 4002, 4003, 4004, 4005].map((id) => values.get(id));
    if (![y, mo, d, h].every((v) => typeof v === 'number')) return undefined;
    return new Date(Date.UTC(y, mo - 1, d, h, mi || 0)).toISOString();
}

function setDecodeEnabled(kind, enabled) {
    enabled ? decodeEnabled.add(kind) : decodeEnabled.delete(kind);
    if (!enabled) decodeQueue = decodeQueue.filter((job) => job.kind !== kind);
    applyMapFilter();
    pumpDecode();
}

function rememberLinks(dataId, links) {
    if (!dataId) return;
    var hrefs = dataLinks.get(dataId) || new Set();
    for (var link of links) {
        if (link.rel == 'canonical') hrefs.add(link.href);
    }
    dataLinks.delete(dataId);  // Re-insert to keep recently used ids
    dataLinks.set(dataId, hrefs);
    if (dataLinks.size > DATA_LINKS_MAX) {
        dataLinks.delete(dataLinks.keys().next().value);
    }
}

function bufrSource(feature, props) {
    var content = props.content && props.content.encoding === 'base64' ? props.content.value : null;
    // Any canonical link may hold BUFR or text; fetchData checks the content
    var urls = (feature.links || [])
        .filter((l) => l.rel == 'canonical' && !(l.length > 5e6))
        .map((l) => l.href);
    if (!content && !urls.length) return null;
    return { content: content, dataId: props.data_id, urls: urls, cap: props.cap_info || null };
}

// Returns { bytes, bufr, url }: the first BUFR copy found, otherwise the first
// copy that is plain text
async function fetchData(source) {
    var text = null;
    if (source.content) {
        var bytes = Uint8Array.from(atob(source.content), (c) => c.charCodeAt(0));
        if (bufrPart(bytes)) return { bytes: bufrPart(bytes), bufr: true };
        if (isText(bytes)) text = { bytes: bytes, bufr: false };
    }
    // Most caches block cross-origin requests, so try the ones that allow it first
    var urls = [...new Set([...source.urls, ...(dataLinks.get(source.dataId) || [])])];
    urls.sort((a, b) => corsFriendly(b) - corsFriendly(a));
    for (var url of urls) {
        try {
            var response = await fetch(url);
            if (!response.ok) continue;
            var bytes = new Uint8Array(await response.arrayBuffer());
            if (bufrPart(bytes)) return { bytes: bufrPart(bytes), bufr: true, url: url };
            if (!text && isText(bytes)) text = { bytes: bytes, bufr: false, url: url };
        } catch (err) {
            console.debug(`Could not fetch ${url}`);
        }
    }
    if (text) return text;
    throw new Error('no downloadable copy in a supported format (the data servers may block browser downloads)');
}

function isText(bytes) {
    var sample = bytes.subarray(0, 2000);
    var printable = sample.filter((b) => b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127)).length;
    return sample.length > 0 && printable / sample.length > 0.95;
}

function corsFriendly(url) {
    return hostname(url).endsWith('.amazonaws.com') ? 1 : 0;
}

// GTS bulletins put an abbreviated heading (e.g. "IUAG04 VHHH 141200") before
// the BUFR message, so look a little way in; returns the BUFR bytes or null
function bufrPart(bytes) {
    var head = String.fromCharCode(...bytes.subarray(0, 256));
    var start = head.indexOf('BUFR');
    return start < 0 ? null : bytes.subarray(start);
}
