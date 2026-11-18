// Ocean profiles: Argo floats (BGC floats too), XBT and CTD casts, gliders and
// moorings. The decoder gives one entry per level (see _ocean in decoder.js):
// [pressure dbar or depth m, temperature °C, salinity, part, temperature flag,
//  salinity flag, { descriptor: [value, flag] }]. Shown as temperature and salinity
// against depth, each biogeochemical variable beside them, and a T–S diagram.
import { svgEl, esc } from '../../lib/util.js';

// GTSPP quality flags (033050): 3 probably bad, 4 bad. 8 (interpolated) and the rest are kept
const isBad = (flag) => flag === 3 || flag === 4;

// Depths are drawn on a square-root scale, so the top few hundred metres (where the
// mixed layer and thermocline are) aren't squeezed against the surface of a 2000 m profile
const DEPTH_TICKS = [0, 10, 25, 50, 100, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 4000, 6000];

// Colours and labels for the biogeochemical variables BGC floats carry; others get grey
const EXTRAS = {
    22188: { label: 'Oxygen', colour: '#1c9bb5' },
    41003: { label: 'Nitrate', colour: '#7b3fa0' },
    41004: { label: 'Chlorophyll-a', colour: '#2e8b2e' },
    41007: { label: 'Backscatter (700 nm)', colour: '#9a6324' },
};
const OCEANOPS = 'https://www.ocean-ops.org/board/wa/Platform?ref=';

// Good values of one variable along one part, shallowest first.
// get(level) gives [value, flag], or null where the level has none
function series(levels, part, get) {
    var out = [];
    for (var l of levels) {
        if (part !== null && l[3] !== part) continue;
        var vf = get(l);
        if (vf && typeof vf[0] === 'number') out.push({ z: l[0], v: vf[0], bad: isBad(vf[1]) });
    }
    return out.sort((a, b) => a.z - b.z);
}
const temperatureOf = (l) => (l[1] === null ? null : [l[1], l[4]]);
const salinityOf = (l) => (l[2] === null ? null : [l[2], l[5]]);
const extraOf = (id) => (l) => (l[6] && l[6][id]) || null;

// The profile's parts, the main one (most temperature levels) first
function partsOf(ocean) {
    var counts = new Map();
    for (var l of ocean.levels) if (l[1] !== null) counts.set(l[3], (counts.get(l[3]) || 0) + 1);
    return [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a));
}

// The extras the profile has, in the order of EXTRAS, then any others
function extrasOf(ocean) {
    var ids = Object.keys(ocean.extras || {});
    return ids.sort((a, b) => (EXTRAS[a] ? Object.keys(EXTRAS).indexOf(a) : 99) - (EXTRAS[b] ? Object.keys(EXTRAS).indexOf(b) : 99))
        .map((id) => ({ id, label: (EXTRAS[id] && EXTRAS[id].label) || titleCase(ocean.extras[id][0]),
            unit: prettyUnit(ocean.extras[id][1]), colour: (EXTRAS[id] && EXTRAS[id].colour) || '#6c757d' }));
}

// BUFR's units as usually written: umol kg-1 to µmol/kg, mg m-3 to mg/m³, m-1 to /m
function prettyUnit(unit) {
    return String(unit || '').replace(/^umol/, 'µmol').replace(/ ?kg-1$/, '/kg').replace(/ ?m-3$/, '/m³').replace(/^m-1$/, '/m');
}

function titleCase(name) {
    var s = String(name).toLowerCase();
    return s.charAt(0).toUpperCase() + s.slice(1);
}

// Mixed layer depth: the shallowest level below the 10 dbar reference where temperature
// is 0.2 °C away from it (de Boyer Montégut et al., 2004). Null if the profile doesn't
// start near the surface or never leaves the mixed layer
export function mixedLayerDepth(points) {
    var good = points.filter((p) => !p.bad);
    var ref = good.find((p) => p.z >= 10);
    if (!ref || ref.z > 20 || good[0].z > 15) return null;
    var below = good.find((p) => p.z > ref.z && Math.abs(p.v - ref.v) > 0.2);
    return below ? below.z : null;
}

