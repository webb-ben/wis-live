// Which page this is, from <html data-page="...">; the pages share every module, and
// this is what they ask to tell them apart:
//  - home (index.html): everything but satellites
//  - gbon (gbon.html): the Global Basic Observing Network's kinds, surface weather
//    stations and upper-air soundings
//  - satellites (satellites.html): only satellites, drawn as coverage
// No imports, so anything (state.js included) can use it
export const PAGE = document.documentElement.dataset.page || 'home';
export const SATELLITE_PAGE = PAGE === 'satellites';
export const GBON_PAGE = PAGE === 'gbon';

// Every page, for the links between them
export const PAGES = [
    { key: 'home', href: './', label: 'All observations' },
    { key: 'gbon', href: 'gbon.html', label: 'Surface and upper air (GBON)' },
    { key: 'satellites', href: 'satellites.html', label: 'Satellite observations' },
];
export const OTHER_PAGES = PAGES.filter((p) => p.key !== PAGE);

// The kinds of observation (OBS_CLASSES keys) the page shows; null for every kind.
// Only the GBON page sorts by kind: the home and satellite pages split by topic (see
// topicOnPage), as a satellite file's reports aren't all sorted as satellites
export const PAGE_CLASSES = GBON_PAGE ? ['station', 'upperair'] : null;

export function classOnPage(cls) {
    return !PAGE_CLASSES || PAGE_CLASSES.includes(cls);
}

// Whether a measure is offered to Style by: satellite measures on the satellite page
// only, and no sea-surface ones on the GBON page, which has no ships or buoys
export function metricOnPage(metric) {
    if ((metric.targets === 'satellite') !== SATELLITE_PAGE) return false;
    return !(GBON_PAGE && metric.group.startsWith('Sea'));
}

// The links to the other pages, as HTML
export function otherPageLinks() {
    return OTHER_PAGES.map((p) => `<a class="legend-page-link" href="${p.href}">${p.label} →</a>`).join('');
}
