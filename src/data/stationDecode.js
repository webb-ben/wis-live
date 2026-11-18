// Station files decoded in the background while the map is styled by a measure (or
// by wave spectrum), so their points can be coloured: live stations newest first,
// replayed ones after them
import { METRICS, WAVE_STYLE, WAVE_CLASSES } from '../config.js';
import { state } from '../state.js';
import { isColourable } from '../map/colour.js';
import { topicClass } from '../messages/messages.js';
import { waveSpectrum, miniWaveSpectrum } from './ocean/wavespec.js';
import { map } from '../map/map.js';
import { setFeatureProperties, pools, records } from '../map/points.js';
import { fetchData } from './download.js';
import { callDecoder } from './decoder.js';
import { metricValues } from './metrics.js';
const METRIC_QUEUE_MAX = 5000;  // Station files waiting to be decoded, newest kept (most carry their data inline, a few ms each)
export let metricQueue = [];
// Replayed stations wait in a queue of their own, taken only when no live station is waiting,
// newest first and capped: a past hour shouldn't hold up what's arriving now
const REPLAY_DECODE_MAX = 500;
export let replayMetricQueue = [];
// Live and replayed stations each decode in a lane of their own, one at a time, so a
// replayed one waiting on its download never holds up a live one behind it
const metricBusy = { live: false, replay: false };

// The style no longer needs stations decoded
export function clearStationDecodes() {
    metricQueue = [];
    replayMetricQueue = [];
}

// Whether the style needs station files decoded: a measure that isn't a
// satellite's, or wave spectra
export function stationDecodesWanted() {
    var m = METRICS[state.colourBy];
    return state.colourBy === WAVE_STYLE || !!(m && m.targets !== 'satellite');
}

// A record the style would decode: one a measure colours, and for wave
// spectra only ships and buoys
export function wantsStationDecode(record) {
    return isColourable(record) && (state.colourBy !== WAVE_STYLE || WAVE_CLASSES.includes(topicClass(record)));
}

// Gives a decoded report with a wave spectrum its map symbol (an image named
// in its "spec" property, drawn by points-spectrum). Once per report
export function attachSpectrum(record) {
    if (record.specImage !== undefined || !record.feature || !record.decoded || !record.decoded.rows) return;
    var spectrum = waveSpectrum(record.decoded.rows);
    record.specImage = null;
    if (!spectrum || !spectrum.peak || !map) return;
    var id = `spec:${record.id}`;
    if (!map.hasImage(id)) map.addImage(id, miniWaveSpectrum(spectrum), { pixelRatio: 2 });
    record.specImage = id;
    setFeatureProperties(record, { spec: id });
}

// Cache and origin stations, ships and buoys without decoded data, newest first
export function queueStationDecodes() {
    var waiting = [...pools.wis2.values()].filter((r) => !r.decoded && r.source && !r.metricTried && wantsStationDecode(r));
    metricQueue = waiting.filter((r) => !r.replay).slice(-METRIC_QUEUE_MAX);
    replayMetricQueue = waiting.filter((r) => r.replay).sort((a, b) => b.born - a.born).slice(0, REPLAY_DECODE_MAX);
    pumpStationDecodes();
}

export function queueStationDecode(record) {
    if (!stationDecodesWanted() || record.decoded || !record.source || !wantsStationDecode(record)) return;
    if (record.replay) {
        // Replays arrive newest first, so once the queue is full the rest are older still
        if (replayMetricQueue.length < REPLAY_DECODE_MAX) replayMetricQueue.push(record);
    } else {
        metricQueue.push(record);
        if (metricQueue.length > METRIC_QUEUE_MAX) metricQueue.shift();
    }
    pumpStationDecodes();
}

export function pumpStationDecodes() {
    decodeStationIn('live');
    decodeStationIn('replay');
}

export async function decodeStationIn(lane) {
    var queue = lane === 'live' ? metricQueue : replayMetricQueue;
    if (metricBusy[lane] || !queue.length || !stationDecodesWanted()) return;
    // Live stations newest first; replayed ones start only while none is waiting
    if (lane === 'replay' && metricQueue.length) return;
    metricBusy[lane] = true;
    var record = lane === 'live' ? metricQueue.pop() : replayMetricQueue.shift();
    record.metricTried = true;
    try {
        if (records.has(record.id) && !record.decoded) {
            var data = await fetchData(record.source);
            if (data.bufr) {
                var key = record.source.dataId || data.url;
                var result = JSON.parse(await callDecoder('decode_bufr', data.bytes, record.wsi || '', key));
                result.key = key;
                result.source = record.source;  // For the pager, should the decoder let the file go
                record.decoded = result;
                setFeatureProperties(record, metricValues(record));
                attachSpectrum(record);
            }
        }
    } catch (err) {
        console.debug(`Could not decode station ${record.wsi}: ${err.message}`);
    }
    metricBusy[lane] = false;
    pumpStationDecodes();
}
