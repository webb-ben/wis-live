// Wave spectra from buoy and ship reports (022080 bands, 022069 energy, and
// their directions), drawn as a polar plot for the info panel and small for
// the map, and the sea-state compass for reports without one
import { svgEl } from '../lib/util.js';

// Directional wave spectrum: one entry per frequency band with its energy
// density (022069) and the direction the waves come from, from the first-order
// directional Fourier coefficients (042011 a1, 042012 b1), or each band's mean
// direction (022086). Returns null when the report has no spectrum.
export function waveSpectrum(rows) {
    var bands = [], band = null;
    for (var [id, , value] of rows) {
        if (id === 22080) bands.push(band = { f: value, e: null, a1: null, b1: null, mean: null, r1: null });
        else if (!band) continue;
        else if (id === 22069) band.e = value;
        // Template 3 06 039 gives each band's mean direction and its first
        // normalised polar coordinate (how tightly the waves keep to it) straight out
        else if (id === 22086) band.mean = value;
        else if (id === 22088 && value >= 0 && value <= 1) band.r1 = value;
        else if (id === 42011) band.a1 = value;
        else if (id === 42012) band.b1 = value;
    }
    bands = bands.filter((b) => b.f > 0 && b.e !== null);
    if (bands.length < 3) return null;
    for (var b of bands) {
        b.dir = b.mean !== null ? b.mean % 360
            : b.a1 !== null && b.b1 !== null && (b.a1 || b.b1) ? (Math.atan2(b.b1, b.a1) * 180 / Math.PI + 360) % 360 : null;
        // Normalised a1, b1 give r1 as their length; unnormalised ones don't
        if (b.r1 === null && b.mean === null && b.dir !== null && Math.hypot(b.a1, b.b1) <= 1) b.r1 = Math.hypot(b.a1, b.b1);
    }
    var peak = bands.reduce((a, b) => (b.e > a.e ? b : a));
    return { bands, peak: peak.e > 0 ? peak : null };
}

// Wave energy in polar form, as buoy spectra are usually drawn: the angle is
// the direction the waves come from (north up), the distance from the centre
// their frequency (long swell in the middle), and the colour the energy, on a
// log scale over two decades down from the peak. Each band's energy is spread
// around its mean direction by a wrapped normal as wide as its directional
// spread (from r1: 022088, or the length of a1, b1 when that is at most 1);
// a band without one is drawn ±30°. A buoy that sends no directions (most)
// gets each band as a full ring, and a note says so.
const WAVESPEC_COLORS = ['#4c6edb', '#58b4e8', '#5ccf9f', '#c5e15a', '#f6b23a', '#e2412b'];
const WAVESPEC_DECADES = 2;  // three coloured nearly the whole disc
const WAVESPEC_SCALE = 2;  // canvas pixels per SVG unit

function wavespecRgb(t) {
    var s = Math.max(0, Math.min(1, t)) * (WAVESPEC_COLORS.length - 1);
    var i = Math.min(WAVESPEC_COLORS.length - 2, Math.floor(s)), k = s - i;
    var [a, b] = [WAVESPEC_COLORS[i], WAVESPEC_COLORS[i + 1]].map((h) => [1, 3, 5].map((j) => parseInt(h.slice(j, j + 2), 16)));
    return a.map((v, j) => Math.round(v + (b[j] - v) * k));
}

// Whether two neighbouring bands agree well enough to blend between: both
// with directions within WAVESPEC_JOIN_DEG of each other (or neither with
// one), and no wider apart than the buoy's usual band spacing, so a missing
// band isn't bridged. A band with no energy joins anything (energy fades to it).
const WAVESPEC_JOIN_DEG = 30;

function wavespecJoins(bands) {
    var gaps = bands.slice(1).map((b, i) => b.f - bands[i].f).sort((x, y) => x - y);
    var usual = gaps[Math.floor(gaps.length / 2)] || 0;
    bands.forEach((a, i) => {
        var b = bands[i + 1];
        if (!b) return void (a.joinNext = false);
        var da = a.e > 0 ? a.dir : null, db = b.e > 0 ? b.dir : null;
        var agree = !(a.e > 0) || !(b.e > 0) || (da === null && db === null)
            || (da !== null && db !== null && Math.abs(((db - da + 540) % 360) - 180) <= WAVESPEC_JOIN_DEG);
        a.joinNext = agree && b.f - a.f <= usual * 1.6;
    });
}

