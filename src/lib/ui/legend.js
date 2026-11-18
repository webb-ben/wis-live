import maplibregl from 'maplibre-gl';
import { LAYER_GROUPS, hiddenLayers, ancestors, effectiveHidden, seenLayers } from '../../map/layers.js';
import { darken, PHONE, esc } from '../util.js';
import { replayPosition, replayWindowMs, REPLAY_TICKS, replayMinutesAt, replayWindowLabel, setReplayWindow, scheduleReplay } from '../../messages/replay.js';
import { setOpacitySlider, syncOpacitySlider, swathOpacity, swathOpacityKey, hoveredCell, swathFiles, swathCells } from '../../data/satellite/coverage.js';
import { paintAge, setColourBy, showColourStatus, isColourable, windArrows } from '../../map/colour.js';
import { notify, setState, state } from '../../state.js';
import { applyMapFilter } from '../../map/filter.js';
import { rebuildQueue } from './queue.js';
import { queueAirports } from '../../data/aviation/airports.js';
import { writeFiltersToUrl } from '../url.js';
import { DECODE_LAYERS, decodeEnabled, setDecodeEnabled } from '../../data/decodeQueue.js';
import { createOverview } from './overview.js';
import { map } from '../../map/map.js';
import { drawOverviewContent } from '../../map/overviewContent.js';
import { makeMinimizable, bindKeyToggles, startKeyToggles, keyToggle, hiddenKeyRows } from './panels.js';
import { TRACK_REBUILD_MS, shipTrackLayers } from '../../map/tracks.js';
import { SATELLITE_STYLE, METRICS, SATELLITE_LAYERS, NO_VALUE_COLOR, WAVE_STYLE, OBS_CLASSES, COLORS, SATELLITE_METRIC_ORDER } from '../../config.js';
import { updateModelField } from '../../map/modelFields.js';
import { passesFilters } from '../filters.js';
import { records } from '../../map/points.js';
import { satelliteColours, satelliteLabel } from '../../data/satellite/rows.js';
import { radars, RADAR_COLORS } from '../../data/radar/radar.js';
import { brokerState } from '../../messages/mqtt.js';
import { SHED_LAYERS } from '../../messages/network.js';
import { SATELLITE_PAGE, metricOnPage, otherPageLinks } from '../../page.js';
// The panels on the map: the layers in the sidebar (LegendControl), the key of what
// is drawn with Style by (StyleControl, top right), and the world map with the
// connection lines and About (MapKey, bottom right)

// The map's credits, under About in the bottom right panel (see addAbout), which says
// what the page is in a paragraph of its own (attribution text would be joined to the
// tile credits with a |)
export const attribution = new maplibregl.AttributionControl({ compact: false });

export const ABOUT_TEXT = 'WIS 2.0 Live shows real-time weather observations as they are published through the WMO Information System. This page is not affiliated with WMO.';

