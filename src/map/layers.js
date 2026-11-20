// The layers a viewer can switch, as the sidebar lists them (LAYER_GROUPS), which
// sit under which (LAYER_PARENTS), and which are off now (effectiveHidden: switched
// off, or under one that is)
import { state } from '../state.js';
import { COLORS, OBS_CLASSES, SATELLITE_LAYERS } from '../config.js';
import { SATELLITE_PAGE, GTS_PAGE, PAGE_CLASSES, classOnPage } from '../page.js';

// GTS sublayers that start off. Their bulletins aren't downloaded until they're
// switched on, so their rows appear when the first such notification arrives
// (see revealGatewayRows) rather than when a report is plotted.
export const GTS_OPT_IN = ['aircraft'];

// Satellites from every source share one row (and one row per satellite) in their
// own section. Each report keeps its source's layer (SATELLITE_LAYERS), which sits under that row.
export const OWN_SECTION = ['satellite'];

// Legend rows, grouped by source; each can be switched on and off. Rows other
// than opt-in ones stay hidden until a point of that kind has arrived. Opt-in
// rows are decoded in the browser, since their notifications carry no location.
// Each page lists its own (LAYER_GROUPS, below)
const ALL_LAYER_GROUPS = [
    { key: 'wis2', label: 'WIS2', subtitle: 'Live from the WIS2 Global Brokers', layers: [
        { key: 'origin', label: 'Origin', color: COLORS.origin, ring: true },
        { key: 'obs', label: 'Cache', color: OBS_CLASSES.station.color, optIn: true },  // Always listed
        // Sublayers sit under their parent and are off whenever it is off
        ...Object.entries(OBS_CLASSES).filter(([key]) => !OWN_SECTION.includes(key)).flatMap(([key, c]) => [
            { key: `cache-${key}`, parent: 'obs', label: c.label, color: c.color, title: c.title },
        ]),
        { key: 'radar', parent: 'obs', label: 'Weather radar', color: COLORS.radar,
            title: 'Reflectivity from the lowest scan of each radar volume (ODIM HDF5) in the cache (e.g. RMI, Belgium), drawn around the radar; downloaded only while this is on' },
    ] },
    { key: 'gts', label: 'GTS gateways', subtitle: 'Bulletins relayed with the GTS', layers: [
        { key: 'gts', label: 'GTS-to-WIS2', color: COLORS.gts, optIn: true,
            title: 'Download and decode the BUFR bulletins republished from the GTS into WIS2 (centres ending -gts-to-wis2), and plot the reports inside' },
        // Each decoded report is sorted by the identifiers it carries (see reportClass)
        ...Object.entries(OBS_CLASSES).filter(([key, c]) => !c.cacheOnly && !OWN_SECTION.includes(key)).flatMap(([key, c]) => [
            { key: `gts-${key}`, parent: 'gts', label: c.label, color: c.color,
                title: c.title + (GTS_OPT_IN.includes(key) ? '; downloaded only while this is on' : '') },
            // Aircraft can be drawn as flight paths; shown once the Aircraft row is
            ...(key === 'aircraft' ? [{ key: 'gts-tracks', parent: 'gts-aircraft', label: 'Tracks', follow: true, track: true,
                color: 'linear-gradient(90deg, #99e9f2, #22b8cf, #1971c2, #5f3dc4)',
                title: 'Each aircraft drawn in the air at its altitude: a path coloured by height (light low, dark high), chevrons pointing the way it is flying, and a red arrowhead at its latest report. Tilt the map to see it in 3D. Off: every report is a point on the ground.' }] : []),
        ]),
        // Listed once a WIS2-to-GTS centre has published something (see revealGatewayRows)
        { key: 'wis2gts', label: 'WIS2-to-GTS (decode required)', color: COLORS.wis2gts,
            title: 'Download and decode the BUFR that WIS2 centres pass on to the GTS (centres ending -wis2-to-gts), and plot the reports inside' },
    ] },
    { key: 'space', label: 'Satellites', subtitle: 'Space-based observations from WIS2 and the GTS', layers: [
        { key: 'satellite', label: OBS_CLASSES.satellite.label, color: OBS_CLASSES.satellite.color,
            title: OBS_CLASSES.satellite.title + ', from the WIS2 cache, the GTS gateways and the Global Replay. Files without a location are downloaded and decoded only while this is on.' },
        // Off: every report is its own point, e.g. to read cloud-motion winds one by one
        { key: 'sat-coverage', parent: 'satellite', option: true, label: 'Draw as coverage areas',
            title: 'Draw files with many reports as shaded hexagons of coverage. Off: every report is a point, coloured by the selected measure.' },
    ] },
    { key: 'other', label: 'Other sources', subtitle: 'More live observations, from services outside the Global Brokers', layers: [
        { key: 'replay', label: 'Global Replay', color: COLORS.replay, optIn: true,
            title: 'Past WIS2 core-data notifications for the view, from the Global Replay service (wis2-grep.weather.gc.ca). Starts once the decoder has loaded and fills in a few at a time, newest first; how far back is set by the slider below, and older points are fainter.' },
        // Replayed messages sorted like the cache's, each row shown once something arrives in it
        ...Object.entries(OBS_CLASSES).filter(([key]) => !OWN_SECTION.includes(key)).map(([key, c]) => ({ key: `replay-${key}`, parent: 'replay', label: c.label, color: c.color, title: c.title })),
        { key: 'airports', label: 'METAR', color: OBS_CLASSES.station.color, optIn: true,
            title: 'Airport weather reports: the latest METAR from every airport the Iowa Environmental Mesonet collects, refreshed every 20 minutes, nearest the view first. An airport that also reports through WIS2 is shown once, as the WIS2 station, with its METAR linked.' },
    ] },
];

