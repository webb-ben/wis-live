// Upper-air soundings and wind profiles: the Skew-T log-P diagram with its winds
// beside it, the larger view in a dialog with the standard levels, and radar wind
// profiles as time-height barbs (drawBarb is shared by both)
import { esc, svgEl } from '../lib/util.js';

// profile levels: [pressure hPa, height gpm, temperature C, dewpoint C, wind dir, wind m/s, dlat, dlon]
export const STANDARD_LEVELS = [1000, 925, 850, 700, 500, 400, 300, 250, 200, 150, 100, 70, 50, 30, 20, 10];

export function soundingTiles(profile) {
    var tile = (label, text) => `<div class="pp-tile"><div>${esc(label)}</div><strong>${esc(text)}</strong></div>`;
    var surface = profile.reduce((a, b) => (b[0] > a[0] ? b : a));
    var top = profile.reduce((a, b) => (b[0] < a[0] ? b : a));
    var windy = profile.filter((l) => l[5] !== null).reduce((a, b) => (!a || b[5] > a[5] ? b : a), null);
    var tiles = [];
    if (surface[2] !== null) tiles.push(tile(`Temperature at ${Math.round(surface[0])} hPa`, `${surface[2].toFixed(1)} °C`));
    if (surface[3] !== null) tiles.push(tile('Dew point', `${surface[3].toFixed(1)} °C`));
    tiles.push(tile('Highest level', top[1] !== null ? `${(top[1] / 1000).toFixed(1)} km (${formatPressure(top[0])} hPa)` : `${formatPressure(top[0])} hPa`));
    if (windy) tiles.push(tile('Strongest wind', `${windy[5].toFixed(0)} m/s at ${formatPressure(windy[0])} hPa`));
    tiles.push(tile('Levels', profile.length.toLocaleString()));
    return tiles;
}

export function formatPressure(p) {
    return p >= 10 ? Math.round(p) : p.toFixed(1);
}

// Wind profiles from wind profilers and weather radars (VAD): winds at
// heights above the site, without pressure, so no Skew-T. Each level starts at a
// height: above sea level (007007), geopotential (007009) or above the station (007006).
// Winds come as direction and speed (011001, 011002) or as components (011003 u,
// 011004 v, as JMA's WINDAS profilers send them). A report can hold several times,
// each starting with its year to minute (WINDAS: six 10-minute periods), so it is
// returned as columns [{ time, levels }], oldest first. Levels without a wind are
// dropped, then columns with fewer than two; null when none are left.
export function windProfileColumns(rows) {
    var station = (rows.find((r) => r[0] === 7030 || r[0] === 7001) || [])[2];
    var parts = {}, columns = [], column = null, level = null;
    for (var [id, , value] of rows) {
        if (id >= 4001 && id <= 4005) {
            parts[id] = value;
            column = level = null;  // Levels after this are another time's
        } else if ([7007, 7009, 7006].includes(id)) {
            var height = typeof value === 'number' ? value + (id === 7006 ? station || 0 : 0) : null;
            if (!column) {
                var time = typeof parts[4001] === 'number' ? Date.UTC(parts[4001], parts[4002] - 1, parts[4003], parts[4004] || 0, parts[4005] || 0) : null;
                columns.push(column = { time, levels: [] });
            }
            level = height === null ? null : { height, dir: null, speed: null, w: null, u: null, v: null };
            if (level) column.levels.push(level);
        } else if (level && typeof value === 'number') {
            var key = { 11001: 'dir', 11002: 'speed', 11003: 'u', 11004: 'v', 11006: 'w' }[id];
            if (key && level[key] === null) level[key] = value;
        }
    }
    columns.forEach((c) => {
        c.levels.forEach((l) => {
            if (l.speed !== null || l.u === null || l.v === null) return;
            l.speed = Math.round(Math.hypot(l.u, l.v) * 10) / 10;
            // The direction the wind comes from: opposite the way (u, v) points
            l.dir = l.speed ? Math.round((Math.atan2(-l.u, -l.v) * 180 / Math.PI + 360) % 360) : null;
        });
        c.levels = c.levels.filter((l) => l.speed !== null).sort((a, b) => a.height - b.height);
        c.levels.station = typeof station === 'number' ? station : null;  // So heights can be drawn above the site
    });
    columns = columns.filter((c) => c.levels.length >= 2).sort((a, b) => (a.time || 0) - (b.time || 0));
    return columns.length ? columns : null;
}

