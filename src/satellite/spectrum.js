// Infrared spectra from hyperspectral sounders (CrIS, IASI): each channel's
// radiance as a brightness temperature against wavenumber, so the CO₂, ozone and
// water-vapour bands show at a glance.
import { svgEl } from '../lib/util.js';
export const PLANCK_C1 = 1.191042e-5;  // mW m-2 sr-1 (cm-1)-4
export const PLANCK_C2 = 1.4387752;    // K cm
export const IASI_WAVENUMBERS = [645, 0.25];  // cm-1 of channel 1, and the spacing (IASI carries no band edges)
// Parts of the spectrum named on the chart, in cm-1
export const SPECTRUM_REGIONS = [[650, 770, 'CO₂'], [800, 980, 'Window'], [1000, 1070, 'O₃'], [1300, 1750, 'H₂O'], [2250, 2390, 'CO₂']];

// [{ channel, wn (cm-1), bt (K) }] from CrIS channel radiances (014044, per cm-1, band
// edges in 008076 groups) or IASI scaled radiances (014046, scale factor per channel
// range in 025140-025142). Missing radiances aren't in the rows, so those channels are gaps.
export function radianceSpectrum(rows) {
    var bands = [], scales = [], band = null, range = null, channel = null, raw = [];
    for (var [id, , value] of rows) {
        if (typeof value !== 'number') continue;
        if (id === 8076) bands.push(band = { wn: [] });
        else if (id === 6029 && band && band.wn.length < 2) band.wn.push(value / 100);  // /m to cm-1
        else if (id === 25140) range = { start: value };
        else if (id === 25141 && range) {
            range.end = value;
            if (band && band.start === undefined && band.wn.length === 2) Object.assign(band, range);
        } else if (id === 25142 && range) scales.push({ ...range, factor: value });
        else if (id === 5042) {
            // Numbering that starts again is another instrument's channels (e.g. CrIS files
            // go on to imager radiances), not more of the spectrum
            if (raw.length && value < raw[raw.length - 1][0]) break;
            channel = value;
        } else if (id === 14044 && channel !== null) raw.push([channel, value]);
        else if (id === 14046 && channel !== null) {
            var c = channel, s = scales.find((r) => c >= r.start && c <= r.end);
            // W m-2 sr-1 m (per m-1) to per cm-1
            if (s) raw.push([channel, value * 10 ** -s.factor * 100]);
        }
    }
    bands = bands.filter((b) => b.wn.length === 2 && b.end > b.start);
    var wavenumber = (c) => {
        if (!bands.length) return IASI_WAVENUMBERS[0] + (c - 1) * IASI_WAVENUMBERS[1];
        var b = bands.find((x) => c >= x.start && c <= x.end);
        return b ? b.wn[0] + (c - b.start) * (b.wn[1] - b.wn[0]) / (b.end - b.start) : null;
    };
    var out = [];
    for (var [ch, radiance] of raw) {
        var wn = wavenumber(ch), mw = radiance * 1000;
        if (!wn || !(mw > 0)) continue;
        out.push({ channel: ch, wn, bt: PLANCK_C2 * wn / Math.log(1 + PLANCK_C1 * wn ** 3 / mw) });
    }
    out.sort((a, b) => a.wn - b.wn);
    return out.length >= 20 ? out : null;
}

// Draws what the popup has, then every channel once the report is decoded again in full
// (satellite reports keep only their first SATELLITE_ROWS_MAX values)
export async function showSpectrum(container, result) {
    var spectrum = result.fullSpectrum || radianceSpectrum(result.rows);
    if (spectrum) renderSpectrum(container, spectrum, { width: 300, height: 200 });
    if (result.fullSpectrum || !result.trimmed || !result.loadFull) return;
    var note = container.parentNode.insertBefore(document.createElement('div'), container.nextSibling);
    note.className = 'pp-status';
    note.textContent = 'Loading every channel…';
    try {
        var full = await result.loadFull();
        result.fullSpectrum = radianceSpectrum(full.rows);
        note.remove();
        if (result.fullSpectrum && container.isConnected) renderSpectrum(container, result.fullSpectrum, { width: 300, height: 200 });
    } catch (err) {
        note.textContent = `Only the first channels: ${err.message}`;
    }
}

