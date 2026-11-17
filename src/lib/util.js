// Small helpers shared by every page: escaping text for HTML, SVG elements,
// colours and units, and loading a script on demand.

export function esc(value) {
    return String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// A darker shade of a hex colour, for outlines that match their fill
export function darken(hex, amount = 0.45) {
    var n = parseInt(hex.trim().slice(1), 16);
    var channel = (shift) => Math.round(((n >> shift) & 255) * (1 - amount));
    return `#${[16, 8, 0].map((shift) => channel(shift).toString(16).padStart(2, '0')).join('')}`;
}

export const SVG_NS = 'http://www.w3.org/2000/svg';

export function svgEl(name, attrs, parent) {
    var el = document.createElementNS(SVG_NS, name);
    for (var k in attrs) el.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(el);
    return el;
}

export function knots(ms) {
    return Math.round(ms * 1.943844);
}

export function loadScript(src) {
    return new Promise((resolve, reject) => {
        var script = document.createElement('script');
        script.src = src;
        script.onload = resolve;
        script.onerror = () => reject(new Error(`could not load ${src}`));
        document.head.appendChild(script);
    });
}
