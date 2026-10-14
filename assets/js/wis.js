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
const MAX_POINTS = 50000;        // Oldest points are dropped beyond this
const FADE_MS = 60 * 60 * 1000;  // Points fade over an hour
const PULSE_MS = 1600;           // Length of the ripple on new arrivals
const COLORS = {
    cache: '#5cb83c',
    webcam: '#F8A700',
    origin: '#6f9fd8',
};
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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
    },
    center: [0, 30],
    zoom: 2,
    minZoom: 1,
    maxZoom: 15,
});

const records = new Map();  // id -> record for every point on the map
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
    map.addLayer({
        id: 'pulses',
        type: 'circle',
        source: 'pulses',
        paint: {
            'circle-color': 'rgba(0, 0, 0, 0)',
            'circle-stroke-color': ['get', 'color'],
            'circle-stroke-width': 1.5,
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
        },
    });
    paintAge();
    setInterval(paintAge, 30 * 1000);
    applyMapFilter();
    flushPoints();
    setInterval(flushPoints, 500);

    map.on('click', 'points', (e) => openPopup(records.get(e.features[0].id)));
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
            channel: record.channel,
            centre: record.centre,
            discipline: record.discipline,
            topic: record.topic.toLowerCase(),
        },
    };
    toAdd.push(feature);
    if (!reduceMotion) pulses.push(feature);

    if (records.size > MAX_POINTS) {
        removePoint(records.values().next().value);
    }
    return record;
}