// The home page lists every group (Satellites starting off, see state.js); the satellite page lists Satellites, and the
// Global Replay for past satellite notifications; the GTS page the gateways' group (GTS-
// to-WIS2 and WIS2-to-GTS); a page of some kinds (GBON, metocean) only the rows of its
// kinds (cache-station, gts-buoy...) and the sources over them, without radar, METAR,
// WIS2-to-GTS or aircraft tracks (see page.js)
const KINDS_LEFT_OUT = ['radar', 'airports', 'wis2gts'];
const rowOfKinds = (l) => {
    var match = /^(?:cache|gts|replay)-(.+)$/.exec(l.key);
    return match ? classOnPage(match[1]) : !KINDS_LEFT_OUT.includes(l.key);
};
export const LAYER_GROUPS = SATELLITE_PAGE
    ? ALL_LAYER_GROUPS.filter((g) => g.key === 'space' || g.key === 'other').map((g) => g.key === 'space' ? g
        : { ...g, subtitle: 'Past satellite notifications', layers: g.layers.filter((l) => l.key === 'replay') })
    : GTS_PAGE
        ? ALL_LAYER_GROUPS.filter((g) => g.key === 'gts' || g.key === 'other').map((g) => g.key === 'gts' ? g
            : { ...g, subtitle: 'Past gateway bulletins', layers: g.layers.filter((l) => l.key === 'replay') })
        : PAGE_CLASSES
            ? ALL_LAYER_GROUPS.filter((g) => g.key !== 'space').map((g) => ({ ...g, layers: g.layers.filter(rowOfKinds) }))
            : ALL_LAYER_GROUPS;

// Layer switches that are off, and which start off: kept in state.js
export const hiddenLayers = state.hiddenLayers;

export const LAYER_PARENTS = Object.fromEntries([
    ...LAYER_GROUPS.flatMap((g) => g.layers).filter((l) => l.parent).map((l) => [l.key, l.parent]),
    // Replayed satellites also go when the Global Replay is off (see applyMapFilter)
    ...SATELLITE_LAYERS.map((k) => [k, 'satellite']),
    // Files without a location are always decoded while Cache is on; the reports inside join its groups
    ['files', 'obs'],
    // Text SYNOPs join GTS-to-WIS2's groups, so they're decoded while it is on
    ['gts-text', 'gts'],
    // The replay window and coverage opacity sliders are greyed out with their rows
    ['replay-window', 'replay'],
    ['sat-opacity', 'sat-coverage'],
]);

export function ancestors(key) {
    var out = [];
    for (var k = LAYER_PARENTS[key]; k; k = LAYER_PARENTS[k]) out.push(k);
    return out;
}

// Layers switched off directly, plus sublayers with any ancestor off
export function effectiveHidden() {
    return [...new Set([...hiddenLayers, ...Object.keys(LAYER_PARENTS).filter((k) => ancestors(k).some((a) => hiddenLayers.has(a)))])];
}

export const seenLayers = new Set();
