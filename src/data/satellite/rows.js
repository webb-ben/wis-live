// Satellites in the sidebar and the key: a row for each, its colour when styled by satellite
import { layerOf } from '../../map/points.js';
import { SATELLITE_NAMES, satelliteNamed, satelliteOscarUrl } from './names.js';
import { darken } from '../../lib/util.js';
import { NO_VALUE_COLOR, SATELLITE_STYLE, OBS_CLASSES } from '../../config.js';
import { state, notify } from '../../state.js';
import { seenLayers, LAYER_PARENTS, hiddenLayers, ancestors } from '../../map/layers.js';
import { page } from '../../page.js';

// One layer row per satellite, added under Space-based (satellites) as
// each satellite is first seen. The name comes from the satellite identifier
// (001007) when the report is decoded, otherwise from the topic
// (.../space-based-observations/noaa-20/...), so both give the same row.
export function satelliteKey(record) {
    if (!/-satellite$/.test(layerOf(record))) return null;
    var name = satelliteName(record);
    return name ? `sat:satellite:${name.toLowerCase()}` : null;
}

// A WIS2 topic names its satellite (sentinel-6b, geo-kompsat-2a), which beats a
// number missing from SATELLITE_NAMES; GTS bulletins only have the number
export function satelliteName(record) {
    // Swath reports may no longer have their decoded values; the file kept the name
    if (record.satName) return record.satName;
    var row = record.decoded && record.decoded.rows && record.decoded.rows.find((x) => x[0] === 1007);
    if (row && SATELLITE_NAMES[row[2]]) return SATELLITE_NAMES[row[2]];
    var match = /space-based-observations\/([^/]+)/.exec(record.topic);
    // The same name the table gives it, so a satellite gets one row whichever way it came
    if (match) return satelliteNamed(match[1]) || match[1].toUpperCase();
    return row ? `Satellite ${row[2]}` : null;
}

// Style by Satellite: each satellite's colour, given in the order they're first seen
// so none share one until there are more satellites than colours
export const SATELLITE_PALETTE = ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b', '#e377c2', '#17becf', '#bcbd22', '#7f7f7f',
    '#393b79', '#e6550d', '#31a354', '#843c39', '#7b4173', '#3182bd', '#fd8d3c', '#74c476', '#9e9ac8', '#e7969c'];

export const satelliteColours = new Map();  // satellite key (sat:satellite:<name>) -> colour; one per satellite, few

export function satelliteColour(key) {
    if (!satelliteColours.has(key)) satelliteColours.set(key, SATELLITE_PALETTE[satelliteColours.size % SATELLITE_PALETTE.length]);
    return satelliteColours.get(key);
}

export function satelliteLabel(key) {
    return key.split(':').slice(2).join(':').toUpperCase().replace(/^SATELLITE /, 'Satellite ');
}

// A paint expression giving each satellite its colour (or its outline, darker); others get fallback
export function satelliteMatch(dark, fallback) {
    var pairs = [...satelliteColours].flatMap(([key, colour]) => [key, dark ? darken(colour) : colour]);
    var other = fallback || (dark ? darken(NO_VALUE_COLOR) : NO_VALUE_COLOR);
    return pairs.length ? ['match', ['coalesce', ['get', 'sat'], ''], ...pairs, other] : other;
}

// The satellites' rows under Space-based take their colours while the map is styled by satellite
export function syncSatelliteRows() {
    document.querySelectorAll('.legend-satellite').forEach((row) => {
        var colour = state.colourBy === SATELLITE_STYLE ? satelliteColour(row.dataset.layer) : OBS_CLASSES.satellite.color;
        var dot = row.querySelector('.legend-dot');
        dot.style.setProperty('--color', colour);
        dot.style.setProperty('--outline', darken(colour));
    });
}

export function addSatelliteRow(key) {
    if (seenLayers.has(key)) return;
    var [, parent] = key.split(':');
    var parentRow = document.querySelector(`.legend-toggle[data-layer="${parent}"]`);
    if (!parentRow) return;
    seenLayers.add(key);
    LAYER_PARENTS[key] = parent;
    satelliteColour(key);
    // A new satellite joins the colours on the map while styled by satellite
    if (state.colourBy === SATELLITE_STYLE) requestAnimationFrame(() => page.restyle());
    var row = document.createElement('label');
    row.className = 'legend-toggle legend-sub legend-depth-2 legend-satellite';
    row.dataset.layer = key;
    var colour = state.colourBy === SATELLITE_STYLE ? satelliteColour(key) : OBS_CLASSES.satellite.color;
    row.innerHTML = `<input type="checkbox" class="form-check-input"${hiddenLayers.has(key) ? '' : ' checked'}><span class="legend-dot" style="--color: ${colour}; --outline: ${darken(colour)}"></span><span></span>`;
    row.lastElementChild.textContent = satelliteLabel(key);
    // Its page in OSCAR/Space, where there is one
    var name = key.split(':').slice(2).join(':');
    var url = satelliteOscarUrl(null, satelliteNamed(name) || name);
    if (url) {
        var link = document.createElement('a');
        link.className = 'legend-oscar';
        link.href = url;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = '↗';
        link.title = `${satelliteLabel(key)} in OSCAR/Space`;
        link.setAttribute('aria-label', link.title);
        row.append(link);
    }
    var input = row.querySelector('input');
    var parentOff = ancestors(key).some((a) => hiddenLayers.has(a));
    input.disabled = parentOff;
    row.classList.toggle('legend-disabled', parentOff);
    input.addEventListener('change', () => {
        input.checked ? hiddenLayers.delete(key) : hiddenLayers.add(key);
        notify('hiddenLayers');
        page.applyMapFilter();
    });
    // Alphabetical among this group's satellites, right after the group's row
    var after = parentRow;
    for (var sibling = parentRow.nextElementSibling; sibling && sibling.classList.contains('legend-satellite') && sibling.dataset.layer.startsWith(`sat:${parent}:`); sibling = sibling.nextElementSibling) {
        if (sibling.dataset.layer > key) break;
        after = sibling;
    }
    after.after(row);
}
