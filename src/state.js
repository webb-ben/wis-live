// The page's shared state in one place: how the map is styled, the filters and
// the layer switches. Read it from `state`; change it with setState (or, for the
// Sets and objects changed in place, change them and call notify), and anything
// subscribed hears which keys changed. Mirrored in the URL by the main page.
import { SATELLITE_PAGE, GTS_PAGE, REPLAY_START_MINUTES } from './page.js';

export const state = {
    // Style by: 'kind' (observation type), 'satellite' (a colour each, where the
    // satellite page opens), or a METRICS key
    colourBy: SATELLITE_PAGE ? 'satellite' : 'kind',
    // Hide whatever the style doesn't colour (Require value / Satellites only). Always on
    // the satellite page, which has no "Other": coverage without the measure isn't drawn
    colouredOnly: SATELLITE_PAGE,
    modelFieldOn: false,  // ECCC model field for the measure, under the points
    // Filters shared by the map, the message list and the dataset list
    filters: { text: '', centres: new Set(), format: '', disciplines: new Set() },
    // Each filter either keeps only what matches ('only') or hides what matches ('hide')
    filterModes: { text: 'only', centres: 'only', format: 'only', disciplines: 'only' },
    // Layer switches that are off. Off at first: radar, the Global Replay, METAR,
    // WIS2-to-GTS, aircraft and ground-based GNSS (cache, GTS and replay), aircraft
    // tracks. Satellites are only on the satellite page, where they start on
    // The GTS page starts with both its gateways on (WIS2-to-GTS too), the GBON page
    // with the Global Replay on (see REPLAY_START_MINUTES)
    hiddenLayers: new Set(['radar', ...(REPLAY_START_MINUTES ? [] : ['replay']), 'cache-gnss', 'gts-gnss', 'replay-gnss', 'airports',
        'cache-aircraft', 'gts-aircraft', 'replay-aircraft', 'gts-tracks', ...(SATELLITE_PAGE ? [] : ['satellite']),
        ...(GTS_PAGE ? [] : ['wis2gts'])]),
    // The services in use, fastest first: { name, ms } of the Global Discovery
    // Catalogue, and { host, id, name, ms } of the global cache downloads try first
    catalogue: null,
    cache: null,
    // The Global Replay's { host, ms } (how long its pages take to answer, smoothed), or
    // { host, failed } when its last request failed; null until it's first asked
    replay: null,
    // Layers switched off because the network is slow (see main.js): { shed: [keys], reason }
    slowNetwork: null,
};

const listeners = new Set();  // { keys: Set or null for every key, fn }

// Sets the given keys; listeners hear about the ones whose value changed
export function setState(changes) {
    var changed = Object.keys(changes).filter((key) => state[key] !== changes[key]);
    changed.forEach((key) => { state[key] = changes[key]; });
    if (changed.length) notify(...changed);
}

// Tells listeners these keys changed, e.g. after adding to state.filters.centres
export function notify(...keys) {
    for (var listener of [...listeners]) {
        if (!listener.keys || keys.some((key) => listener.keys.has(key))) listener.fn(state, keys);
    }
}

// fn(state, changedKeys) runs whenever one of keys changes (any key, if none are
// given); returns a function that stops it
export function subscribe(keys, fn) {
    var listener = { keys: keys && keys.length ? new Set(keys) : null, fn };
    listeners.add(listener);
    return () => listeners.delete(listener);
}

// While developing, the state can be inspected and watched from the console:
// wisState.state, or wisState.subscribe(null, (s, keys) => console.log(keys))
if (import.meta.env && import.meta.env.DEV) window.wisState = { state, subscribe };
