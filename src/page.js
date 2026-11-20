// Which page this is, from <html data-page="...">; the pages share every module, and
// this is what they ask to tell them apart:
//  - home (index.html): everything but satellites
//  - gbon (gbon.html): the Global Basic Observing Network's kinds, surface weather
//    stations and upper-air soundings
//  - metocean (metocean.html): the sea's, ships and buoys (floats among them)
//  - gts (gts.html): what the GTS gateways pass between the GTS and WIS2, both ways
//  - satellites (satellites.html): only satellites, drawn as coverage
// No imports, so anything (state.js included) can use it
export const PAGE = document.documentElement.dataset.page || 'home';
export const SATELLITE_PAGE = PAGE === 'satellites';
export const GBON_PAGE = PAGE === 'gbon';
export const METOCEAN_PAGE = PAGE === 'metocean';
export const GTS_PAGE = PAGE === 'gts';

// Every page, for the links between them
export const PAGES = [
    { key: 'home', href: './', label: 'All observations' },
    { key: 'gbon', href: 'gbon.html', label: 'Surface and upper air' },
    { key: 'metocean', href: 'metocean.html', label: 'Ships and buoys' },
    { key: 'gts', href: 'gts.html', label: 'GTS gateways' },
    { key: 'satellites', href: 'satellites.html', label: 'Satellites' },
];
export const OTHER_PAGES = PAGES.filter((p) => p.key !== PAGE);

// The kinds of observation (OBS_CLASSES keys) the page shows; null for every kind. Only
// the GBON and metocean pages sort by kind (by topic first, then each report's kind, see
// topicOnPage and addPoint): the home and satellite pages split by topic, as a satellite
// file's reports aren't all sorted as satellites, and the GTS page by its gateways
export const PAGE_CLASSES = GBON_PAGE ? ['station', 'upperair'] : METOCEAN_PAGE ? ['ship', 'buoy'] : null;

export function classOnPage(cls) {
    return !PAGE_CLASSES || PAGE_CLASSES.includes(cls);
}

// Whether a measure is offered to Style by: satellite measures on the satellite page
// only, and no sea-surface ones on the GBON page, which has no ships or buoys
export function metricOnPage(metric) {
    if ((metric.targets === 'satellite') !== SATELLITE_PAGE) return false;
    return !(GBON_PAGE && metric.group.startsWith('Sea'));
}

// The GTS gateway centres, as heard on the Global Brokers in November 2026: DWD
// (Offenbach) and JMA (Tokyo) republish the GTS into WIS2. No WIS2-to-GTS centre
// was publishing then; add one here when it does, or the GTS page won't hear it
export const GATEWAY_CENTRES = ['de-dwd-gts-to-wis2', 'jp-jma-gts-to-wis2'];

// The Global Broker topics the page subscribes to (MQTT filters: + one level, # the
// rest). The satellite page takes only satellites': WIS2's space-based observations,
// under any centre, data policy and discipline, and the GTS gateways' satellite
// bulletins, headed IN and IE (as isSpaceBased). The others take everything, and
// leave out what isn't theirs (see topicOnPage). The GTS page takes the gateway
// centres by name, as MQTT can't match the end of one (-gts-to-wis2)
export const PAGE_TOPICS = SATELLITE_PAGE
    ? ['origin', 'cache'].flatMap((channel) => [
        `${channel}/a/wis2/+/data/+/+/space-based-observations/#`,
        `${channel}/a/wis2/+/data/core/I/N/#`,
        `${channel}/a/wis2/+/data/core/I/E/#`,
    ])
    : GTS_PAGE
        ? ['origin', 'cache'].flatMap((channel) => GATEWAY_CENTRES.map((centre) => `${channel}/a/wis2/${centre}/#`))
        : ['origin/a/wis2/#', 'cache/a/wis2/#'];

// The links to the other pages, as HTML
export function otherPageLinks() {
    return OTHER_PAGES.map((p) => `<a class="legend-page-link" href="${p.href}">${p.label} →</a>`).join('');
}
