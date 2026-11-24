// A WIS2 notification, two ways: its details (what it says, laid out to read) and the literal
// JSON (highlighted, with Copy). Shown in the info panel's Message tab (popup.js) and a
// message opened from the sidebar's list (queue.js, in the info panel too); the details first
import { esc } from '../util.js';
import { timeAgo, formatBytes, highlightJson } from '../format.js';
import { formatOf, FORMATS, gtsHeading } from '../../messages/messages.js';

// Properties the details lay out themselves; any others are listed under Other properties
const SHOWN = new Set(['data_id', 'metadata_id', 'pubtime', 'datetime', 'start_datetime', 'end_datetime', 'integrity',
    'gts', 'global-cache', 'cache', 'content', 'wigos_station_identifier', 'cap_info', 'title', 'description']);

// "2026-11-24 19:43:03 UTC (2 min ago)"
function when(iso) {
    var t = Date.parse(iso || '');
    if (!t) return esc(iso || '');
    return `${esc(new Date(t).toISOString().slice(0, 19).replace('T', ' '))} UTC <small>(${esc(timeAgo(t))})</small>`;
}

function row(label, html) {
    return html ? `<tr><th>${esc(label)}</th><td>${html}</td></tr>` : '';
}

// The geometry, readably: a point's latitude and longitude, else the box round it
function where(geometry) {
    if (!geometry || !geometry.type) return '<span class="wn-muted">None (the file says where)</span>';
    var points = [];
    var walk = (c) => (typeof c[0] === 'number' ? points.push(c) : c.forEach(walk));
    if (geometry.coordinates) walk(geometry.coordinates);
    var f = (v) => (Math.round(v * 1000) / 1000).toString();
    if (geometry.type === 'Point' && points.length) return `${f(points[0][1])}, ${f(points[0][0])} <small>(lat, lon)</small>`;
    if (!points.length) return esc(geometry.type);
    var lons = points.map((p) => p[0]), lats = points.map((p) => p[1]);
    return `${esc(geometry.type)} <small>${f(Math.min(...lats))} to ${f(Math.max(...lats))} lat, ${f(Math.min(...lons))} to ${f(Math.max(...lons))} lon</small>`;
}

// A property's value for the Other properties rows: text as it is, anything else as JSON
function plain(v) {
    return typeof v === 'object' ? `<code>${esc(JSON.stringify(v))}</code>` : esc(String(v));
}