// As windProfileColumns, but a radar's or profiler's report with no winds (002003 radar
// or wind profiler) comes back as one empty column at its time, so it can be drawn as a
// gap among the site's other reports. Null for any other report without winds
export function windProfileColumnsOrEmpty(rows, fallbackTime) {
    var columns = windProfileColumns(rows);
    if (columns) return columns;
    var get = (id) => (rows.find((r) => r[0] === id) || [])[2];
    if (![3, 6].includes(get(2003))) return null;
    var time = typeof get(4001) === 'number' ? Date.UTC(get(4001), get(4002) - 1, get(4003), get(4004) || 0, get(4005) || 0) : fallbackTime;
    var levels = [];
    var station = get(7030) ?? get(7001);
    levels.station = typeof station === 'number' ? station : null;
    return [{ time, levels }];
}

// The latest time's levels, for the tiles and to tell a wind profile from other reports
export function windProfileLevels(rows) {
    var columns = windProfileColumns(rows);
    return columns ? columns[columns.length - 1].levels : null;
}

export function windProfileTiles(levels, values) {
    var tile = (label, text) => `<div class="pp-tile"><div>${esc(label)}</div><strong>${esc(text)}</strong></div>`;
    var km = (m) => `${(m / 1000).toFixed(1)} km`;
    var windy = levels.reduce((a, b) => (b.speed > a.speed ? b : a));
    var equipment = { 3: 'Radar', 6: 'Wind profiler' }[(values.get(2003) || [])[0]];
    var mhz = (values.get(2121) || [])[0];
    var tiles = [];
    if (equipment) tiles.push(tile('Measured by', typeof mhz === 'number' ? `${equipment}, ${Math.round(mhz / 1e6)} MHz` : equipment));
    tiles.push(tile('Heights', `${km(levels[0].height)} to ${km(levels[levels.length - 1].height)}`));
    tiles.push(tile('Strongest wind', `${windy.speed.toFixed(0)} m/s at ${km(windy.height)}`));
    // A time period (004025) after "time averaged" (008021 = 2) is how long the winds are averaged over
    var period = (values.get(4025) || [])[0];
    if ((values.get(8021) || [])[0] === 2 && typeof period === 'number' && period) tiles.push(tile('Averaged over', `${Math.abs(period)} min`));
    tiles.push(tile('Levels', levels.length.toLocaleString()));
    return tiles;
}

// A radar or profiler report with no winds at any height this time: what it does say
export function emptyWindTiles(values) {
    var tile = (label, text) => `<div class="pp-tile"><div>${esc(label)}</div><strong>${esc(text)}</strong></div>`;
    var equipment = { 3: 'Radar', 6: 'Wind profiler' }[(values.get(2003) || [])[0]];
    var tiles = [];
    if (equipment) tiles.push(tile('Measured by', equipment));
    tiles.push(tile('Winds', 'None this time'));
    var height = (values.get(7001) || values.get(7030) || [])[0];
    if (typeof height === 'number') tiles.push(tile('Site height', `${Math.round(height)} m`));
    return tiles;
}

// DWD's weather radars, by the short site name (001018) their wind profiles carry
const DWD_RADARS = { ASB: 'Borkum', BOO: 'Boostedt', DRS: 'Dresden', EIS: 'Eisberg', ESS: 'Essen', FBG: 'Feldberg',
    FLD: 'Flechtdorf', HNR: 'Hannover', ISN: 'Isen', MEM: 'Memmingen', MHP: 'Hohenpeißenberg', NEU: 'Neuhaus',
    NHB: 'Neuheilenbach', OFT: 'Offenthal', PRO: 'Prötzel', ROS: 'Rostock', TUR: 'Türkheim', UMD: 'Ummendorf' };

// A site known only by its short name (001018), as radars name themselves: spelled out
// for a German one (WMO block 10)
export function shortSiteName(values) {
    var code = ((values.get(1018) || [])[0] || '').toString().replace(/[\x00-\x20ÿ]+/g, '').toUpperCase();
    if (!code) return null;
    var german = (values.get(1001) || [])[0] === 10;
    return german && DWD_RADARS[code] ? `${DWD_RADARS[code]} (${code})` : code;
}

// Wind speed in 5 kt bins, calm to 60 kt and over, as on profiler time-height plots
export const BARB_COLORS = ['#000080', '#0000f0', '#0040ff', '#0090ff', '#00e5f8', '#4dffaa',
    '#a4ff53', '#f0ff00', '#ffb000', '#ff5900', '#f00000', '#800000'];

