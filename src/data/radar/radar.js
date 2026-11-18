// Weather radar. Each radar's latest lowest scan (ODIM HDF5, read by the decoder's
// radar_scan) is drawn as an image around it, reprojected from range and azimuth
// onto the map's Mercator grid. initRadar wires it to the page
import { isDataLink } from '../../messages.js';

let map = null;
let deps = null;

// map: the MapLibre map. enabled(): whether radar files are being decoded. shown():
// whether the radar layer is on. plotted(): counts a scan drawn. changed(): the map
// key has something new to say. Takes radars off once nothing newer has come
export function initRadar(options) {
    map = options.map;
    deps = options;
    setInterval(() => {
        for (var [site, r] of [...radars]) {
            if (Date.now() - r.updated > RADAR_STALE_MS) removeRadar(site);
        }
        deps.changed();
    }, 60 * 1000);
}

// dBZ thresholds and colours, light rain to hail; below 5 dBZ isn't drawn (the map key shows them)
export const RADAR_COLORS = [[5, '#9be1ff'], [10, '#4fc3f7'], [15, '#2196f3'], [20, '#00c853'], [25, '#64dd17'], [30, '#ffeb3b'],
    [35, '#ffc107'], [40, '#ff9800'], [45, '#f44336'], [50, '#c62828'], [55, '#e91e63'], [60, '#9c27b0'], [65, '#ffffff']];

export const radars = new Map();  // site -> { id, time, quantity, updated }, one image each
const RADAR_MAX = 100;  // Radars drawn at once
const RADAR_STALE_MS = 30 * 60 * 1000;  // A radar with nothing newer is taken off
const RADAR_IMAGE_PX = 600;
let radarIds = 0;
let radarLookup = null;

// RGBA for each byte the decoder sends: (dBZ + 32) * 2, 0 for no echo
export function radarColours() {
    if (radarLookup) return radarLookup;
    radarLookup = new Uint8ClampedArray(256 * 4);
    for (var v = 1; v < 255; v++) {
        var dbz = v / 2 - 32, step = RADAR_COLORS.filter(([t]) => dbz >= t).pop();
        if (!step) continue;
        var hex = step[1];
        radarLookup.set([parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16), 255], v * 4);
    }
    return radarLookup;
}

export function renderRadar(scan) {
    var bytes = Uint8Array.from(atob(scan.data), (c) => c.charCodeAt(0));
    var R = 6371008.8, rad = Math.PI / 180;
    var start = scan.rstart * 1000, range = start + scan.nbins * scan.rscale;
    var dLat = range / R / rad, dLon = dLat / Math.cos(scan.lat * rad);
    var north = scan.lat + dLat, south = scan.lat - dLat, west = scan.lon - dLon, east = scan.lon + dLon;
    var merc = (lat) => Math.log(Math.tan(Math.PI / 4 + lat * rad / 2));
    var yN = merc(north), yS = merc(south), size = RADAR_IMAGE_PX;
    var canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    var ctx = canvas.getContext('2d'), image = ctx.createImageData(size, size), lut = radarColours();
    for (var py = 0; py < size; py++) {
        // Rows are evenly spaced in Mercator y, as the map draws the image
        var lat = (2 * Math.atan(Math.exp(yN + (py + 0.5) / size * (yS - yN))) - Math.PI / 2) / rad;
        var dy = (lat - scan.lat) * rad * R, kx = rad * R * Math.cos(lat * rad);
        for (var px = 0; px < size; px++) {
            var dx = (west + (px + 0.5) / size * (east - west) - scan.lon) * kx;
            var bin = Math.floor((Math.hypot(dx, dy) - start) / scan.rscale);
            if (bin < 0 || bin >= scan.nbins) continue;
            // Rays run clockwise from north
            var ray = Math.floor(((Math.atan2(dx, dy) / rad + 360) % 360) / 360 * scan.nrays) % scan.nrays;
            var v = bytes[ray * scan.nbins + bin];
            if (v && lut[v * 4 + 3]) image.data.set(lut.subarray(v * 4, v * 4 + 4), (py * size + px) * 4);
        }
    }
    ctx.putImageData(image, 0, 0);
    return { url: canvas.toDataURL('image/png'), coordinates: [[west, north], [east, north], [east, south], [west, south]] };
}

