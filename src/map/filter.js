// The layer switches and filters as the map's layer filters (applyMapFilter)
import { filterModes, filters, topicTerms } from '../lib/filters.js';
import { hiddenLayers, effectiveHidden } from './layers.js';
import { map } from './map.js';
import { state } from '../state.js';
import { METRICS, SATELLITE_STYLE, WAVE_STYLE } from '../config.js';
import { isColourTarget, windArrows, isArrow } from './colour.js';
import { syncSwathPoints, refreshSatelliteOutline } from '../data/satellite/coverage.js';
import { TWIN_LAYERS } from './twins.js';
import { radars } from '../data/radar/radar.js';
import { filterGrib } from '../data/grib/grib.js';
import { DECODE_LAYERS } from '../data/decodeQueue.js';
import { updateMapKey } from '../lib/ui/legend.js';

export function applyMapFilter() {
    var expr = ['all'];
    var add = (key, condition) => expr.push(filterModes[key] === 'hide' ? ['!', condition] : condition);
    if (filters.centres.size) add('centres', ['in', ['get', 'centre'], ['literal', [...filters.centres]]]);
    if (filters.format.size) add('format', ['in', ['get', 'format'], ['literal', [...filters.format]]]);
    if (filters.disciplines.size) add('disciplines', ['any', ['in', ['get', 'discipline'], ['literal', [...filters.disciplines]]],
        filters.disciplines.has('space-weather') && ['==', ['get', 'space'], true]]);
    // Data policy, from the topic (…/data/core/…)
    if (filters.policy.size) add('policy', ['any', ...[...filters.policy].map((p) => ['in', `/data/${p}/`, ['get', 'topic']])]);
    var terms = topicTerms();
    if (terms.length) add('text', ['any', ...terms.map((term) => ['in', term, ['get', 'topic']])]);
    if (hiddenLayers.size) {
        var hidden = effectiveHidden();
        expr.push(['!', ['in', ['get', 'layer'], ['literal', hidden]]]);
        // Reports decoded by a switched-off option or layer go too, whatever group they're in
        var hiddenVia = Object.keys(DECODE_LAYERS).filter((k) => hidden.includes(k));
        if (hiddenVia.length) expr.push(['!', ['in', ['coalesce', ['get', 'via'], ''], ['literal', hiddenVia]]]);
        // Individual satellites switched off under Space-based
        var hiddenSats = [...hiddenLayers].filter((k) => k.startsWith('sat:'));
        if (hiddenSats.length) expr.push(['!', ['in', ['coalesce', ['get', 'sat'], ''], ['literal', hiddenSats]]]);
    }
    if (effectiveHidden().includes('replay')) expr.push(['!=', ['get', 'replay'], true]);
    if (!map.getLayer('points')) return;
    filterGrib(expr);
    var tracksOn = !effectiveHidden().includes('gts-tracks');
    // With aircraft tracks on, tracked aircraft are drawn in the air instead of on the ground
    // Optionally only the points coloured by the selected measure
    if (state.colouredOnly && METRICS[state.colourBy]) expr.push(['all', isColourTarget(), ['has', `m_${state.colourBy}`]]);
    // Or, styled by satellite, only what came from a satellite
    if (state.colouredOnly && state.colourBy === SATELLITE_STYLE) expr.push(isColourTarget());
    // Or, styled by wave spectrum, only reports with one
    if (state.colouredOnly && state.colourBy === WAVE_STYLE) expr.push(['has', 'spec']);
    // Swath reports are only points while coverage is switched off (see syncSwathPoints)
    var coverage = !effectiveHidden().includes('sat-coverage');
    syncSwathPoints();
    var shown = tracksOn ? [...expr, ['!=', ['get', 'tracked'], true]] : expr;
    // A ship is a dot only at its latest report; its track joins the rest
    shown = [...shown, ['!', ['all', ['==', ['get', 'shipTrack'], true], ['==', ['get', 'superseded'], true]]]];
    var arrows = windArrows();
    map.setFilter('points-arrow', arrows ? [...shown, isArrow()] : ['boolean', false]);
    map.setFilter('points-spectrum', state.colourBy === WAVE_STYLE ? [...shown, ['has', 'spec']] : ['boolean', false]);
    if (arrows) shown = [...shown, ['!', isArrow()]];
    // Circles for WIS2, diamonds for the GTS, squares for other sources: airports and the Global Replay
    var square = ['any', ['==', ['get', 'ext'], true], ['==', ['get', 'replay'], true]];
    map.setFilter('points', [...shown, ['!=', ['get', 'gateway'], true], ['!', square]]);
    map.setFilter('points-gts', [...shown, ['==', ['get', 'gateway'], true], ['!', square]]);
    // An airport with a twin station (WIS2 or GTS) is only drawn while every layer with one is off
    var twinShown = ['all', ...TWIN_LAYERS.filter((l) => !effectiveHidden().includes(l)).map((l) => ['!=', ['get', `twin_${l}`], true])];
    map.setFilter('points-ext', [...shown, square, twinShown]);
    map.setFilter('pulses', tracksOn ? [...expr, ['!=', ['get', 'tracked'], true]] : expr);
    // Coloured by a satellite measure, coverage its files measure but the cell has no
    // value for (too far from any report to fill) is left out rather than drawn plain
    var swathExpr = METRICS[state.colourBy] ? [...expr, ['!=', ['get', `no_${state.colourBy}`], true]] : expr;
    map.setFilter('swaths-fill', !coverage ? ['boolean', false] : swathExpr.length > 1 ? swathExpr : null);
    refreshSatelliteOutline();
    map.setFilter('swath-arrows', coverage && state.colourBy === 'satWind'
        ? [...expr, ['has', 'm_windDir'], ['>', ['coalesce', ['get', 'm_satWind'], 0], 0]]
        : ['boolean', false]);
    map.setFilter('tracks', [...expr, ['==', ['geometry-type'], 'LineString']]);
    updateMapKey();
    map.setFilter('track-ribbons', [...expr, ['==', ['geometry-type'], 'Polygon']]);
    var radarShown = effectiveHidden().includes('radar') ? 'none' : 'visible';
    radars.forEach((r) => map.getLayer(r.id) && map.setLayoutProperty(r.id, 'visibility', radarShown));
}