export class LegendControl {
    onAdd(map) {
        var container = document.createElement('div');
        container.className = 'legend layer-panel';
        // Links to the other pages: all observations, GBON and satellites (see page.js)
        container.innerHTML = `
            <nav class="legend-pages" aria-label="Other views">${otherPageLinks()}</nav>
            ${LAYER_GROUPS.map((g) => `
            <section class="legend-section legend-section-${g.key}">
            <div class="legend-group">${g.label}<small>${g.subtitle}</small></div>
            <div class="legend-style"><span class="legend-dot legend-sample"></span>${g.key === 'gts' ? 'Diamonds on the map' : g.key === 'other' ? 'Squares on the map' : g.key === 'space' ? 'Hexagons of coverage on the map; single reports as circles from WIS2, diamonds from the GTS' : 'Circles on the map'}</div>
            ${g.layers.map((l) => `
            ${l.option ? `
            <label class="legend-toggle legend-option form-switch" data-layer="${l.key}"${l.title ? ` title="${l.title}"` : ''}>
                <input type="checkbox" class="form-check-input" role="switch"${hiddenLayers.has(l.key) ? '' : ' checked'}>
                <span>${l.label}${l.hint ? `<small>${l.hint}</small>` : ''}</span>
            </label>` : `
            <label class="legend-toggle${l.parent ? ` legend-sub legend-depth-${ancestors(l.key).length}` : ''}${isGroupRow(g, l) ? ' legend-parent' : ''}" data-layer="${l.key}"${l.optIn || g.layers.some((c) => c.parent === l.key && c.optIn) ? '' : ' hidden'}${l.title ? ` title="${l.title}"` : ''}>
                <input type="checkbox" class="form-check-input"${hiddenLayers.has(l.key) ? '' : ' checked'}>
                ${isGroupRow(g, l) ? '' : `<span class="legend-dot${l.ring ? ' legend-ring' : ''}${l.track ? ' legend-line' : ''}" style="--color: ${l.color}${l.track ? '' : `; --outline: ${darken(l.color)}`}"></span>`}${l.label}
            </label>`}`).join('')}
            </section>`).join('')}`;

        // How far back the Global Replay reaches, under its row: earlier on the left, now on the right
        container.querySelector('.legend-toggle[data-layer="replay"]').insertAdjacentHTML('afterend', `
            <label class="legend-option legend-range" data-layer="replay-window">
                <span class="legend-range-value">Since <output></output></span>
                <input type="range" min="0" max="1000" step="1" value="${Math.round(replayPosition(replayWindowMs / 60000) * 1000)}"
                    aria-label="How far back the Global Replay reaches">
                <span class="legend-range-ticks" aria-hidden="true">${REPLAY_TICKS.map((m) =>
                    `<span style="--at: ${replayPosition(m)}">${m < 60 ? `${m}m` : `${m / 60}h`}</span>`).join('')}</span>
            </label>`);
        // Its own slider and label: the coverage opacity slider is another .legend-range, earlier in the panel
        var replayRange = container.querySelector('.legend-range[data-layer="replay-window"]');
        var range = replayRange.querySelector('input');
        var minutesShown = () => replayMinutesAt(range.value / 1000);
        var showWindow = () => {
            var minutes = minutesShown();
            var since = new Date(Date.now() - minutes * 60000).toISOString().slice(11, 16);
            replayRange.querySelector('output').textContent = `${since} UTC (${replayWindowLabel(minutes)} ago)`;
            range.setAttribute('aria-valuetext', `${replayWindowLabel(minutes)}, since ${since} UTC`);
        };
        showWindow();
        setInterval(showWindow, 30 * 1000);  // The start time moves with the clock
        range.addEventListener('input', showWindow);
        range.addEventListener('change', () => setReplayWindow(minutesShown()));

        // How see-through satellite coverage is, under its row. The satellite page has none:
        // its coverage is opaque (see paintAge)
        var coverageToggle = container.querySelector('.legend-toggle[data-layer="sat-coverage"]');
        if (coverageToggle && !SATELLITE_PAGE) coverageToggle.after(buildOpacitySlider());

        container.querySelectorAll('.legend-toggle[data-layer]').forEach((row) => {
            var key = row.dataset.layer;
            row.querySelector('input').addEventListener('change', (e) => {
                e.target.checked ? hiddenLayers.delete(key) : hiddenLayers.add(key);
                notify('hiddenLayers');
                syncDecoding();
                syncSublayers();
                applyMapFilter();
                if (key === 'obs' || key === 'origin') rebuildQueue();
                if (key === 'airports' && e.target.checked) queueAirports();
                if (key === 'replay') {
                    if (e.target.checked) scheduleReplay(0);
                    writeFiltersToUrl();  // ?replay= follows it
                }
            });
        });
        // Sublayers are greyed out while their parent is off
        var syncSublayers = () => container.querySelectorAll('.legend-sub, .legend-option').forEach((sub) => {
            var parentOff = ancestors(sub.dataset.layer).some((a) => hiddenLayers.has(a));
            sub.querySelector('input').disabled = parentOff;
            sub.classList.toggle('legend-disabled', parentOff);
        });
        // Decoding runs for a layer or option that is on and whose parents are on too
        var syncDecoding = () => {
            var hidden = effectiveHidden();
            Object.keys(DECODE_LAYERS).forEach((k) => {
                var on = !hidden.includes(k);
                if (on !== decodeEnabled.has(k)) setDecodeEnabled(k, on);
            });
        };
        syncSublayers();
        // The decode layers are defined further down the script, so start once it has run
        setTimeout(syncDecoding);
        return container;
    }

