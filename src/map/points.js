// The points on the map: every record, each observation's record by data_id, each
// station's latest, new ids, and adding and removing them. Changes wait in
// pending (add, remove, update) until the page's next flush sends them to the
// map's 'points' source in one go (takePending).
import { isSpaceBased, topicClass } from '../messages/messages.js';
import { rememberStation } from '../data/gts/synop.js';
import { darken } from '../lib/util.js';
import { isLatestOnTrack, markTracksDirty, latestOnTrack, promoteOnTrack } from './tracks.js';
import { addPulse } from './pulses.js';
import { seenLayers } from './layers.js';
import { map } from './map.js';
import { satelliteKey, addSatelliteRow } from '../data/satellite/rows.js';
import { metricValues } from '../data/metrics.js';
import { indexTwin, unindexTwin } from './twins.js';
import { showLegendRow } from '../lib/ui/legend.js';
import { PAGE_CLASSES, classOnPage, SATELLITE_PAGE } from '../page.js';
import { OBS_CLASSES } from '../config.js';

// The kinds Origin has a row for (all but satellites, which have their own section: OWN_SECTION in layers.js)
const ORIGIN_KINDS = new Set(Object.keys(OBS_CLASSES).filter((k) => k !== 'satellite'));

export const records = new Map();  // id -> record for every point on the map
export const byDataId = new Map();  // data_id -> record, so each observation is drawn once
// The latest report on the map from each station, so a replayed report that is
// older than one already here can be left out (bounded by the points on the map)
export const latestByStation = new Map();  // station id -> record
let nextId = 1;
let hooks = null;

export function newId() {
    return nextId++;
}

export function observedAt(record) {
    return Date.parse(record.props.datetime || '') || record.born;
}

// linked(key, record): the reports decoded from a file are on the map (its sidebar
// entries link to the first). plotted(kind): counts a report decoded by an optional
// layer. decoding(kind): whether that layer is still on
export function initPoints(options) {
    hooks = options;
}

export function linkDecoded(key, record) {
    hooks.linked(key, record);
}

export function countPlotted(kind, n = 1) {
    hooks.plotted(kind, n);
}

export function decoding(kind) {
    return hooks.decoding(kind);
}

export const MAX_POINTS = 100000;        // Oldest points are dropped beyond this...
export const MAX_DECODED_POINTS = 30000;  // ...with reports decoded from files capped separately so they can't crowd out the rest,
// ...and satellite points apart again: small files, and swaths while coverage is off (see
// SWATH_FILES_MAX). The satellite page always draws swaths as coverage, so its points are
// only the small files, and fewer are kept
export const MAX_SATELLITE_POINTS = SATELLITE_PAGE ? 20000 : 100000;
export const pools = { wis2: new Map(), decoded: new Map(), satellite: new Map() };  // Same records, in arrival order per cap
const POOL_CAPS = { wis2: MAX_POINTS, decoded: MAX_DECODED_POINTS, satellite: MAX_SATELLITE_POINTS };

export function poolOf(record) {
    if (!record.decodedLayer) return 'wis2';
    return record.subLayer && record.subLayer.endsWith('-satellite') ? 'satellite' : 'decoded';
}

// Waiting for the next flush
let toAdd = [];
let toRemove = [];
let toUpdate = [];

// The changes since the last flush, for the map's 'points' source (updateData), or
// null when there are none; they're cleared
export function takePending() {
    if (!toAdd.length && !toRemove.length && !toUpdate.length) return null;
    var pending = { add: toAdd, remove: toRemove, update: toUpdate };
    toAdd = [];
    toRemove = [];
    toUpdate = [];
    return pending;
}

export function isGateway(record) {
    return ['gts', 'gts-satellite', 'gts-text', 'wis2gts'].includes(record.decodedLayer);
}

// Satellite data by its topic, or by what it decoded to: GTS bulletins under other
// headings can carry satellite reports (identified by 001007)
export function isSpaceRecord(record) {
    return isSpaceBased(record.topic) || /-satellite$/.test(layerOf(record));
}

// A record's kind of observation (an OBS_CLASSES key): from its layer (cache-station,
// gts-upperair...), or for an origin copy from its topic. Airports' METARs are their own
export function recordClass(record) {
    var layer = layerOf(record);
    if (layer === 'origin') return topicClass(record);
    var match = /^(?:origin|cache|gts|replay)-(.+)$/.exec(layer);
    return match ? match[1] : layer;
}

export function layerOf(record) {
    if (record.subLayer) return record.subLayer;
    if (record.decodedLayer) return record.decodedLayer;
    // Origin copies by kind, like the cache's; satellites, which have their own section, stay plain origin
    if (record.channel !== 'cache') return ORIGIN_KINDS.has(topicClass(record)) ? `origin-${topicClass(record)}` : 'origin';
    return `cache-${topicClass(record)}`;
}

