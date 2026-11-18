// The map's point symbols as signed distance fields (TinySDF's encoding: 0.75 at
// the edge, 8 px radius), so MapLibre can tint each point and draw its outline as a halo

export const DIAMOND_HALF = 14;  // Half-diagonal of the diamond image, in image pixels (pixel ratio 2)

// A diamond as a signed distance field, so MapLibre can tint it per point and
// draw an outline (halo). Encoding as TinySDF: 0.75 at the edge, 8 px radius.
// A wind arrow pointing up (north), as a signed distance field so it takes any
// colour and a halo. The shape is drawn on a canvas and the field measured from it.
export function arrowSdf() {
    var size = 48, c = size / 2, radius = 8, cutoff = 0.25;
    var canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    var ctx = canvas.getContext('2d');
    ctx.beginPath();
    ctx.moveTo(c, c - 16);       // tip
    ctx.lineTo(c + 10, c - 2);
    ctx.lineTo(c + 4, c - 2);
    ctx.lineTo(c + 4, c + 15);   // tail
    ctx.lineTo(c - 4, c + 15);
    ctx.lineTo(c - 4, c - 2);
    ctx.lineTo(c - 10, c - 2);
    ctx.closePath();
    ctx.fill();
    var alpha = ctx.getImageData(0, 0, size, size).data;
    var inside = (i) => alpha[i * 4 + 3] > 127;
    var edges = [];
    for (var i = 0; i < size * size; i++) {
        var x = i % size, y = (i / size) | 0;
        if (inside(i) && [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => !inside((y + dy) * size + x + dx))) edges.push([x, y]);
    }
    var data = new Uint8ClampedArray(size * size * 4);
    for (var j = 0; j < size * size; j++) {
        var px = j % size, py = (j / size) | 0, d = Infinity;
        for (var [ex, ey] of edges) d = Math.min(d, Math.hypot(px - ex, py - ey));
        d = inside(j) ? -d : d;
        data[j * 4] = data[j * 4 + 1] = data[j * 4 + 2] = 255;
        data[j * 4 + 3] = 255 - 255 * (d / radius + cutoff);
    }
    return { width: size, height: size, data };
}

// A square as a signed distance field, for points from other sources (airports)
export function squareSdf() {
    var half = 10, size = 2 * (half + 8), c = size / 2, radius = 8, cutoff = 0.25;
    var data = new Uint8ClampedArray(size * size * 4);
    for (var y = 0; y < size; y++) {
        for (var x = 0; x < size; x++) {
            var d = Math.max(Math.abs(x + 0.5 - c), Math.abs(y + 0.5 - c)) - half;
            var i = (y * size + x) * 4;
            data[i] = data[i + 1] = data[i + 2] = 255;
            data[i + 3] = 255 - 255 * (d / radius + cutoff);
        }
    }
    return { width: size, height: size, data };
}

export function diamondSdf() {
    var size = 2 * (DIAMOND_HALF + 8), c = size / 2, radius = 8, cutoff = 0.25;
    var data = new Uint8ClampedArray(size * size * 4);
    for (var y = 0; y < size; y++) {
        for (var x = 0; x < size; x++) {
            // Distance outside the diamond |x| + |y| = half (negative inside)
            var d = (Math.abs(x + 0.5 - c) + Math.abs(y + 0.5 - c) - DIAMOND_HALF) / Math.SQRT2;
            var i = (y * size + x) * 4;
            data[i] = data[i + 1] = data[i + 2] = 255;
            data[i + 3] = 255 - 255 * (d / radius + cutoff);
        }
    }
    return { width: size, height: size, data };
}