export const KNOTS = 1.943844;  // Per m/s

export const WIND_PROFILE_COLUMNS = 24;  // Times drawn side by side (WINDAS reports hold six each)

export function barbColor(knots) {
    return BARB_COLORS[Math.max(0, Math.min(BARB_COLORS.length - 1, Math.floor(knots / 5)))];
}

// A wind barb with its base at 0,0 and its staff pointing north, to be rotated to
// where the wind comes from: pennants 50 kt, barbs 10, half barbs 5. Null when calm.
export function barbShape(knots, L) {
    var n = Math.round(knots / 5) * 5;
    if (!n) return null;
    var fx = L * 0.42, fy = L * 0.16, step = L * 0.19;
    var lines = `M0 0V${-L}`, flags = '', y = -L;
    for (; n >= 50; n -= 50, y += step * 1.5) flags += `M0 ${y}L${fx} ${y - fy}L0 ${y + step * 1.2}Z`;
    for (; n >= 10; n -= 10, y += step) lines += `M0 ${y}L${fx} ${y - fy}`;
    // A half barb on its own sits a step in from the tip, so it isn't read as a full one
    if (n >= 5) lines += `M0 ${y === -L ? y + step : y}L${fx / 2} ${(y === -L ? y + step : y) - fy / 2}`;
    return { lines, flags };
}

// Draws a barb coloured by speed at x, y; false when there's no direction to draw it in
export function drawBarb(parent, x, y, speed, dir, L) {
    var knots = speed * KNOTS, color = barbColor(knots), shape = barbShape(knots, L);
    if (!shape) {
        svgEl('circle', { cx: x, cy: y, r: L * 0.18, class: 'windprof-barb', stroke: color }, parent);
        return true;
    }
    if (dir === null) return false;
    var g = svgEl('g', { transform: `translate(${x} ${y}) rotate(${dir})`, stroke: color, fill: color }, parent);
    svgEl('path', { d: shape.lines, class: 'windprof-barb' }, g);
    if (shape.flags) svgEl('path', { d: shape.flags, stroke: 'none' }, g);
    return true;
}

export function reportSite(rows) {
    var get = (ids) => (rows.find((r) => ids.includes(r[0]) && typeof r[2] === 'number') || [])[2];
    var lat = get([5001, 5002]), lon = get([6001, 6002]);
    return lat === undefined || lon === undefined ? null : [lon, lat];
}