// Density anomaly σt (kg/m³ − 1000) at the surface from salinity and temperature,
// by the UNESCO 1981 (EOS-80) one-atmosphere equation of state
export function sigmaT(s, t) {
    var rw = 999.842594 + 6.793952e-2 * t - 9.09529e-3 * t ** 2 + 1.001685e-4 * t ** 3 - 1.120083e-6 * t ** 4 + 6.536332e-9 * t ** 5;
    var a = 0.824493 - 4.0899e-3 * t + 7.6438e-5 * t ** 2 - 8.2467e-7 * t ** 3 + 5.3875e-9 * t ** 4;
    var b = -5.72466e-3 + 1.0227e-4 * t - 1.6546e-6 * t ** 2;
    return rw + a * s + b * s ** 1.5 + 4.8314e-4 * s ** 2 - 1000;
}

// Headline tiles: the float, its cycle, how deep it went, the surface water and mixed
// layer. values: the report's first value per descriptor (Map id -> [value, unit])
export function oceanTiles(ocean, values) {
    var tile = (label, html) => `<div class="pp-tile"><div>${esc(label)}</div><strong>${html}</strong></div>`;
    var get = (id) => (values.has(id) ? values.get(id)[0] : null);
    var tiles = [];
    var platform = get(1087);
    if (platform !== null) {
        tiles.push(tile('Float', `<a href="${OCEANOPS}${encodeURIComponent(platform)}" target="_blank" rel="noopener"
            title="This platform in OceanOPS">${esc(String(platform))}</a>${get(1085) ? ` <small>${esc(String(get(1085)).trim())}</small>` : ''}`));
    }
    var cycle = get(22055), direction = get(22056);
    if (cycle !== null) tiles.push(tile('Cycle', `${esc(String(cycle))}${direction === 0 ? ' <small>ascending</small>' : direction === 1 ? ' <small>descending</small>' : ''}`));
    var main = partsOf(ocean)[0] ?? 0;
    var t = series(ocean.levels, main, temperatureOf), s = series(ocean.levels, main, salinityOf);
    var deepest = Math.max(...ocean.levels.map((l) => l[0]));
    tiles.push(tile('Deepest', `${Math.round(deepest).toLocaleString()} ${ocean.unit}`
        + ` <small>${ocean.levels.length.toLocaleString()} levels</small>`));
    var top = (points) => points.find((p) => !p.bad);
    if (top(t)) tiles.push(tile('Near-surface', `${top(t).v.toFixed(2)} °C${top(s) ? ` · ${top(s).v.toFixed(2)} psu` : ''}`
        + ` <small>at ${top(t).z} ${ocean.unit}</small>`));
    var mld = mixedLayerDepth(t);
    if (mld !== null) tiles.push(tile('Mixed layer', `${Math.round(mld)} ${ocean.unit} <small>0.2 °C below 10 ${ocean.unit}</small>`));
    var bad = ocean.levels.filter((l) => isBad(l[4]) || isBad(l[5])).length;
    if (bad) tiles.push(tile('Flagged bad', `${bad.toLocaleString()} level${bad === 1 ? '' : 's'} <small>not drawn as data</small>`));
    var extras = extrasOf(ocean);
    if (extras.length) tiles.push(tile('Biogeochemical', esc(extras.map((x) => x.label).join(', '))));
    return tiles;
}

