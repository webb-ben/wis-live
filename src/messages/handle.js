import { rememberLinks, bufrSource } from '../data/download.js';
import { noteCacheLinks } from '../data/caches.js';
import { noteDataset } from '../data/catalogue.js';
import { revealGatewayRows, DECODE_LAYERS, decodeEnabled, queueDecode } from '../data/decodeQueue.js';
import { pointFor, stationId, disciplineOf, formatOf, isUpdate, topicClass } from './messages.js';
import { latestByStation, records, observedAt, removePoint, newId, addPoint } from '../map/points.js';
import { COLORS, OBS_CLASSES } from '../config.js';
import { shipTrackKey } from '../data/reports.js';
import { queueStationDecode } from '../data/stationDecode.js';


export const ignoredTopics = [
    '/a/wis2/ca-eccc-msc/data/core/weather/prediction',
];

// Turns a notification into a map point, returning its record (or nothing)
export function onMessage(topic, feature, replay) {
    // Kept for every message so the sidebar can find a downloadable copy
    rememberLinks((feature.properties || {}).data_id, feature.links || []);
    // And which global cache each host belongs to, timed when first seen
    if (topic.startsWith('cache/')) noteCacheLinks(feature);
    noteDataset(feature);
    revealGatewayRows(topic, feature);
    // Replayed messages are only drawn: decoding a past hour of files would swamp the decoder
    var kind = !replay && Object.keys(DECODE_LAYERS).find((key) => DECODE_LAYERS[key](topic, feature));
    if (kind && decodeEnabled.has(kind)) queueDecode(kind, topic, feature);

    if (ignoredTopics.some((t) => topic.includes(t))) {
        return; // Ignore this topic
    }
    if (!feature.geometry || !feature.geometry.hasOwnProperty('type')){
        console.debug(`Message from ${topic} missing geometry`);
        return;
    }

    var coords = pointFor(feature.geometry);
    if (!coords) {
        console.debug(`Message from ${topic} has invalid or too large geometry`);
        return;
    }

    var props = feature.properties || {};
    var links = feature.links || [];
    // A replayed report the map already has a report as recent from the same station
    // for is neither drawn nor decoded
    if (replay) {
        var station = stationId(props), latest = station && latestByStation.get(station);
        if (latest && records.has(latest.id) && observedAt(latest) >= (Date.parse(props.datetime || '') || 0)) return null;
        // Replays come newest published first, so a late-published older report may be
        // here already; the newer one takes its place
        if (latest && records.has(latest.id) && latest.replay) removePoint(latest);
    }

    var [channel, t] = topic.split('/a/wis2/');
    var webcam = t.includes('webcam');
    var record = {
        id: newId(),
        coords: coords,
        topic: topic,
        channel: channel,
        centre: t.split('/', 1)[0],
        path: t.slice(t.indexOf('/') + 1),
        discipline: disciplineOf(t),
        webcam: webcam,
        props: props,
        links: links,
        wsi: stationId(props),
        format: formatOf(feature),
        color: COLORS.origin,
        source: webcam ? null : bufrSource(feature, props, topic),
        update: isUpdate(feature),
        notification: feature,
        decoded: null,
        replay: !!replay,
        // Replayed points fade by when they were published
        born: replay ? Math.min(Date.parse(props.pubtime) || Date.now(), Date.now()) : Date.now(),
    };
    if (channel === 'cache' || replay) record.color = OBS_CLASSES[topicClass(record)].color;
    if (replay) record.subLayer = `replay-${topicClass(record)}`;
    if (topicClass(record) === 'ship') record.track = shipTrackKey(record.wsi);
    var added = addPoint(record);
    if (added === record) queueStationDecode(record);
    return added;
}
