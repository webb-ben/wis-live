// Which points the style colours: the layers a measure colours (stations, ships
// and buoys, or satellites), as a map expression (isColourTarget) and for a record
// (isColourable)
import { SATELLITE_LAYERS, COLOURABLE, SATELLITE_STYLE, METRICS, ORIGIN_COLOURABLE, WAVE_STYLE, NO_VALUE_COLOR } from '../config.js';
import { state, setState } from '../state.js';
import { layerOf, records } from './points.js';
import { topicClass } from '../messages/messages.js';
import { map } from './map.js';
import { swathOpacity, swathOpacityKey, syncOpacitySlider, swathPointsShown, swathFiles } from '../data/satellite/coverage.js';
import { darken } from '../lib/util.js';
import { satelliteMatch, syncSatelliteRows } from '../data/satellite/rows.js';
import { updateModelField } from './modelFields.js';
import { applyMapFilter } from './filter.js';
import { scaleLabel } from '../lib/format.js';
import { clearStationDecodes, queueStationDecodes, attachSpectrum, metricQueue, replayMetricQueue } from '../data/stationDecode.js';
import { writeFiltersToUrl } from '../lib/url.js';
import { syncMetricTile } from '../lib/ui/popup.js';
import { stylePanel } from '../lib/ui/legend.js';

// The layers a measure colours (stations, ships and buoys unless it says satellites)
export function colourTargets(m) {
    return m && m.targets === 'satellite' ? SATELLITE_LAYERS : COLOURABLE;
}

// Styled by satellite (each its own colour) or by a satellite measure: only the
// satellite layers are coloured, and their coverage is drawn strong
export function satelliteStyled() {
    return state.colourBy === SATELLITE_STYLE || !!(METRICS[state.colourBy] && METRICS[state.colourBy].targets === 'satellite');
}

export function isColourTarget() {
    var m = METRICS[state.colourBy];
    var target = ['in', ['get', 'layer'], ['literal', colourTargets(m)]];
    if (state.colourBy === SATELLITE_STYLE) return ['in', ['get', 'layer'], ['literal', SATELLITE_LAYERS]];
    if (m && m.targets === 'satellite') return target;
    return ['any', target, ['all', ['==', ['get', 'layer'], 'origin'], ['in', ['get', 'kind'], ['literal', ORIGIN_COLOURABLE]]]];
}

// A record a measure colours, as isColourTarget decides for points on the map
export function isColourable(record, m) {
    var layer = layerOf(record);
    if (m && m.targets === 'satellite') return SATELLITE_LAYERS.includes(layer);
    return COLOURABLE.includes(layer) || (layer === 'origin' && ORIGIN_COLOURABLE.includes(topicClass(record)));
}

export const IS_AIRCRAFT = ['in', ['get', 'layer'], ['literal', ['cache-aircraft', 'gts-aircraft', 'replay-aircraft']]];

export const FADE_MS = 4 * 60 * 60 * 1000;  // Points fade over four hours

// Wind measures draw points with a direction as arrows (calm ones stay as points)
export function windArrows() {
    return state.colourBy === 'wind' || state.colourBy === 'satWind';
}

export function isArrow() {
    return ['all', isColourTarget(), ['has', 'm_windDir'], ['>', ['coalesce', ['get', `m_${state.colourBy}`], 0], 0]];
}

export function paintAge() {
    var opacity = ['interpolate', ['linear'], ['-', Date.now(), ['get', 'born']], 0, 1, FADE_MS, 0.35];
    // While stations are coloured by a measure, everything else steps back
    // (aircraft keep their own colour and opacity: they aren't coloured by the measures)
    if (state.colourBy !== 'kind') {
        // Surface measures leave aircraft alone (they aren't coloured); satellite measures dim them too
        var kept = satelliteStyled() ? isColourTarget() : ['any', isColourTarget(), IS_AIRCRAFT];
        opacity = ['case', kept, opacity, ['*', opacity, 0.25]];
    }
    map.setPaintProperty('points', 'circle-opacity', ['case', ['get', 'origin'], 0, opacity]);
    map.setPaintProperty('points', 'circle-stroke-opacity', opacity);
    map.setPaintProperty('points-gts', 'icon-opacity', opacity);
    map.setPaintProperty('points-ext', 'icon-opacity', opacity);
    map.setPaintProperty('points-arrow', 'icon-opacity', opacity);
    // Satellite coverage: even shading. Only while colouring by cloud amount does
    // opacity follow the value (clear see-through, overcast strong).
    // The coverage slider sets the even shading, and scales the cloud-amount range with
    // it (clear 0.05 to overcast 0.8 at 30%). Coverage doesn't fade with age: the slider
    // alone sets how strong it is
    var level = swathOpacity[swathOpacityKey()];
    var cloud = state.colourBy !== 'cloudAmount' ? level
        : ['case', ['has', 'm_cloudAmount'], ['min', 1, ['*', level / 0.3,
            ['interpolate', ['linear'], ['get', 'm_cloudAmount'], 0, 0.05, 100, 0.8]]], level];
    map.setPaintProperty('swaths-fill', 'fill-opacity', cloud);
    // The selected cell: a little stronger than the coverage so it stands out, never solid
    map.setPaintProperty('swath-lift', 'fill-opacity', Math.min(0.8, level + 0.2));
    map.setPaintProperty('tracks', 'line-opacity', ['interpolate', ['linear'], ['-', Date.now(), ['get', 'born']], 0, 0.9, FADE_MS, 0.35]);
}