// Time across and height up the side, with a barb at each level coloured by the
// wind's speed, as profiler plots draw them
export function renderWindProfile(container, columns, opts) {
    var W = opts.width, H = opts.height;
    var m = { top: 20, right: 42, bottom: 32, left: 34 };
    var w = W - m.left - m.right, h = H - m.top - m.bottom;
    columns = columns.slice().sort((a, b) => a.time - b.time);
    // Heights above the site, where every report says how high it is
    var agl = columns.every((c) => c.levels.station !== null);
    var above = (c, l) => l.height - (agl ? c.levels.station : 0);
    var heights = columns.flatMap((c) => c.levels.map((l) => above(c, l)));
    // With no winds at all, the first 3 km, where weather radars see winds when they do
    if (!heights.length) heights = [0, 3000];
    var lo = Math.min(...heights), hi = Math.max(...heights);
    var hMin = Math.min(0, lo), hMax = hi + Math.max(100, (hi - lo) * 0.04);
    var y = (z) => m.top + h * (hMax - z) / (hMax - hMin);
    var t0 = columns[0].time, t1 = columns[columns.length - 1].time;
    var tPad = columns.length > 1 ? (t1 - t0) / (columns.length - 1) / 2 : 30 * 60e3;
    var x = (t) => m.left + w * (t - t0 + tPad) / (t1 - t0 + 2 * tPad);
    var L = Math.max(10, Math.min(18, w / columns.length * 0.85));  // Barb length
    var hhmm = (t) => new Date(t).toISOString().slice(11, 16);

    var svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'windprof', role: 'img',
        'aria-label': 'Wind barbs by height and time, coloured by speed' });
    svgEl('rect', { x: 0, y: 0, width: W, height: H, class: 'skewt-bg' }, svg);

    // Height lines every 0.1 to 2 km, whichever gives no more than six
    var zStep = [100, 200, 250, 500, 1000, 2000].find((s) => (hMax - hMin) / s <= 6) || 5000;
    for (var z = Math.ceil(hMin / zStep) * zStep; z <= hMax; z += zStep) {
        svgEl('line', { x1: m.left, x2: m.left + w, y1: y(z), y2: y(z), class: 'skewt-isobar' }, svg);
        svgEl('text', { x: m.left - 5, y: y(z) + 3.5, class: 'skewt-label', 'text-anchor': 'end' }, svg).textContent = Number((z / 1000).toFixed(2));
    }
    svgEl('text', { x: 0, y: 0, class: 'skewt-label', 'text-anchor': 'middle',
        transform: `translate(9 ${m.top + h / 2}) rotate(-90)` }, svg).textContent = agl ? 'Height (km above site)' : 'Height (km)';
    svgEl('text', { x: m.left + w / 2, y: H - 3, class: 'skewt-axis', 'text-anchor': 'middle' }, svg).textContent = 'Time (UTC)';

    // A line up each report's time, labelled where there's room
    var lastLabel = -Infinity;
    for (var c of columns) {
        var cx = x(c.time);
        // A time with no winds is a dashed line, an empty column
        svgEl('line', { x1: cx, x2: cx, y1: m.top, y2: m.top + h, class: c.levels.length ? 'windprof-col' : 'windprof-col windprof-empty' }, svg);
        if (cx - lastLabel < 32) continue;
        lastLabel = cx;
        svgEl('text', { x: cx, y: m.top + h + 13, class: 'skewt-label', 'text-anchor': 'middle' }, svg).textContent = hhmm(c.time);
    }

    // Barbs from the base of each column's line, thinned where levels crowd
    var drawn = [];
    for (var col of columns) {
        var lastY = Infinity;
        for (var l of col.levels) {
            var cy = y(above(col, l));
            if (lastY - cy < L * 0.3) continue;
            var bx = x(col.time);
            if (!drawBarb(svg, bx, cy, l.speed, l.dir, L)) continue;
            lastY = cy;
            drawn.push({ col, l, x: bx, y: cy });
        }
    }
    svgEl('rect', { x: m.left, y: m.top, width: w, height: h, class: 'skewt-frame' }, svg);
    if (!drawn.length) {
        svgEl('text', { x: m.left + w / 2, y: m.top + h / 2, class: 'skewt-axis', 'text-anchor': 'middle' }, svg)
            .textContent = columns.length > 1 ? 'No winds at these times' : 'No winds this time';
    }

    // The colour scale, in knots
    var sx = m.left + w + 8, kMax = BARB_COLORS.length * 5;
    var sy = (k) => m.top + h * (1 - k / kMax);
    BARB_COLORS.forEach((c, i) => svgEl('rect', { x: sx, y: sy((i + 1) * 5), width: 8, height: h / BARB_COLORS.length + 0.5, fill: c }, svg));
    svgEl('rect', { x: sx, y: m.top, width: 8, height: h, class: 'skewt-frame' }, svg);
    for (var k = 0; k <= kMax; k += 10) {
        svgEl('text', { x: sx + 11, y: sy(k) + 3.5, class: 'skewt-label' }, svg).textContent = k;
    }
    svgEl('text', { x: sx + 4, y: m.top - 6, class: 'skewt-label', 'text-anchor': 'middle' }, svg).textContent = 'kt';

    // Hover readout for the barb nearest the pointer; otherwise how loading is going
    var guide = svgEl('circle', { cx: -20, cy: -20, r: L * 0.35, class: 'windprof-guide' }, svg);
    var readout = svgEl('text', { x: m.left, y: 13, class: 'skewt-readout' }, svg);
    readout.textContent = opts.status || '';
    svg.addEventListener('mousemove', (e) => {
        if (!drawn.length) return;
        var box = svg.getBoundingClientRect();
        var px = (e.clientX - box.left) * W / box.width, py = (e.clientY - box.top) * H / box.height;
        var near = drawn.reduce((a, b) => (Math.hypot(b.x - px, b.y - py) < Math.hypot(a.x - px, a.y - py) ? b : a));
        guide.setAttribute('cx', near.x);
        guide.setAttribute('cy', near.y);
        var l = near.l;
        readout.textContent = [hhmm(near.col.time), `${(above(near.col, l) / 1000).toFixed(2)} km`,
            `${Math.round(l.speed * KNOTS)} kt (${l.speed} m/s)`, l.dir !== null ? `from ${Math.round(l.dir)}°` : null,
            l.w !== null ? `w ${l.w} m/s` : null].filter(Boolean).join(' · ');
    });
    svg.addEventListener('mouseleave', () => {
        guide.setAttribute('cx', -20);
        guide.setAttribute('cy', -20);
        readout.textContent = opts.status || '';
    });

    container.replaceChildren(svg);
}

