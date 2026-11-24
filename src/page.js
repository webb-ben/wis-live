// Which page this is, from <html data-page="...">; the pages share every module, and
// this is what they ask to tell them apart:
//  - home (index.html): everything, satellites a layer that starts off
//  - gbon (gbon.html): the Global Basic Observing Network's kinds, surface weather
//    stations and upper-air soundings
//  - metocean (metocean.html): the sea's, ships and buoys (floats among them)
//  - gts (gts.html): what the GTS gateways pass between the GTS and WIS2, both ways
//  - radar (radar.html): weather radar volumes, and winds measured from the ground by
//    radars and wind profilers
//  - satellites (satellites.html): only satellites, drawn as coverage
//  - forecasts (forecasts.html): only forecast products (…/prediction/… topics): the
//    areas GRIB files cover, each drawable. The other pages leave them out
// No imports, so anything (state.js included) can use it
export const PAGE = document.documentElement.dataset.page || 'home';
export const SATELLITE_PAGE = PAGE === 'satellites';
export const FORECAST_PAGE = PAGE === 'forecasts';

// Forecast products: WIS2 topics under …/data/<policy>/<discipline>/prediction/
export const FORECAST_TOPIC = /\/data\/[^/]+\/[^/]+\/prediction\//;
export const GBON_PAGE = PAGE === 'gbon';
export const METOCEAN_PAGE = PAGE === 'metocean';
export const GTS_PAGE = PAGE === 'gts';
export const RADAR_PAGE = PAGE === 'radar';
// The GBON page opens with the Global Replay on, reaching back this far (minutes);
// the others with it off, at 5 minutes once switched on
export const REPLAY_START_MINUTES = GBON_PAGE ? 60 : null;
// Pages that take satellites: theirs, and All observations, where they're a layer that starts off
export const SATELLITES_ON_PAGE = SATELLITE_PAGE || PAGE === 'home';

// Every page, for the links between them and the welcome (see welcome.js)
export const PAGES = [
    { key: 'home', href: './', label: 'All observations',
        about: 'Everything arriving through WIS2' },
    { key: 'gbon', href: 'gbon.html', label: 'Surface and upper air',
        about: 'The Global Basic Observing Network: weather stations and upper-air soundings' },
    { key: 'metocean', href: 'metocean.html', label: 'Ships and buoys',
        about: 'Observations at sea: ships, drifting and moored buoys, and ocean floats' },
    { key: 'radar', href: 'radar.html', label: 'Radar',
        about: 'Weather radar reflectivity, and winds measured by radars and wind profilers' },
    { key: 'gts', href: 'gts.html', label: 'GTS gateways',
        about: 'Bulletins sent to the Global Telecommunication System gateways and WIS2' },
    { key: 'satellites', href: 'satellites.html', label: 'Satellites',
        about: 'Space-based observations, drawn as areas of coverage' },
    { key: 'forecasts', href: 'forecasts.html', label: 'Forecasts',
        about: 'Model output and forecast products: the areas they cover, and their values drawn' },
];
export const OTHER_PAGES = PAGES.filter((p) => p.key !== PAGE);

// The kinds of observation (OBS_CLASSES keys) the page shows; null for every kind. Only
// the GBON and metocean pages sort by kind (by topic first, then each report's kind, see
// topicOnPage and addPoint): the home and satellite pages split by topic, as a satellite
// file's reports aren't all sorted as satellites, and the GTS page by its gateways
export const PAGE_CLASSES = GBON_PAGE ? ['station', 'upperair'] : METOCEAN_PAGE ? ['ship', 'buoy'] : RADAR_PAGE ? ['radarwind'] : null;

export function classOnPage(cls) {
    return !PAGE_CLASSES || PAGE_CLASSES.includes(cls);
}

// Whether a measure is offered to Style by: satellite measures where satellites are
// (only them on the satellite page), and no sea-surface ones on the GBON and radar pages,
// which have no ships or buoys
export function metricOnPage(metric) {
    if (metric.targets === 'satellite' ? !SATELLITES_ON_PAGE : SATELLITE_PAGE) return false;
    return !((GBON_PAGE || RADAR_PAGE) && metric.group.startsWith('Sea'));
}

// The GTS gateway centres, as WMO lists them (WIS 2.0 Global Services, community.wmo.int):
// DWD and JMA republish the GTS into WIS2, CMA and the Met Office pass a subset of
// WIS2 on to the GTS. The GTS page hears no other centre, so add new ones here
// GTS bulletins of forecasts in BUFR for the surface (T1T2 = JS, JSXX): tropical cyclone
// track forecasts (ECMWF's JSXX..ECEP ensemble), which the forecasts page draws (cyclone.js)
export const GATEWAY_CYCLONE = /-gts-to-wis2\/data\/core\/J\/S\/X\/X\//;

export const GATEWAY_CENTRES = ['de-dwd-gts-to-wis2', 'jp-jma-gts-to-wis2', 'cn-cma-wis2-to-gts', 'uk-metoffice-wis2-to-gts'];

// The Global Broker topics the page subscribes to (MQTT filters: + one level, # the
// rest). The satellite page takes only satellites': WIS2's space-based observations,
// under any centre, data policy and discipline, and the GTS gateways' satellite
// bulletins, headed IN and IE, and ISXX from EUSR (as isSpaceBased). The others take everything, and
// leave out what isn't theirs (see topicOnPage). The GTS page takes the gateway
// centres by name, as MQTT can't match the end of one (-gts-to-wis2). The forecasts page
// takes only forecast products, under any centre, data policy and discipline
export const PAGE_TOPICS = SATELLITE_PAGE
    ? ['origin', 'cache'].flatMap((channel) => [
        `${channel}/a/wis2/+/data/+/+/space-based-observations/#`,
        `${channel}/a/wis2/+/data/core/I/N/#`,
        `${channel}/a/wis2/+/data/core/I/E/#`,
        `${channel}/a/wis2/+/data/core/I/S/X/X/+/EUSR`,
    ])
    : GTS_PAGE
        ? ['origin', 'cache'].flatMap((channel) => GATEWAY_CENTRES.map((centre) => `${channel}/a/wis2/${centre}/#`))
        : FORECAST_PAGE
            ? [...['origin', 'cache'].map((channel) => `${channel}/a/wis2/+/data/+/+/prediction/#`),
                // And the GTS's tropical cyclone track forecasts (GATEWAY_CYCLONE)
                'cache/a/wis2/+/data/core/J/S/X/X/#']
            : ['origin/a/wis2/#', 'cache/a/wis2/#'];

// The links to the other pages, as HTML
export function otherPageLinks() {
    return OTHER_PAGES.map((p) => `<a class="legend-page-link" href="${p.href}">${p.label} →</a>`).join('');
}
