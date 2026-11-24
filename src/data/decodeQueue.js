import { GATEWAY_SATELLITE, isDataLink, formatOf, GATEWAY_TOPIC, isSpaceBased, pointFor, GATEWAY_AIRCRAFT, GATEWAY_UPPER_AIR, topicClass, disciplineOf, isUpdate, FORMATS, noteSniffedFormat } from '../messages/messages.js';
import { SYNOP_TOPIC, plotSynopBulletin } from './gts/synop.js';
import { radarNoReflectivity, radarHeading, RADAR_FILE_MAX_BYTES, radarThrottled, plotRadar } from './radar/radar.js';
import { seenLayers, effectiveHidden } from '../map/layers.js';
import { decodeKey } from '../lib/ui/queue.js';
import { decodeHref, DATA_LINKS_MAX, fetchTracked, bufrPart, sniffFormat } from './download.js';
import { plotCitypage } from './alerts/citypage.js';
import { queueSwob, clearSwob, parseSwob } from './swob/swob.js';
import { LOCAL } from './caches.js';
import { queueGrib, clearGrib } from './grib/grib.js';
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
    wis2gts: (topic, feature) => topic.startsWith('cache/') && WIS2_GTS_TOPIC.test(topic) && !NOT_BUFR.includes(formatOf(feature, topic))
        && !(feature.links || []).some((l) => isDataLink(l) && l.length > DECODE_FILE_MAX_BYTES),
    // Gateway centres belong to their own layers above
    files: (topic, feature) => topic.startsWith('cache/') && !GATEWAY_TOPIC.test(topic) && !isSpaceBased(topic) && decodableFile(topic, feature),
    // ODIM HDF5 radar volumes. Velocity-only files are skipped by name, or by their
    // GTS heading once a file under it has turned out to hold no reflectivity
    radar: (topic, feature) => topic.startsWith('cache/') && /radar/i.test(topic) && formatOf(feature, topic) === 'hdf'
        && !radarNoReflectivity.has(radarHeading(feature))
        && !(feature.links || []).some((l) => isDataLink(l) && (l.length > RADAR_FILE_MAX_BYTES || /vrad/i.test(l.href))),
    // Any space-based file not drawn from its notification: no geometry, or a swath too
    // large to plot. On the satellite page, where everything is coverage, every one
    // (its notification isn't drawn as a point then, see onMessage)
    'cache-satellite': (topic, feature) => topic.startsWith('cache/') && !GATEWAY_TOPIC.test(topic) && isSpaceBased(topic)
        && (SATELLITE_PAGE || !(feature.geometry && feature.geometry.type && pointFor(feature.geometry))) && !NOT_BUFR.includes(formatOf(feature, topic))
        && !(feature.links || []).some((l) => isDataLink(l) && l.length > SATELLITE_FILE_MAX_BYTES),
    // ECCC SWOB-ML station reports, which are only on the origin channel (see swob.js). Only
    // on the local dev and preview servers for now: ECCC's servers send no CORS headers, and
    // through a deployed proxy (proxy/) they'd be most of its requests
    swob: (topic, feature) => LOCAL && topic.startsWith('origin/') && /surface-based-observations/.test(topic)
        && (feature.links || []).some((l) => isDataLink(l) && /-swob\.xml$/i.test((l.href || '').split(/[?#]/)[0])),
    // Origin copies of files without a location, decoded like the cache's ('files') and
    // drawn as origin points until the cache's copy, decoded, replaces each report (they
    // share a data_id, see addPoint). Only from servers that let browsers download
    'origin-files': (topic, feature) => topic.startsWith('origin/') && !GATEWAY_TOPIC.test(topic) && !isSpaceBased(topic)
        && decodableFile(topic, feature),
    // GRIB files, outlined by the grid their headers give (see grib.js): the cache's copy, or
    // the origin's where the notification says the caches won't copy it ("cache": false:
    // ECMWF's open data, up to 16 GB a file, read from data.ecmwf.int by range)
    grib: (topic, feature) => (topic.startsWith('cache/') || (topic.startsWith('origin/') && (feature.properties || {}).cache === false))
        && !GATEWAY_TOPIC.test(topic) && formatOf(feature, topic) === 'grib',
};

export function decodableFile(topic, feature) {
    return !feature.geometry
        && (!NOT_BUFR.includes(formatOf(feature, topic)) || (formatOf(feature, topic) === 'xml' && /citypage/i.test(topic + JSON.stringify(feature.links || [])))
            || (formatOf(feature, topic) === 'text' && /lightning/i.test(topic)))
        && (feature.links || []).some((l) => isDataLink(l) && l.length > 0 && l.length <= DECODE_FILE_MAX_BYTES);
}

export const DECODE_FETCH_TIMEOUT_MS = 20000;

export const decodeEnabled = new Set();

export const decodePlotted = { gts: 0, 'gts-satellite': 0, 'gts-text': 0, wis2gts: 0, files: 0, 'cache-satellite': 0, radar: 0, swob: 0, grib: 0, 'origin-files': 0 };

// Two queues, so satellite files (large, and many at once after each pass) don't hold
// up stations, ships and aircraft, nor the other way round. Each has its own downloads
// (fetches at once) and cap (oldest dropped when it falls behind); they share the
// background decoder, taking turns
export const decodeQueues = {
    obs: { queue: [], ready: [], fetching: 0, fetches: 3, max: 100 },
    satellite: { queue: [], ready: [], fetching: 0, fetches: 2, max: 40 },
};

export const queueFor = (kind) => decodeQueues[/satellite$/.test(kind) ? 'satellite' : 'obs'];

// Satellite files are chosen before they're downloaded: the GTS alone announces a few
// hundred a minute (EUMETSAT's IELX and INCX bulletins most), each taking a quarter to
// two thirds of a second to decode, far more than a browser can keep up with. So each
// product (its topic without bulletin numbers, as coverage's productKey) keeps only its
// newest file waiting, a newer one taking its place without the older being fetched,
// and the products take turns, each taken at most once per SATELLITE_PRODUCT_GAP_MS:
// a busy product can't crowd out the rest, and what's drawn stays recent. On the
// satellite page, which has nothing else to decode, products come round more often
export const SATELLITE_PRODUCT_GAP_MS = SATELLITE_PAGE ? 15e3 : 60e3;
const SATELLITE_PRODUCTS_MAX = 300;  // Products remembered (there are a few dozen)
const satelliteWaiting = new Map();  // product -> its newest job not yet taken
const satelliteTaken = new Map();  // product -> when a file of it was last taken
let satelliteTimer = null;

// Both GTS-to-WIS2 gateways republish the same bulletins, so their copies are one product
export function satelliteProduct(topic) {
    return topic.replace(/^[^/]+\/a\/wis2\//, '').replace(/^[^/]+-gts-to-wis2\//, 'gts/').split('/').filter((part) => !/^\d+$/.test(part)).join('/').toLowerCase();
}

function waitSatellite(job) {
    var product = satelliteProduct(job.topic);
    var older = satelliteWaiting.get(product);
    if (older) decodeSeen.delete(older.key);  // Passed over, never fetched; another copy may come
    satelliteWaiting.delete(product);  // So the Map's order stays oldest arrival first
    satelliteWaiting.set(product, job);
    if (satelliteWaiting.size > SATELLITE_PRODUCTS_MAX) {
        var [first, dropped] = satelliteWaiting.entries().next().value;
        satelliteWaiting.delete(first);
        decodeSeen.delete(dropped.key);
    }
}

// The next satellite file to fetch: of the products due, the one taken longest ago.
// Null when none is due, with a wake-up for when the first will be
function takeSatellite() {
    var now = Date.now(), best = null, bestTaken = Infinity, wait = Infinity;
    for (var product of satelliteWaiting.keys()) {
        var taken = satelliteTaken.get(product) || 0;
        if (taken + SATELLITE_PRODUCT_GAP_MS > now) {
            wait = Math.min(wait, taken + SATELLITE_PRODUCT_GAP_MS - now);
        } else if (taken < bestTaken) {
            best = product;
            bestTaken = taken;
        }
    }
    if (best === null) {
        if (wait < Infinity && !satelliteTimer) {
            satelliteTimer = setTimeout(() => { satelliteTimer = null; pumpDecode(); }, wait + 50);
        }
        return null;
    }
    var job = satelliteWaiting.get(best);
    satelliteWaiting.delete(best);
    satelliteTaken.delete(best);
    satelliteTaken.set(best, now);
    if (satelliteTaken.size > SATELLITE_PRODUCTS_MAX) satelliteTaken.delete(satelliteTaken.keys().next().value);
    return job;
}

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
    // An origin copy is a file of its own to decode: the cache's copy is decoded again
    // when it comes, to replace its reports
    if (kind === 'origin-files' && key) key = `origin:${key}`;
    var href = decodeHref(feature);
    // GRIB headers also try the main cache's likely copy (fetchHead),
    // so they go ahead when every copy announced is on a server that blocks browsers
    if ((!href && kind !== 'grib') || !key || decodeSeen.has(key)) return;
    if (satelliteSkipped(kind, topic)) return;
    if (kind === 'radar' && radarThrottled(feature)) return;
    decodeSeen.add(key);
    if (decodeSeen.size > DATA_LINKS_MAX) decodeSeen.delete(decodeSeen.values().next().value);
    // SWOB too, each station at most every few minutes (see swob.js). One not taken
    // now may be announced again later
    if (kind === 'swob') {
        if (!queueSwob({ kind, key, topic, feature, href }, fetchSwob)) decodeSeen.delete(key);
        return;
    }
    // GRIB only has its headers read, the newest file of each product (see grib.js)
    if (kind === 'grib') {
        if (!queueGrib({ kind, key, topic, feature, href })) decodeSeen.delete(key);
        return;
    }
    // XML needs no decoder, so it skips the queue rather than waiting behind BUFR
    if (formatOf(feature, topic) === 'xml') {
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
    if (formatOf(feature, topic) === 'text') {
        fetchTracked(href, { signal: AbortSignal.timeout(DECODE_FETCH_TIMEOUT_MS) })
            .then((response) => (response.ok ? response.text() : null))
            .then((text) => text && decodeEnabled.has(kind) && plotLightningText({ kind, key, topic, feature, href }, text))
            .catch((err) => console.debug(`Could not fetch ${href}: ${err.message}`));
        return;
    }
    var q = queueFor(kind);
    if (q === decodeQueues.satellite) {
        waitSatellite({ kind, key, topic, feature, href });
        pumpDecode();
        return;
    }
    q.queue.push({ kind, key, topic, feature, href });
    if (q.queue.length > q.max) decodeSeen.delete(q.queue.shift().key);  // A later copy may try again
    pumpDecode();
}

// Downloads take far longer than decoding (tens of ms), so several files are
// fetched at once while the decoder works through the ones already here (ready)
export function pumpDecode() {
    for (var q of Object.values(decodeQueues)) {
        while (q.fetching < q.fetches && q.ready.length < q.fetches) {
            // Newest first, to stay close to real time; satellites by product (see takeSatellite)
            var job = q === decodeQueues.satellite ? takeSatellite() : q.queue.pop();
            if (!job) break;
            fetchForDecode(q, job);
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
        routeFile(q, job, raw);
    } catch (err) {
        decodeSeen.delete(job.key);  // Let another cache's copy try
        console.debug(`Could not fetch ${job.href}: ${err.message}`);
    }
    q.fetching--;
    decodeNext();
    pumpDecode();
}

// Where a downloaded file goes, by what its first bytes say it is rather than what
// its notification said: BUFR to pybufrkit, ODIM HDF5 (radar) to its reader, Environment
// Canada XML, text SYNOPs and lightning to their parsers here. Anything else (GRIB
// filed without a type, say) is noted as what it is, for the message list and the file
// type filter, and not decoded
function routeFile(q, job, raw) {
    var format = sniffFormat(raw);
    noteSniffedFormat(job.feature, format);
    var text = () => new TextDecoder().decode(raw);
    if (job.kind === 'radar' ? format === 'hdf' : format === 'bufr') {
        q.ready.push({ job, bytes: job.kind === 'radar' ? raw : bufrPart(raw) });
    } else if (format === 'xml' && /citypage/i.test(job.topic + JSON.stringify(job.feature.links || []))) {
        plotCitypage(job, text());
    } else if (format === 'text' && SYNOP_TOPIC.test(job.topic)) {
        plotSynopBulletin(job, text());
    } else if (format === 'text' && /lightning/i.test(job.topic)) {
        plotLightningText(job, text());
    } else {
        console.debug(`Not decoded: ${job.href} is ${FORMATS[format]}`);
    }
}

// Downloads a SWOB-ML file and plots its station like a decoded BUFR report
async function fetchSwob(job) {
    try {
        var href = decodeHref(job.feature);
        if (!href) throw new Error('no copy on a host that allows browser downloads');
        var response = await fetchTracked(href, { signal: AbortSignal.timeout(DECODE_FETCH_TIMEOUT_MS) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        var swob = parseSwob(await response.text());
        if (swob && decodeEnabled.has('swob')) plotDecodedReport({ ...job, wsi: swob.wsi }, swob.rows, null, 0, 0, null);
    } catch (err) {
        decodeSeen.delete(job.key);
        console.debug(`Could not fetch ${job.href}: ${err.message}`);
    }
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
    var subLayer = job.kind === 'gts' || job.kind === 'gts-satellite' ? `gts-${cls}` : ['files', 'cache-satellite'].includes(job.kind) ? `cache-${cls}` : null;
    // Origin copies' reports and ECCC's SWOB stations (from its own servers) are origin
    // points: rings, in Origin's row for their kind (satellites have none: plain Origin)
    if (job.kind === 'swob' || job.kind === 'origin-files') subLayer = cls === 'satellite' ? 'origin' : `origin-${cls}`;
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
        wsi: job.wsi || reportId(values),
        format: job.kind === 'swob' ? 'xml' : 'bufr',
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
        // An origin copy links its message rows (keyed without origin:) as the cache's would
        linkDecoded(job.key.replace(/^origin:/, ''), record);
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
    if (!enabled && kind === 'swob') clearSwob();
    if (!enabled && kind === 'grib') clearGrib();
    if (!enabled) {
        queueFor(kind).queue = queueFor(kind).queue.filter((job) => job.kind !== kind);
        for (var [product, job] of satelliteWaiting) {
            if (job.kind === kind) {
                satelliteWaiting.delete(product);
                decodeSeen.delete(job.key);
            }
        }
    }
    applyMapFilter();
    pumpDecode();
}