// Pressure lines labelled on the chart, and the minor ticks between them
export const SKEWT_LABELS = [1000, 850, 700, 500, 300, 200, 100, 50, 20, 10];

export const SKEWT_TICKS = [1000, 900, 800, 700, 600, 500, 400, 300, 200, 100, 90, 80, 70, 60, 50, 40, 30, 20, 10];

export const SKEWT_SKEW = 16;  // Isotherms lean right by this many °C per e-fold of pressure

export function renderSkewT(container, profile, opts) {
    var W = opts.width, H = opts.height;
    var m = { top: 40, right: 10, bottom: 34, left: 46 };
    var w = W - m.left - m.right, h = H - m.top - m.bottom;

    // From just below 1000 hPa (or the surface) up to the highest level reported
    var ps = profile.map((l) => l[0]);
    var pMax = Math.max(1050, Math.max(...ps));
    var pMin = Math.max(1, Math.min(100, Math.min(...ps) * 0.95));
    var y = (p) => m.top + h * (Math.log(p) - Math.log(pMin)) / (Math.log(pMax) - Math.log(pMin));
    var tLeft = -50, tRight = 50;
    var x = (t, p) => m.left + w * (t + SKEWT_SKEW * Math.log(1000 / p) - tLeft) / (tRight - tLeft);

    var svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'skewt', role: 'img',
        'aria-label': 'Skew-T log-P diagram of temperature and dew point against pressure' });
    var clipId = `skewt-clip-${Math.random().toString(36).slice(2)}`;
    svgEl('rect', { x: m.left, y: m.top, width: w, height: h }, svgEl('clipPath', { id: clipId }, svgEl('defs', {}, svg)));
    svgEl('rect', { x: 0, y: 0, width: W, height: H, class: 'skewt-bg' }, svg);
    var plot = svgEl('g', { 'clip-path': `url(#${clipId})` }, svg);

    // Title
    svgEl('text', { x: m.left + w / 2, y: 15, class: 'skewt-title', 'text-anchor': 'middle' }, svg).textContent = 'Skew-T log-P Diagram';
    if (opts.time) {
        var stamp = opts.time.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
        svgEl('text', { x: m.left + w / 2, y: 30, class: 'skewt-title', 'text-anchor': 'middle' }, svg).textContent = stamp;
    }

    // Skewed isotherms, with 0 °C dashed, and the pressure grid
    for (var t = -160; t <= 50; t += 10) {
        svgEl('line', { x1: x(t, pMax), y1: y(pMax), x2: x(t, pMin), y2: y(pMin), class: t === 0 ? 'skewt-zero' : 'skewt-isotherm' }, plot);
    }
    for (var p of SKEWT_LABELS.filter((p) => p <= pMax && p >= pMin)) {
        svgEl('line', { x1: m.left, y1: y(p), x2: m.left + w, y2: y(p), class: 'skewt-isobar' }, plot);
        svgEl('text', { x: m.left - 6, y: y(p) + 3.5, class: 'skewt-label', 'text-anchor': 'end' }, svg).textContent = p;
    }
    for (var p of SKEWT_TICKS.filter((p) => p <= pMax && p >= pMin)) {
        var major = SKEWT_LABELS.includes(p);
        svgEl('line', { x1: m.left - (major ? 4 : 2), y1: y(p), x2: m.left, y2: y(p), class: 'skewt-tick' }, svg);
    }
    for (var t = tLeft; t <= tRight; t += 10) {
        var xb = m.left + w * (t - tLeft) / (tRight - tLeft);
        svgEl('line', { x1: xb, y1: m.top + h, x2: xb, y2: m.top + h + 4, class: 'skewt-tick' }, svg);
        svgEl('text', { x: xb, y: m.top + h + 14, class: 'skewt-label', 'text-anchor': 'middle' }, svg).textContent = t;
    }
    svgEl('text', { x: m.left + w / 2, y: H - 4, class: 'skewt-axis', 'text-anchor': 'middle' }, svg).textContent = 'Temperature (°C)';
    svgEl('text', { x: 0, y: 0, class: 'skewt-axis', 'text-anchor': 'middle',
        transform: `translate(11 ${m.top + h / 2}) rotate(-90)` }, svg).textContent = 'Pressure (hPa)';

    // Temperature and dew point profiles, highest pressure (lowest altitude) first
    var sorted = profile.slice().sort((a, b) => b[0] - a[0]);
    var line = (i, cls) => {
        var pts = sorted.filter((l) => l[i] !== null && l[0] >= pMin).map((l) => `${x(l[i], l[0]).toFixed(1)},${y(l[0]).toFixed(1)}`);
        if (pts.length > 1) svgEl('polyline', { points: pts.join(' '), class: cls }, plot);
    };
    line(3, 'skewt-dewpoint');
    line(2, 'skewt-temperature');
    svgEl('rect', { x: m.left, y: m.top, width: w, height: h, class: 'skewt-frame' }, svg);

    // Legend, top right
    var legend = svgEl('g', { transform: `translate(${m.left + w - 92} ${m.top + 6})` }, svg);
    svgEl('rect', { x: 0, y: 0, width: 86, height: 34, rx: 3, class: 'skewt-legend' }, legend);
    [['Temperature', 'skewt-temperature'], ['Dewpoint', 'skewt-dewpoint']].forEach(([text, cls], i) => {
        svgEl('line', { x1: 6, y1: 11 + i * 13, x2: 22, y2: 11 + i * 13, class: cls }, legend);
        svgEl('text', { x: 27, y: 14.5 + i * 13, class: 'skewt-label skewt-legend-text' }, legend).textContent = text;
    });

    // Hover readout
    var readout = svgEl('text', { x: m.left + 4, y: m.top + h - 6, class: 'skewt-readout' }, svg);
    var guide = svgEl('line', { x1: m.left, x2: m.left + w, class: 'skewt-guide', visibility: 'hidden' }, svg);
    svg.addEventListener('mousemove', (e) => {
        var box = svg.getBoundingClientRect();
        var py = (e.clientY - box.top) * H / box.height;
        var level = sorted.reduce((a, b) => (Math.abs(y(b[0]) - py) < Math.abs(y(a[0]) - py) ? b : a));
        guide.setAttribute('y1', y(level[0]));
        guide.setAttribute('y2', y(level[0]));
        guide.setAttribute('visibility', 'visible');
        readout.textContent = [
            `${formatPressure(level[0])} hPa`,
            level[1] !== null ? `${Math.round(level[1]).toLocaleString()} m` : null,
            level[2] !== null ? `T ${level[2].toFixed(1)}°` : null,
            level[3] !== null ? `Td ${level[3].toFixed(1)}°` : null,
            level[5] !== null ? `${level[5].toFixed(0)} m/s ${level[4] !== null ? level[4] + '°' : ''}` : null,
        ].filter(Boolean).join(' · ');
    });
    svg.addEventListener('mouseleave', () => {
        guide.setAttribute('visibility', 'hidden');
        readout.textContent = '';
    });

    container.replaceChildren(svg);
}