// Temperature, salinity and each biogeochemical variable against depth, side by side
// on one depth axis, as many abreast as the width has room for (at least PANEL_MIN_W
// each, or opts.perRow) and the rest in further charts below. opts.only: 'physical'
// (temperature and salinity) or 'bgc' (the rest). A hover line reads off every panel.
// Returns whether anything was drawn
const PANEL_MIN_W = 110;
export function renderOceanProfile(container, ocean, opts) {
    var parts = partsOf(ocean);
    var panels = [
        { label: 'Temperature', unit: '°C', colour: '#e41a1c', get: temperatureOf },
        { label: 'Salinity', unit: 'psu', colour: '#1f4fb4', get: salinityOf },
        ...extrasOf(ocean).map((x) => ({ label: x.label, unit: x.unit, colour: x.colour, get: extraOf(x.id), extra: true })),
    ].filter((p) => !opts.only || (opts.only === 'bgc') === !!p.extra)
        .map((p) => ({ ...p, lines: (p.extra ? [null] : parts).map((part) => ({ part, points: series(ocean.levels, part, p.get) })) }))
        .filter((p) => p.lines.some((l) => l.points.length));
    if (!panels.length) {
        container.replaceChildren();
        return false;
    }
    var perRow = opts.perRow || Math.max(1, Math.floor((opts.width - 48) / PANEL_MIN_W));
    var charts = [];
    for (var i = 0; i < panels.length; i += perRow) {
        charts.push(profileChart(ocean, panels.slice(i, i + perRow), parts[0] ?? 0, opts));
    }
    container.replaceChildren(...charts);
    return true;
}

// Whether the profile has biogeochemical values to draw
export function hasBgc(ocean) {
    return extrasOf(ocean).length > 0;
}