    onRemove() {
        // Nothing to do here
    }
}

// A row whose points are all drawn by the groups under it (Cache, GTS-to-WIS2),
// so it has no symbol of its own
export function isGroupRow(group, layer) {
    return group.layers.some((c) => c.parent === layer.key && !c.option && !c.follow);
}

export class MapKey {
    onAdd() {
        this.container = document.createElement('div');
        this.container.className = 'maplibregl-ctrl map-key map-world';
        // Top to bottom: notices (the filters in force, and layers a slow network switched
        // off), the world map, the connection lines (broker, catalogue, cache), then About
        // and credits (added below, see addAbout)
        var notices = document.createElement('div');
        notices.className = 'key-notices';
        mapKeySlow = document.createElement('div');
        mapKeySlow.className = 'key-slow';
        mapKeySlow.hidden = true;
        // The filter banner, built with the sidebar, moves in here
        var banner = document.querySelector('.filter-banner');
        notices.append(...[banner, mapKeySlow].filter(Boolean));
        mapKeyStatus = document.createElement('div');
        mapKeyStatus.className = 'key-status';
        overview = createOverview({ map, drawContent: drawOverviewContent, hoveredCell: () => hoveredCell });
        // On the satellite page the world map heads the legend's panel, bottom left (added
        // first, see main.js); this panel keeps the notices, connection lines and About
        var legendPanel = SATELLITE_PAGE && document.querySelector('.map-style');
        if (legendPanel) {
            legendPanel.prepend(overview.section);
            this.container.append(notices, mapKeyStatus);
        } else this.container.append(notices, overview.section, mapKeyStatus);
        // Opens minimized, like the key: the notices and the world map. + shows the
        // connection lines and About and credits
        makeMinimizable(this.container, 'world-map', 'connection status and credits', { alwaysStartMinimized: true });
        updateMapKey();
        return this.container;
    }

    onRemove() {
        // Nothing to do here
    }
}

// Top right: the key of what is drawn now, then Style by with its options. (The
// sidebar opens from the tab on its edge; ProjectionControl's Flat/Globe isn't shown for now)
export class StyleControl {
    onAdd() {
        var container = document.createElement('div');
        container.className = 'maplibregl-ctrl map-key map-style';
        var heading = container.appendChild(document.createElement('div'));
        heading.className = 'map-key-heading';
        heading.textContent = 'Legend';
        mapKeyBody = container.appendChild(document.createElement('div'));
        mapKeyBody.className = 'map-key-main';
        container.append(buildStylePanel());
        // A key row or source hides (or shows again) what it stands for (src/ui/panels.js)
        bindKeyToggles(container);
        container.addEventListener('click', (e) => {
            // On phones the panel opens to its options on a tap anywhere but a control or key row
            if (PHONE.matches && !e.target.closest('select, input, label, [data-key-toggle]')) container.classList.toggle('map-key-open');
        });
        // Opens minimized, just the key, smaller, without Style by; + brings Style by back.
        // On the satellite page (bottom left, see main.js), Style by is always there
        if (!SATELLITE_PAGE) makeMinimizable(container, 'key', 'Style by options', { alwaysStartMinimized: true });
        return container;
    }

    onRemove() {
        // Nothing to do here
    }
}

export let mapKeyBody = null;  // The key's rows, in StyleControl (top right)

export let mapKeyStatus = null;  // The broker line, under the world map (bottom right)

export let mapKeySlow = null;  // The slow network notice, above the world map with the filters

// The world map under the key (see createOverview), declared here as the key is built while the page loads
export let overview = null;  // { section, draw, hover, select }

let mapKeyHtml = '';
let mapKeyDirty = false;
let mapKeyBuilt = 0;
export let stylePanel = null;