// The levels of a sounding with a wind, lowest first, each with a height: as reported,
// interpolated in log pressure between levels that report one, or else from the
// standard atmosphere
export function soundingWinds(profile) {
    var sorted = profile.slice().sort((a, b) => b[0] - a[0]);
    var known = sorted.filter((l) => l[1] !== null);
    var height = (l) => {
        if (l[1] !== null) return l[1];
        var below = known.filter((k) => k[0] > l[0]).pop(), above = known.find((k) => k[0] < l[0]);
        if (below && above) return below[1] + (above[1] - below[1]) * Math.log(below[0] / l[0]) / Math.log(below[0] / above[0]);
        return 44330 * (1 - Math.pow(l[0] / 1013.25, 0.1903));
    };
    return sorted.filter((l) => l[5] !== null).map((l) => ({ p: l[0], z: height(l), speed: l[5], dir: l[4] }));
}

// Winds up through a sounding: speed, and the direction they come from, against
// height, with barbs coloured by speed (as on the wind profiles) down the right
export function renderSoundingWind(container, profile, opts) {
    var W = opts.width, H = opts.height;
    var m = { top: 40, right: 6, bottom: 34, left: 40 };
    var w = W - m.left - m.right, h = H - m.top - m.bottom;
    var strip = 28, gap = 10, pw = (w - strip - gap * 2) / 2;
    var levels = soundingWinds(profile);
    var zMin = Math.min(0, ...levels.map((l) => l.z)), zMax = Math.max(...levels.map((l) => l.z));
    zMax += Math.max(200, (zMax - zMin) * 0.03);
    var y = (z) => m.top + h * (zMax - z) / (zMax - zMin);
    var vMax = Math.max(...levels.map((l) => l.speed));
    var vStep = [5, 10, 20, 25].find((s) => vMax / s <= 4) || 50;
    vMax = Math.max(vStep, Math.ceil(vMax * 1.05 / vStep) * vStep);
    var ax = m.left, bx = m.left + pw + gap;
    var xs = (v) => ax + pw * v / vMax;
    var xd = (d) => bx + pw * d / 360;
    var barbX = bx + pw + gap + strip / 2;

    var svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'skewt', role: 'img',
        'aria-label': 'Wind speed and direction against height' });
    svgEl('rect', { x: 0, y: 0, width: W, height: H, class: 'skewt-bg' }, svg);
    svgEl('text', { x: m.left + w / 2, y: 15, class: 'skewt-title', 'text-anchor': 'middle' }, svg).textContent = 'Winds';
    if (opts.time) {
        var stamp = opts.time.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
        svgEl('text', { x: m.left + w / 2, y: 30, class: 'skewt-title', 'text-anchor': 'middle' }, svg).textContent = stamp;
    }

    // Height lines across both panels, labelled in km
    var zStep = [500, 1000, 2000, 5000].find((s) => (zMax - zMin) / s <= 8) || 10000;
    for (var z = Math.ceil(zMin / zStep) * zStep; z <= zMax; z += zStep) {
        [ax, bx].forEach((x0) => svgEl('line', { x1: x0, x2: x0 + pw, y1: y(z), y2: y(z), class: 'skewt-isobar' }, svg));
        svgEl('text', { x: m.left - 6, y: y(z) + 3.5, class: 'skewt-label', 'text-anchor': 'end' }, svg).textContent = z / 1000;
    }
    svgEl('text', { x: 0, y: 0, class: 'skewt-axis', 'text-anchor': 'middle',
        transform: `translate(11 ${m.top + h / 2}) rotate(-90)` }, svg).textContent = 'Height (km)';
    var tick = (x, text) => {
        svgEl('line', { x1: x, x2: x, y1: m.top, y2: m.top + h, class: 'skewt-isobar' }, svg);
        svgEl('text', { x, y: m.top + h + 14, class: 'skewt-label', 'text-anchor': 'middle' }, svg).textContent = text;
    };
    for (var v = 0; v <= vMax; v += vStep) tick(xs(v), v);
    for (var d = 0; d <= 360; d += 90) tick(xd(d), d);
    svgEl('text', { x: ax + pw / 2, y: H - 4, class: 'skewt-axis', 'text-anchor': 'middle' }, svg).textContent = 'Speed (m/s)';
    svgEl('text', { x: bx + pw / 2, y: H - 4, class: 'skewt-axis', 'text-anchor': 'middle' }, svg).textContent = 'From (°)';
    svgEl('text', { x: barbX, y: H - 4, class: 'skewt-axis', 'text-anchor': 'middle' }, svg).textContent = 'kt';

    // Speed as a line; direction as dots, since it wraps from 360° to 0°
    svgEl('polyline', { points: levels.map((l) => `${xs(l.speed).toFixed(1)},${y(l.z).toFixed(1)}`).join(' '), class: 'sounding-speed' }, svg);
    levels.filter((l) => l.dir !== null).forEach((l) => svgEl('circle', { cx: xd(l.dir), cy: y(l.z), r: 1.8, class: 'sounding-dir' }, svg));
    [ax, bx].forEach((x0) => svgEl('rect', { x: x0, y: m.top, width: pw, height: h, class: 'skewt-frame' }, svg));

    // Barbs, thinned so they don't overlap
    var lastY = Infinity;
    for (var l of levels) {
        var cy = y(l.z);
        if (lastY - cy < 9) continue;
        if (drawBarb(svg, barbX, cy, l.speed, l.dir, 13)) lastY = cy;
    }

    // Hover readout
    var readout = svgEl('text', { x: m.left + 4, y: m.top + h - 6, class: 'skewt-readout' }, svg);
    var guide = svgEl('line', { x1: m.left, x2: m.left + w, class: 'skewt-guide', visibility: 'hidden' }, svg);
    svg.addEventListener('mousemove', (e) => {
        var box = svg.getBoundingClientRect();
        var py = (e.clientY - box.top) * H / box.height;
        var level = levels.reduce((a, b) => (Math.abs(y(b.z) - py) < Math.abs(y(a.z) - py) ? b : a));
        guide.setAttribute('y1', y(level.z));
        guide.setAttribute('y2', y(level.z));
        guide.setAttribute('visibility', 'visible');
        readout.textContent = [`${(level.z / 1000).toFixed(2)} km`, `${formatPressure(level.p)} hPa`,
            `${level.speed.toFixed(0)} m/s (${Math.round(level.speed * KNOTS)} kt)`,
            level.dir !== null ? `from ${Math.round(level.dir)}°` : null].filter(Boolean).join(' · ');
    });
    svg.addEventListener('mouseleave', () => {
        guide.setAttribute('visibility', 'hidden');
        readout.textContent = '';
    });

    container.replaceChildren(svg);
}