function details(message, topic) {
    var props = message.properties || {};
    var t = topic || props.topic || '';
    var [channel, rest = ''] = t.split('/a/wis2/');
    var centre = rest.split('/', 1)[0];
    var path = rest.slice(centre.length + 1);
    var policy = (/\/data\/(core|recommended)\//.exec(t) || [])[1];
    var format = FORMATS[formatOf(message, t)];
    var file = (props.data_id || '').split('/').pop();
    var heading = gtsHeading(message);
    var period = props.start_datetime || props.end_datetime
        ? `${when(props.start_datetime)} to ${when(props.end_datetime)}` : when(props.datetime);

    var badges = [
        channel && `<span class="wn-badge wn-${esc(channel)}">${esc(channel)}</span>`,
        policy && `<span class="wn-badge wn-${esc(policy)}">${esc(policy)}</span>`,
        format && `<span class="wn-badge">${esc(format)}</span>`,
        props.cache === false && '<span class="wn-badge wn-nocache" title="The global caches don\'t copy this file">not cached</span>',
    ].filter(Boolean).join('');

    var links = (message.links || []).map((l) => `<li>
        <span class="wn-rel">${esc(l.rel || 'link')}</span>
        <a href="${esc(l.href || '')}" target="_blank" rel="noopener">${esc((l.href || '').replace(/^https?:\/\//, ''))}</a>
        <small>${[l.type, l.length ? formatBytes(l.length) : ''].filter(Boolean).map(esc).join(' · ')}</small></li>`).join('');

    var others = Object.entries(props).filter(([k]) => !SHOWN.has(k));

    return `<div class="wn-details">
        <div class="wn-head">
            <div class="wn-centre">${esc(centre || 'WIS2')}</div>
            <div class="wn-badges">${badges}</div>
        </div>
        ${props.title ? `<div class="wn-title">${esc(props.title)}</div>` : ''}
        <div class="wn-file">${esc(file || message.id || '')}</div>
        ${props.description ? `<p class="wn-desc">${esc(props.description)}</p>` : ''}
        <table class="wn-table">
            ${row('Topic', `<span class="wn-mono">${esc(path)}</span>`)}
            ${row('Published', when(props.pubtime))}
            ${row(props.start_datetime ? 'Data period' : 'Data time', period)}
            ${row('Location', where(message.geometry))}
            ${row('Station', props.wigos_station_identifier && `<span class="wn-mono">${esc(props.wigos_station_identifier)}</span>`)}
            ${row('GTS heading', heading && `<span class="wn-mono">${esc(heading)}${props.gts && props.gts.cccc ? ` ${esc(props.gts.cccc)}` : ''}</span>`)}
            ${row('Global cache', props['global-cache'] && esc(props['global-cache']))}
            ${row('Dataset', props.metadata_id && `<span class="wn-mono">${esc(props.metadata_id)}</span>`)}
            ${row('Inline data', props.content && `${esc(props.content.encoding || '')} · ${formatBytes(props.content.size || (props.content.value || '').length)}`)}
            ${row('Warning', props.cap_info && plain(props.cap_info))}
            ${row('Integrity', props.integrity && `${esc(props.integrity.method || '')} <small class="wn-mono">${esc((props.integrity.value || '').slice(0, 16))}…</small>`)}
        </table>
        ${links ? `<div class="wn-sub">Links</div><ul class="wn-links">${links}</ul>` : ''}
        ${others.length ? `<div class="wn-sub">Other properties</div><table class="wn-table">${others.map(([k, v]) => row(k, plain(v))).join('')}</table>` : ''}
        <div class="wn-foot">
            <span class="wn-mono">${esc(message.id || '')}</span>
            ${(message.conformsTo || []).map((c) => `<span>${esc(String(c).replace(/^https?:\/\//, ''))}</span>`).join('')}
        </div>
    </div>`;
}

// Fills `out` with the notification: Details and JSON, switched by the buttons at the top.
// note: a line above both (e.g. that a report was decoded from this file)
export function renderNotification(out, message, topic, note = '') {
    var json = JSON.stringify(message, null, 2);
    out.innerHTML = `
        <div class="pp-message-head">
            <div class="wn-switch" role="tablist" aria-label="How to show the message">
                <button type="button" role="tab" data-view="details" aria-selected="true">Details</button>
                <button type="button" role="tab" data-view="json" aria-selected="false">JSON</button>
            </div>
            <button type="button" class="btn btn-sm btn-outline-secondary wn-copy" hidden>Copy</button>
        </div>
        ${note ? `<div class="pp-status">${esc(note)}</div>` : ''}
        <div class="wn-view" data-view="details">${details(message, topic)}</div>
        <div class="wn-view" data-view="json" hidden>
            <div class="pp-mono pp-message-topic"></div>
            <pre class="pp-json"></pre>
        </div>`;
    out.querySelector('.pp-message-topic').textContent = topic || '';
    out.querySelector('.pp-json').innerHTML = highlightJson(json);
    var copy = out.querySelector('.wn-copy');
    out.querySelectorAll('.wn-switch button').forEach((button) => button.addEventListener('click', (e) => {
        e.stopPropagation();
        var view = button.dataset.view;
        out.querySelectorAll('.wn-switch button').forEach((b) => b.setAttribute('aria-selected', b === button));
        out.querySelectorAll('.wn-view').forEach((v) => { v.hidden = v.dataset.view !== view; });
        copy.hidden = view !== 'json';
    }));
    copy.addEventListener('click', (e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(json).then(() => {
            copy.textContent = 'Copied';
            setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
        }).catch(() => { copy.textContent = 'Copy failed'; });
    });
}
