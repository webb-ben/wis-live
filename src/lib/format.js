// Formatting values for display: a BUFR value with its unit, labels, sizes, how
// long ago, station names, and notification JSON with highlighting
import { esc } from './util.js';

export function formatValue(value, unit) {
    if (typeof value !== 'number') return [value, ''];
    if (unit === 'K') return [(value - 273.15).toFixed(1), '°C'];
    if (unit === 'Pa') return [(value / 100).toFixed(1), 'hPa'];
    if (unit === 'm' && value >= 1000) return [Number((value / 1000).toFixed(1)), 'km'];
    if (unit === 'KG M-2') return [value, 'mm'];
    if (unit === 'CODE TABLE' || unit === 'FLAG TABLE') return [value, '(code)'];
    if (['Numeric', 'CCITT IA5', 'a', 'mon', 'd', 'h', 'min'].includes(unit)) return [value, ''];
    return [Number(value.toFixed(5)), unit];
}

export function formatLabel(type) {
    if (/bufr/.test(type || '')) return 'BUFR';
    if (/grib/.test(type || '')) return 'GRIB';
    return 'data';
}

export function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function timeAgo(time) {
    var seconds = Math.round((Date.now() - new Date(time)) / 1000);
    if (isNaN(seconds)) return '';
    if (seconds < 10) return 'just now';
    if (seconds < 60) return `${seconds} sec ago`;
    if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
    if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
    return `${Math.round(seconds / 86400)} d ago`;
}

export function titleCase(name) {
    return name.toLowerCase().replace(/(^|[\s(\/-])\w/g, (c) => c.toUpperCase());
}

// Returns a cleaned station name, or null when the decoded value isn't usable:
// not text, padding or control characters only, undecodable bytes, a
// placeholder such as "MISSING", or no letters at all (e.g. "0000", "///")
export function stationName(entry) {
    if (!entry || typeof entry[0] !== 'string') return null;
    // ÿ is a BUFR padding byte (0xFF) read as Latin-1
    var name = entry[0].replace(/ÿ/g, '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (name.length < 2 || name.length > 64) return null;
    if (name.includes('\ufffd')) return null;
    if (!/[a-z]/i.test(name)) return null;
    // "SHIP" stands in for the call sign of ships that don't publish theirs
    if (/^(missing|unknown|none|null|n\/?a|test|station|ship)$/i.test(name)) return null;
    return name;
}

// Scale ends with at most one decimal (e.g. 28.3 m/s, not 28.29)
export function scaleLabel(v) {
    return Number(v.toFixed(1));
}

export function formatMetric(value, m) {
    var digits = m.unit === '%' ? 0 : 1;
    return `${value.toFixed(digits)} ${m.unit}`;
}

// Escapes JSON text and wraps keys, strings, numbers and literals for colouring;
// URLs become links
export function highlightJson(json) {
    return esc(json).replace(/(&#34;(?:[^&]|&(?!#34;))*?&#34;)(\s*:)?|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b|\b(true|false|null)\b/g,
        (match, str, colon, num, lit) => {
            if (str && colon) return `<span class="json-key">${str}</span>${colon}`;
            if (str) {
                var inner = str.slice(5, -5);
                return /^https?:\/\//.test(inner)
                    ? `<span class="json-string">&#34;<a href="${inner}" target="_blank" rel="noopener">${inner}</a>&#34;</span>`
                    : `<span class="json-string">${str}</span>`;
            }
            if (num !== undefined) return `<span class="json-number">${num}</span>`;
            return `<span class="json-literal">${lit}</span>`;
        });
}