// The Skew-T with the winds beside it, when the sounding has winds to show; they
// wrap one above the other where there isn't room (as in a popup)
export function showSoundingCharts(container, profile, opts) {
    container.innerHTML = '<div class="sounding-pair"><div></div><div></div></div>';
    var [skewT, wind] = container.querySelectorAll('.sounding-pair > div');
    renderSkewT(skewT, profile, opts);
    if (soundingWinds(profile).length >= 2) renderSoundingWind(wind, profile, opts);
    else wind.remove();
}

// Launch time from the report's year/month/day/hour/minute, or null
export function soundingTime(values) {
    var time = [4001, 4002, 4003, 4004, 4005].map((id) => values.get(id) && values.get(id)[0]);
    return time[0] ? new Date(Date.UTC(time[0], time[1] - 1, time[2], time[3] || 0, time[4] || 0)) : null;
}

// Larger view in a dialog, with a table of the standard levels
export function openSounding(profile, label, values) {
    var dialog = document.querySelector('.sounding-dialog');
    if (!dialog) {
        dialog = document.createElement('dialog');
        dialog.className = 'sounding-dialog';
        dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
        document.body.appendChild(dialog);
    }
    var nearest = (p) => profile.reduce((a, b) => (Math.abs(b[0] - p) < Math.abs(a[0] - p) ? b : a));
    var rows = STANDARD_LEVELS
        .map((p) => nearest(p))
        .filter((l, i, all) => Math.abs(l[0] - STANDARD_LEVELS[i]) / STANDARD_LEVELS[i] < 0.03 && all.indexOf(l) === i);
    var cell = (v, digits) => (v === null || v === undefined ? '–' : Number(v).toFixed(digits));
    var launched = soundingTime(values);

    dialog.innerHTML = `
        <div class="sounding-head">
            <div>
                <strong></strong>
                <div class="pp-status">${launched ? `Launched ${esc(launched.toUTCString().replace(':00 GMT', ' UTC'))} · ` : ''}${profile.length.toLocaleString()} levels</div>
            </div>
            <button type="button" class="btn-close" aria-label="Close"></button>
        </div>
        <div class="sounding-body">
            <div class="sounding-chart"></div>
            ${rows.length ? `
            <table class="table table-sm sounding-table">
                <thead><tr><th>hPa</th><th>Height m</th><th>T °C</th><th>Td °C</th><th>Wind</th></tr></thead>
                <tbody>${rows.map((l) => `
                    <tr><td>${formatPressure(l[0])}</td><td>${cell(l[1], 0)}</td><td>${cell(l[2], 1)}</td><td>${cell(l[3], 1)}</td>
                    <td>${l[5] === null ? '–' : `${cell(l[5], 0)} m/s${l[4] === null ? '' : ` ${l[4]}°`}`}</td></tr>`).join('')}
                </tbody>
            </table>` : ''}
        </div>`;
    dialog.querySelector('strong').textContent = label;
    dialog.querySelector('.btn-close').addEventListener('click', () => dialog.close());
    // Two charts abreast where the window allows, else each the full width
    var room = window.innerWidth - 48;
    var width = room >= 700 ? Math.min(440, (room - 16) / 2) : Math.min(480, room);
    showSoundingCharts(dialog.querySelector('.sounding-chart'), profile, { width: width, height: Math.round(width * 1.3), time: launched });
    dialog.showModal();
}