// Energy per degree at a frequency and bearing. Between bands that agree
// (see wavespecJoins) energy, direction and spread blend smoothly; between
// bands that don't, each keeps its own up to halfway, so a break shows as one
function wavespecDensity(bands, f, deg) {
    var first = bands[0], last = bands[bands.length - 1];
    if (f < first.lo || f > last.hi) return 0;
    var i = bands.findIndex((b) => b.f > f);
    var a = i <= 0 ? (i === 0 ? first : last) : bands[i - 1], b = i <= 0 ? a : bands[i];
    var k = a === b ? 0 : (f - a.f) / (b.f - a.f);
    if (a !== b && !a.joinNext) k = k < 0.5 ? 0 : 1;
    var e = a.e + (b.e - a.e) * k;
    if (!(e > 0)) return 0;
    var da = a.e > 0 ? a.dir : null, db = b.e > 0 ? b.dir : null;
    if (da === null && db === null) return e / 360;
    if (da === null) da = db;
    if (db === null) db = da;
    var dir = da + (((db - da + 540) % 360) - 180) * k;
    var sigma = a.sigma + (b.sigma - a.sigma) * k;
    var delta = ((deg - dir + 540) % 360) - 180;
    return e * Math.exp(-delta * delta / (2 * sigma * sigma)) / (sigma * Math.sqrt(2 * Math.PI));
}

// Lays the bands out (each spans halfway to its neighbours), with their spreads
// and which neighbours blend; returns the frequency at the disc's rim
function wavespecPrepare(bands) {
    bands.forEach((b, i) => {
        b.lo = Math.max(0, i ? (bands[i - 1].f + b.f) / 2 : b.f - (bands[1].f - b.f) / 2);
        b.hi = i < bands.length - 1 ? (b.f + bands[i + 1].f) / 2 : b.f + (b.f - bands[i - 1].f) / 2;
        b.sigma = Math.max(8, Math.min(80, b.r1 !== null ? Math.sqrt(2 * (1 - b.r1)) * 180 / Math.PI : 30));
    });
    wavespecJoins(bands);
    return Math.ceil(Math.max(...bands.map((b) => b.hi)) * 10 - 1e-9) / 10;
}

