import { GATEWAY_SATELLITE, isDataLink, formatOf, GATEWAY_TOPIC, isSpaceBased, pointFor, GATEWAY_AIRCRAFT, GATEWAY_UPPER_AIR, topicClass, disciplineOf, isUpdate } from '../messages/messages.js';
import { SYNOP_TOPIC, plotSynopBulletin } from './gts/synop.js';
import { radarNoReflectivity, radarHeading, RADAR_FILE_MAX_BYTES, radarThrottled, plotRadar } from './radar/radar.js';
import { seenLayers, effectiveHidden } from '../map/layers.js';
import { decodeKey } from '../lib/ui/queue.js';
import { decodeHref, DATA_LINKS_MAX, fetchTracked, bufrPart } from './download.js';
import { plotCitypage } from './alerts/citypage.js';
import { plotLightningText, seenFlash, flashTime } from './lightning/lightning.js';
import { callDecoder } from './decoder.js';
import { SWATH_MIN_REPORTS, addSwathFile } from './satellite/coverage.js';
import { metricValues } from './metrics.js';
import { reportClass, reportTime, reportId } from './reports.js';
import { OBS_CLASSES, COLORS, METRICS } from '../config.js';
import { newId, addPoint, linkDecoded } from '../map/points.js';
import { trackKey, markTracksDirty } from '../map/tracks.js';
import { aircraftAltitude } from './aviation/aircraft.js';
import { applyMapFilter } from '../map/filter.js';
import { attachSpectrum } from './stationDecode.js';
import { showLegendRow } from '../lib/ui/legend.js';
import { SATELLITE_PAGE } from '../page.js';


export const SATELLITE_ROWS_MAX = 200;  // Decoded values kept per satellite report (IASI has thousands of channels)

// Optional layers decoded in the background: some notifications carry no
// geometry, but the reports inside the BUFR file do, so download and decode the
// file and plot each report.
// GTS-to-WIS2: every BUFR bulletin series (T1 = I); reports are sorted into
// sublayers once decoded
export const GTS_TOPIC = /\/a\/wis2\/[^/]+-gts-to-wis2\/data\//;

// WIS2-to-GTS: whatever BUFR those centres pass on (any size limit the link states applies)
export const WIS2_GTS_TOPIC = /\/a\/wis2\/[^/]+-wis2-to-gts\//;

// Files: any other small cached file without geometry that may be BUFR, plus
// XML whose location is inside the file (Environment Canada citypage forecasts)
export const DECODE_FILE_MAX_BYTES = 200 * 1024;

export const DECODE_FILE_MAX_REPORTS = 300;  // Per file, so a satellite swath can't flood the map

export const IGNORED_SATELLITES = [852];  // 0 01 007 numbers left out: 852 is a combination of Metop-1 to Metop-3

export const NOT_BUFR = ['grib', 'xml', 'csv', 'json', 'image', 'hdf', 'text'];

// Satellite files, from the cache or the GTS, are decoded while the Satellites row
// is on, whatever Cache and GTS-to-WIS2 say, and may be larger than other files
export const SATELLITE_FILE_MAX_BYTES = 16 * 1024 * 1024;  // Big passes (IASI runs to 15 MB) are sampled, see _messages

export const DECODE_LAYERS = {
    gts: (topic, feature) => topic.startsWith('cache/') && GTS_TOPIC.test(topic) && !GATEWAY_SATELLITE.test(topic),
    // Text SYNOPs, decoded here rather than by pybufrkit (see parseSynopBulletin)
    'gts-text': (topic, feature) => topic.startsWith('cache/') && SYNOP_TOPIC.test(topic)
        && !(feature.links || []).some((l) => isDataLink(l) && l.length > DECODE_FILE_MAX_BYTES),
    'gts-satellite': (topic, feature) => topic.startsWith('cache/') && GTS_TOPIC.test(topic) && GATEWAY_SATELLITE.test(topic),
    wis2gts: (topic, feature) => topic.startsWith('cache/') && WIS2_GTS_TOPIC.test(topic) && !NOT_BUFR.includes(formatOf(feature))
        && !(feature.links || []).some((l) => isDataLink(l) && l.length > DECODE_FILE_MAX_BYTES),
    // Gateway centres belong to their own layers above
    files: (topic, feature) => topic.startsWith('cache/') && !GATEWAY_TOPIC.test(topic) && !isSpaceBased(topic) && decodableFile(topic, feature),
    // ODIM HDF5 radar volumes. Velocity-only files are skipped by name, or by their
    // GTS heading once a file under it has turned out to hold no reflectivity
    radar: (topic, feature) => topic.startsWith('cache/') && /radar/i.test(topic) && formatOf(feature) === 'hdf'
        && !radarNoReflectivity.has(radarHeading(feature))
        && !(feature.links || []).some((l) => isDataLink(l) && (l.length > RADAR_FILE_MAX_BYTES || /vrad/i.test(l.href))),
    // Any space-based file not drawn from its notification: no geometry, or a swath too
    // large to plot. On the satellite page, where everything is coverage, every one
    // (its notification isn't drawn as a point then, see onMessage)
    'cache-satellite': (topic, feature) => topic.startsWith('cache/') && !GATEWAY_TOPIC.test(topic) && isSpaceBased(topic)
        && (SATELLITE_PAGE || !(feature.geometry && feature.geometry.type && pointFor(feature.geometry))) && !NOT_BUFR.includes(formatOf(feature))
        && !(feature.links || []).some((l) => isDataLink(l) && l.length > SATELLITE_FILE_MAX_BYTES),
};

