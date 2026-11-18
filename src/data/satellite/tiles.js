// A decoded satellite report's info panel tiles: what made it (satellite, instrument)
// and what it measures
import { metricTileAttr, windTiles } from '../../lib/ui/popup.js';
import { esc } from '../../lib/util.js';
import { SATELLITE_NAMES, INSTRUMENT_NAMES, AMV_METHODS, PIXEL_TYPES } from './names.js';
import { satelliteLink } from './rows.js';
import { SATELLITE_STYLE } from '../../config.js';

export function satelliteTiles(rows, values) {
    // id: the descriptor of a value the map can be coloured by (see metricTileAttr)
    var tile = (label, html, id) => `<div class="pp-tile"${metricTileAttr(id, true)}><div>${esc(label)}</div><strong>${html}</strong></div>`;
    var number = (id) => (values.has(id) && typeof values.get(id)[0] === 'number' ? values.get(id)[0] : null);
    var count = (id) => rows.filter((r) => r[0] === id).length;
    var all = (id) => rows.filter((r) => r[0] === id && typeof r[2] === 'number').map((r) => r[2]);
    var tiles = [];

    var sat = number(1007), inst = number(2019);
    var name = sat === null ? null : SATELLITE_NAMES[sat] || `Satellite ${sat}`;
    var instrument = inst === null ? null : INSTRUMENT_NAMES[inst] || `instrument ${inst}`;
    // A known satellite's tile styles the map by satellite, each in its colour
    tiles.push(tile('Satellite', `${name ? satelliteLink(name, sat) : 'Unknown'}${instrument ? ` <small>${esc(instrument)}</small>` : ''}`)
        .replace('class="pp-tile"', `class="pp-tile"${name ? ` data-metric="${SATELLITE_STYLE}"` : ''}`));

    // What kind of product, from the elements it carries
    var product = count(15037) ? 'Radio occultation'
        : values.has(11002) && (values.has(2023) || values.has(11113)) ? 'Cloud-motion winds'
        : values.has(11012) && (values.has(21101) || values.has(21119)) ? 'Ocean surface winds'
        : values.has(15001) ? 'Ozone'
        : values.has(13095) ? 'Water vapour'
        : count(12163) || count(12063) ? 'Radiances'
        : count(14044) || count(14046) ? 'Infrared spectrum'
        : count(12101) > 5 ? 'Temperature and humidity profile'
        : values.has(10081) ? 'Altimetry'
        : values.has(15021) ? 'Trace gases'
        : 'Satellite data';
    tiles.push(tile('Product', esc(product)));
    if (number(5040) !== null) tiles.push(tile('Orbit', esc(number(5040).toLocaleString())));

    if (product === 'Cloud-motion winds') {
        tiles.push(...windTiles(values, 'satWind'));
        var method = number(2023);
        if (method !== null) tiles.push(tile('Tracked in', esc(AMV_METHODS[method] || `method ${method}`)));
        // Several confidences can follow (with and without the forecast check); the first is the main one
        if (number(33007) !== null) tiles.push(tile('Confidence', `${esc(Math.round(number(33007)))} %`));
    }
    if (product === 'Ocean surface winds') {
        // The scatterometer gives several possible winds; 021102 says which one was chosen
        var pick = Math.max(0, (number(21102) || 1) - 1);
        var speeds = all(11012), dirs = all(11011);
        var speed = speeds[pick] ?? speeds[0], dir = dirs[pick] ?? dirs[0];
        if (speed !== undefined) tiles.push(...windTiles(new Map([[11002, [speed]], ...(dir !== undefined ? [[11001, [dir]]] : [])]), 'seaWind'));
        if (speeds.length > 1) tiles.push(tile('Possible winds', `${esc(speeds.length)} <small>this one most likely</small>`));
    }
    if (number(15001) !== null) tiles.push(tile('Total ozone', `${esc(Math.round(number(15001)))} DU`, 15001));
    // Column water vapour, then its uncertainty after 008093 (0 = total uncertainty)
    var vapour = all(13095);
    if (vapour.length) {
        var spread = values.has(8093) && vapour.length > 1 ? vapour[1] : null;
        var doubtful = spread !== null && spread > vapour[0] / 2;
        tiles.push(tile('Water vapour', `${esc(vapour[0].toFixed(1))} kg/m²${spread !== null ? ` <small>± ${esc(spread.toFixed(1))}${doubtful ? ', low confidence' : ''}</small>` : ''}`, 13095));
    }
    if (number(8072) !== null && PIXEL_TYPES[number(8072)]) tiles.push(tile('Pixel', esc(PIXEL_TYPES[number(8072)])));
    if (number(10102) !== null) {
        var anomaly = number(10102) * 100;
        tiles.push(tile('Sea-level anomaly', `${anomaly > 0 ? '+' : ''}${esc(anomaly.toFixed(1))} cm <small>vs the long-term mean</small>`, 10102));
    }
    if (number(20016) !== null) tiles.push(tile('Cloud-top pressure', `${esc(Math.round(number(20016) / 100))} hPa`, 20016));
    if (number(20014) !== null) tiles.push(tile('Cloud-top height', `${esc((number(20014) / 1000).toFixed(1))} km`));
    if (product === 'Cloud-motion winds' && number(12001) !== null) tiles.push(tile('Cloud temperature', `${esc((number(12001) - 273.15).toFixed(1))} °C`));
    if (number(20081) !== null) tiles.push(tile('Cloud amount', `${esc(Math.round(number(20081)))} %`, 20081));

    var bt = all(12163).concat(all(12063));
    if (bt.length) {
        tiles.push(tile('Channels', esc(bt.length)));
        tiles.push(tile('Brightness temperature', `${esc(Math.round(Math.min(...bt)))}–${esc(Math.round(Math.max(...bt)))} K`, 12163));
    }
    // Channel frequencies: microwave in GHz, infrared and visible as wavelengths
    var freqs = all(2153).filter((f) => f > 0);
    if (freqs.length) {
        var lo = Math.min(...freqs), hi = Math.max(...freqs);
        var fmt = (f) => (f < 1e12 ? `${Number((f / 1e9).toFixed(1))} GHz` : `${Number((3e8 / f * 1e6).toFixed(1))} µm`);
        var text = lo === hi ? fmt(lo) : lo < 1e12 ? `${Number((lo / 1e9).toFixed(1))}–${fmt(hi)}` : `${Number((3e8 / hi * 1e6).toFixed(1))}–${fmt(lo)}`;
        tiles.push(tile(freqs.length > 1 ? 'Channels at' : 'Channel', esc(text)));
    }
    if (number(12061) !== null) tiles.push(tile('Skin temperature', `${esc((number(12061) - 273.15).toFixed(1))} °C`, 12061));
    if (product === 'Temperature and humidity profile') tiles.push(tile('Profile levels', esc(count(12101))));
    if (product === 'Radio occultation') {
        tiles.push(tile('Profile levels', esc(count(15037))));
        var heights = all(7007);
        if (heights.length > 1) tiles.push(tile('Heights', `${esc((Math.max(0, Math.min(...heights)) / 1000).toFixed(1))}–${esc(Math.round(Math.max(...heights) / 1000))} km`));
    }

    // Where the sun and the satellite were, seen from the ground
    var sun = number(7025);
    if (sun !== null) tiles.push(tile('Sun', `${sun < 90 ? 'Day' : 'Night'} <small>${esc(Math.round(sun))}° from overhead</small>`));
    if (number(7024) !== null) tiles.push(tile('Viewing angle', `${esc(Math.round(number(7024)))}° <small>from overhead</small>`));
    return tiles;
}
