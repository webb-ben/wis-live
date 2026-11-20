// Geometry on the globe: distances, hulls and rings, lines across ±180, and the
// H3 hexagon cells satellite coverage is drawn in.
import { latLngToCell, cellToBoundary, cellsToMultiPolygon, gridDisk, gridDiskDistances, cellToLatLng, originToDirectedEdges, getDirectedEdgeDestination, directedEdgeToBoundary, getHexagonEdgeLengthAvg, getResolution, UNITS } from 'h3-js';
export { getResolution };

export function distanceKm([lon1, lat1], [lon2, lat2]) {
    var r = Math.PI / 180;
    var a = Math.sin((lat2 - lat1) * r / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lon2 - lon1) * r / 2) ** 2;
    return 12742 * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Splits time-ordered positions into runs where every step passes the test
export function segments(points, ok, minPoints) {
    var out = [], run = [points[0]];
    for (var i = 1; i < points.length; i++) {
        if (ok(points[i - 1], points[i])) {
            run.push(points[i]);
        } else {
            if (run.length >= minPoints) out.push(run);
            run = [points[i]];
        }
    }
    if (run.length >= minPoints) out.push(run);
    return out;
}

// Longitudes carried past ±180 so a line crossing the antimeridian doesn't wrap the globe
export function unwrap(coords) {
    var out = [coords[0].slice()];
    for (var i = 1; i < coords.length; i++) {
        var lon = coords[i][0];
        while (lon - out[i - 1][0] > 180) lon -= 360;
        while (lon - out[i - 1][0] < -180) lon += 360;
        out.push([lon, coords[i][1]]);
    }
    return out;
}

// Convex hull (monotone chain) of [lon, lat] points, as a closed ring
export function convexHull(points) {
    var pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    var cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    var lower = [], upper = [];
    for (var p of pts) {
        while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
        lower.push(p);
    }
    for (var i = pts.length - 1; i >= 0; i--) {
        while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pts[i]) <= 0) upper.pop();
        upper.push(pts[i]);
    }
    var ring = lower.slice(0, -1).concat(upper.slice(0, -1));
    return ring.length >= 3 ? ring.concat([ring[0]]) : null;
}

// Whether a point is inside a ring, or within `margin` degrees of its edge
// (so neighbouring strips of one pass meet without gaps)
export function inOrNearRing([x, y], ring, margin) {
    var inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        var [xi, yi] = ring[i], [xj, yj] = ring[j];
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    if (inside) return true;
    for (var k = 1; k < ring.length; k++) {
        var [ax, ay] = ring[k - 1], [bx, by] = ring[k];
        var dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy || 1;
        var t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len));
        if (Math.hypot(x - ax - t * dx, y - ay - t * dy) <= margin) return true;
    }
    return false;
}

// Coverage cells are H3 hexagons (h3-js), the same everywhere on the globe with
// no seam at ±180. The whole globe's (the overview and the map zoomed out) are
// resolution 2, about 180 km a side; each resolution up is about 2.6 times smaller,
// down to H3_RESOLUTION_MAX zoomed in. A file is never drawn finer than its reports'
// spacing allows, nor coarser than H3_RESOLUTION_MIN (see resolutionForSpacing)
export const H3_RESOLUTION = 2;
export const H3_RESOLUTION_MAX = 4;  // About 45 km between cells: finer is more cells than the reports kept fill

export function h3Cell(lon, lat, resolution = H3_RESOLUTION) {
    return latLngToCell(lat, ((lon + 540) % 360) - 180, resolution);
}

// A step in degrees fine enough to find every cell of a resolution across a footprint
// (about 1.2° at resolution 2, 0.45° at 3, 0.06° at 5)
export function h3SampleDeg(resolution) {
    return getHexagonEdgeLengthAvg(resolution, UNITS.km) / 111 * 0.72;
}

export function h3Neighbors(cell) {
    return gridDisk(cell, 1).filter((neighbor) => neighbor !== cell);
}

// Centre-to-centre distance between neighbouring cells of a resolution, in km
// (about 840 at resolution 1, 320 at 2, 120 at 3, 45 at 4, 17 at 5)
export function h3SpacingKm(resolution) {
    return getHexagonEdgeLengthAvg(resolution, UNITS.km) * Math.sqrt(3);
}

// The typical distance in km between a file's reports and their nearest other report:
// the median over up to SPACING_SAMPLES of them. coords is [lon, lat, lon, lat, ...].
// Reports within SPACING_SAME_KM of one another (another level or channel at the same
// spot) count as one place. Sorted by latitude, each search stops once the latitude
// alone is further than the nearest found, so a large file takes milliseconds
export const SPACING_SAMPLES = 256;
export const SPACING_SAME_KM = 0.5;
export function reportSpacingKm(coords) {
    var n = coords.length / 2;
    if (n < 2) return Infinity;
    var order = Array.from({ length: n }, (_, i) => i).sort((a, b) => coords[2 * a + 1] - coords[2 * b + 1]);
    var step = Math.max(1, Math.floor(n / SPACING_SAMPLES)), nearest = [];
    for (var p = 0; p < n; p += step) {
        var i = order[p], here = [coords[2 * i], coords[2 * i + 1]], best = Infinity;
        for (var dir of [-1, 1]) {
            for (var q = p + dir; q >= 0 && q < n; q += dir) {
                var j = order[q];
                if ((Math.abs(coords[2 * j + 1] - here[1])) * 111.2 >= best) break;
                var d = distanceKm(here, [coords[2 * j], coords[2 * j + 1]]);
                if (d > SPACING_SAME_KM && d < best) best = d;
            }
        }
        if (best < Infinity) nearest.push(best);
    }
    if (!nearest.length) return Infinity;
    nearest.sort((a, b) => a - b);
    return nearest[Math.floor(nearest.length / 2)];
}