export function renderSpectrum(container, spectrum, opts) {
    var W = opts.width, H = opts.height;
    var m = { top: 16, right: 10, bottom: 30, left: 36 };
    var w = W - m.left - m.right, bottom = H - m.bottom;
    var wnMin = spectrum[0].wn, wnMax = spectrum[spectrum.length - 1].wn;
    var bts = spectrum.map((p) => p.bt);
    var btMin = Math.floor(Math.min(...bts) / 10) * 10, btMax = Math.ceil(Math.max(...bts) / 10) * 10;
    if (btMax - btMin < 20) btMax = btMin + 20;
    var x = (wn) => m.left + w * (wn - wnMin) / (wnMax - wnMin || 1);
    var y = (bt) => bottom - (bottom - m.top) * (bt - btMin) / (btMax - btMin);

    var svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'irspec', role: 'img',
        'aria-label': 'Infrared spectrum: brightness temperature by wavenumber' });
    svgEl('rect', { x: 0, y: 0, width: W, height: H, class: 'skewt-bg' }, svg);

    // Named regions behind the line, labelled along the top where there's room
    var labelEnd = -Infinity;
    for (var [lo, hi, label] of SPECTRUM_REGIONS) {
        if (hi < wnMin || lo > wnMax) continue;
        var x0 = x(Math.max(lo, wnMin)), x1 = x(Math.min(hi, wnMax)), mid = (x0 + x1) / 2, half = label.length * 3;
        svgEl('rect', { x: x0, y: m.top, width: x1 - x0, height: bottom - m.top, class: label === 'Window' ? 'irspec-window' : 'irspec-band' }, svg);
        if (mid - half < labelEnd + 4) continue;
        svgEl('text', { x: mid, y: m.top - 4, class: 'skewt-label', 'text-anchor': 'middle' }, svg).textContent = label;
        labelEnd = mid + half;
    }

    // Temperature axis
    var step = btMax - btMin > 80 ? 20 : 10;
    for (var t = btMin; t <= btMax; t += step) {
        svgEl('line', { x1: m.left, x2: m.left + w, y1: y(t), y2: y(t), class: 'skewt-isobar' }, svg);
        svgEl('text', { x: m.left - 5, y: y(t) + 3.5, class: 'skewt-label', 'text-anchor': 'end' }, svg).textContent = t;
    }
    svgEl('text', { x: 0, y: 0, class: 'skewt-label', 'text-anchor': 'middle',
        transform: `translate(9 ${(m.top + bottom) / 2}) rotate(-90)` }, svg).textContent = 'K';

    // One line per run of channels, broken between bands. Files often carry a selection
    // of channels, so smaller gaps are bridged
    var runs = [], run = [];
    spectrum.forEach((p, i) => {
        if (i && p.wn - spectrum[i - 1].wn > 40) {
            runs.push(run);
            run = [];
        }
        run.push(p);
    });
    runs.push(run);
    for (var r of runs) {
        if (r.length === 1) svgEl('circle', { cx: x(r[0].wn), cy: y(r[0].bt), r: 1, class: 'irspec-dot' }, svg);
        else svgEl('polyline', { points: r.map((p) => `${x(p.wn).toFixed(1)},${y(p.bt).toFixed(1)}`).join(' '), class: 'irspec-line' }, svg);
    }

    // Wavenumber axis
    for (var wn of [700, 1000, 1500, 2000, 2500]) {
        if (wn < wnMin || wn > wnMax) continue;
        svgEl('line', { x1: x(wn), x2: x(wn), y1: bottom, y2: bottom + 4, class: 'skewt-tick' }, svg);
        svgEl('text', { x: x(wn), y: bottom + 14, class: 'skewt-label', 'text-anchor': 'middle' }, svg).textContent = wn;
    }
    svgEl('text', { x: m.left + w / 2, y: H - 3, class: 'skewt-axis', 'text-anchor': 'middle' }, svg).textContent = 'Wavenumber (cm⁻¹)';
    svgEl('rect', { x: m.left, y: m.top, width: w, height: bottom - m.top, class: 'skewt-frame' }, svg);

    // Hover readout for the nearest channel
    var marker = svgEl('circle', { r: 2.5, class: 'irspec-marker', visibility: 'hidden' }, svg);
    var readout = svgEl('text', { x: m.left + w - 4, y: bottom - 6, class: 'skewt-readout', 'text-anchor': 'end' }, svg);
    svg.addEventListener('mousemove', (e) => {
        var box = svg.getBoundingClientRect();
        var wn = wnMin + ((e.clientX - box.left) * W / box.width - m.left) / w * (wnMax - wnMin);
        var p = spectrum.reduce((best, q) => (Math.abs(q.wn - wn) < Math.abs(best.wn - wn) ? q : best));
        marker.setAttribute('cx', x(p.wn));
        marker.setAttribute('cy', y(p.bt));
        marker.setAttribute('visibility', 'visible');
        readout.textContent = `Ch ${p.channel} · ${p.wn.toFixed(1)} cm⁻¹ (${(1e4 / p.wn).toFixed(2)} µm) · ${p.bt.toFixed(1)} K`;
    });
    svg.addEventListener('mouseleave', () => {
        marker.setAttribute('visibility', 'hidden');
        readout.textContent = '';
    });

    container.replaceChildren(svg);
}