// Adds a point, or returns the record already drawn for the same observation.
// The origin and every global cache each republish an observation, so a cache
// copy replaces an origin one but later copies are skipped
export function addPoint(record) {
    // Only the kinds the page shows (see page.js): on the GBON page, the stations and
    // soundings in a file that holds other kinds too. Nothing is drawn for the rest
    if (PAGE_CLASSES && !classOnPage(recordClass(record))) return null;
    var existing = byDataId.get(record.props.data_id);
    if (existing && records.has(existing.id)) {
        // An update replaces the data published earlier under its data_id; the caches'
        // copies of the same update (same pubtime) are skipped like any other copy
        var newer = record.update && Date.parse(record.props.pubtime || '') > Date.parse(existing.props.pubtime || '');
        if (!newer && (existing.channel === 'cache' || record.channel !== 'cache')) return existing;
        removePoint(existing);
    }
    if (record.props.data_id) byDataId.set(record.props.data_id, record);

    records.set(record.id, record);
    rememberStation(record);
    if (record.wsi) {
        var latest = latestByStation.get(record.wsi);
        if (!latest || !records.has(latest.id) || observedAt(record) >= observedAt(latest)) latestByStation.set(record.wsi, record);
    }
    var feature = {
        type: 'Feature',
        id: record.id,
        geometry: { type: 'Point', coordinates: record.coords },
        properties: {
            color: record.color,
            origin: record.channel !== 'cache' && !record.external,
            born: record.born,
            order: record.id,
            layer: layerOf(record),
            format: record.format,
            channel: record.channel,
            centre: record.centre,
            discipline: record.discipline,
            space: isSpaceRecord(record),
            via: record.decodedLayer || '',
            gateway: isGateway(record),
            sat: satelliteKey(record),
            ext: !!record.external,
            replay: !!record.replay,
            outline: darken(record.color),
            topic: record.topic.toLowerCase(),
            ...metricValues(record),
        },
    };
    // While tracks are on, an aircraft is drawn only at its latest report and
    // the track line carries the rest. A ship always is: its track is always drawn
    if (!isLatestOnTrack(record)) feature.properties.superseded = true;
    if (record.track && record.track.startsWith('aircraft:')) feature.properties.tracked = true;
    if (record.track && record.track.startsWith('ship:')) feature.properties.shipTrack = true;
    record.feature = feature;
    toAdd.push(feature);
    if (record.track) markTracksDirty();
    // Swath reports drawn as points arrive a whole file at a time, too many to pulse
    if (!feature.properties.superseded && !record.external && !record.replay && !record.swath) addPulse(feature);
    if (!seenLayers.has(feature.properties.layer)) showLegendRow(feature.properties.layer);
    if (feature.properties.sat) addSatelliteRow(feature.properties.sat);
    indexTwin(record);
    // Other sources are bounded by their own station lists, and stay put
    if (record.external) return record;

    var pool = pools[poolOf(record)];
    pool.set(record.id, record);
    if (pool.size > POOL_CAPS[poolOf(record)]) {
        removePoint(pool.values().next().value);
    }
    return record;
}

export function removePoint(record) {
    if (record.track) markTracksDirty();
    records.delete(record.id);
    unindexTwin(record);
    pools[poolOf(record)].delete(record.id);
    if (byDataId.get(record.props.data_id) === record) byDataId.delete(record.props.data_id);
    if (record.track && latestOnTrack.get(record.track) === record) {
        latestOnTrack.delete(record.track);
        promoteOnTrack(record.track);
    }
    if (record.wsi && latestByStation.get(record.wsi) === record) latestByStation.delete(record.wsi);
    // Its spectrum symbol goes once the point has left the map
    if (record.specImage) {
        var image = record.specImage;
        setTimeout(() => { if (map.hasImage(image)) map.removeImage(image); }, 5000);
    }
    var queued = toAdd.length;
    toAdd = toAdd.filter((f) => f.id !== record.id);
    if (toAdd.length === queued) toRemove.push(record.id);
    toUpdate = toUpdate.filter((u) => u.id !== record.id);
}

// Adds properties to a point already on the map (or still waiting to be drawn)
export function setFeatureProperties(record, props) {
    if (!record.feature || !Object.keys(props).length) return;
    Object.assign(record.feature.properties, props);
    if (!toAdd.includes(record.feature)) {
        toUpdate.push({ id: record.id, addOrUpdateProperties: Object.entries(props).map(([key, value]) => ({ key, value })) });
    }
}