// Applies the style again (a new satellite joins the colours)
export function restyle() {
    if (stylePanel) setColourBy(state.colourBy, stylePanel);
}

export function setColourBy(key, legend) {
    setState({ colourBy: key });
    var m = METRICS[key];
    // What the colours mean, as text, for the minimized key (which hides Style by)
    var colourName = legend.querySelector('.key-colour-name');
    if (colourName) colourName.textContent = m ? `${m.label}${m.unit ? ` (${m.unit})` : ''}`
        : key === SATELLITE_STYLE ? 'Coloured by satellite' : key === WAVE_STYLE ? 'Wave spectra' : '';
    var color = ['get', 'color'];
    var swathColor = color;
    var originRing = ['get', 'color'];
    if (m) {
        var value = ['get', `m_${key}`];
        var target = isColourTarget();
        var scaled = ['interpolate', ['linear'], value, ...m.stops.flat()];
        // Everything the measure doesn't colour is grey, so no kind's colour reads as a
        // value on the scale; aircraft keep theirs under surface measures (never coloured)
        var kept = m.targets === 'satellite' ? false : IS_AIRCRAFT;
        color = ['case',
            ['all', target, ['has', `m_${key}`]], scaled,
            kept, ['get', 'color'],
            NO_VALUE_COLOR];
        swathColor = ['case', ['all', target, ['has', `m_${key}`]], scaled, ['get', 'color']];
        // Origin points are rings, so the ring itself takes the value's colour
        originRing = color;
        // Outlines follow the same scale, darkened
        var outline = ['case',
            ['all', target, ['has', `m_${key}`]], ['interpolate', ['linear'], value, ...m.stops.flatMap(([v, c]) => [v, darken(c)])],
            kept, ['get', 'outline'],
            darken(NO_VALUE_COLOR)];
    } else if (key === SATELLITE_STYLE) {
        // Each satellite its own colour; everything else grey
        var target = isColourTarget();
        color = ['case', target, satelliteMatch(false), NO_VALUE_COLOR];
        swathColor = satelliteMatch(false, ['get', 'color']);
        originRing = color;
        var outline = ['case', target, satelliteMatch(true), darken(NO_VALUE_COLOR)];
    } else if (key === WAVE_STYLE) {
        // Reports with a spectrum keep their colour, at its middle; everything else grey
        color = ['case', ['has', 'spec'], ['get', 'color'], NO_VALUE_COLOR];
        originRing = color;
        var outline = ['case', ['has', 'spec'], ['get', 'outline'], darken(NO_VALUE_COLOR)];
    }
    // Calm reports under a wind measure are empty: an outline with no fill
    var pointColor = windArrows()
        ? ['case', ['all', target, ['==', ['to-number', ['get', `m_${key}`], -1], 0]], 'rgba(0, 0, 0, 0)', color]
        : color;
    map.setPaintProperty('points', 'circle-color', pointColor);
    // Outlines follow the style (a measure's scale, or each satellite's colour), else each point's own
    var styledOutline = outline || ['get', 'outline'];
    map.setPaintProperty('points-gts', 'icon-halo-color', styledOutline);
    map.setPaintProperty('points', 'circle-stroke-color', ['case', ['get', 'origin'], originRing, styledOutline]);
    map.setPaintProperty('points-gts', 'icon-color', pointColor);
    map.setPaintProperty('points-ext', 'icon-color', pointColor);
    map.setPaintProperty('points-ext', 'icon-halo-color', styledOutline);
    map.setPaintProperty('points-arrow', 'icon-color', color);
    if (windArrows()) {
        // Longer arrows for stronger winds, which also win where arrows would overlap
        var speed = ['to-number', ['get', `m_${key}`], 0];
        var length = ['interpolate', ['linear'], speed, 0, 0.55, 5, 0.8, 15, 1.15, 25, 1.4];
        map.setLayoutProperty('points-arrow', 'icon-size', ['interpolate', ['linear'], ['zoom'],
            1, ['*', 0.6, length], 6, ['*', 0.9, length], 10, ['*', 1.2, length]]);
        map.setLayoutProperty('points-arrow', 'symbol-sort-key', ['-', 0, speed]);
    }
    map.setPaintProperty('swaths-fill', 'fill-color', swathColor);
    map.setPaintProperty('swath-lift', 'fill-color', swathColor);
    paintAge();
    syncOpacitySlider();
    // Tiles in an open popup show which measure is in use, however it was chosen
    document.querySelectorAll('.pp-tile[data-metric]').forEach(syncMetricTile);
    syncSatelliteRows();
    var scale = legend.querySelector('.legend-scale');
    if (scale) scale.hidden = !m;
    // The same checkbox hides whatever the style doesn't colour: points without a value
    // for a measure, or anything not from a satellite
    var colouredOnlyRow = legend.querySelector('.legend-coloured-only');
    if (colouredOnlyRow) {
        var bySatellite = key === SATELLITE_STYLE, byWaves = key === WAVE_STYLE;
        colouredOnlyRow.hidden = !m && !bySatellite && !byWaves;
        colouredOnlyRow.querySelector('span').textContent = bySatellite ? 'Satellites only' : byWaves ? 'Spectra only' : 'Require value';
        colouredOnlyRow.title = bySatellite ? 'Only satellite observations are drawn'
            : byWaves ? 'Only ships and buoys that report a wave spectrum are drawn' : 'Only points with a value for the measure are drawn';
    }
    updateModelField(legend);
    applyMapFilter();
    if (m) {
        if (scale && scale.children.length === 3) {
            var [lo, bar, hi] = scale.children;
            lo.textContent = `${scaleLabel(m.stops[0][0])}`;
            hi.textContent = `${scaleLabel(m.stops[m.stops.length - 1][0])} ${m.unit}`;
            bar.style.background = `linear-gradient(90deg, ${m.stops.map(([v, c]) => c).join(', ')})`;
        }
        if (m.targets === 'satellite') clearStationDecodes();
        else queueStationDecodes();
    } else if (key === WAVE_STYLE) {
        // Reports decoded already (the GTS's, or opened) get their symbols now
        for (var record of records.values()) attachSpectrum(record);
        queueStationDecodes();
    } else {
        clearStationDecodes();
    }
    showColourStatus(legend);
    writeFiltersToUrl();
}

