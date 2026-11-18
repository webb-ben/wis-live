// The map's panels: minimizing part of one, and the key's rows that hide what
// they stand for with a click
import { esc } from '../lib/util.js';

// A panel on the map with a button that minimizes part of it (what the CSS hides under
// .map-key-minimized: the key's Style by, the connection status under the world map), as each viewer left it
// (localStorage, wis-minimized-<key>), or minimized every time the page opens when
// opts.alwaysStartMinimized. part names that part in the button's title;
// opts.onChange(minimized) hears it change
export function makeMinimizable(container, key, part, opts = {}) {
    var onChange = opts.onChange;
    var storageKey = `wis-minimized-${key}`;
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'map-key-min-toggle';
    var set = (minimized, remember) => {
        container.classList.toggle('map-key-minimized', minimized);
        button.textContent = minimized ? '+' : '−';
        button.title = minimized ? `Show the ${part}` : `Hide the ${part}`;
        button.setAttribute('aria-expanded', String(!minimized));
        if (remember && !opts.alwaysStartMinimized) {
            try {
                minimized ? localStorage.setItem(storageKey, '1') : localStorage.removeItem(storageKey);
            } catch (err) {
                // Not kept (private window, storage blocked); it still works for this visit
            }
        }
        if (onChange) onChange(minimized);
    };
    button.addEventListener('click', (e) => {
        e.stopPropagation();  // Not the phone's tap-to-open on the key (see StyleControl)
        set(!container.classList.contains('map-key-minimized'), true);
    });
    container.prepend(button);
    if (opts.alwaysStartMinimized) return set(true, false);
    var stored = false;
    try {
        stored = localStorage.getItem(storageKey) === '1';
    } catch (err) {
        // Storage unavailable: start open
    }
    set(stored, false);
}

// ---------- Key rows (and source shapes) a click hides, as the sidebar's switches
// would. One hidden from the key stays in it, greyed, until clicked again.
let keyToggles = new Map();  // Row or source id -> the layers a click on it hides (rebuilt with the key)
const keyOff = new Map();  // Ids hidden from the key -> { html, layers it switched off, shape }
let deps = null;

// hiddenLayers: the Set of layers switched off. directChange(): after layers with no
// sidebar row were switched straight in hiddenLayers. refresh(): rebuilds the key
export function initKeyToggles({ hiddenLayers, directChange, refresh }) {
    deps = { hiddenLayers, directChange, refresh };
}

// Starts a rebuild of the key: rows register again as they're made
export function startKeyToggles() {
    keyToggles = new Map();
}

// A row (or, with cls 'key-shape' and tag 'span', a source's shape) that hides layers on a click
export function keyToggle(id, layers, label, inner, cls = 'key-row', tag = 'div') {
    keyToggles.set(id, layers);
    return `<${tag} class="${cls} key-toggle" data-key-toggle="${esc(id)}" role="button" tabindex="0" aria-pressed="false" title="Click to hide ${esc(label)}">${inner}</${tag}>`;
}

// The rows and shapes hidden from the key, greyed, to show again with a click.
// One switched back on elsewhere (the sidebar) drops out. Call after the key's own rows
export function hiddenKeyRows() {
    var rows = [], shapes = [];
    for (var [id, off] of keyOff) {
        if (keyToggles.has(id) || !off.layers.some((l) => deps.hiddenLayers.has(l))) {
            if (!keyToggles.has(id)) keyOff.delete(id);
            continue;
        }
        keyToggles.set(id, off.layers);
        var html = off.html.replace('key-toggle"', 'key-toggle key-off"').replace('aria-pressed="false"', 'aria-pressed="true"')
            .replace(/title="Click to hide ([^"]*)"/, 'title="Hidden: click to show $1"');
        (off.shape ? shapes : rows).push(html);
    }
    return { rows, shapes };
}

// Clicks and Enter or Space on the container's rows
export function bindKeyToggles(container) {
    container.addEventListener('click', (e) => {
        var row = e.target.closest('[data-key-toggle]');
        if (row) toggleKeyRow(row);
    });
    container.addEventListener('keydown', (e) => {
        var row = (e.key === 'Enter' || e.key === ' ') && e.target.closest('[data-key-toggle]');
        if (!row) return;
        e.preventDefault();
        var id = row.dataset.keyToggle;
        toggleKeyRow(row);
        // The key is rebuilt; keep the keyboard on the same row
        var again = container.querySelector(`[data-key-toggle="${CSS.escape(id)}"]`);
        if (again) again.focus();
    });
}

// A click on a key row hides it; on one hidden (greyed), shows again what that click hid
function toggleKeyRow(el) {
    var id = el.dataset.keyToggle;
    var off = keyOff.get(id);
    if (off && el.classList.contains('key-off')) {
        keyOff.delete(id);
        setLayersShown(off.layers, true);
        return;
    }
    // Only what's on now, so showing it again doesn't switch on what was already off
    var layers = (keyToggles.get(id) || []).filter((l) => !deps.hiddenLayers.has(l));
    if (!layers.length) return;
    keyOff.set(id, { html: el.outerHTML, layers: [...(off ? off.layers : []), ...layers], shape: el.tagName === 'SPAN' });
    setLayersShown(layers, false);
}

// Switches layers on or off through their sidebar rows, so everything a switch does
// happens (decoding, the replay, the message list); any without a row directly
function setLayersShown(layers, on) {
    var direct = false;
    for (var layer of layers) {
        var input = document.querySelector(`.legend-toggle[data-layer="${CSS.escape(layer)}"] input`);
        if (input) {
            if (input.checked === on) continue;
            input.checked = on;
            input.dispatchEvent(new Event('change'));
        } else {
            on ? deps.hiddenLayers.delete(layer) : deps.hiddenLayers.add(layer);
            direct = true;
        }
    }
    if (direct) deps.directChange();
    deps.refresh();
}
