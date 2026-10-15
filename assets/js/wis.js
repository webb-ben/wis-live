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
    cache: '#5cb83c',
    webcam: '#F8A700',
    origin: '#6f9fd8',
    gts: '#9b6cd1',
    files: '#d16c9b',
};
// Legend rows, grouped by source; each can be switched on and off. Rows other
// than opt-in ones stay hidden until a point of that kind has arrived. Opt-in
// rows are decoded in the browser, since their notifications carry no location.
const LAYER_GROUPS = [
    { label: 'WIS2 data', layers: [
        { key: 'obs', label: 'Cache', color: COLORS.cache },
        { key: 'webcam', label: 'Webcam images', color: COLORS.webcam },
        { key: 'origin', label: 'Origin', color: COLORS.origin, ring: true },
        { key: 'files', label: 'Cache (decode required)', color: COLORS.files, optIn: true,
            title: 'Download and decode small BUFR files whose notification has no location, and plot the reports inside' },
    ] },
    { label: 'GTS-to-WIS2 gateway', layers: [
        { key: 'gts', label: 'GTS bulletins (decode required)', color: COLORS.gts, optIn: true,
            title: 'Download and decode the BUFR bulletins republished from the GTS, and plot the reports inside' },
    ] },
];
const hiddenLayers = new Set(['gts', 'files']);
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