export function decodableFile(topic, feature) {
    return !feature.geometry
        && (!NOT_BUFR.includes(formatOf(feature)) || (formatOf(feature) === 'xml' && /citypage/i.test(topic + JSON.stringify(feature.links || [])))
            || (formatOf(feature) === 'text' && /lightning/i.test(topic)))
        && (feature.links || []).some((l) => isDataLink(l) && l.length > 0 && l.length <= DECODE_FILE_MAX_BYTES);
}

export const DECODE_FETCH_TIMEOUT_MS = 20000;

export const decodeEnabled = new Set();

export const decodePlotted = { gts: 0, 'gts-satellite': 0, 'gts-text': 0, wis2gts: 0, files: 0, 'cache-satellite': 0, radar: 0 };

// Two queues, so satellite files (large, and many at once after each pass) don't hold
// up stations, ships and aircraft, nor the other way round. Each has its own downloads
// (fetches at once) and cap (oldest dropped when it falls behind); they share the
// background decoder, taking turns
export const decodeQueues = {
    obs: { queue: [], ready: [], fetching: 0, fetches: 3, max: 100 },
    satellite: { queue: [], ready: [], fetching: 0, fetches: 2, max: 40 },
};

export const queueFor = (kind) => decodeQueues[/satellite$/.test(kind) ? 'satellite' : 'obs'];

export let lastDecoded = 'satellite';  // Which queue the decoder took from last

export let decodeBusy = false;

export const decodeSeen = new Set();

// Shows the GTS Aircraft, Satellites, radar and WIS2-to-GTS rows once such a file
// has been announced, even though it isn't downloaded while the row is off
export function revealGatewayRows(topic, feature) {
    if (!seenLayers.has('satellite') && isSpaceBased(topic)) showLegendRow('satellite');
    if (!seenLayers.has('radar') && DECODE_LAYERS.radar(topic, feature)) showLegendRow('radar');
    if (!seenLayers.has('wis2gts') && WIS2_GTS_TOPIC.test(topic)) showLegendRow('wis2gts');
    if (!seenLayers.has('gts-aircraft') && GATEWAY_AIRCRAFT.test(topic)) showLegendRow('gts-aircraft');
}

// GTS aircraft files are only fetched while their group is on (satellite files
// have decode layers of their own, on only while Satellites is)
export function satelliteSkipped(kind, topic) {
    if (kind === 'gts' && GATEWAY_AIRCRAFT.test(topic)) return effectiveHidden().includes('gts-aircraft');
    return false;
}

