// Lightning. The Met Office sends each batch of flashes as BUFR (one subset per
// flash: its position, then the sensors that located it) and as a CSV; both are
// plotted, so a flash seen in one is skipped in the other
import { OBS_CLASSES } from '../../config.js';
import { disciplineOf } from '../../messages/messages.js';
import { newId, addPoint, linkDecoded, countPlotted } from '../../map/points.js';

const FLASHES_MAX = 5000;
const flashesSeen = new Set();

// Whether a flash was plotted already (from the other copy of the batch); notes it if not
export function seenFlash(time, lat, lon) {
    var key = `${Math.round(time / 100)}:${lat.toFixed(2)},${lon.toFixed(2)}`;
    if (flashesSeen.has(key)) return true;
    flashesSeen.add(key);
    if (flashesSeen.size > FLASHES_MAX) flashesSeen.delete(flashesSeen.values().next().value);
    return false;
}

// Time of a BUFR flash to the millisecond (seconds are 004006)
export function flashTime(values) {
    var [y, mo, d, h, mi, sec] = [4001, 4002, 4003, 4004, 4005, 4006].map((id) => values.get(id));
    return Date.UTC(y, mo - 1, d, h, mi || 0) + Math.round((sec || 0) * 1000);
}

// date,time,microseconds,FLP ID,quality,latitude,longitude,error
// 19/10/2026,04:20:48,286057,1,G,50.206,-1.228,10.62
export function plotLightningText(job, text) {
    var props = job.feature.properties || {};
    var [channel, t] = job.topic.split('/a/wis2/');
    var line = /^(\d{2})\/(\d{2})\/(\d{4}),(\d{2}):(\d{2}):(\d{2}),(\d+),[^,]*,([^,]*),(-?[\d.]+),(-?[\d.]+)/;
    var first = null;
    text.split('\n').forEach((row, i) => {
        var m = line.exec(row.trim());
        if (!m) return;
        var [, d, mo, y, h, mi, sec, micro, quality] = m;
        var lat = Number(m[9]), lon = Number(m[10]);
        if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
        var time = Date.UTC(y, mo - 1, d, h, mi, sec) + Math.round(Number(micro) / 1000);
        if (seenFlash(time, lat, lon)) return;
        var rows = [
            [4001, 'Year', Number(y), 'a'], [4002, 'Month', Number(mo), 'mon'], [4003, 'Day', Number(d), 'd'],
            [4004, 'Hour', Number(h), 'h'], [4005, 'Minute', Number(mi), 'min'], [4006, 'Second', Number(sec) + Number(micro) / 1e6, 's'],
            [5001, 'Latitude', lat, 'deg'], [6001, 'Longitude', lon, 'deg'],
            [0, 'Quality', quality, ''],  // The CSV's error column has no stated unit, so it's left out
        ];
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
            subLayer: channel === 'cache' ? 'cache-warning' : 'origin-warning',  // An origin copy's are origin points
            observed: time,
            props: { data_id: `${props.data_id}#${i}`, pubtime: props.pubtime, datetime: new Date(time).toISOString() },
            links: job.feature.links || [],
            notification: job.feature,
            wsi: null,
            format: 'text',
            color: OBS_CLASSES.warning.color,
            source: null,
            decoded: { subsets: 1, index: 0, rows: rows, profile: null },
            born: Date.now(),
        });
        countPlotted(job.kind);
        if (!first) linkDecoded(job.key, first = record);
    });
}
