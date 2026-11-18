// Aircraft reports (AMDAR and similar): their altitude, route and phase of flight,
// and each aircraft's track drawn in the air, as bands at its altitude with chevrons
// along the way and an arrowhead at its latest report
import { distanceKm, segments, unwrap } from '../lib/geo.js';
import { esc } from '../lib/util.js';

const TRACK_MAX_GAP_MS = 90 * 60e3;
const AIRCRAFT_MAX_KMH = 1300;           // Faster than this means a mixed-up identifier

// Sizes of the floating aircraft shapes, in screen pixels at the current zoom
const BAND_PX = 3;
const CHEVRON_PX = 9;
const CHEVRON_SPACING_PX = 60;
const MARKER_PX = 16;

// Kilometres per screen pixel at a latitude and zoom
function kmPerPixel(lat, zoom) {
    return 40075.016 * Math.max(Math.cos(lat * Math.PI / 180), 0.05) / (512 * 2 ** zoom);
}

// One aircraft's reports (sorted by time) as shapes in the air, sized for the
// map's zoom. Runs are split where reports are too far apart in time, or would
// need an impossible speed (two aircraft sharing an identifier). key is
// 'aircraft:<id>'; props go on every shape (where it came from, its colour...)
export function aircraftTrack(key, reports, zoom, props) {
    var points = reports.map((r) => ({ t: r.observed, c: r.coords, alt: r.alt, id: r.id }));
    var runs = segments(points, (a, b) => b.t - a.t <= TRACK_MAX_GAP_MS
        && distanceKm(a.c, b.c) / Math.max((b.t - a.t) / 3600e3, 1 / 60) <= AIRCRAFT_MAX_KMH, 2);
    if (!runs.length) return [];
    var route = trackRoute(reports);
    return aircraftShapes(runs, {
        kind: 'aircraft',
        label: `Aircraft ${key.slice(9)}${route ? ` · ${route}` : ''}`,
        count: reports.length,
        ...props,
    }, zoom);
}

// Local flat frame around a point: km east/north to lon/lat offsets
function frame(lat) {
    var kx = 111.32 * Math.max(Math.cos(lat * Math.PI / 180), 0.05);
    return { toLonLat: ([x, y], [lon0, lat0]) => [lon0 + x / kx, lat0 + y / 111.32], kx };
}

// Bands for each step at its altitude, chevrons every so often pointing along
// the path, and an arrowhead at the latest report, all floating in the air
function aircraftShapes(runs, common, zoom) {
    var out = [];
    // bottom and top are metres; the band spans its step's climb or descent so steps join up
    var shape = (ring, alt, role, recordId, bottom, top) => out.push({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [ring.concat([ring[0]])] },
        properties: { ...common, role, alt, recordId, bottom, top },
    });
    // Polygon from km offsets (x along travel, y to the left) around a point heading at angle
    var oriented = (centre, angle, pts) => {
        var f = frame(centre[1]);
        return pts.map(([along, left]) => f.toLonLat([along * Math.cos(angle) - left * Math.sin(angle), along * Math.sin(angle) + left * Math.cos(angle)], centre));
    };
    var lastStep = null;
    for (var run of runs) {
        var coords = unwrap(run.map((p) => p.c));
        var sinceChevron = 0;
        for (var i = 1; i < run.length; i++) {
            var a = run[i - 1], b = run[i];
            var alt = a.alt > 0 && b.alt > 0 ? (a.alt + b.alt) / 2 : a.alt > 0 ? a.alt : b.alt;
            if (!(alt > 0)) continue;
            var p1 = coords[i - 1], p2 = coords[i];
            var f = frame((p1[1] + p2[1]) / 2), px = kmPerPixel((p1[1] + p2[1]) / 2, zoom);
            var dx = (p2[0] - p1[0]) * f.kx, dy = (p2[1] - p1[1]) * 111.32, len = Math.hypot(dx, dy);
            if (!len) continue;
            var angle = Math.atan2(dy, dx), half = BAND_PX * px / 2;
            // Fill-extrusions have flat tops, so a climb or descent is split into
            // pieces small enough to read as a slope
            var altA = a.alt > 0 ? a.alt : alt, altB = b.alt > 0 ? b.alt : alt;
            var pieces = Math.min(24, Math.max(1, Math.ceil(Math.abs(altB - altA) / (Math.max(altA, altB) * 0.02))));
            for (var k = 0; k < pieces; k++) {
                var lo = altA + (altB - altA) * k / pieces, hi = altA + (altB - altA) * (k + 1) / pieces;
                shape(oriented(p1, angle, [[len * k / pieces, half], [len * (k + 1) / pieces, half], [len * (k + 1) / pieces, -half], [len * k / pieces, -half]]),
                    (lo + hi) / 2, 'band', b.id, Math.min(lo, hi) * 0.985, Math.max(lo, hi) * 1.015);
            }
            // A chevron whenever enough path has passed on screen
            sinceChevron += len / px;
            if (sinceChevron >= CHEVRON_SPACING_PX) {
                sinceChevron = 0;
                var mid = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2], c = CHEVRON_PX * px;
                shape(oriented(mid, angle, [[c / 2, 0], [-c / 2, c / 2], [-c / 4, 0], [-c / 2, -c / 2]]), alt, 'arrow', b.id, alt * 0.97, alt * 1.03);
            }
            lastStep = { point: p2, angle, alt: b.alt > 0 ? b.alt : alt, id: b.id };
        }
    }
    if (lastStep) {
        var m = MARKER_PX * kmPerPixel(lastStep.point[1], zoom);
        shape(oriented(lastStep.point, lastStep.angle, [[m * 0.6, 0], [-m * 0.4, m * 0.45], [-m * 0.2, 0], [-m * 0.4, -m * 0.45]]),
            lastStep.alt, 'marker', lastStep.id, lastStep.alt * 0.95, lastStep.alt * 1.05);
    }
    return out;
}