export function showColourStatus(legend) {
    var el = legend.querySelector('.legend-colour-status');
    if (state.colourBy === WAVE_STYLE) {
        var withSpectrum = [...records.values()].filter((r) => r.specImage).length;
        var queued = metricQueue.length + replayMetricQueue.length;
        el.hidden = false;
        el.textContent = `${withSpectrum.toLocaleString()} with a wave spectrum` + (queued ? ` · decoding ${queued.toLocaleString()}` : '');
        return;
    }
    // Only measures have values to count (not observation type, nor satellite)
    if (!METRICS[state.colourBy]) { el.hidden = true; return; }
    var points = [...records.values()].filter((r) => isColourable(r, METRICS[state.colourBy]));
    var known = points.filter((r) => r.feature && r.feature.properties[`m_${state.colourBy}`] !== undefined).length;
    var total = points.length;
    // Swath reports drawn as coverage, not points
    if (!swathPointsShown) {
        for (var file of swathFiles.values()) {
            if (!isColourable(file.template, METRICS[state.colourBy])) continue;
            total += file.n;
            var values = file.metrics[state.colourBy];
            if (values) known += values.filter((v) => !isNaN(v)).length;
        }
    }
    el.hidden = false;
    var waiting = metricQueue.length + replayMetricQueue.length;
    el.textContent = `${known.toLocaleString()} of ${total.toLocaleString()} have a value` + (waiting ? ` · decoding ${waiting.toLocaleString()}` : '');
}
