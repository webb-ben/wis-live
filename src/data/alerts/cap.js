// CAP (Common Alerting Protocol) warnings: what the alert says, coloured by
// its severity, with a button that shows its area on the map
import { esc } from '../../lib/util.js';

export const SEVERITY_COLORS = {
    Extreme: '#8b1a1a',
    Severe: '#d9363e',
    Moderate: '#f08c00',
    Minor: '#e6b800',
    Unknown: '#868e96',
};

// Common Alerting Protocol: a readable card instead of raw XML. Without the
// XML (blocked download), falls back to the notification's cap_info.
// showArea(rings, colour): draws the alert's area on the map
export function renderCap(out, title, decoded, showArea) {
    var alert = decoded.cap ? parseCap(decoded.cap) : { info: decoded.capInfo || {}, areas: [] };
    var info = alert.info;
    var severity = SEVERITY_COLORS[info.severity] ? info.severity : 'Unknown';
    var when = (v) => v ? esc(new Date(v).toLocaleString()) : '';
    if (title && info.event) title.textContent = info.event;

    out.innerHTML = `
        <div class="cap" style="--severity: ${SEVERITY_COLORS[severity]}">
            ${!title && info.event ? `<div class="cap-event">${esc(info.event)}</div>` : ''}
            <div class="cap-badges">
                <span class="cap-severity">${esc(severity)}</span>
                ${info.urgency ? `<span>${esc(info.urgency)}</span>` : ''}
                ${info.certainty ? `<span>${esc(info.certainty)}</span>` : ''}
            </div>
            ${info.headline ? `<div class="cap-headline">${esc(info.headline)}</div>` : ''}
            <dl class="pp-meta">
                ${alert.areaDesc ? `<dt>Area</dt><dd>${esc(alert.areaDesc)}</dd>` : ''}
                ${info.onset || info.effective ? `<dt>From</dt><dd>${when(info.onset || info.effective)}</dd>` : ''}
                ${info.expires ? `<dt>Until</dt><dd>${when(info.expires)}</dd>` : ''}
                ${info.senderName ? `<dt>Issued by</dt><dd>${esc(info.senderName)}</dd>` : ''}
            </dl>
            ${info.description ? `<p class="cap-text">${esc(info.description)}</p>` : ''}
            ${info.instruction ? `<p class="cap-text cap-instruction">${esc(info.instruction)}</p>` : ''}
            <div class="pp-actions"></div>
            ${decoded.cap ? '' : '<div class="pp-status">The full alert can\'t be downloaded in the browser; open it to read the details.</div>'}
            ${decoded.cap ? `<details class="pp-more"><summary>Alert XML</summary><pre class="pp-text"></pre></details>` : ''}
        </div>`;
    if (decoded.cap) out.querySelector('pre').textContent = decoded.cap;

    var actions = out.querySelector('.pp-actions');
    if (alert.areas.length) {
        var show = document.createElement('button');
        show.type = 'button';
        show.className = 'btn btn-sm btn-outline-secondary';
        show.textContent = 'Show area on map';
        show.addEventListener('click', () => showArea(alert.areas, SEVERITY_COLORS[severity]));
        actions.appendChild(show);
    }
    var link = info.web || decoded.href;
    if (link) {
        var open = document.createElement('a');
        open.className = 'btn btn-sm btn-outline-secondary';
        open.href = link;
        open.target = '_blank';
        open.rel = 'noopener';
        open.textContent = info.web ? 'Issuer\'s page' : 'Open alert';
        actions.appendChild(open);
    }
}

export function parseCap(xml) {
    var doc = new DOMParser().parseFromString(xml, 'application/xml');
    var child = (el, name) => el && el.getElementsByTagNameNS('*', name)[0];
    var text = (el, name) => { var c = child(el, name); return c ? c.textContent.trim() : ''; };
    // Prefer English when the alert is issued in several languages
    var infos = [...doc.getElementsByTagNameNS('*', 'info')];
    var infoEl = infos.find((i) => /^en/i.test(text(i, 'language'))) || infos[0];
    var info = {};
    ['event', 'urgency', 'severity', 'certainty', 'effective', 'onset', 'expires', 'senderName',
        'headline', 'description', 'instruction', 'web'].forEach((k) => { info[k] = text(infoEl, k); });

    var areaEls = infoEl ? [...infoEl.getElementsByTagNameNS('*', 'area')] : [];
    var areas = [];
    for (var area of areaEls) {
        // "lat,lon lat,lon ..." rings
        for (var poly of area.getElementsByTagNameNS('*', 'polygon')) {
            var ring = poly.textContent.trim().split(/\s+/).map((p) => p.split(',').map(Number).reverse());
            if (ring.length >= 4 && ring.every((c) => c.length === 2 && c.every(isFinite))) areas.push(ring);
        }
    }
    return {
        info: info,
        areaDesc: areaEls.map((a) => text(a, 'areaDesc')).filter(Boolean).join('; '),
        areas: areas,
    };
}
