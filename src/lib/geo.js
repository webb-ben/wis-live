// Geometry on the globe: distances, hulls and rings, lines across ±180, and the
// H3 hexagon cells satellite coverage is drawn in.
import { latLngToCell, cellToBoundary, cellsToMultiPolygon, gridDisk, getHexagonEdgeLengthAvg, getResolution, UNITS } from 'h3-js';
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
// down to H3_RESOLUTION_MAX zoomed in
export const H3_RESOLUTION = 2;
export const H3_RESOLUTION_MAX = 5;

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

// A cell's outline as [lon, lat], longitudes carried past ±180 where it crosses
// so it isn't drawn the whole way round the globe
export function cellRing(cell) {
    return unwrap(cellToBoundary(cell, true));
}

// The outline of a set of cells merged together: one ring per edge of the area
// (outer edges and any holes), each carried past ±180 like cellRing
export function cellsOutline(cells) {
    return cells.length ? cellsToMultiPolygon(cells, true).flat().map(unwrap) : [];
}
