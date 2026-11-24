// Style by centre (CENTRE_STYLE): every point in the colour of the centre-id that published it.
// The first ten centres seen take ten colours as different as can be (FIRST), so the main
// ones never look alike; after those each takes a random colour, kept while the page is open
import { darken } from '../lib/util.js';
import { NO_VALUE_COLOR } from '../config.js';
import { records } from './points.js';

const colours = new Map();

// HSL (0-360, 0-1, 0-1) to #rrggbb, as darken() needs
function hex(h, s, l) {
    var f = (n) => {
        var k = (n + h / 30) % 12;
        var c = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
        return Math.round(c * 255).toString(16).padStart(2, '0');
    };
    return `#${f(0)}${f(8)}${f(4)}`;
}

// The first centres seen take these, as far apart as colours go (hue and lightness, none
// grey, which means no value); the rest a random one
const FIRST = ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#17becf', '#e377c2', '#8c564b', '#bcbd22', '#1b1b7a'];

export function centreColour(centre) {
    if (!centre) return NO_VALUE_COLOR;
    if (!colours.has(centre)) {
        // Saturated and mid-light, so it neither greys out nor vanishes on the basemap
        colours.set(centre, colours.size < FIRST.length ? FIRST[colours.size]
            : hex(Math.random() * 360, 0.55 + Math.random() * 0.3, 0.35 + Math.random() * 0.2));
    }
    return colours.get(centre);
}

// The centre a point is styled by: the one that made it, which for a GTS bulletin is the one
// its heading names (record.issuer, gtsOrigin.js), not the gateway that relayed it
export function centreOf(record) {
    return record.issuer || record.centre;
}

// How a point is drawn, as the legend shows it: a GTS diamond, a square for other sources
// (airports, the Global Replay), an origin ring, else a cache circle
function shapeOf(record) {
    var q = record.feature.properties;
    if (q.ext || q.replay) return 'square';
    if (q.gateway) return 'diamond';
    if (q.origin) return 'ring';
    return 'circle';
}

// The centres with points on the map, most points first: [[centre, count, shapes], …], shapes
// the ones its points are drawn as (a Set of circle, ring, diamond, square)
export function centresOnMap() {
    var counts = new Map();
    for (var record of records.values()) {
        var centre = centreOf(record);
        if (!centre || record.feature.properties.superseded) continue;
        var c = counts.get(centre) || [centre, 0, new Set()];
        c[1]++;
        c[2].add(shapeOf(record));
        counts.set(centre, c);
    }
    return [...counts.values()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

// A MapLibre expression: each point's centre's colour (dark: its outline's), grey for none
export function centreMatch(dark) {
    var centres = [...new Set([...records.values()].map(centreOf).filter(Boolean))];
    if (!centres.length) return dark ? darken(NO_VALUE_COLOR) : NO_VALUE_COLOR;
    return ['match', ['get', 'issuer'], ...centres.flatMap((c) => [c, dark ? darken(centreColour(c)) : centreColour(c)]),
        dark ? darken(NO_VALUE_COLOR) : NO_VALUE_COLOR];
}

export function centreCount() {
    return new Set([...records.values()].map(centreOf)).size;
}
