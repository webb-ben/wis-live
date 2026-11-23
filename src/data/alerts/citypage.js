// Environment Canada citypage forecasts on the map, one point per site (the
// view is src/plots/citypage.js)
import { OBS_CLASSES } from '../../config.js';
import { disciplineOf } from '../../messages/messages.js';
import { records, byDataId, newId, addPoint, removePoint, linkDecoded, countPlotted } from '../../map/points.js';

// Citypage forecasts come in English and French for each site and are reissued
// through the day: keep one point per site, the latest, preferring English
export function plotCitypage(job, xml) {
    var doc = new DOMParser().parseFromString(xml, 'application/xml');
    var site = doc.querySelector('siteData > location > name');
    if (!site) return;
    var coord = (v) => {
        var m = /^([\d.]+)([NSEW])$/.exec((v || '').trim());
        return m ? Number(m[1]) * (/[SW]/.test(m[2]) ? -1 : 1) : NaN;
    };
    var lat = coord(site.getAttribute('lat')), lon = coord(site.getAttribute('lon'));
    if (!isFinite(lat) || !isFinite(lon)) return;

    var french = /_fr\.xml$/i.test(job.href);
    var key = `citypage:${site.getAttribute('code') || site.textContent.trim()}`;
    var existing = byDataId.get(key);
    if (existing && records.has(existing.id)) {
        if (french && !existing.french) return;
        removePoint(existing);
    }
    var props = job.feature.properties || {};
    var [channel, t] = job.topic.split('/a/wis2/');
    var record = addPoint({
        id: newId(),
        coords: [lon, lat],
        topic: job.topic,
        channel: channel,
        centre: t.split('/', 1)[0],
        path: t.slice(t.indexOf('/') + 1),
        discipline: disciplineOf(t),
        webcam: false,
        decodedLayer: job.kind,
        // Forecasts carry the warnings in effect for the site; an origin copy's are origin points
        subLayer: channel === 'cache' ? 'cache-warning' : 'origin-warning',
        props: { data_id: key, pubtime: props.pubtime, metadata_id: site.textContent.trim() },
        links: job.feature.links || [],
        notification: job.feature,
        wsi: null,
        french: french,
        format: 'xml',
        color: OBS_CLASSES.warning.color,
        source: null,
        decoded: { xml: xml },
        born: Date.now(),
    });
    countPlotted(job.kind);
    linkDecoded(job.key, record);
}
