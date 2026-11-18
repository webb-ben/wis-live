// Station twins: airports that are also weather stations
import { layerOf, records, setFeatureProperties, newId, addPoint } from './points.js';
import { distanceKm } from '../lib/geo.js';
import { metricValues } from '../data/metrics.js';
import { OBS_CLASSES } from '../config.js';

// One point per station: many airports also report as weather stations,
// through WIS2 or the GTS (synops with WMO or WIGOS ids), with no identifier in
// common with the METAR. An airport within TWIN_KM of such a station (WIS2 cache,
// GTS or replay) is taken to be the same station: the station's point stays, the
// airport square is hidden while any layer with a twin of it is on (see
// applyMapFilter), and the station's popup links the METAR.
export const TWIN_KM = 2;

export const TWIN_CELL = 0.05;  // Grid cell in degrees (about 5 km), so lookups only look next door

export const TWIN_LAYERS = ['cache-station', 'gts-station', 'replay-station'];

export const twinGrid = new Map();  // cell -> Set of airport and station records

export function twinKind(record) {
    if (record.subLayer === 'airports') return 'airport';
    return !record.external && TWIN_LAYERS.includes(layerOf(record)) ? 'station' : null;
}

export function twinCell([lon, lat], dx = 0, dy = 0) {
    return `${Math.floor(lon / TWIN_CELL) + dx},${Math.floor(lat / TWIN_CELL) + dy}`;
}

// Records of a kind within TWIN_KM, nearest first
export function twinsNear(record, kind) {
    var near = [];
    for (var dx = -1; dx <= 1; dx++) {
        for (var dy = -1; dy <= 1; dy++) {
            for (var other of twinGrid.get(twinCell(record.coords, dx, dy)) || []) {
                if (other === record || twinKind(other) !== kind || !records.has(other.id)) continue;
                var km = distanceKm(record.coords, other.coords);
                if (km <= TWIN_KM) near.push([km, other]);
            }
        }
    }
    return near.sort((a, b) => a[0] - b[0]).map(([, other]) => other);
}

// Flags an airport with each station layer that has a twin of it (twin_gts-station and so on)
export function markTwins(airport) {
    var layers = new Set(twinsNear(airport, 'station').map(layerOf));
    setFeatureProperties(airport, Object.fromEntries(TWIN_LAYERS.map((l) => [`twin_${l}`, layers.has(l)])));
}

export function indexTwin(record) {
    var kind = twinKind(record);
    if (!kind || !record.coords) return;
    var cell = twinCell(record.coords);
    if (!twinGrid.has(cell)) twinGrid.set(cell, new Set());
    twinGrid.get(cell).add(record);
    if (kind === 'airport') markTwins(record);
    else twinsNear(record, 'airport').forEach(markTwins);
}

// A station that goes may leave its airport with no twin, and so shown again
export function unindexTwin(record) {
    var cell = record.coords && twinGrid.get(twinCell(record.coords));
    if (!cell || !cell.delete(record)) return;
    if (!cell.size) twinGrid.delete(twinCell(record.coords));
    if (twinKind(record) === 'station') twinsNear(record, 'airport').forEach(markTwins);
}

// Adds a station from another source, or refreshes the readings of one already on the map
export function externalStation(stations, s) {
    // Fade by the age of the observation, like WIS2 points
    var born = isFinite(s.observed) ? Math.min(s.observed, Date.now()) : Date.now();
    var datetime = isFinite(s.observed) ? new Date(s.observed).toISOString() : undefined;
    var record = stations.get(s.id);
    if (record) {
        record.decoded = { subsets: 1, index: 0, rows: s.rows };
        record.notification = s.notification;
        if (datetime) record.props.datetime = datetime;
        setFeatureProperties(record, { ...metricValues(record), born });
        return record;
    }
    record = {
        id: newId(),
        coords: [s.lon, s.lat],
        topic: `${s.layer}/${s.path}`,
        channel: s.layer,
        centre: s.centre,
        path: s.path,
        discipline: 'weather',
        webcam: false,
        external: true,
        badge: s.badge,
        subLayer: s.layer,
        props: { data_id: `${s.layer}:${s.id}`, metadata_id: s.name, ...(datetime ? { datetime } : {}) },
        links: [s.link],
        wsi: s.id,
        format: s.format,
        color: OBS_CLASSES.station.color,
        source: null,
        notification: s.notification,
        decoded: { subsets: 1, index: 0, rows: s.rows },
        born,
    };
    stations.set(s.id, record);
    addPoint(record);
    return record;
}
