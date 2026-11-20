import { rememberLinks, bufrSource } from '../data/download.js';
import { noteCacheLinks } from '../data/caches.js';
import { noteDataset } from '../data/catalogue.js';
import { revealGatewayRows, DECODE_LAYERS, decodeEnabled, queueDecode } from '../data/decodeQueue.js';
import { pointFor, stationId, disciplineOf, formatOf, isUpdate, topicClass, isSpaceBased, GATEWAY_TOPIC } from './messages.js';
import { SATELLITE_PAGE, SATELLITES_ON_PAGE, GTS_PAGE, PAGE_CLASSES } from '../page.js';
import { latestByStation, records, observedAt, removePoint, newId, addPoint } from '../map/points.js';
import { COLORS, OBS_CLASSES } from '../config.js';
import { shipTrackKey } from '../data/reports.js';
import { queueStationDecode } from '../data/stationDecode.js';


export const ignoredTopics = [
    '/a/wis2/ca-eccc-msc/data/core/weather/prediction',
];

// Kinds of observation the GBON page never shows, by what a notification's topic says
// it holds: their files aren't downloaded there. Files that don't say are decoded,
// and only their stations and soundings drawn (see addPoint)
// Whether this page takes a notification (see page.js): satellites on theirs (only them)
// and All observations; on
// the GTS page only the gateways'; on a page of some kinds (GBON, metocean) nothing
// whose topic says it's another kind, so its file isn't downloaded. A topic that
// doesn't say ('other') is taken, and only the page's kinds of report in its file drawn
// (see addPoint)
export function topicOnPage(topic, feature) {
    if (isSpaceBased(topic) ? !SATELLITES_ON_PAGE : SATELLITE_PAGE) return false;
    if (GTS_PAGE && !GATEWAY_TOPIC.test(topic)) return false;
    if (!PAGE_CLASSES) return true;
    var props = (feature && feature.properties) || {};
    var cls = topicClass({ topic, webcam: topic.includes('webcam'), props });
    return cls === 'other' || PAGE_CLASSES.includes(cls);
}

// Turns a notification into a map point, returning its record (or nothing)
export function onMessage(topic, feature, replay) {
    // Each page takes only its own, live, replayed or shown from the catalogue
    if (!topicOnPage(topic, feature)) return;
    // Kept for every message so the sidebar can find a downloadable copy
    rememberLinks((feature.properties || {}).data_id, feature.links || []);
    // And which global cache each host belongs to, timed when first seen
    if (topic.startsWith('cache/')) noteCacheLinks(feature);
    noteDataset(feature);
    revealGatewayRows(topic, feature);
    // Replayed messages are only drawn: decoding a past hour of files would swamp the decoder
    var kind = !replay && Object.keys(DECODE_LAYERS).find((key) => DECODE_LAYERS[key](topic, feature));
    if (kind && decodeEnabled.has(kind)) {
        queueDecode(kind, topic, feature);
        // The satellite page draws a decoded file as coverage, not its notification as a point
        if (SATELLITE_PAGE) return null;
    }

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
