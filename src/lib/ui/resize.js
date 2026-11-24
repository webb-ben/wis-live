// The sidebar (left) and the info panel (right) can be dragged wider or narrower by a strip
// on their inner edge. Their widths are CSS variables (--queue-width, --info-width, used by
// style.css for the panels and the map controls beside them), kept in this browser; a double
// click on the strip puts the default back. Not on phones, where the panels fill the screen
import { track } from '../analytics.js';

const MIN = 260;
const PANELS = {
    queue: { side: 'left', variable: '--queue-width', key: 'wis-queue-width', fallback: 340 },
    info: { side: 'right', variable: '--info-width', key: 'wis-info-width', fallback: 380 },
};

// The most a panel may take: most of the window, leaving the map a strip
function most() {
    return Math.max(MIN, Math.min(900, window.innerWidth * 0.7));
}

function apply(panel, width) {
    var w = Math.round(Math.max(MIN, Math.min(most(), width)));
    document.documentElement.style.setProperty(panel.variable, `${w}px`);
    return w;
}

// Widths dragged on an earlier visit
for (var p of Object.values(PANELS)) {
    try {
        var saved = Number(localStorage.getItem(p.key));
        if (saved) apply(p, saved);
    } catch (err) {
        // Storage blocked: the defaults
    }
}

// Adds the grab strip to a panel element ('queue' or 'info')
export function makeResizable(element, name) {
    var panel = PANELS[name];
    if (!element || element.querySelector(':scope > .panel-resize')) return;
    var strip = document.createElement('div');
    strip.className = 'panel-resize';
    strip.title = 'Drag to resize; double-click for the default width';
    strip.setAttribute('aria-hidden', 'true');
    element.appendChild(strip);
    var width = null;
    strip.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        strip.setPointerCapture(e.pointerId);
        strip.classList.add('active');
        document.body.classList.add('panel-resizing');
    });
    strip.addEventListener('pointermove', (e) => {
        if (!strip.hasPointerCapture(e.pointerId)) return;
        width = apply(panel, panel.side === 'left' ? e.clientX : window.innerWidth - e.clientX);
    });
    var done = (e) => {
        if (!strip.hasPointerCapture(e.pointerId)) return;
        strip.releasePointerCapture(e.pointerId);
        strip.classList.remove('active');
        document.body.classList.remove('panel-resizing');
        if (width == null) return;
        try {
            localStorage.setItem(panel.key, String(width));
        } catch (err) {
            // Storage blocked: kept until the page is closed
        }
        track('panel_resize', { panel: name, width });
        width = null;
        // The world map's frame stops at the panels' edges (overview.js), and redraws on resize
        window.dispatchEvent(new Event('resize'));
    };
    strip.addEventListener('pointerup', done);
    strip.addEventListener('pointercancel', done);
    strip.addEventListener('click', (e) => e.stopPropagation());  // Not the panel's own click
    strip.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        document.documentElement.style.removeProperty(panel.variable);
        try {
            localStorage.removeItem(panel.key);
        } catch (err) {
            // Storage blocked
        }
        window.dispatchEvent(new Event('resize'));
    });
}
