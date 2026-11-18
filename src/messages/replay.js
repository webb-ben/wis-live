import { effectiveHidden } from '../map/layers.js';
import { records, removePoint } from '../map/points.js';
import { decoderReady, decoderGaveUp } from '../data/decoder.js';
import { map } from '../map/map.js';
import { disciplineOf, formatOf } from './messages.js';
import { writeFiltersToUrl } from '../lib/url.js';
import { filterModes, filters, passesFilterChips } from '../lib/filters.js';
import { onMessage } from './handle.js';

// Global Replay: past notifications from the WIS2 Global Replay service
// (OGC API - Features). The view's past replayWindowMs is fetched newest first,
// up to REPLAY_MAX, after each pan; messages carry their data inline, so stations
// can still be coloured. The service keeps a copy from every global cache, so only
// one cache's copies are asked for (core data; recommended data isn't cached).
export const REPLAY_API = 'https://wis2-grep.weather.gc.ca/collections/wis2-notification-messages/items';

export const REPLAY_CACHE = 'data-metoffice-noaa-global-cache';

export const REPLAY_PAGE = 500;

export const REPLAY_MAX = 5000;

// Replayed notifications go on the map a batch at a time, newest first, rather than
// thousands at once, so live messages and the decoder keep up
export const REPLAY_BATCH = 10;

export const REPLAY_TICK_MS = 500;

export let replayTimer = null;

export let replayAbort = null;

export let replayedView = '';

export let replayBacklog = [];  // [topic, feature] still to go on the map

export let replayFeeding = null;

// How far back the Global Replay reaches, set by a continuous slider on a log scale:
// 12 hours ago at the left, 5 minutes at the right, so time runs left to right and
// recent windows get most of the track. Long windows over a busy view stop at
// REPLAY_MAX, newest first, so they reach back less far there
export const REPLAY_RANGE_MINUTES = [720, 5];

export const REPLAY_TICKS = [720, 360, 180, 60, 30, 15, 5];

export const REPLAY_DEFAULT_MINUTES = 5;

export let replayWindowMs = REPLAY_DEFAULT_MINUTES * 60 * 1000;

// The window as a link gives it, before the replay starts
export function setReplayWindowMs(ms) {
    replayWindowMs = ms;
}

// Slider position (0 to 1) for a window in minutes, and back, rounded to whole
// minutes under an hour and to 5 minutes above
export function replayPosition(minutes) {
    var [far, near] = REPLAY_RANGE_MINUTES.map(Math.log);
    return (Math.log(minutes) - far) / (near - far);
}

export function replayMinutesAt(position) {
    var [far, near] = REPLAY_RANGE_MINUTES.map(Math.log);
    var minutes = Math.exp(far + (near - far) * position);
    return minutes < 60 ? Math.round(minutes) : Math.round(minutes / 5) * 5;
}

export function feedReplay() {
    replayFeeding = null;
    if (effectiveHidden().includes('replay')) {
        replayBacklog = [];
        return;
    }
    replayBacklog.splice(0, REPLAY_BATCH).forEach(([topic, feature]) => onMessage(topic, feature, true));
    if (replayBacklog.length) replayFeeding = setTimeout(feedReplay, REPLAY_TICK_MS);
}

// 5 minutes, 1 hour, 2 h 35 min
export function replayWindowLabel(minutes) {
    if (minutes < 60) return `${minutes} minutes`;
    var hours = Math.floor(minutes / 60), rest = minutes % 60;
    if (rest) return `${hours} h ${rest} min`;
    return hours === 1 ? '1 hour' : `${hours} hours`;
}

// The slider under the Global Replay row: a shorter window drops replayed points
// now outside it, and either way the view is fetched again
export function setReplayWindow(minutes) {
    replayWindowMs = minutes * 60 * 1000;
    writeFiltersToUrl();
    var cutoff = Date.now() - replayWindowMs;
    [...records.values()].filter((r) => r.replay && r.born < cutoff).forEach(removePoint);
    replayedView = '';
    scheduleReplay(300);
}

// Nothing is asked of the replay service until the decoder has loaded (or failed to):
// both are big downloads, and the decoder matters more to the first view
export function scheduleReplay(delay = 800) {
    clearTimeout(replayTimer);
    if (effectiveHidden().includes('replay')) return;
    if (!decoderReady && !decoderGaveUp) return;  // Called again once it has
    replayTimer = setTimeout(loadReplay, delay);
}