function profileChart(ocean, panels, main, opts) {
    var W = opts.width, H = opts.height;
    var m = { top: 30, right: 8, bottom: 8, left: 40 };
    var gap = 8;
    var pw = (W - m.left - m.right - gap * (panels.length - 1)) / panels.length;
    var zTop = Math.max(...ocean.levels.map((l) => l[0])) * 1.02 || 1;
    var y = (z) => m.top + (H - m.top - m.bottom) * Math.sqrt(Math.max(0, z) / zTop);

    var svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'ocean-chart', role: 'img',
        'aria-label': `${panels.map((p) => p.label.toLowerCase()).join(', ')} against ${ocean.unit === 'dbar' ? 'pressure' : 'depth'}` });
    svgEl('rect', { x: 0, y: 0, width: W, height: H, class: 'skewt-bg' }, svg);
    for (var d of DEPTH_TICKS) {
        if (d > zTop) break;
        svgEl('line', { x1: m.left, x2: W - m.right, y1: y(d), y2: y(d), class: 'skewt-isobar' }, svg);
        svgEl('text', { x: m.left - 4, y: y(d) + 3.5, class: 'skewt-label', 'text-anchor': 'end' }, svg).textContent = d;
    }
    svgEl('text', { x: 0, y: 0, class: 'skewt-label', 'text-anchor': 'middle',
        transform: `translate(9 ${(m.top + H - m.bottom) / 2}) rotate(-90)` }, svg).textContent = ocean.unit === 'dbar' ? 'Pressure (dbar)' : 'Depth (m)';

    panels.forEach((p, i) => {
        var x0 = m.left + i * (pw + gap);
        var all = p.lines.flatMap((l) => l.points.filter((q) => !q.bad).map((q) => q.v));
        if (!all.length) all = p.lines.flatMap((l) => l.points.map((q) => q.v));
        var lo = Math.min(...all), hi = Math.max(...all), pad = (hi - lo) * 0.06 || Math.abs(lo) * 0.05 || 1;
        p.lo = lo - pad;
        p.hi = hi + pad;
        p.x = (v) => x0 + pw * (v - p.lo) / (p.hi - p.lo);
        p.x0 = x0;
        // Its range across the top, in its colour
        svgEl('text', { x: x0 + pw / 2, y: 11, class: 'ocean-panel-label', 'text-anchor': 'middle', fill: p.colour }, svg).textContent = p.label;
        svgEl('text', { x: x0 + pw / 2, y: 23, class: 'skewt-label', 'text-anchor': 'middle' }, svg).textContent =
            `${niceNumber(lo)}–${niceNumber(hi)} ${p.unit}`;
        p.lines.forEach((line) => {
            var good = line.points.filter((q) => !q.bad);
            if (good.length > 1) {
                svgEl('polyline', { points: good.map((q) => `${p.x(q.v).toFixed(1)},${y(q.z).toFixed(1)}`).join(' '),
                    class: line.part === main || line.part === null ? 'ocean-line' : 'ocean-line ocean-line-other', stroke: p.colour }, svg);
            } else if (good.length === 1) {
                svgEl('circle', { cx: p.x(good[0].v), cy: y(good[0].z), r: 2, fill: p.colour }, svg);
            }
            // Flagged values still show where they were, as crosses, so a gap is explained
            for (var q of line.points.filter((r) => r.bad && r.v >= p.lo && r.v <= p.hi)) {
                var cx = p.x(q.v), cy = y(q.z);
                svgEl('path', { d: `M${cx - 2.5},${cy - 2.5}L${cx + 2.5},${cy + 2.5}M${cx - 2.5},${cy + 2.5}L${cx + 2.5},${cy - 2.5}`, class: 'ocean-bad' }, svg);
            }
        });
        svgEl('rect', { x: x0, y: m.top, width: pw, height: H - m.top - m.bottom, class: 'skewt-frame' }, svg);
    });

    // The mixed layer, across every panel
    var mld = mixedLayerDepth(series(ocean.levels, main, temperatureOf));
    if (mld !== null) {
        svgEl('line', { x1: m.left, x2: W - m.right, y1: y(mld), y2: y(mld), class: 'ocean-mld' }, svg);
        svgEl('text', { x: W - m.right - 3, y: y(mld) - 3, class: 'skewt-label', 'text-anchor': 'end' }, svg).textContent = 'Mixed layer';
    }

    // Hover: a line at the pointer's depth, and each panel's value there
    var guide = svgEl('line', { x1: m.left, x2: W - m.right, y1: 0, y2: 0, class: 'skewt-guide', visibility: 'hidden' }, svg);
    var depthLabel = svgEl('text', { x: m.left + 3, y: 0, class: 'skewt-readout' }, svg);
    var readouts = panels.map((p) => svgEl('text', { x: p.x0 + pw - 3, y: 0, class: 'skewt-readout', 'text-anchor': 'end' }, svg));
    svg.addEventListener('mousemove', (e) => {
        var box = svg.getBoundingClientRect();
        var py = (e.clientY - box.top) * H / box.height;
        if (py < m.top || py > H - m.bottom) return hide();
        var z = zTop * ((py - m.top) / (H - m.top - m.bottom)) ** 2;
        guide.setAttribute('y1', py);
        guide.setAttribute('y2', py);
        guide.setAttribute('visibility', 'visible');
        depthLabel.setAttribute('y', py - 3);
        depthLabel.textContent = `${Math.round(z)} ${ocean.unit}`;
        panels.forEach((p, i) => {
            var points = (p.lines.find((l) => l.part === main || l.part === null) || p.lines[0]).points.filter((q) => !q.bad);
            var near = points.length ? points.reduce((a, b) => (Math.abs(b.z - z) < Math.abs(a.z - z) ? b : a)) : null;
            readouts[i].setAttribute('y', py + 11);
            readouts[i].textContent = near && Math.abs(near.z - z) < Math.max(5, z * 0.05) ? niceNumber(near.v) : '';
        });
    });
    var hide = () => {
        guide.setAttribute('visibility', 'hidden');
        depthLabel.textContent = '';
        readouts.forEach((r) => { r.textContent = ''; });
    };
    svg.addEventListener('mouseleave', hide);
    return svg;
}