// Airport codes from 001111 (origination) and 001112 (destination); blanks and
// "???" mean unknown. Returns e.g. "DUB → TFS", "DUB → ?" or null.
function cleanAirport(code) {
    var c = typeof code === 'string' ? code.trim().toUpperCase() : '';
    return /^[A-Z0-9]{3,4}$/.test(c) ? c : null;
}

// A decoded aircraft report's info panel tiles: its route and its phase of flight,
// where it gives them. values: descriptor -> [value, unit]
export function aircraftTiles(values) {
    var route = flightRoute(values.has(1111) && values.get(1111)[0], values.has(1112) && values.get(1112)[0]);
    var phase = values.has(8009) ? flightPhase(values.get(8009)[0]) : null;
    return {
        route: route ? [`<div class="pp-tile"><div>Route</div><strong>${esc(route)}</strong></div>`] : [],
        phase: phase ? [`<div class="pp-tile"><div>Flight phase</div><strong>${esc(phase)}</strong></div>`] : [],
    };
}

function flightRoute(from, to) {
    from = cleanAirport(from);
    to = cleanAirport(to);
    return from || to ? `${from || '?'} → ${to || '?'}` : null;
}

// Detailed phase of flight, code table 0 08 009
function flightPhase(code) {
    if ([0, 1, 3, 4].includes(code)) return 'Level flight';
    if (code === 2) return 'Unsteady';
    if (code === 5 || (code >= 7 && code <= 10)) return 'Climbing';
    if (code === 6 || (code >= 11 && code <= 14)) return 'Descending';
    return null;
}

// The route most of a track's reports agree on, since many leave it blank
export function trackRoute(reports) {
    var vote = (id) => {
        var counts = new Map();
        for (var r of reports) {
            var row = r.decoded && r.decoded.rows.find((x) => x[0] === id);
            var code = row && cleanAirport(row[2]);
            if (code) counts.set(code, (counts.get(code) || 0) + 1);
        }
        return [...counts].sort((a, b) => b[1] - a[1]).map(([c]) => c)[0];
    };
    return flightRoute(vote(1111), vote(1112));
}

// Altitude in metres for aircraft reports (AMDAR and similar), else null:
// flight level, height or altitude, or indicated aircraft altitude
export function aircraftAltitude(values, t) {
    var aircraft = values.has(1008) || values.has(1006) || /\/data\/core\/I\/U\/A\//.test(t);
    if (!aircraft) return null;
    var alt = [7010, 10053, 7002, 10070, 7007].map((id) => values.get(id)).find((v) => typeof v === 'number');
    return alt > 0 && alt < 25000 ? alt : null;
}