export function queueDecode(kind, topic, feature) {
    var key = decodeKey(topic, feature);
    var href = decodeHref(feature);
    if (!href || !key || decodeSeen.has(key)) return;
    if (satelliteSkipped(kind, topic)) return;
    if (kind === 'radar' && radarThrottled(feature)) return;
    decodeSeen.add(key);
    if (decodeSeen.size > DATA_LINKS_MAX) decodeSeen.delete(decodeSeen.values().next().value);
    // XML needs no decoder, so it skips the queue rather than waiting behind BUFR
    if (formatOf(feature) === 'xml') {
        fetchTracked(href, { signal: AbortSignal.timeout(DECODE_FETCH_TIMEOUT_MS) })
            .then((response) => (response.ok ? response.text() : null))
            .then((xml) => xml && decodeEnabled.has(kind) && plotCitypage({ kind, key, topic, feature, href }, xml))
            .catch((err) => console.debug(`Could not fetch ${href}: ${err.message}`));
        return;
    }
    // So do text SYNOPs (JMA sends them as .txt, DWD with no extension)
    if (kind === 'gts-text') {
        fetchTracked(href, { signal: AbortSignal.timeout(DECODE_FETCH_TIMEOUT_MS) })
            .then((response) => (response.ok ? response.text() : null))
            .then((text) => text && decodeEnabled.has(kind) && plotSynopBulletin({ kind, key, topic, feature, href }, text))
            .catch((err) => console.debug(`Could not fetch ${href}: ${err.message}`));
        return;
    }
    // And text lightning reports, which are a short CSV
    if (formatOf(feature) === 'text') {
        fetchTracked(href, { signal: AbortSignal.timeout(DECODE_FETCH_TIMEOUT_MS) })
            .then((response) => (response.ok ? response.text() : null))
            .then((text) => text && decodeEnabled.has(kind) && plotLightningText({ kind, key, topic, feature, href }, text))
            .catch((err) => console.debug(`Could not fetch ${href}: ${err.message}`));
        return;
    }
    var q = queueFor(kind);
    q.queue.push({ kind, key, topic, feature, href });
    if (q.queue.length > q.max) decodeSeen.delete(q.queue.shift().key);  // A later copy may try again
    pumpDecode();
}

// Downloads take far longer than decoding (tens of ms), so several files are
// fetched at once while the decoder works through the ones already here (ready)
export function pumpDecode() {
    for (var q of Object.values(decodeQueues)) {
        while (q.fetching < q.fetches && q.ready.length < q.fetches && q.queue.length) {
            fetchForDecode(q, q.queue.pop());  // Newest first, to stay close to real time
        }
    }
}