const popup = new maplibregl.Popup({ maxWidth: '340px', focusAfterOpen: false });
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
        if (!record || popup.isOpen()) return hoverLabel.remove();
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
            space: isSpaceBased(record.topic),
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
            <label class="legend-toggle" data-layer="${l.key}"${l.optIn ? '' : ' hidden'}${l.title ? ` title="${l.title}"` : ''}>
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
                if (DECODE_LAYERS[key]) {
                    setDecodeEnabled(key, e.target.checked);
                    status.hidden = !decodeEnabled.size;
                }
                applyMapFilter();
            });
        });
        setInterval(() => {
            if (!decodeEnabled.size) return;
            var plotted = [...decodeEnabled].reduce((n, key) => n + decodePlotted[key], 0);
            status.textContent = decoderReady || plotted
                ? `${plotted.toLocaleString()} reports plotted · ${decodeQueue.length} files waiting`
                    + (decodeEnabled.has('gts') ? ' · tilt to see aircraft altitude' : '')
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

// Popup
function openPopup(record) {
    if (!record) return;
    hoverLabel.remove();
    popup.setLngLat(record.coords).setDOMContent(buildPopup(record)).addTo(map);
    keepPopupInView();
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
            ${props.datetime ? `<dt>Observed</dt><dd>${esc(new Date(props.datetime).toLocaleString())}</dd>` : ''}
            <dt>Topic</dt><dd class="pp-mono">${esc(record.path)}</dd>
        </dl>
        <div class="pp-actions"></div>
        <div class="pp-decoded"></div>`;

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
    } else if (decoded.text !== undefined) {
        out.innerHTML = '<pre class="pp-text"></pre>';
        out.firstChild.textContent = decoded.text.trim();
    } else {
        renderDecoded(out, title, decoded);
    }
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

// Pan so a popup isn't cut off by the screen edges or the sidebar
function keepPopupInView() {
    var el = popup.getElement();
    if (!el) return;
    var box = el.getBoundingClientRect();
    var view = map.getContainer().getBoundingClientRect();
    var left = view.left + (document.body.classList.contains('queue-open')
        ? document.querySelector('.queue').getBoundingClientRect().right - view.left : 0);
    var dx = Math.min(0, box.left - left - 10) || Math.max(0, box.right - view.right + 10);
    var dy = Math.min(0, box.top - view.top - 10) || Math.max(0, box.bottom - view.bottom + 10);
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
    var tiles = sounding ? soundingTiles(profile) : [];
    for (var key of sounding ? [] : KEY_VALUES) {
        var id = key.ids.find((i) => values.has(i));
        if (!id || (key.unless && key.unless.some((i) => values.has(i)))) continue;
        var text = formatValue(...values.get(id)).join(' ');
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
        <details class="pp-more"${tiles.length ? '' : ' open'}>
            <summary>All decoded fields (${result.rows.length})</summary>
            <table class="table table-sm">${result.rows.map(([id, name, value, unit]) => `
                <tr><td>${esc(titleCase(name))}</td><td>${esc(formatValue(value, unit).join(' ').trim())}</td></tr>`).join('')}
            </table>
        </details>`;
    out.querySelectorAll('.pp-pager button').forEach((button) => button.addEventListener('click', () => {
        showReport(out, title, result.key, result.index + Number(button.dataset.step));
    }));
    if (sounding) {
        var label = name || (title && title.textContent) || 'Sounding';
        renderSkewT(out.querySelector('.sounding'), profile, { width: 300, height: 390, time: soundingTime(values) });
        out.querySelector('.sounding-expand').addEventListener('click', () => openSounding(profile, label, values));
    }
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

// centre/data/core/<discipline>/...; GTS bulletin topics have none
// WIS2 space-based-observations topics, and GTS satellite bulletins (T1T2 = IN, IE)
function isSpaceBased(topic) {
    return /\/space-based-observations\//.test(topic) || /-gts-to-wis2\/data\/core\/I\/[NE]\//.test(topic);
}

function disciplineOf(t) {
    var parts = t.split('/');
    if (DISCIPLINES.hasOwnProperty(parts[3])) return parts[3];
    // GTS bulletins: T1 = I (BUFR observations), T2 = S/U (weather) or O (ocean)
    if (parts[0].endsWith('-gts-to-wis2') && parts[3] === 'I') {
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
    if (hiddenLayers.size) expr.push(['!', ['in', ['get', 'layer'], ['literal', [...hiddenLayers]]]]);
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
        message: message,
        record: record,
    };
    queueTotal++;
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

function renderQueueRow(entry) {
    var row = document.createElement('li');
    row.className = 'queue-row';
    row.title = entry.record ? 'Show on map' : 'Not on map: click to decode or view the message';

    var head = document.createElement('div');
    var dot = document.createElement('span');
    dot.className = 'queue-dot';
    if (entry.record) {
        dot.style.background = entry.record.color;
    }
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

    row.addEventListener('click', function(){
        if (entry.record) {
            map.flyTo({ center: entry.record.coords, zoom: Math.max(map.getZoom(), 5) });
            openPopup(entry.record);
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
    if (topic.startsWith('cache/')) {
        var kind = Object.keys(DECODE_LAYERS).find((key) => DECODE_LAYERS[key](topic, feature));
        if (kind && decodeEnabled.has(kind)) queueDecode(kind, topic, feature);
    }

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
// GTS: surface (IS), upper-air (IU) and ocean (IO) bulletins; satellite series are skipped.
const GTS_TOPIC = /\/a\/wis2\/[^/]+-gts-to-wis2\/data\/core\/I\/([SUO])\//;
// Files: any other small cached file without geometry that may be BUFR
const DECODE_FILE_MAX_BYTES = 200 * 1024;
const DECODE_FILE_MAX_REPORTS = 300;  // Per file, so a satellite swath can't flood the map
const NOT_BUFR = ['grib', 'xml', 'csv', 'json', 'image', 'hdf', 'text'];
const DECODE_LAYERS = {
    gts: (topic, feature) => GTS_TOPIC.test(topic),
    files: (topic, feature) => !feature.geometry && !NOT_BUFR.includes(formatOf(feature))
        && (feature.links || []).some((l) => l.rel == 'canonical' && l.length > 0 && l.length <= DECODE_FILE_MAX_BYTES),
};
const DECODE_QUEUE_MAX = 100;  // Oldest files are dropped when decoding falls behind
const decodeEnabled = new Set();
const decodePlotted = { gts: 0, files: 0 };
let decodeQueue = [];
let decodeBusy = false;
const decodeSeen = new Set();

function queueDecode(kind, topic, feature) {
    var props = feature.properties || {};
    var link = (feature.links || []).find((l) => l.rel == 'canonical' && corsFriendly(l.href));
    // Each cache republishes the file; take the first copy a browser can download
    if (!link || decodeSeen.has(props.data_id) || (!showSpace && isSpaceBased(topic))) return;
    decodeSeen.add(props.data_id);
    if (decodeSeen.size > DATA_LINKS_MAX) decodeSeen.delete(decodeSeen.values().next().value);
    decodeQueue.push({ kind, topic, feature, href: link.href });
    if (decodeQueue.length > DECODE_QUEUE_MAX) decodeQueue.shift();
    pumpDecode();
}

async function pumpDecode() {
    if (decodeBusy || !decodeQueue.length) return;
    decodeBusy = true;
    var job = decodeQueue.pop();  // Newest first, to stay close to real time
    try {
        var response = await fetch(job.href);
        var bytes = response.ok ? bufrPart(new Uint8Array(await response.arrayBuffer())) : null;
        if (bytes) {
            var limit = job.kind === 'files' ? DECODE_FILE_MAX_REPORTS : 0;
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
        props: {
            data_id: `${props.data_id}#${index}`,
            pubtime: props.pubtime,
            datetime: reportTime(values),
        },
        links: job.feature.links || [],
        wsi: reportId(values),
        format: 'bufr',
        color: COLORS[job.kind],
        source: null,
        decoded: { subsets: 1, index: 0, rows: rows, profile: profile },
        alt: aircraftAltitude(values, t),
        born: Date.now(),
    };
    addPoint(record);
    decodePlotted[job.kind]++;
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