// The view as a bbox for an OGC API query (west, south, east, north). A view crossing
// the antimeridian, or the whole globe, asks for everything.
export function viewBbox() {
    var b = map.getBounds();
    var clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    var bbox = [clamp(b.getWest(), -180, 180), clamp(b.getSouth(), -90, 90), clamp(b.getEast(), -180, 180), clamp(b.getNorth(), -90, 90)]
        .map((v) => v.toFixed(2));
    if (b.getEast() - b.getWest() >= 360 || Number(bbox[0]) >= Number(bbox[2])) bbox = ['-180', '-90', '180', '90'];
    return bbox;
}

// The replay follows the filters. What the service can narrow down itself (its topic=
// matches whole leading segments of a topic) it is asked for: the topic text up to its
// last /, or one request per centre while only a few are shown. Every notification
// is then checked against all the filters (replayMatches), so ones they'd hide don't
// use up REPLAY_MAX
export const REPLAY_TOPIC_PREFIX = 'cache/a/wis2/';

export const REPLAY_CENTRES_MAX = 5;  // Shown centres beyond this are fetched together and sorted out here

export function replayTopics() {
    var text = filterModes.text !== 'hide' && filters.text.startsWith(REPLAY_TOPIC_PREFIX)
        ? filters.text.slice(0, filters.text.lastIndexOf('/')) : '';
    if (text.length > REPLAY_TOPIC_PREFIX.length) return [text];
    if (filters.centres.size && filterModes.centres !== 'hide' && filters.centres.size <= REPLAY_CENTRES_MAX) {
        return [...filters.centres].map((centre) => `${REPLAY_TOPIC_PREFIX}${centre}`);
    }
    return [null];
}

export function replayMatches(topic, feature) {
    var [channel, t] = topic.split('/a/wis2/');
    return passesFilterChips({ topic, channel, centre: t.split('/', 1)[0], discipline: disciplineOf(t), format: formatOf(feature) });
}

export async function loadReplay() {
    var bbox = viewBbox();
    var since = new Date(Date.now() - replayWindowMs).toISOString().replace(/\.\d+Z$/, 'Z');
    var topics = replayTopics();
    var filtersKey = JSON.stringify([filters.text, [...filters.centres].sort(), filters.format, [...filters.disciplines].sort(), filterModes]);
    // The same view and filters within ten minutes aren't fetched again
    var view = `${bbox.join(',')}|${since.slice(0, 15)}|${filtersKey}`;
    if (view === replayedView) return;
    replayedView = view;
    if (replayAbort) replayAbort.abort();
    replayBacklog = [];  // What was waiting belongs to the last view
    var abort = replayAbort = new AbortController();
    var base = `${REPLAY_API}?f=json&sortby=-pubtime&limit=${REPLAY_PAGE}&bbox=${bbox.join(',')}&datetime=${since}/..&global-cache=${REPLAY_CACHE}`;
    try {
        // Each request gets a share of REPLAY_MAX, newest first
        for (var prefix of topics) {
            var url = prefix ? `${base}&topic=${encodeURIComponent(prefix)}` : base;
            for (var fetched = 0; url && fetched < REPLAY_MAX / topics.length && !abort.signal.aborted;) {
                var response = await fetch(url, { signal: abort.signal });
                if (!response.ok) throw new Error(`Global Replay answered ${response.status}`);
                var page = await response.json();
                if (abort.signal.aborted) break;
                for (var feature of page.features || []) {
                    var topic = feature.properties && feature.properties.topic;
                    if (topic && topic.includes('/a/wis2/') && replayMatches(topic, feature)) replayBacklog.push([topic, feature]);
                }
                if (!replayFeeding) feedReplay();
                fetched += (page.features || []).length;
                var next = (page.links || []).find((l) => l.rel === 'next');
                url = next && (page.features || []).length ? next.href : null;
            }
        }
    } catch (err) {
        if (err.name !== 'AbortError') {
            replayedView = '';  // Try again on the next pan
            console.debug(`Could not load the Global Replay: ${err.message}`);
        }
    }
}