// Temperature against salinity, each level a dot coloured by depth (shallow light,
// deep dark), over lines of equal density (σt). Water masses show as the curve's bends
export function renderTSDiagram(container, ocean, opts) {
    var main = partsOf(ocean)[0] ?? 0;
    var points = ocean.levels.filter((l) => l[3] === main && l[1] !== null && l[2] !== null && !isBad(l[4]) && !isBad(l[5]))
        .map((l) => ({ z: l[0], t: l[1], s: l[2] }));
    if (points.length < 3) return false;
    var W = opts.width, H = opts.height;
    var m = { top: 10, right: 10, bottom: 30, left: 44 };
    var sLo = Math.min(...points.map((p) => p.s)), sHi = Math.max(...points.map((p) => p.s));
    var tLo = Math.min(...points.map((p) => p.t)), tHi = Math.max(...points.map((p) => p.t));
    var sPad = (sHi - sLo) * 0.08 || 0.1, tPad = (tHi - tLo) * 0.08 || 0.5;
    [sLo, sHi, tLo, tHi] = [sLo - sPad, sHi + sPad, tLo - tPad, tHi + tPad];
    var x = (s) => m.left + (W - m.left - m.right) * (s - sLo) / (sHi - sLo);
    var y = (t) => H - m.bottom - (H - m.top - m.bottom) * (t - tLo) / (tHi - tLo);

    var svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'ocean-chart', role: 'img',
        'aria-label': 'Temperature against salinity, coloured by depth, with lines of equal density' });
    svgEl('rect', { x: 0, y: 0, width: W, height: H, class: 'skewt-bg' }, svg);
    var clip = `ts-clip-${Math.random().toString(36).slice(2)}`;
    svgEl('rect', { x: m.left, y: m.top, width: W - m.left - m.right, height: H - m.top - m.bottom }, svgEl('clipPath', { id: clip }, svgEl('defs', {}, svg)));

    // σt contours: traced across the box by bisecting for t at each salinity
    var sigmas = [sigmaT(sLo, tHi), sigmaT(sHi, tHi), sigmaT(sLo, tLo), sigmaT(sHi, tLo)];
    var gLo = Math.min(...sigmas), gHi = Math.max(...sigmas);
    var step = [0.1, 0.2, 0.25, 0.5, 1, 2].find((st) => (gHi - gLo) / st <= 8) || 5;
    var contours = svgEl('g', { 'clip-path': `url(#${clip})` }, svg);
    for (var g = Math.ceil(gLo / step) * step; g <= gHi; g += step) {
        var line = [];
        for (var i = 0; i <= 40; i++) {
            var s = sLo + (sHi - sLo) * i / 40;
            var t = solveT(s, g, tLo - 5, tHi + 5);
            if (t !== null) line.push(`${x(s).toFixed(1)},${y(t).toFixed(1)}`);
        }
        if (line.length < 2) continue;
        svgEl('polyline', { points: line.join(' '), class: 'ocean-sigma' }, contours);
        var last = line[line.length - 1].split(',').map(Number);
        if (last[1] > m.top + 8 && last[1] < H - m.bottom - 2) {
            svgEl('text', { x: last[0] - 2, y: last[1] - 2, class: 'ocean-sigma-label', 'text-anchor': 'end' }, svg).textContent = niceNumber(g);
        }
    }

    // Dots, shallowest drawn last so the surface sits on top
    var zMax = Math.max(...points.map((p) => p.z)) || 1;
    for (var p of [...points].sort((a, b) => b.z - a.z)) {
        svgEl('circle', { cx: x(p.s).toFixed(1), cy: y(p.t).toFixed(1), r: 2.2, class: 'ocean-ts-dot',
            fill: depthColour(Math.sqrt(p.z / zMax)) }, svg);
    }

    // Axes
    var sTicks = niceTicks(sLo, sHi, 5), tTicks = niceTicks(tLo, tHi, 6);
    for (var tick of sTicks) {
        svgEl('line', { x1: x(tick), x2: x(tick), y1: H - m.bottom, y2: H - m.bottom + 4, class: 'skewt-tick' }, svg);
        svgEl('text', { x: x(tick), y: H - m.bottom + 14, class: 'skewt-label', 'text-anchor': 'middle' }, svg).textContent = tickLabel(tick, sTicks);
    }
    for (var tt of tTicks) {
        svgEl('line', { x1: m.left - 4, x2: m.left, y1: y(tt), y2: y(tt), class: 'skewt-tick' }, svg);
        svgEl('text', { x: m.left - 6, y: y(tt) + 3.5, class: 'skewt-label', 'text-anchor': 'end' }, svg).textContent = tickLabel(tt, tTicks);
    }
    svgEl('text', { x: (m.left + W - m.right) / 2, y: H - 3, class: 'skewt-axis', 'text-anchor': 'middle' }, svg).textContent = 'Salinity (psu) · lines of σt, kg/m³';
    svgEl('text', { x: 0, y: 0, class: 'skewt-axis', 'text-anchor': 'middle',
        transform: `translate(10 ${(m.top + H - m.bottom) / 2}) rotate(-90)` }, svg).textContent = 'Temperature (°C)';
    svgEl('rect', { x: m.left, y: m.top, width: W - m.left - m.right, height: H - m.top - m.bottom, class: 'skewt-frame' }, svg);

    // Hover: the nearest level's depth, temperature, salinity and density
    var readout = svgEl('text', { x: W - m.right - 4, y: m.top + 12, class: 'skewt-readout', 'text-anchor': 'end' }, svg);
    svg.addEventListener('mousemove', (e) => {
        var box = svg.getBoundingClientRect();
        var px = (e.clientX - box.left) * W / box.width, py = (e.clientY - box.top) * H / box.height;
        var near = points.reduce((a, b) => (Math.hypot(x(b.s) - px, y(b.t) - py) < Math.hypot(x(a.s) - px, y(a.t) - py) ? b : a));
        readout.textContent = Math.hypot(x(near.s) - px, y(near.t) - py) < 20
            ? `${Math.round(near.z)} ${ocean.unit} · ${near.t.toFixed(2)} °C · ${near.s.toFixed(3)} psu · σt ${sigmaT(near.s, near.t).toFixed(2)}` : '';
    });
    svg.addEventListener('mouseleave', () => { readout.textContent = ''; });
    container.replaceChildren(svg);
    return true;
}