// What's drawn changed: the key is rebuilt at the next refreshKey
export function keyChanged() {
    mapKeyDirty = true;
}

// Rebuilds the key if something changed and it's been long enough (it follows points
// arriving and going, at most every few seconds)
export function refreshKey(now) {
    if (mapKeyDirty && now - mapKeyBuilt > TRACK_REBUILD_MS) updateMapKey();
}

// The coverage opacity slider: the opacity for the style in use (see swathOpacityKey),
// remembered in this browser. One per page (setOpacitySlider)
export function buildOpacitySlider() {
    var holder = document.createElement('div');
    holder.innerHTML = `
        <label class="legend-option legend-range legend-range-satellite" data-layer="sat-opacity">
            <span class="legend-range-value">Coverage opacity <output></output></span>
            <input type="range" min="0" max="100" step="5" aria-label="Opacity of satellite coverage">
            <span class="legend-range-ticks" aria-hidden="true">${[0, 25, 50, 75, 100].map((p) =>
                `<span style="--at: ${p / 100}">${p}%</span>`).join('')}</span>
        </label>`;
    var slider = holder.firstElementChild;
    setOpacitySlider(slider);
    var range = slider.querySelector('input');
    syncOpacitySlider();
    range.addEventListener('input', () => {
        swathOpacity[swathOpacityKey()] = range.value / 100;
        syncOpacitySlider();
        paintAge();
    });
    range.addEventListener('change', () => {
        var key = swathOpacityKey();
        try {
            localStorage.setItem(`wis-coverage-opacity-${key}`, String(swathOpacity[key]));
        } catch (err) {
            // Storage unavailable; the setting lasts until the page is closed
        }
    });
    return slider;
}

// Satellite measures most often seen first (SATELLITE_METRIC_ORDER); the rest keep METRICS' order
function byFrequency([a], [b]) {
    var rank = (key) => (SATELLITE_METRIC_ORDER.includes(key) ? SATELLITE_METRIC_ORDER.indexOf(key) : -1);
    return rank(a) - rank(b);
}

// Style by's options, as HTML: the page's measures (metricOnPage), grouped, most often
// seen first. seen, if given, keeps only the measures in it, and the one in use
function styleOptions(seen) {
    var offered = Object.entries(METRICS).filter(([key, m]) => metricOnPage(m) && (!seen || seen.has(key) || key === state.colourBy))
        .sort(byFrequency);
    return (SATELLITE_PAGE ? `<option value="${SATELLITE_STYLE}">Satellite</option>` : '<option value="kind">Observation type</option>')
        + [...new Set(offered.map(([, m]) => m.group))].map((group) => `<optgroup label="${group}">${offered
            .filter(([, m]) => m.group === group).map(([key, m]) => `<option value="${key}">${m.label}</option>`).join('')}</optgroup>`).join('');
}

// On the satellite page, Style by offers only the measures some satellite on the map has
// values for (every satellite file is decoded, so what's there is known; elsewhere a
// station's values are only decoded once a measure is chosen, so every one is offered)
let offeredKey = '';
function syncStyleOptions() {
    if (!SATELLITE_PAGE || !stylePanel) return;
    var seen = new Set();
    satelliteHoldings().forEach((held) => held.metrics.forEach((m) => seen.add(m)));
    var key = [...seen].sort().join(',') + `|${state.colourBy}`;
    if (key === offeredKey) return;
    offeredKey = key;
    var select = stylePanel.querySelector('select');
    select.innerHTML = styleOptions(seen);
    select.value = state.colourBy;
}