function removePoint(record) {
    records.delete(record.id);
    if (byDataId.get(record.props.data_id) === record) byDataId.delete(record.props.data_id);
    var queued = toAdd.length;
    toAdd = toAdd.filter((f) => f.id !== record.id);
    if (toAdd.length === queued) toRemove.push(record.id);
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

class LegendControl {
    onAdd(map) {
        var container = document.createElement('div');
        container.className = 'maplibregl-ctrl legend';
        container.innerHTML = `
            <div><span class="legend-dot" style="background: ${COLORS.cache}"></span>Observation</div>
            <div><span class="legend-dot" style="background: ${COLORS.webcam}"></span>Webcam</div>
            <div><span class="legend-dot legend-ring" style="border-color: ${COLORS.origin}"></span>Origin only, not yet cached</div>
            <div class="legend-note">Pulses mark new arrivals; points fade over an hour</div>`;
        return container;
    }

    onRemove() {
        // Nothing to do here
    }
}

class InfoControl {
    onAdd(map) {
        var container = document.createElement('div');
        container.className = 'maplibregl-ctrl';

        var icon = document.createElement('span');
        icon.className = 'dot';
        icon.innerHTML = '<i style="font-size: 18px;">i</i>';

        var msg = document.createElement('span');
        msg.className = 'popup';
        msg.innerHTML = '<div style="margin: 4px;">WIS 2.0 Live shows real-time weather observations as they are published through the WMO Information System. This page is not affiliated with WMO.</div>'
        msg.style.display = 'none';
        container.append(icon, msg);

        icon.addEventListener('mouseover', function(){
            msg.style.display = 'inline-block';
            icon.style.display = 'none';
        });

        msg.addEventListener('mouseout', function(){
            msg.style.display = 'none';
            icon.style.display = 'inline-block';
        });

        return container;
    }

    onRemove() {
        // Nothing to do here
    }
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
    if (record.source && !record.decoded) {
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn btn-sm btn-primary';
        button.textContent = 'Decode';
        button.addEventListener('click', () => decodeRecord(record, button, out, title));
        actions.appendChild(button);
    }
    if (canonical && !image) {
        var download = document.createElement('a');
        download.className = 'btn btn-sm btn-outline-secondary';
        download.href = canonical.href;
        download.target = '_blank';
        download.rel = 'noopener';
        download.textContent = `Download ${formatLabel(canonical.type)}${canonical.length ? ` (${formatBytes(canonical.length)})` : ''}`;
        actions.appendChild(download);
    }
    if (record.decoded) showDecoded(out, title, record.decoded);
    return div;
}

async function decodeRecord(record, button, out, title) {
    button.disabled = true;
    try {
        record.decoded = await decodeSource(record.source, record.wsi, out);
        showDecoded(out, title, record.decoded);
        button.remove();
    } catch (err) {
        out.innerHTML = `<div class="pp-status pp-error">Could not decode: ${esc(err.message)}</div>`;
        button.disabled = false;
    }
    keepPopupInView();
}

// Downloads and decodes a message's data: BUFR is decoded, text (e.g. a GTS
// bulletin) is returned as-is
async function decodeSource(source, wsi, out) {
    out.innerHTML = `<div class="pp-status">${decoder ? 'Downloading data…' : 'Loading decoder (first time only)…'}</div>`;
    var pyodide = loadDecoder();
    pyodide.catch(() => {});  // Not needed for text; errors surface below for BUFR
    var data = await fetchData(source);
    if (!data.bufr) return { text: new TextDecoder('latin1').decode(data.bytes) };

    var py = await pyodide;
    out.innerHTML = '<div class="pp-status">Decoding…</div>';
    var key = source.dataId || data.url || String(Date.now());
    var result = JSON.parse(py.globals.get('decode_bufr')(data.bytes, wsi || '', key));
    result.key = key;
    return result;
}

function showDecoded(out, title, decoded) {
    if (decoded.text !== undefined) {
        out.innerHTML = '<pre class="pp-text"></pre>';
        out.firstChild.textContent = decoded.text.trim();
    } else {
        renderDecoded(out, title, decoded);
    }
}

async function showReport(out, title, key, index) {
    try {
        var py = await loadDecoder();
        var result = JSON.parse(py.globals.get('decode_bufr')(null, '', key, index));
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
    if (dx || dy) map.panBy([dx, dy]);
}

// Headline values shown as tiles, by BUFR descriptor
const KEY_VALUES = [
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

    var tiles = [];
    for (var key of KEY_VALUES) {
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
    if (seconds < 60) return 'just now';
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
let queueList, queueCount, queueFilter, queueMapped, queuePause, queueCentre, queueToggle;

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
const filters = { text: '', channel: '', centre: '', disciplines: new Set() };
const centres = new Set();

// centre/data/core/<discipline>/...; GTS bulletin topics have none
function disciplineOf(t) {
    var d = t.split('/')[3];
    return DISCIPLINES.hasOwnProperty(d) ? d : 'other';
}

function matchesFilters(item) {
    return (!filters.channel || item.channel === filters.channel)
        && (!filters.centre || item.centre === filters.centre)
        && (!filters.disciplines.size || filters.disciplines.has(item.discipline))
        && (!filters.text || item.topic.toLowerCase().includes(filters.text));
}

function filtersActive() {
    return !!(filters.text || filters.channel || filters.centre || filters.disciplines.size);
}

function applyMapFilter() {
    var expr = ['all'];
    if (filters.channel) expr.push(['==', ['get', 'channel'], filters.channel]);
    if (filters.centre) expr.push(['==', ['get', 'centre'], filters.centre]);
    if (filters.disciplines.size) expr.push(['in', ['get', 'discipline'], ['literal', [...filters.disciplines]]]);
    if (filters.text) expr.push(['in', filters.text, ['get', 'topic']]);
    var filter = expr.length > 1 ? expr : null;
    if (!map.getLayer('points')) return;
    map.setFilter('points', filter);
    map.setFilter('pulses', filter);
}

function applyFilters() {
    applyMapFilter();
    rebuildQueue();
    var active = filtersActive();
    queueToggle.classList.toggle('filtered', active);
    queueToggle.title = active ? 'Message queue (filters on)' : 'Message queue';
    document.querySelector('.queue-reset').hidden = !active;
}

function zoomToCentre(centre) {
    var bounds = new maplibregl.LngLatBounds();
    for (var record of records.values()) {
        if (record.centre === centre) bounds.extend(record.coords);
    }
    if (bounds.isEmpty()) return;
    var sidebar = document.querySelector('.queue').getBoundingClientRect().width;
    map.fitBounds(bounds, { padding: { top: 60, bottom: 60, left: sidebar + 60, right: 60 }, maxZoom: 7 });
}

function addCentreOption(centre) {
    centres.add(centre);
    var option = new Option(centre, centre);
    var next = [...queueCentre.options].slice(1).find((o) => o.value > centre);
    queueCentre.add(option, next || null);
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
                    <select class="form-select form-select-sm queue-centre" aria-label="Centre">
                        <option value="">All centres</option>
                    </select>
                </div>
                <div class="queue-chips" role="group" aria-label="Earth system discipline">
                    ${Object.entries(DISCIPLINES).map(([key, label]) =>
                        `<button type="button" class="queue-chip" data-discipline="${key}" aria-pressed="false">${label}</button>`).join('')}
                </div>
                <div class="queue-controls">
                    <label class="form-check-label"><input type="checkbox" class="form-check-input"> On map only</label>
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
        queueMapped = sidebar.querySelector('input[type=checkbox]');
        queuePause = sidebar.querySelector('.queue-pause');
        queueCentre = sidebar.querySelector('.queue-centre');
        var queueChannel = sidebar.querySelector('.queue-channel');
        var chips = [...sidebar.querySelectorAll('.queue-chip')];

        queueFilter.addEventListener('input', function(){
            filters.text = queueFilter.value.trim().toLowerCase();
            applyFilters();
        });
        queueChannel.addEventListener('change', function(){
            filters.channel = queueChannel.value;
            applyFilters();
        });
        queueCentre.addEventListener('change', function(){
            filters.centre = queueCentre.value;
            applyFilters();
            if (filters.centre) zoomToCentre(filters.centre);
        });
        chips.forEach((chip) => chip.addEventListener('click', function(){
            var key = chip.dataset.discipline;
            filters.disciplines.has(key) ? filters.disciplines.delete(key) : filters.disciplines.add(key);
            chip.setAttribute('aria-pressed', filters.disciplines.has(key));
            applyFilters();
        }));
        sidebar.querySelector('.queue-reset').addEventListener('click', function(){
            filters.text = filters.channel = filters.centre = '';
            filters.disciplines.clear();
            queueFilter.value = queueChannel.value = queueCentre.value = '';
            chips.forEach((chip) => chip.setAttribute('aria-pressed', 'false'));
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

function queueMessage(topic, message, record) {
    var [channel, t] = topic.split('/a/wis2/');
    var entry = {
        time: new Date(),
        topic: topic,
        channel: channel,
        centre: t.split('/', 1)[0],
        path: t.slice(t.indexOf('/') + 1),
        discipline: disciplineOf(t),
        message: message,
        record: record,
    };
    queueTotal++;
    if (queueCentre && !centres.has(entry.centre)) addCentreOption(entry.centre);
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

    if (source) {
        var decode = document.createElement('button');
        decode.type = 'button';
        decode.className = 'btn btn-sm btn-primary';
        decode.textContent = 'Decode';
        decode.addEventListener('click', async () => {
            decode.disabled = true;
            try {
                showDecoded(out, null, await decodeSource(source, stationId(props), out));
                decode.remove();
            } catch (err) {
                out.innerHTML = `<div class="pp-status pp-error">Could not decode: ${esc(err.message)}</div>`;
                decode.disabled = false;
            }
        });
        actions.appendChild(decode);
    }
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
                    queueMessage(topic, message, onMessage(topic, message));
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
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left');
map.addControl(new InfoControl(), 'top-right');
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

// Turns a notification into a map point, returning its record (or nothing)
function onMessage(topic, message) {
    // message is Buffer
    try {
        var feature = JSON.parse(message.toString())
    } catch (err) {
        console.debug(`Message from ${topic} is not valid JSON`);
        return;
    }
    // Kept for every message so the sidebar can find a downloadable copy
    rememberLinks((feature.properties || {}).data_id, feature.links || []);

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
let decoder = null;

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
    return json.dumps({
        'subsets': len(subsets),
        'index': index,
        'rows': subsets[index],
    })
`;

function loadDecoder() {
    if (decoder) return decoder;
    decoder = new Promise((resolve, reject) => {
        var script = document.createElement('script');
        script.src = PYODIDE_URL + 'pyodide.js';
        script.onload = resolve;
        script.onerror = () => reject(new Error('Could not load Pyodide'));
        document.head.appendChild(script);
    }).then(async () => {
        var py = await loadPyodide({ indexURL: PYODIDE_URL });
        await py.loadPackage('micropip');
        var micropip = py.pyimport('micropip');
        await micropip.install(['bitstring==3.1.9', 'six']);
        py.unpackArchive(await fetchWheel(), 'wheel');
        py.runPython(DECODE_PY);
        return py;
    });
    decoder.catch(() => { decoder = null; });  // Allow a retry
    return decoder;
}

// pybufrkit only ships as an sdist, so we serve our own pure-Python wheel.
// Fall back to the CDN copy when the local one can't be fetched (e.g. file://).
async function fetchWheel() {
    for (var url of [PYBUFRKIT_WHEEL, PYBUFRKIT_WHEEL_CDN]) {
        try {
            var response = await fetch(url);
            if (response.ok) return await response.arrayBuffer();
        } catch (err) {
            console.debug(`Could not fetch ${url}`);
        }
    }
    throw new Error('could not download the BUFR decoder');
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
    return { content: content, dataId: props.data_id, urls: urls };
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