// The field on a pixel grid over a disc of radius R (scale pixels a unit), in
// continuous colour on a clear canvas; below the scale's floor it's left clear,
// fading out over its lowest tenth. vMax: the energy per degree at full colour.
function wavespecCanvas(bands, fMax, R, scale) {
    var N = Math.round(2 * R * scale);
    var values = new Float32Array(N * N);
    var vMax = 0;
    for (var py = 0; py < N; py++) {
        for (var px = 0; px < N; px++) {
            var dx = (px + 0.5) / scale - R, dy = (py + 0.5) / scale - R;
            var r = Math.hypot(dx, dy);
            if (r > R) continue;
            var v = wavespecDensity(bands, r / R * fMax, (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360);
            values[py * N + px] = v;
            if (v > vMax) vMax = v;
        }
    }
    vMax = vMax || 1;
    var canvas = document.createElement('canvas');
    canvas.width = canvas.height = N;
    var ctx = canvas.getContext('2d');
    var image = ctx.createImageData(N, N);
    for (var i = 0; i < values.length; i++) {
        if (!(values[i] > 0)) continue;
        var t = 1 + Math.log10(values[i] / vMax) / WAVESPEC_DECADES;
        if (t <= 0) continue;
        image.data.set([...wavespecRgb(t), Math.round(255 * Math.min(1, t * 10))], i * 4);
    }
    ctx.putImageData(image, 0, 0);
    return { canvas, vMax };
}

// The map's symbol for a report styled by wave spectrum: the same field, small,
// on a pale disc with a rim and a tick at north (the symbol turns with the map)
const WAVESPEC_MINI_PX = 44;

export function miniWaveSpectrum(spectrum) {
    var fMax = wavespecPrepare(spectrum.bands);
    var R = WAVESPEC_MINI_PX / 2;
    var { canvas } = wavespecCanvas(spectrum.bands, fMax, R, 2);
    var N = canvas.width;
    var out = document.createElement('canvas');
    out.width = out.height = N;
    var ctx = out.getContext('2d');
    ctx.beginPath();
    ctx.arc(N / 2, N / 2, N / 2 - 1.5, 0, 2 * Math.PI);
    ctx.fillStyle = 'rgba(248, 249, 250, 0.85)';
    ctx.fill();
    ctx.drawImage(canvas, 0, 0);
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(73, 80, 87, 0.85)';
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(N / 2, 1);
    ctx.lineTo(N / 2, 9);
    ctx.stroke();
    return ctx.getImageData(0, 0, N, N);
}

// opts: width, and the wind and wave directions (from) and ship's heading to
// draw on top, as the compass would
export function renderWaveSpectrum(container, spectrum, opts) {
    var bands = spectrum.bands;
    var hasDir = bands.some((b) => b.dir !== null && b.e > 0);
    var W = opts.width, R = Math.round(W * 0.34);
    var cx = W / 2, cy = 24 + R;
    var barY = cy + R + 28, H = barY + 40;
    var fMax = wavespecPrepare(bands);
    var rf = (f) => R * Math.min(f, fMax) / fMax;
    // Compass bearing (clockwise from north) and radius to the screen
    var at = (deg, r) => [cx + r * Math.sin(deg * Math.PI / 180), cy - r * Math.cos(deg * Math.PI / 180)];
    var { canvas, vMax } = wavespecCanvas(bands, fMax, R, WAVESPEC_SCALE);

    var svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'wavespec', role: 'img',
        'aria-label': hasDir ? 'Wave energy by direction and frequency' : 'Wave energy by frequency, as rings' });
    svgEl('rect', { x: 0, y: 0, width: W, height: H, class: 'skewt-bg' }, svg);
    svgEl('circle', { cx, cy, r: R, class: 'wavespec-disc' }, svg);
    svgEl('image', { x: cx - R, y: cy - R, width: 2 * R, height: 2 * R, href: canvas.toDataURL() }, svg);

    // Grid on top: frequency rings every 0.1 Hz, spokes every 45°
    for (var f = 0.1; f <= fMax + 1e-9; f += 0.1) {
        svgEl('circle', { cx, cy, r: rf(f), class: 'wavespec-grid' }, svg);
        var [lx, ly] = at(112.5, rf(f));
        svgEl('text', { x: lx + 2, y: ly + 3, class: 'wavespec-ring-label' }, svg).textContent = `${Number(f.toFixed(1))}`;
    }
    for (var d = 0; d < 360; d += 45) {
        var [x1, y1] = at(d, 0), [x2, y2] = at(d, R);
        svgEl('line', { x1, y1, x2, y2, class: 'wavespec-grid' }, svg);
    }
    svgEl('circle', { cx, cy, r: R, class: 'wavespec-edge' }, svg);
    ['N', 'E', 'S', 'W'].forEach((name, i) => {
        var [x, y] = at(i * 90, R + 11);
        svgEl('text', { x, y: y + 4, class: 'skewt-axis', 'text-anchor': 'middle' }, svg).textContent = name;
    });
    var [hx, hy] = at(112.5, R + 4);
    svgEl('text', { x: hx + 2, y: hy + 10, class: 'wavespec-ring-label' }, svg).textContent = 'Hz';

    // The compass's arrows on top, as it draws them: wind and waves from the rim
    // in toward the middle (where they come from), the ship's heading out from it
    var arrow = (deg, from, to, cls) => {
        var [x1, y1] = at(deg, from), [x2, y2] = at(deg, to);
        var a = Math.atan2(y2 - y1, x2 - x1);
        var head = [a + 2.6, a - 2.6].map((b) => `${(x2 + 9 * Math.cos(b)).toFixed(1)},${(y2 + 9 * Math.sin(b)).toFixed(1)}`).join(' ');
        var g = svgEl('g', { class: `wavespec-arrow ${cls}` }, svg);
        svgEl('line', { x1, y1, x2, y2, class: 'wavespec-halo' }, g);
        svgEl('polygon', { points: `${x2.toFixed(1)},${y2.toFixed(1)} ${head}`, class: 'wavespec-halo' }, g);
        svgEl('line', { x1, y1, x2, y2 }, g);
        svgEl('polygon', { points: `${x2.toFixed(1)},${y2.toFixed(1)} ${head}` }, g);
    };
    var waves = opts.waves || [];
    waves.forEach((d) => arrow(d, R, R * 0.45, 'pp-compass-swell'));
    if (opts.wind !== undefined) arrow(opts.wind, R, R * 0.45, 'pp-compass-wind');
    if (opts.heading !== undefined) arrow(opts.heading, 0, R * 0.4, 'pp-compass-ship');

    // Colour bar: peak (red) on the left down to the faintest drawn (blue)
    var defs = svgEl('defs', {}, svg);
    var grad = svgEl('linearGradient', { id: 'wavespec-scale' }, defs);
    WAVESPEC_COLORS.slice().reverse().forEach((color, i) => svgEl('stop', { offset: i / (WAVESPEC_COLORS.length - 1), 'stop-color': color }, grad));
    var barW = W - 80, barX = 40;
    svgEl('rect', { x: barX, y: barY, width: barW, height: 8, fill: 'url(#wavespec-scale)' }, svg);
    var unit = hasDir ? 'm²/Hz/°' : 'm²/Hz';
    var num = (v) => (v >= 0.01 ? Number(v.toPrecision(2)) : v.toExponential(0));
    var span = hasDir ? 1 : 360;  // a ring's energy per degree back to the band's
    svgEl('text', { x: barX, y: barY - 4, class: 'skewt-label' }, svg).textContent = num(vMax * span);
    svgEl('text', { x: barX + barW, y: barY - 4, class: 'skewt-label', 'text-anchor': 'end' }, svg).textContent = num(vMax * span / 10 ** WAVESPEC_DECADES);
    svgEl('text', { x: W / 2, y: barY - 4, class: 'skewt-label', 'text-anchor': 'middle' }, svg).textContent = `Energy (${unit})`;

    // Readout: the peak, or the band (and direction) under the pointer
    var describe = (band, dir) => [`${(1 / band.f).toFixed(1)} s (${band.f.toFixed(3)} Hz)`, `${band.e} m²/Hz`,
        dir !== null && dir !== undefined ? `from ${Math.round(dir)}°` : null].filter(Boolean).join(' · ');
    var resting = spectrum.peak ? `Peak ${describe(spectrum.peak, spectrum.peak.dir)}` : '';
    var readout = svgEl('text', { x: W / 2, y: H - 6, class: 'skewt-readout', 'text-anchor': 'middle' }, svg);
    readout.textContent = resting;
    svg.addEventListener('mousemove', (e) => {
        var box = svg.getBoundingClientRect();
        var px = (e.clientX - box.left) * W / box.width - cx, py = (e.clientY - box.top) * H / box.height - cy;
        var f = Math.hypot(px, py) / R * fMax;
        var band = Math.hypot(px, py) <= R && bands.find((b) => f >= b.lo && f < b.hi);
        if (!band) return void (readout.textContent = resting);
        readout.textContent = describe(band, band.dir);
    });
    svg.addEventListener('mouseleave', () => { readout.textContent = resting; });

    container.replaceChildren(svg);
    var key = [
        opts.wind !== undefined ? '<span><i class="pp-key-wind"></i>Wind</span>' : '',
        waves.length ? '<span><i class="pp-key-swell"></i>Waves</span>' : '',
        opts.heading !== undefined ? '<span><i class="pp-key-ship"></i>Ship</span>' : '',
    ].join('');
    if (key) container.insertAdjacentHTML('beforeend', `<div class="wavespec-key">${key}</div>`);
    if (!hasDir) {
        var note = container.appendChild(document.createElement('div'));
        note.className = 'pp-status';
        note.textContent = 'This buoy sends no wave directions, so each band is a full ring.';
    }
}