export async function fetchForDecode(q, job) {
    q.fetching++;
    try {
        // A stalled server would otherwise hold up the queue
        // Radar volumes can run to tens of MB, so they get longer
        // Picked again now, as it may have waited in the queue while a host was found to block
        // browsers, or while another download was the first try of the host it picked
        job.href = decodeHref(job.feature);
        if (!job.href) throw new Error('no copy on a host that allows browser downloads');
        var response = await fetchTracked(job.href, { signal: AbortSignal.timeout(DECODE_FETCH_TIMEOUT_MS * (job.kind === 'radar' ? 4 : 1)) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        var raw = new Uint8Array(await response.arrayBuffer());
        var bytes = job.kind === 'radar' ? raw : bufrPart(raw);
        if (bytes) q.ready.push({ job, bytes });
    } catch (err) {
        decodeSeen.delete(job.key);  // Let another cache's copy try
        console.debug(`Could not fetch ${job.href}: ${err.message}`);
    }
    q.fetching--;
    decodeNext();
    pumpDecode();
}

export async function decodeNext() {
    // The queues take turns; one with nothing ready lets the other go again
    var turn = lastDecoded === 'satellite' ? ['obs', 'satellite'] : ['satellite', 'obs'];
    var from = turn.find((name) => decodeQueues[name].ready.length);
    if (decodeBusy || !from) return;
    decodeBusy = true;
    lastDecoded = from;
    var { job, bytes } = decodeQueues[from].ready.shift();
    try {
        if (job.kind === 'radar') {
            plotRadar(job, JSON.parse(await callDecoder('radar_scan', bytes)));
        } else {
            var subsets = JSON.parse(await callDecoder('decode_subsets', bytes, DECODE_FILE_MAX_REPORTS));
            // Satellite files big enough for coverage are kept as one swath, not as points
            var swath = subsets.length >= SWATH_MIN_REPORTS ? [] : null;
            subsets.forEach(([rows, profile, index], i) => plotDecodedReport(job, rows, profile, i, index, swath));
            if (swath && swath.length >= SWATH_MIN_REPORTS) addSwathFile(job, swath);
            else if (swath) swath.forEach((record) => plotRecord(job, record));
        }
    } catch (err) {
        console.debug(`Could not decode ${job.href}: ${err.message}`);
    }
    decodeBusy = false;
    decodeNext();
    pumpDecode();
}

export function plotDecodedReport(job, rows, profile, index, fileIndex, swath) {
    var values = new Map();
    for (var [id, name, value] of rows) {
        if (!values.has(id)) values.set(id, value);
    }
    var lat = [5001, 5002].map((id) => values.get(id)).find((v) => typeof v === 'number');
    var lon = [6001, 6002].map((id) => values.get(id)).find((v) => typeof v === 'number');
    if (lat === undefined || lon === undefined || Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
    // Products made from several satellites aren't one satellite's coverage (and spread
    // over so much of the globe that outlining them on hover breaks); left out
    if (IGNORED_SATELLITES.includes(values.get(1007))) return;

    var props = job.feature.properties || {};
    var [channel, t] = job.topic.split('/a/wis2/');
    // GTS reports join GTS-to-WIS2's groups and decoded cache files join Cache's
    // The bulletin header says what it holds for aircraft (IUA) and satellites (IN, IE)
    var cls = GATEWAY_AIRCRAFT.test(job.topic) ? 'aircraft' : GATEWAY_SATELLITE.test(job.topic) ? 'satellite' : reportClass(values, profile, rows);
    // Upper-air bulletins (IU…: TEMP, PILOT, wind profiler) carry station numbers, but aren't weather stations
    if (cls === 'station' && GATEWAY_UPPER_AIR.test(job.topic)) cls = 'upperair';
    // WIS2 topics say what they hold (…/moored-buoys-and-moorings), which beats guessing from
    // the identifiers: buoys and ships with WIGOS ids would otherwise read as weather stations
    // Lightning flashes join the warnings, which are cache-only, but do come as BUFR
    var lightning = /lightning/i.test(job.topic);
    if (!GATEWAY_TOPIC.test(job.topic)) {
        var fromTopic = topicClass({ topic: job.topic, webcam: false, props });
        if (fromTopic !== 'other' && (lightning || !OBS_CLASSES[fromTopic].cacheOnly)) cls = fromTopic;
    }
    var subLayer = job.kind === 'gts' || job.kind === 'gts-satellite' ? `gts-${cls}` : job.kind === 'files' || job.kind === 'cache-satellite' ? `cache-${cls}` : null;
    if (lightning && seenFlash(flashTime(values), lat, lon)) return;
    if (subLayer && subLayer.endsWith('-satellite') && effectiveHidden().includes(subLayer)) return;
    var kept = subLayer && subLayer.endsWith('-satellite') ? trimRows(rows) : rows;
    var record = {
        id: newId(),
        coords: [lon, lat],
        topic: job.topic,
        channel: channel,
        centre: t.split('/', 1)[0],
        path: t.slice(t.indexOf('/') + 1),
        discipline: disciplineOf(t),
        webcam: false,
        decodedLayer: job.kind,
        subLayer: subLayer,
        update: isUpdate(job.feature),
        track: trackKey(subLayer, values),
        observed: Date.parse(reportTime(values) || '') || Date.now(),
        props: {
            data_id: `${props.data_id}#${index}`,
            pubtime: props.pubtime,
            datetime: reportTime(values),
        },
        links: job.feature.links || [],
        notification: job.feature,
        wsi: reportId(values),
        format: 'bufr',
        color: subLayer ? OBS_CLASSES[cls].color : COLORS[job.kind],
        source: null,
        decoded: { subsets: 1, index: 0, rows: kept, profile: profile, trimmed: kept !== rows },
        alt: aircraftAltitude(values, t),
        born: Date.now(),
    };
    if (subLayer && subLayer.endsWith('-satellite')) {
        record.fileKey = props.data_id;  // Reports from one file make one swath
        record.fileIndex = fileIndex;
        // Gathered up by decodeNext, which decides whether the file is a swath
        if (swath) { swath.push(record); return; }
    }
    plotRecord(job, record);
}

export function plotRecord(job, record) {
    addPoint(record);
    attachSpectrum(record);
    if (record.track) markTracksDirty();
    decodePlotted[job.kind]++;
    // The first report with a location stands for the file; report 0 may have none
    if (!job.linked) {
        job.linked = true;
        linkDecoded(job.key, record);
    }
}

// The first SATELLITE_ROWS_MAX values, plus the first of any value a measure colours by
// (and wind direction, 011001, for the coverage's wind arrows)
const WANTED_IDS = [...Object.values(METRICS).flatMap((m) => m.ids || []), 11001];
export function trimRows(rows) {
    if (rows.length <= SATELLITE_ROWS_MAX) return rows;
    var wanted = new Set(WANTED_IDS);
    var kept = rows.slice(0, SATELLITE_ROWS_MAX);
    kept.forEach((r) => wanted.delete(r[0]));
    for (var i = SATELLITE_ROWS_MAX; i < rows.length && wanted.size; i++) {
        if (wanted.delete(rows[i][0])) kept.push(rows[i]);
    }
    return kept;
}

export function setDecodeEnabled(kind, enabled) {
    enabled ? decodeEnabled.add(kind) : decodeEnabled.delete(kind);
    if (!enabled) queueFor(kind).queue = queueFor(kind).queue.filter((job) => job.kind !== kind);
    applyMapFilter();
    pumpDecode();
}
