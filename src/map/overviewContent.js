import { effectiveHidden } from './layers.js';
import { METRICS, SATELLITE_STYLE, SATELLITE_LAYERS, NO_VALUE_COLOR } from '../config.js';
import { state } from '../state.js';
import { globalGrid, swathCells, swathFeature, swathOpacity, swathOpacityKey } from '../data/satellite/coverage.js';
import { passesFilters } from '../lib/filters.js';
import { satelliteColours } from '../data/satellite/rows.js';
import { records } from './points.js';
import { isColourable } from './colour.js';
import { overviewForecast } from '../data/grib/grib.js';


// What the world overview (src/lib/ui/overview.js) shows of the map: points
// that pass the layer switches and filters, coloured as on the map, and satellite coverage
export function drawOverviewContent(ctx, projection, d3, width) {
    // The forecasts page's field, points and outlines first, under everything (grib.js)
    overviewForecast(ctx, projection, d3, width);
    var radius = width > 400 ? 1.6 : 1.1;  // Points, smaller on a small map
    var hidden = new Set(effectiveHidden());
    var m = METRICS[state.colourBy];
    var scale = m && d3.scaleLinear().domain(m.stops.map((s) => s[0])).range(m.stops.map((s) => s[1])).clamp(true);

    // Satellite coverage: each hexagon projected corner by corner (corners past ±180
    // are held at the edge, so a cell there doesn't stretch across the map). Cells of
    // one colour are one path, so their shared edges aren't shaded twice
    if (!hidden.has('sat-coverage')) {
        var fills = new Map();
        for (var cell of swathCells.values()) {
            var feature = swathFeature(cell, globalGrid), p = feature.properties;
            if (!passesFilters(p, hidden)) continue;
            var value = m && m.targets === 'satellite' ? p[`m_${state.colourBy}`] : undefined;
            if (state.colouredOnly && m && value == null) continue;
            var fill = state.colourBy === SATELLITE_STYLE ? satelliteColours.get(p.sat) || p.color : value != null ? scale(value) : p.color;
            if (!fills.has(fill)) fills.set(fill, []);
            fills.get(fill).push(feature.geometry.coordinates[0].map(([lon, lat]) => projection([Math.max(-180, Math.min(180, lon)), lat])));
        }
        ctx.globalAlpha = Math.max(0.15, swathOpacity[swathOpacityKey()]);
        for (var [fill, rings] of fills) {
            ctx.beginPath();
            for (var ring of rings) {
                ring.forEach((xy, i) => (i ? ctx.lineTo(...xy) : ctx.moveTo(...xy)));
                ctx.closePath();
            }
            ctx.fillStyle = fill;
            ctx.fill('nonzero');
        }
    }

    // Points, gathered by colour so each colour is one path; origin copies are rings
    var groups = new Map();
    for (var record of records.values()) {
        var q = record.feature.properties;
        if (q.superseded || !passesFilters(q, hidden)) continue;
        var target = m && isColourable(record, m);
        var v = m ? q[`m_${state.colourBy}`] : undefined;
        if (state.colouredOnly && m && !(target && v != null)) continue;
        if (state.colouredOnly && state.colourBy === SATELLITE_STYLE && !SATELLITE_LAYERS.includes(q.layer)) continue;
        // As setColourBy: grey without a value, aircraft keep theirs under surface measures
        var colour = state.colourBy === SATELLITE_STYLE ? (SATELLITE_LAYERS.includes(q.layer) && satelliteColours.get(q.sat)) || NO_VALUE_COLOR
            : !m ? q.color : target && v != null ? scale(v) : m.targets !== 'satellite' && /-aircraft$/.test(q.layer) ? q.color : NO_VALUE_COLOR;
        var xy = projection(record.coords);
        if (!xy) continue;
        var key = `${colour}|${q.origin ? 'ring' : 'dot'}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(xy);
    }
    ctx.globalAlpha = 0.85;
    for (var [group, points] of groups) {
        var [fill, shape] = group.split('|');
        ctx.beginPath();
        for (var [x, y] of points) {
            ctx.moveTo(x + radius, y);
            ctx.arc(x, y, radius, 0, 2 * Math.PI);
        }
        if (shape === 'ring') {
            ctx.strokeStyle = fill;
            ctx.lineWidth = 0.8;
            ctx.stroke();
        } else {
            ctx.fillStyle = fill;
            ctx.fill();
        }
    }
}