// Compass showing where the wind and swell come from (arrows pointing in) and
// where the ship is heading (arrow pointing out)
export function marineCompass(windFrom, swellFrom, heading) {
    if (windFrom === undefined && !swellFrom.length && heading === undefined) return '';
    var c = 50;
    var at = (deg, r) => [c + r * Math.sin(deg * Math.PI / 180), c - r * Math.cos(deg * Math.PI / 180)];
    var arrow = (deg, from, to, cls) => {
        var [x1, y1] = at(deg, from), [x2, y2] = at(deg, to);
        var a = Math.atan2(y2 - y1, x2 - x1);
        var head = [a + 2.6, a - 2.6].map((b) => `${(x2 + 7 * Math.cos(b)).toFixed(1)},${(y2 + 7 * Math.sin(b)).toFixed(1)}`);
        return `<g class="${cls}"><line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`
            + `<polygon points="${x2.toFixed(1)},${y2.toFixed(1)} ${head.join(' ')}"/></g>`;
    };
    var key = [
        windFrom !== undefined ? '<span><i class="pp-key-wind"></i>Wind</span>' : '',
        swellFrom.length ? '<span><i class="pp-key-swell"></i>Waves</span>' : '',
        heading !== undefined ? '<span><i class="pp-key-ship"></i>Ship</span>' : '',
    ].join('');
    return `
        <figure class="pp-compass">
            <svg viewBox="0 0 100 100" width="100" height="100" role="img" aria-label="Wind, swell and ship heading">
                <circle cx="${c}" cy="${c}" r="38" class="pp-compass-ring"/>
                ${['N', 'E', 'S', 'W'].map((d, i) => {
                    var [x, y] = at(i * 90, 46);
                    return `<text x="${x}" y="${y + 3.5}" text-anchor="middle">${d}</text>`;
                }).join('')}
                ${swellFrom.map((d) => arrow(d, 38, 8, 'pp-compass-swell')).join('')}
                ${windFrom !== undefined ? arrow(windFrom, 38, 8, 'pp-compass-wind') : ''}
                ${heading !== undefined ? arrow(heading, 0, 30, 'pp-compass-ship') : ''}
            </svg>
            <figcaption>${key}</figcaption>
        </figure>`;
}