// The finest resolution whose cells are at least as far apart as the reports, so most
// cells hold a report of their own rather than an estimate: between H3_RESOLUTION_MIN
// (sparse files, such as cloud-motion winds) and H3_RESOLUTION_MAX (imagers, sounders)
export const H3_RESOLUTION_MIN = 1;
export function resolutionForSpacing(spacingKm) {
    for (var r = H3_RESOLUTION_MAX; r > H3_RESOLUTION_MIN; r--) {
        if (h3SpacingKm(r) >= spacingKm) return r;
    }
    return H3_RESOLUTION_MIN;
}

// A cell's centre, as [lon, lat]
export function cellCentre(cell) {
    var [lat, lon] = cellToLatLng(cell);
    return [lon, lat];
}

// A cell's neighbours by distance: [ring 1, ring 2, ... ring k]
export function h3NeighborRings(cell, k) {
    return gridDiskDistances(cell, k).slice(1);
}

// A cell's outline as [lon, lat], longitudes carried past ±180 where it crosses
// so it isn't drawn the whole way round the globe
export function cellRing(cell) {
    var ring = unwrap(cellToBoundary(cell, true));
    // A cell round a pole goes the whole way round it, so unwrapped its ring ends 360°
    // from where it began; closed straight back it would cut a wedge out. Closed along
    // the pole instead, it's drawn whole
    var first = ring[0], last = ring[ring.length - 1];
    if (Math.abs(last[0] - first[0]) > 180) {
        var pole = ring.reduce((sum, [, lat]) => sum + lat, 0) > 0 ? 90 : -90;
        ring.push([last[0], pole], [first[0], pole], first);
    }
    return ring;
}

// The border of a set of cells (a Set of H3 indexes), as short [lon, lat] segments: each
// cell edge whose neighbour across it isn't in the set. Linear in the cells and never
// fails, unlike merging them into polygons (cellsOutline), which is slow over large
// areas and throws on ones that wrap the globe. A segment crossing ±180 is carried past it.
// covered(lon, lat, cell), if given, says whether the point just past an edge, in the
// cell beyond it, counts as covered (by cells of another resolution, or as a gap
// enclosed by the set, see enclosedGaps): an edge whose far side is covered isn't a border
export function cellsBorder(cells, covered) {
    var segments = [];
    for (var cell of cells) {
        for (var edge of originToDirectedEdges(cell)) {
            var outside = getDirectedEdgeDestination(edge);
            if (cells.has(outside)) continue;
            var segment = unwrap(directedEdgeToBoundary(edge, true));
            if (covered && covered(...justBeyond(segment, outside), outside)) continue;
            segments.push(segment);
        }
    }
    return segments;
}

// The empty cells a set of cells encloses: gaps inside it, as against the outside. From
// each empty cell next to the set, the empty cells it joins are searched; a search that
// runs past HOLE_CELLS_MAX cells, or into one already found to be outside, is outside,
// and all it passed through with it. So each gap is searched once, and the outside only
// as far as the limit
export const HOLE_CELLS_MAX = 400;
export function enclosedGaps(cells, limit = HOLE_CELLS_MAX) {
    var enclosed = new Set(), outside = new Set();
    for (var cell of cells) {
        for (var start of h3Neighbors(cell)) {
            if (cells.has(start) || enclosed.has(start) || outside.has(start)) continue;
            var seen = new Set([start]), queue = [start], open = false;
            while (queue.length && !open) {
                for (var next of h3Neighbors(queue.pop())) {
                    if (cells.has(next) || seen.has(next)) continue;
                    if (outside.has(next) || seen.size >= limit) { open = true; break; }
                    seen.add(next);
                    queue.push(next);
                }
            }
            seen.forEach((c) => (open ? outside : enclosed).add(c));
        }
    }
    return enclosed;
}

// A point just past the middle of a cell edge, a tenth of the way on towards the centre
// of the cell beyond it, as [lon, lat]
function justBeyond([[lon1, lat1], [lon2, lat2]], beyond) {
    var lon = (lon1 + lon2) / 2, lat = (lat1 + lat2) / 2;
    var [cLat, cLon] = cellToLatLng(beyond);
    cLon = lon + ((((cLon - lon) % 360) + 540) % 360) - 180;
    return [lon + (cLon - lon) * 0.1, lat + (cLat - lat) * 0.1];
}

// The outline of a set of cells merged together: one ring per edge of the area
// (outer edges and any holes), each carried past ±180 like cellRing
export function cellsOutline(cells) {
    return cells.length ? cellsToMultiPolygon(cells, true).flat().map(unwrap) : [];
}
