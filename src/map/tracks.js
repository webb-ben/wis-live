// Tracks. Aircraft and ship reports are joined by identifier in time order: ships
// as lines on the map, aircraft in the air (src/data/aviation/aircraft.js). Rebuilt
// at most every TRACK_REBUILD_MS, when something on a track has changed. (Satellites
// aren't joined: their coverage already shows where they've been.)
import { map } from './map.js';
import { shipTrackKey, reportId } from '../data/reports.js';
import { records, isSpaceRecord, layerOf, setFeatureProperties } from './points.js';
import { aircraftTrack } from '../data/aviation/aircraft.js';
import { segments, distanceKm, unwrap } from '../lib/geo.js';
import { keyChanged } from '../lib/ui/legend.js';
export const TRACK_REBUILD_MS = 2000;
const SHIP_MAX_GAP_MS = 24 * 3600e3;     // Ships report every few hours
const SHIP_MAX_KMH = 80;
const SHIP_MIN_KM = 2;                   // A track shorter than this is a platform that stays put
let tracksDirty = false;
let tracksBuilt = 0;
export let shipTrackLayers = new Set();  // Layers with a ship track drawn, for the map key (set by buildTracks)

// Something on a track changed: rebuild them at the next chance
export function markTracksDirty() {
    tracksDirty = true;
}

// Rebuilds the tracks on the map if they changed and the last build is old enough
export function rebuildTracks(now) {
    if (!tracksDirty || now - tracksBuilt <= TRACK_REBUILD_MS) return;
    tracksDirty = false;
    tracksBuilt = now;
    map.getSource('tracks').setData({ type: 'FeatureCollection', features: buildTracks() });
}

// A decoded report's track key: an aircraft's registration or flight, a ship's call sign
export function trackKey(subLayer, values) {
    var text = (id) => (typeof values.get(id) === 'string' ? values.get(id).trim() : values.has(id) ? String(values.get(id)) : '');
    if (subLayer === 'gts-aircraft') {
        var id = text(1008) || text(1006);
        return id ? `aircraft:${id}` : null;
    }
    if (subLayer && subLayer.endsWith('-ship')) return shipTrackKey(text(1011) || reportId(values));
    return null;
}

function buildTracks() {
    var groups = new Map();
    for (var record of records.values()) {
        if (!record.track) continue;
        if (!groups.has(record.track)) groups.set(record.track, []);
        groups.get(record.track).push(record);
    }
    var features = [];
    var shipLayers = new Set();
    for (var [key, reports] of groups) {
        reports.sort((a, b) => a.observed - b.observed);
        if (key.startsWith('ship:')) {
            var lines = shipTrack(key, reports);
            features.push(...lines);
            if (lines.length) shipLayers.add(lines[0].properties.layer);
            continue;
        }
        var last = reports[reports.length - 1];
        features.push(...aircraftTrack(key, reports, map.getZoom(), {
            lastId: last.id,
            color: last.color,
            born: last.born,
            layer: 'gts-tracks',
            sat: null,
            channel: last.channel,
            centre: last.centre,
            format: last.format,
            discipline: last.discipline,
            space: isSpaceRecord(last),
            topic: last.topic.toLowerCase(),
        }));
    }
    if ([...shipLayers].join() !== [...shipTrackLayers].join()) keyChanged();
    shipTrackLayers = shipLayers;
    return features;
}

// One ship's reports as lines (none if it hasn't moved). Runs are split where
// reports are too far apart in time, or would need an impossible speed (two ships
// sharing an identifier); the line goes on the Tracks row under the latest report's layer
function shipTrack(key, reports) {
    var points = reports.map((r) => ({ t: r.observed, c: r.coords, id: r.id }));
    var runs = segments(points, (a, b) => b.t - a.t <= SHIP_MAX_GAP_MS
        && distanceKm(a.c, b.c) / Math.max((b.t - a.t) / 3600e3, 0.25) <= SHIP_MAX_KMH, 2)
        .filter((run) => run.slice(1).reduce((km, p, i) => km + distanceKm(run[i].c, p.c), 0) >= SHIP_MIN_KM);
    if (!runs.length) return [];
    var last = reports[reports.length - 1];
    var layer = layerOf(last);
    // A LineString each, as the tracks layer draws only those
    return runs.map((run) => ({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: unwrap(run.map((p) => p.c)) },
        properties: {
            kind: 'ship',
            label: `Ship ${key.slice(5)}`,
            count: reports.length,
            lastId: last.id,
            color: last.color,
            born: last.born,
            // On with its ship's layer; there's no switch for the tracks alone
            layer,
            via: last.decodedLayer || '',
            sat: null,
            channel: last.channel,
            centre: last.centre,
            format: last.format,
            discipline: last.discipline,
            space: false,
            replay: !!last.replay,
            topic: last.topic.toLowerCase(),
        },
    }));
}

// The latest report on each aircraft or ship track: a report takes over from the
// track's previous latest, unless that one was observed later
export const latestOnTrack = new Map();  // track key -> record

// Whether a report is its track's latest (it becomes so unless a later one is here)
export function isLatestOnTrack(record) {
    if (!record.track) return true;
    var current = latestOnTrack.get(record.track);
    if (current && records.has(current.id)) {
        if (current.observed > record.observed) return false;
        supersede(current);
    }
    latestOnTrack.set(record.track, record);
    return true;
}

// Flags a point as no longer its track's latest, in place if it hasn't been drawn yet
function supersede(record) {
    setFeatureProperties(record, { superseded: true });
}

// When a track's latest report goes, the newest one left takes over its dot
export function promoteOnTrack(track) {
    var next = null;
    for (var other of records.values()) {
        if (other.track === track && (!next || other.observed > next.observed)) next = other;
    }
    if (!next) return;
    latestOnTrack.set(track, next);
    if (next.feature.properties.superseded) setFeatureProperties(next, { superseded: false });
}