// The temperature at which water of salinity s has density anomaly sigma, by bisection
// (density falls as temperature rises over the ocean's range). Null if outside lo..hi
function solveT(s, sigma, lo, hi) {
    if ((sigmaT(s, lo) - sigma) * (sigmaT(s, hi) - sigma) > 0) return null;
    for (var i = 0; i < 40; i++) {
        var mid = (lo + hi) / 2;
        if (sigmaT(s, mid) > sigma) lo = mid;
        else hi = mid;
    }
    return (lo + hi) / 2;
}

// Shallow (0) pale yellow to deep (1) dark blue
function depthColour(f) {
    var stops = [[255, 237, 160], [65, 182, 196], [37, 52, 148], [8, 29, 88]];
    var i = Math.min(stops.length - 2, Math.floor(f * (stops.length - 1))), r = f * (stops.length - 1) - i;
    return `rgb(${stops[i].map((c, k) => Math.round(c + (stops[i + 1][k] - c) * r)).join(',')})`;
}

function niceTicks(lo, hi, count) {
    var raw = (hi - lo) / count, mag = 10 ** Math.floor(Math.log10(raw));
    var step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((k) => k >= raw);
    var out = [];
    for (var v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Number(v.toFixed(10)));
    return out;
}

// A tick's label with as many decimals as the step between ticks needs (7, 7.5, 34.25)
function tickLabel(v, ticks) {
    var step = ticks.length > 1 ? ticks[1] - ticks[0] : 1;
    var decimals = Math.max(0, Math.min(3, Math.ceil(-Math.log10(step) + 1e-9)));
    if (decimals && Number((step * 10 ** decimals).toFixed(6)) % 1) decimals++;
    return v.toFixed(decimals);
}

function niceNumber(v) {
    var a = Math.abs(v);
    return a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : a >= 1 ? v.toFixed(2) : a >= 0.01 ? v.toFixed(3) : v.toPrecision(2);
}