export const RADAR_FILE_MAX_BYTES = 50 * 1024 * 1024;

// Volumes bigger than this (Cyprus's GAMIC files run 27-39 MB) are fetched at most every
// RADAR_LARGE_EVERY_MS per radar, rather than every few minutes
export const RADAR_LARGE_BYTES = 5 * 1024 * 1024;

export const RADAR_LARGE_EVERY_MS = 15 * 60 * 1000;

export const radarLargeFetched = new Map();  // radar (data_id without its time) -> when last fetched

// A large volume from a radar fetched less than RADAR_LARGE_EVERY_MS ago is skipped.
// The radar is the data_id with its timestamp taken out (LONGRANGE_LCA_20261019180257_00.h5)
export function radarThrottled(feature) {
    var link = (feature.links || []).find((l) => isDataLink(l));
    if (!link || !(link.length > RADAR_LARGE_BYTES)) return false;
    var radar = String((feature.properties || {}).data_id).replace(/\d{8}T?\d{4,6}/g, '');
    if (Date.now() - (radarLargeFetched.get(radar) || 0) < RADAR_LARGE_EVERY_MS) return true;
    radarLargeFetched.set(radar, Date.now());
    if (radarLargeFetched.size > RADAR_MAX) radarLargeFetched.delete(radarLargeFetched.keys().next().value);
    return false;
}

// RMI sends reflectivity and velocity under different headings (PAGW, PAGY, PAHZ):
// a heading whose file held no reflectivity isn't downloaded again
export const radarNoReflectivity = new Set();

export function radarHeading(feature) {
    var gts = (feature.properties || {}).gts;
    return gts && gts.ttaaii ? `${gts.ttaaii} ${gts.cccc}` : null;
}

export function plotRadar(job, scan) {
    if (!scan) {
        var heading = radarHeading(job.feature);
        if (heading && radarNoReflectivity.size < 1000) radarNoReflectivity.add(heading);
        return;
    }
    if (!map.getLayer('points') || !deps.enabled()) return;
    var src = scan.source || {};
    var site = src.NOD || src.RAD || src.WMO || `${scan.lat},${scan.lon}`;
    var d = String(scan.date || ''), t = String(scan.time || '').padStart(6, '0');
    var time = Date.parse(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}Z`) || Date.now();
    var existing = radars.get(site);
    // Filtered reflectivity (DBZH) beats unfiltered (TH) from the same radar, unless it has gone stale
    if (existing && (time < existing.time
        || (scan.quantity !== 'DBZH' && existing.quantity === 'DBZH' && time - existing.time < RADAR_STALE_MS))) return;
    var { url, coordinates } = renderRadar(scan);
    var id = existing ? existing.id : `radar-${radarIds++}`;
    if (existing) {
        map.getSource(id).updateImage({ url, coordinates });
    } else {
        map.addSource(id, { type: 'image', url, coordinates });
        // Under the coverage, tracks and points
        var before = ['swaths-fill', 'tracks', 'points'].find((l) => map.getLayer(l));
        map.addLayer({ id, type: 'raster', source: id, paint: { 'raster-opacity': 0.75, 'raster-fade-duration': 0 },
            layout: { visibility: deps.shown() ? 'visible' : 'none' } }, before);
    }
    radars.delete(site);  // Re-insert so the least recently updated is first
    radars.set(site, { id, time, quantity: scan.quantity, updated: Date.now() });
    if (radars.size > RADAR_MAX) removeRadar(radars.keys().next().value);
    deps.plotted();
    deps.changed();
}

function removeRadar(site) {
    var r = radars.get(site);
    radars.delete(site);
    if (map.getLayer(r.id)) map.removeLayer(r.id);
    if (map.getSource(r.id)) map.removeSource(r.id);
}