// Color by and the options that go with it, at the top of the map key
export function buildStylePanel() {
    stylePanel = document.createElement('div');
    stylePanel.className = 'map-key-style';
    stylePanel.innerHTML = `
        <div class="legend-colour">
            <label class="key-colour-by">Style by
                <select class="form-select form-select-sm" aria-label="Color points by">${styleOptions(null)}</select>
            </label>
            <div class="key-colour-name"></div>
            <div class="legend-scale" hidden><span></span><i></i><span></span></div>
            <div class="key-options">
                <label class="legend-coloured-only" hidden title="Only points with a value for the measure are drawn"><input type="checkbox" class="form-check-input"> <span>Require value</span></label>
            </div>
            <div class="legend-note legend-colour-status" hidden></div>
            <label class="legend-model form-switch" hidden title="Draw Environment and Climate Change Canada's global model field for the same measure, at the current hour, under the points, so observations can be compared with the model">
                <input type="checkbox" class="form-check-input" role="switch">
                <span>Model base layer<small class="legend-model-note"></small></span>
            </label>
            <div class="legend-model-info" hidden><img alt="Model field legend"></div>
        </div>`;
    stylePanel.querySelector('select').addEventListener('change', (e) => setColourBy(e.target.value, stylePanel));
    stylePanel.querySelector('.legend-coloured-only input').addEventListener('change', (e) => {
        setState({ colouredOnly: e.target.checked });
        applyMapFilter();
        writeFiltersToUrl();
    });
    stylePanel.querySelector('.legend-model input').addEventListener('change', (e) => {
        setState({ modelFieldOn: e.target.checked });
        updateModelField(stylePanel);
        writeFiltersToUrl();
    });
    setInterval(() => showColourStatus(stylePanel), 1000);
    return stylePanel;
}

// What each satellite on the map has: satellite key -> { sources: Set of 'WIS2', 'GTS'
// (where its data came from), metrics: Set of the METRICS keys it has values for }
export function satelliteHoldings() {
    var holdings = new Map();
    var note = (p, metrics) => {
        if (!p.sat) return;
        if (!holdings.has(p.sat)) holdings.set(p.sat, { sources: new Set(), metrics: new Set() });
        var held = holdings.get(p.sat);
        held.sources.add(p.gateway ? 'GTS' : 'WIS2');
        metrics.forEach((m) => held.metrics.add(m));
    };
    for (var file of swathFiles.values()) note(file.props, Object.keys(file.means));
    for (var record of records.values()) {
        if (!record.feature) continue;
        var p = record.feature.properties;
        note(p, Object.keys(p).filter((k) => k.startsWith('m_')).map((k) => k.slice(2)));
    }
    return holdings;
}

// The key's satellite rows: each satellite switched on, in its colour, by name, a click
// switching it off. With a measure (metric), only those with values for it. On the
// satellite page each also says where its data came from (WIS2, the GTS), as its
// coverage is one grid whatever the source, not circles and diamonds
function satelliteRows(metric) {
    var hidden = effectiveHidden(), holdings = satelliteHoldings();
    return [...satelliteColours].filter(([sat]) => !hidden.includes(sat) && (!metric || holdings.get(sat)?.metrics.has(metric)))
        .sort(([a], [b]) => satelliteLabel(a).localeCompare(satelliteLabel(b)))
        .map(([sat, colour]) => {
            var via = SATELLITE_PAGE && holdings.get(sat)?.sources;
            var tag = via ? `<small class="key-source">${[...via].sort().reverse().join(' · ')}</small>` : '';
            return keyToggle(sat, [sat], satelliteLabel(sat),
                `<span class="legend-dot" style="--color: ${colour}; --outline: ${darken(colour)}"></span>${esc(satelliteLabel(sat))}${tag}`);
        });
}

export function drawnLayers() {
    var hidden = new Set(effectiveHidden());
    var m = state.colouredOnly && METRICS[state.colourBy];
    var out = new Set();
    // Satellites only (styled by satellite, with the checkbox on) leaves out the rest
    var satellitesOnly = state.colouredOnly && state.colourBy === SATELLITE_STYLE;
    var passes = (p) => passesFilters(p, hidden) && !(satellitesOnly && !SATELLITE_LAYERS.includes(p.layer));
    var mark = (p) => {
        out.add(p.layer);
        if (p.via) out.add(p.via);
    };
    for (var record of records.values()) {
        var p = record.feature.properties;
        if (out.has(p.layer) && (!p.via || out.has(p.via))) continue;
        if (!passes(p) || (m && !(isColourable(record, m) && p[`m_${state.colourBy}`] != null))) continue;
        mark(p);
    }
    if (!hidden.has('sat-coverage')) {
        for (var file of swathFiles.values()) {
            if (passes(file.props) && !(m && !(isColourable(file.template, m) && file.means[state.colourBy] != null))) mark(file.props);
        }
    }
    return out;
}