// The profile at standard depths, nearest level to each (within 5%), for the table
// in the expanded view
const TABLE_DEPTHS = [0, 5, 10, 20, 30, 50, 75, 100, 150, 200, 300, 400, 500, 700, 1000, 1500, 2000];
export function oceanTable(ocean) {
    var main = partsOf(ocean)[0] ?? 0;
    var levels = ocean.levels.filter((l) => l[3] === main);
    var extras = extrasOf(ocean);
    var nearestWith = (z, get) => {
        var best = null;
        for (var l of ocean.levels) {
            var vf = get(l);
            if (!vf || isBad(vf[1])) continue;
            if (!best || Math.abs(l[0] - z) < Math.abs(best[0] - z)) best = [l[0], vf[0]];
        }
        return best && Math.abs(best[0] - z) <= Math.max(2, z * 0.05) ? best[1] : null;
    };
    var rows = TABLE_DEPTHS.filter((z) => levels.some((l) => Math.abs(l[0] - z) <= Math.max(2, z * 0.05)))
        .map((z) => [z, nearestWith(z, temperatureOf), nearestWith(z, salinityOf), ...extras.map((x) => nearestWith(z, extraOf(x.id)))]);
    var cell = (v) => (v === null ? '–' : niceNumber(v));
    return `<table class="table table-sm sounding-table">
        <thead><tr><th>${ocean.unit}</th><th>T °C</th><th>S psu</th><th>σt</th>${extras.map((x) => `<th>${esc(x.label)} <small>${esc(x.unit)}</small></th>`).join('')}</tr></thead>
        <tbody>${rows.map(([z, t, s, ...xs]) => `
            <tr><td>${z}</td><td>${cell(t)}</td><td>${cell(s)}</td><td>${t !== null && s !== null ? sigmaT(s, t).toFixed(2) : '–'}</td>${xs.map((v) => `<td>${cell(v)}</td>`).join('')}</tr>`).join('')}
        </tbody>
    </table>`;
}

// The expanded view: everything measured against depth (temperature, salinity and
// each biogeochemical variable) in one row on one depth axis, so a feature lines up
// across all of them; the T–S diagram beside it where there's room, else below; then
// the table at standard depths
const EXPANDED_PANEL_MIN_W = 120;
const TS_W = 440;
export function openOceanProfile(ocean, label, subtitle) {
    var dialog = document.querySelector('.sounding-dialog');
    if (!dialog) {
        dialog = document.createElement('dialog');
        dialog.className = 'sounding-dialog';
        dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
        document.body.appendChild(dialog);
    }
    dialog.innerHTML = `
        <div class="sounding-head">
            <div>
                <strong></strong>
                <div class="pp-status"></div>
            </div>
            <button type="button" class="btn-close" aria-label="Close"></button>
        </div>
        <div class="ocean-expanded">
            <section>
                <div class="pp-section">With ${ocean.unit === 'dbar' ? 'pressure' : 'depth'}</div>
                <div class="ocean-big-profile"></div>
            </section>
            <section>
                <div class="pp-section">T–S diagram</div>
                <div class="ocean-big-ts"></div>
            </section>
            <section class="ocean-wide">
                <div class="pp-section">At standard ${ocean.unit === 'dbar' ? 'pressures' : 'depths'}</div>
                ${oceanTable(ocean)}
            </section>
        </div>`;
    dialog.querySelector('strong').textContent = label;
    dialog.querySelector('.pp-status').textContent = subtitle;
    dialog.querySelector('.btn-close').addEventListener('click', () => dialog.close());
    var room = Math.min(window.innerWidth - 48, 1360);
    var panels = 2 + extrasOf(ocean).length;
    var gap = 20;
    // Beside the T–S diagram if every panel still gets its minimum width there; else the
    // profile takes the whole width, and wraps only if even that is too narrow
    var beside = room - TS_W - gap - 48 >= panels * EXPANDED_PANEL_MIN_W;
    var profileW = beside ? room - TS_W - gap : room;
    var perRow = Math.max(1, Math.min(panels, Math.floor((profileW - 48) / EXPANDED_PANEL_MIN_W)));
    var height = Math.round(Math.min(560, window.innerHeight * 0.62));
    renderOceanProfile(dialog.querySelector('.ocean-big-profile'), ocean, { width: profileW, height, perRow });
    var tsW = beside ? TS_W : Math.min(560, room);
    if (!renderTSDiagram(dialog.querySelector('.ocean-big-ts'), ocean, { width: tsW, height: beside ? height : Math.round(tsW * 0.8) })) {
        dialog.querySelector('.ocean-big-ts').closest('section').remove();
    }
    dialog.querySelector('.ocean-expanded').classList.toggle('ocean-stacked', !beside);
    dialog.showModal();
}
