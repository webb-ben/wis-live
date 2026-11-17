// The page's shared state in one place: how the map is styled, the filters and
// the layer switches. Read it from `state`; change it with setState (or, for the
// Sets and objects changed in place, change them and call notify), and anything
// subscribed hears which keys changed. Mirrored in the URL by the main page.

export const state = {
    // Style by: 'kind' (observation type), 'satellite' (a colour each), or a METRICS key
    colourBy: 'kind',
    colouredOnly: false,  // Hide whatever the style doesn't colour (Require value / Satellites only)
    modelFieldOn: false,  // ECCC model field for the measure, under the points
    // Filters shared by the map, the message list and the dataset list
    filters: { text: '', centres: new Set(), format: '', disciplines: new Set() },
    // Each filter either keeps only what matches ('only') or hides what matches ('hide')
    filterModes: { text: 'only', centres: 'only', format: 'only', disciplines: 'only' },
    // Layer switches that are off. Off at first: radar, the Global Replay, METAR,
    // WIS2-to-GTS, aircraft and ground-based GNSS (cache, GTS and replay), and aircraft tracks
    hiddenLayers: new Set(['radar', 'replay', 'cache-gnss', 'gts-gnss', 'replay-gnss', 'airports', 'wis2gts',
        'cache-aircraft', 'gts-aircraft', 'replay-aircraft', 'gts-tracks']),
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