export function updateMapKey() {
    if (!mapKeyBody) return;
    syncStyleOptions();
    var hidden = effectiveHidden();
    var shown = drawnLayers();
    var drawn = (key) => shown.has(key);
    var drawnAny = (prefix) => [...shown].some((k) => k.startsWith(prefix));
    var symbol = (shape, color) => `<span class="legend-dot${shape === 'diamond' ? ' key-diamond' : ''}${shape === 'square' ? ' key-square' : ''}${shape === 'ring' ? ' legend-ring' : ''}" style="--color: ${color}; --outline: ${darken(color)}"></span>`;
    var rows = [];
    // Rows (and source shapes) a click hides, as the sidebar's switches would (src/ui/panels.js)
    startKeyToggles();
    var toggle = keyToggle;
    var m = METRICS[state.colourBy];
    var coverage = SATELLITE_LAYERS.some(drawn) && !hidden.includes('sat-coverage') && swathCells.size;
    var swatch = '<span class="legend-dot key-swath" title="Coverage"></span>';
    if (m) {
        // The measure and its scale are in the style panel above
        // With "Require value" on, points without one aren't drawn, so there's nothing to explain
        // The same grey "Other" row as styled by satellite: whatever the style doesn't colour
        // (on the satellite page, where everything is a satellite's, nothing)
        if (!state.colouredOnly && !SATELLITE_PAGE) rows.push(`<div class="key-note">${symbol('circle', NO_VALUE_COLOR)}Other</div>`);
        if (coverage) rows.push(toggle('sat-coverage', ['sat-coverage'], 'satellite coverage', `${swatch}Satellite coverage${state.colourBy === 'cloudAmount' ? ', darker = cloudier' : ''}`));
        // On the satellite page, the satellites that measure it, each switched off with a click
        if (SATELLITE_PAGE) rows.push(...satelliteRows(state.colourBy));
    } else if (state.colourBy === SATELLITE_STYLE) {
        // Each satellite switched on, in its colour, by name; everything else is grey
        rows.push(...satelliteRows(null));
        // Nothing else is drawn with Satellites only on, nor on the satellite page
        if (!state.colouredOnly && !SATELLITE_PAGE) rows.push(`<div class="key-note">${symbol('circle', NO_VALUE_COLOR)}Other</div>`);
    } else if (state.colourBy === WAVE_STYLE) {
        rows.push('<div class="key-note"><span class="key-wavespec"></span>Wave spectrum: where waves come from (north up), longer waves inside, red = most energy</div>');
        if (!state.colouredOnly) rows.push(`<div class="key-note">${symbol('circle', NO_VALUE_COLOR)}Other</div>`);
    } else {
        for (var [key, c] of Object.entries(OBS_CLASSES)) {
            var shapes = [drawn(`cache-${key}`) && 'circle', drawn(`gts-${key}`) && 'diamond', drawn(`replay-${key}`) && 'square'].filter(Boolean);
            // Satellites' points and their coverage on one line
            var extra = key === 'satellite' && coverage ? swatch : '';
            if (shapes.length || extra) {
                rows.push(toggle(`class:${key}`, [`cache-${key}`, `gts-${key}`, `replay-${key}`, ...(key === 'satellite' ? SATELLITE_LAYERS : [])],
                    c.label.toLowerCase(), `${shapes.map((shape) => symbol(shape, c.color)).join('')}${extra}${esc(c.label)}`));
            }
        }
    }
    if (drawn('wis2gts')) rows.push(toggle('wis2gts', ['wis2gts'], 'WIS2-to-GTS', `${symbol('diamond', COLORS.wis2gts)}WIS2-to-GTS`));
    if (!hidden.includes('radar') && radars.size) {
        rows.push(`<div class="key-title">Radar reflectivity (dBZ)</div>`);
        rows.push(`<div class="legend-scale"><span>5</span><i style="background: linear-gradient(90deg, ${RADAR_COLORS.map(([, c]) => c).join(', ')})"></i><span>65</span></div>`);
    }
    var shipTracks = [...shipTrackLayers].filter((l) => !hidden.includes(l));
    if (shipTracks.length) {
        // Shown whenever there are tracks to draw, not a switch
        rows.push(`<div class="key-row"><span class="legend-dot legend-line" style="--color: ${OBS_CLASSES.ship.color}"></span>Ship tracks</div>`);
    }
    if (!hidden.includes('gts-tracks') && drawn('gts-aircraft')) {
        rows.push(toggle('gts-tracks', ['gts-tracks'], 'aircraft tracks',
            '<span class="legend-dot legend-line" style="--color: linear-gradient(90deg, #99e9f2, #22b8cf, #1971c2, #5f3dc4)"></span>Aircraft tracks by altitude'));
    }
    if (state.modelFieldOn && m && m.wms) rows.push(`<div class="key-note">Base layer: ECCC model ${esc(m.wmsLabel || m.label.toLowerCase())}</div>`);
    if (windArrows()) {
        rows.push('<div class="key-note"><span class="key-arrow">➜</span>Arrows point the way the wind blows; longer is stronger. Zoom in for more.</div>');
        rows.push(`<div class="key-note">${symbol('ring', m.stops[0][1])}Calm</div>`);
    }
    // How each source is drawn: WIS2 cache circles, WIS2 origin rings, GTS diamonds
    // Each symbol stays on one line with its label
    // Each also hides its source with a click (the sidebar's Cache, Origin, GTS-to-WIS2,
    // Global Replay and METAR switches)
    var shape = (id, layer, kind, color, label) => toggle(id, [layer], label, `${symbol(kind, color)}${label}`, 'key-shape', 'span');
    // Other sources are squares: the Global Replay (its rows are replay-station and so on) and airports
    // The satellite page says each satellite's source on its row instead (see above)
    var shapes = SATELLITE_PAGE ? [] : [drawnAny('cache-') && shape('source:obs', 'obs', 'circle', '#adb5bd', 'WIS2'),
        drawn('origin') && shape('source:origin', 'origin', 'ring', COLORS.origin, 'WIS2 origin'),
        drawnAny('gts-') && shape('source:gts', 'gts', 'diamond', '#adb5bd', 'GTS'),
        drawnAny('replay-') && shape('source:replay', 'replay', 'square', '#adb5bd', 'Replay'),
        drawn('airports') && shape('source:airports', 'airports', 'square', '#adb5bd', 'METAR')].filter(Boolean);
    // Rows and sources hidden from the key, greyed, to show again with a click
    var { rows: offRows, shapes: offShapes } = hiddenKeyRows();
    rows.push(...offRows);
    if (shapes.length || offShapes.length) rows.push(`<div class="key-shapes">${[...shapes, ...offShapes].join('')}</div>`);
    // Under the world map, apart from the key: the Global Broker messages come from, the
    // fastest Global Discovery Catalogue (dataset records come from it) and the fastest
    // global cache (downloads try it first), each host with how long it took to answer
    var ms = (n) => (n == null || !isFinite(n) ? '' : ` · ${Math.round(n)} ms`);
    var line = (dot, text, title) => `<div class="key-note key-broker"><span class="broker-dot ${dot}"></span>`
        + `<span class="key-broker-text" title="${esc(title)}">${esc(text)}</span></div>`;
    var broker = brokerState.host || '';
    var status = {
        connected: `Broker: ${broker}${ms(brokerState.ms)}`,
        reconnecting: `Reconnecting to ${broker}…`,
        connecting: 'Connecting to a broker…',
        retrying: 'No Global Broker reachable, retrying…',
    }[brokerState.state];
    var brokerHtml = line(`broker-${brokerState.state}`, status, 'WIS2 Global Broker the live messages come from, and its round trip time (measured every minute)');
    // Grey while being found, green once one has answered, like the broker's dot
    brokerHtml += state.catalogue && state.catalogue.failed
        ? line('broker-retrying', 'Catalogue: none reachable', 'No Global Discovery Catalogue answered; dataset records are tried again on demand')
        : state.catalogue
        ? line('broker-connected', `Catalogue: ${state.catalogue.host}${ms(state.catalogue.ms)}`,
            `Global Discovery Catalogue the dataset records come from: the fastest to answer, checked every minute (${state.catalogue.name})`)
        : line('broker-connecting', 'Catalogue: finding the fastest…', 'Timing the Global Discovery Catalogues');
    brokerHtml += state.cache
        ? line('broker-connected', `Cache: ${state.cache.host}${ms(state.cache.ms)}`,
            `Global cache downloads try first: the fastest to answer, checked every minute (${state.cache.name})`)
        : line('broker-connecting', 'Cache: finding the fastest…', 'Timing the global caches as their messages arrive');
    if (mapKeyStatus && brokerHtml !== mapKeyStatus.dataset.html) {
        mapKeyStatus.innerHTML = mapKeyStatus.dataset.html = brokerHtml;
    }
    // Layers switched off for a slow network: a notice above the world map, with the filters
    var slowHtml = '';
    if (state.slowNetwork) {
        var shedNames = SHED_LAYERS.filter((l) => state.slowNetwork.shed.includes(l.key)).map((l) => l.label).join(' and ');
        slowHtml = line('broker-reconnecting', `Slow network: ${shedNames} off`,
            `Switched off to save the connection (${state.slowNetwork.reason}). Switch them back on under Layers.`);
    }
    if (mapKeySlow && slowHtml !== mapKeySlow.dataset.html) {
        mapKeySlow.innerHTML = mapKeySlow.dataset.html = slowHtml;
        mapKeySlow.hidden = !slowHtml;
    }
    // Refreshed as points come and go; left alone when nothing changed, so a hover isn't interrupted
    var html = rows.join('');
    if (html !== mapKeyHtml) mapKeyBody.innerHTML = mapKeyHtml = html;
    mapKeyDirty = false;
    mapKeyBuilt = Date.now();
}

export function showLegendRow(key) {
    if (SATELLITE_LAYERS.includes(key) && !seenLayers.has('satellite')) showLegendRow('satellite');
    seenLayers.add(key);
    updateMapKey();
    var row = document.querySelector(`.legend-toggle[data-layer="${key}"]`);
    if (row) row.hidden = false;
    // Rows that follow their parent, such as aircraft tracks
    LAYER_GROUPS.flatMap((g) => g.layers).filter((l) => l.follow && l.parent === key).forEach((l) => {
        var child = document.querySelector(`.legend-toggle[data-layer="${l.key}"]`);
        if (child) child.hidden = false;
    });
}

// What this page is and the map's credits, last in the bottom right panel. While it's
// minimized (see MapKey) the heading and description go with the connection lines, but
// the tile credits always show. MapLibre's attribution keeps itself up to date there
// as sources come and go. Once MapKey is on the map
export function addAbout() {
    var about = document.createElement('section');
    about.className = 'key-about';
    about.setAttribute('aria-label', 'About and credits');
    // The map's credits, with the panel's −/+ (connection status and credits) at the end
    // of their line rather than in the panel's corner, which the world map fills
    var credits = document.createElement('div');
    credits.className = 'key-credits';
    credits.appendChild(attribution.onAdd(map));
    var panel = mapKeyStatus.parentElement;
    var toggle = panel && panel.querySelector(':scope > .map-key-min-toggle');
    if (toggle) credits.appendChild(toggle);
    about.innerHTML = '<div class="key-about-title">ⓘ About and credits</div><p class="key-about-text"></p>';
    about.querySelector('.key-about-text').textContent = ABOUT_TEXT;
    // The satellite page has no sidebar, where the other pages keep their links to the
    // rest: its links are here, shown with the About text when the panel is opened
    if (SATELLITE_PAGE) about.querySelector('.key-about-text').insertAdjacentHTML('afterend',
        `<nav class="legend-pages" aria-label="Other views">${otherPageLinks()}</nav>`);
    about.append(credits);
    mapKeyStatus.after(about);
}
