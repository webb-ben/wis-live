String.prototype.hexDecode = function(){
    var j;
    var hexes = this.match(/.{1,4}/g) || [];
    var back = "";
    for(j = 0; j<hexes.length; j++) {
        back += String.fromCharCode(parseInt(hexes[j], 16));
    }

    return back;
}

// Map
const MAX_POINTS = 100000;        // Oldest points are dropped beyond this...
const MAX_DECODED_POINTS = 30000;  // ...with reports decoded from files capped separately so they can't crowd out the rest,
const MAX_SATELLITE_POINTS = 100000;  // ...and satellites apart again, so passes stay up long enough to build coverage
const SATELLITE_ROWS_MAX = 200;  // Decoded values kept per satellite report (IASI has thousands of channels)
const FADE_MS = 4 * 60 * 60 * 1000;  // Points fade over four hours
const PULSE_MS = 1600;           // Length of the ripple on new arrivals
const COLORS = {
    origin: '#6f9fd8',
    gts: '#9b6cd1',
    wis2gts: '#c2255c',
    files: '#83C95D',
    radar: '#0ca678',
    'cache-satellite': '#9c36b5',  // OBS_CLASSES.satellite
    'gts-satellite': '#9c36b5',
    'gts-text': '#9b6cd1',  // COLORS.gts
    replay: '#4c6ef5',
};
// Kinds of observation, shared by the Cache and GTS-to-WIS2 groups so each kind
// has one colour on the map. Cache points are sorted by topic (see topicClass),
// decoded reports by the identifiers they carry (see reportClass).
// Colours follow the domain (land green, sky cyan, sea navy, buoy orange,
// space purple, alert red) and are spread across hues to stay distinct
const OBS_CLASSES = {
    station: { label: 'Weather stations', color: '#2f9e44', title: 'Surface observations from fixed stations' },
    upperair: { label: 'Upper-air soundings', color: '#7048e8', title: 'Profiles through the atmosphere (radiosondes, TEMP)' },
    aircraft: { label: 'Aircraft', color: '#15aabf', title: 'Observations from aircraft (AMDAR, AIREP)' },
    ship: { label: 'Ships', color: '#1c3d8f', title: 'Observations from ships and other mobile stations' },
    buoy: { label: 'Buoys and floats', color: '#f76707', title: 'Ocean observations from buoys, floats and moorings' },
    gnss: { label: 'Ground-based GNSS', color: '#a5662b', title: 'Atmospheric path delays and water vapour from GNSS receivers (e.g. E-GVAP), not weather observations' },
    satellite: { label: 'Space-based (satellites)', color: '#9c36b5', title: 'Observations from satellites (winds, radiances, occultations)' },
    lightning: { label: 'Lightning', color: '#e64980', cacheOnly: true, title: 'Lightning flashes located by detection networks (e.g. the Met Office LEELA network)' },
    webcam: { label: 'Webcam images', color: '#fcc419', cacheOnly: true, title: 'Camera images' },
    warning: { label: 'Warnings and alerts', color: '#e03131', cacheOnly: true, title: 'Weather warnings, alerts and advisories, including CAP messages and Environment Canada city forecasts' },
    other: { label: 'Other', color: '#868e96', title: 'Anything not in the groups above' },
};
// ---------- Model fields from ECCC GeoMet (WMS). GeoMet serves its default time,
// the current hour; the hour in the URL only makes browsers fetch fresh tiles.
const GEOMET = 'https://geo.weather.gc.ca/geomet';
let modelFieldOn = false;

function modelFieldUrl(key) {
    var hour = new Date().toISOString().slice(0, 13);
    return `${GEOMET}?service=WMS&version=1.3.0&request=GetMap&layers=${METRICS[key].wms}&styles=&crs=EPSG:3857`
        + `&bbox={bbox-epsg-3857}&width=256&height=256&format=image/png&transparent=true&_h=${hour}`;
}

// Shows the model base layer for the selected measure, if asked for, with its legend.
// The switch is only offered while colouring by a measure, and says when that measure has no model field.
function updateModelField(legend) {
    var m = METRICS[colourBy], available = !!m && !!m.wms, on = modelFieldOn && available;
    var row = legend.querySelector('.legend-model');
    row.hidden = !m;
    row.querySelector('input').disabled = !available;
    // Shown off where there's nothing to draw; the choice comes back with a measure that has one
    row.querySelector('input').checked = on;
    row.classList.toggle('legend-disabled', !available);
    row.querySelector('.legend-model-note').textContent = !m ? ''
        : !available ? `No model field for ${m.label.toLowerCase()}`
        : `ECCC ${m.wms.split('_')[0]} ${m.label.toLowerCase()}, ${new Date().toISOString().slice(11, 13)}:00 UTC, under the points`;
    var info = legend.querySelector('.legend-model-info');
    info.hidden = !on;
    if (map.getLayer('model-field')) {
        if (on) map.getSource('model-field').setTiles([modelFieldUrl(colourBy)]);
        map.setLayoutProperty('model-field', 'visibility', on ? 'visible' : 'none');
    }
    if (on) info.querySelector('img').src = `${GEOMET}?version=1.3.0&service=WMS&request=GetLegendGraphic&sld_version=1.1.0&layer=${m.wms}&format=image/png`;
    updateMapKey();
}

// Keeps the model field on the current hour
setInterval(() => {
    if (stylePanel && modelFieldOn) updateModelField(stylePanel);
}, 10 * 60 * 1000);

// Measures stations, ships and buoys can be coloured by (see setColourBy)
// `wms`: the matching ECCC GeoMet model layer (GDPS, or GDWPS for waves), shown
// behind the points on request. `period` (hours): totals over exactly that window, as 013011 after 004024 = -period,
// or the older fixed-window element given in `ids`
// Colour scales sampled from ECCC GeoMet's default legend for each model layer
// (GetLegendGraphic), so a station's colour matches the model field behind it.
// Units converted to the stations' own: sea temperature K to °C, wind knots to m/s.
const GEOMET_STOPS = {
    temp: [
        [-40, '#00007f'], [-37.5, '#000096'], [-35, '#0000b4'], [-32.5, '#0000ce'], [-30, '#0000ec'],
        [-27.5, '#001af4'], [-25, '#003cfc'], [-22.5, '#0065fd'], [-20, '#008ffd'], [-17.5, '#00b9fd'],
        [-15, '#00e3fd'], [-12.5, '#17f0c7'], [-10, '#33fc86'], [-7.5, '#52fc86'], [-5, '#77fc86'],
        [-2.5, '#93fc6a'], [0, '#b7fd46'], [2.5, '#d6fd27'], [5, '#fbfe03'], [7.5, '#fedf00'],
        [10, '#fdbd00'], [12.5, '#fd9b00'], [15, '#fd7900'], [17.5, '#fd5700'], [20, '#fd3200'],
        [22.5, '#f61b00'], [25, '#ee0000'], [27.5, '#d50000'], [30, '#b60000'], [32.5, '#9a0000'],
        [35, '#7f0000'], [37.5, '#6a0000'], [40, '#560000'],
    ],
    rh: [
        [0, '#ffffff'], [2.5, '#8a8ac4'], [5, '#00007f'], [7.5, '#000095'], [10, '#0000ac'],
        [12.5, '#0000c4'], [15, '#0000db'], [17.5, '#0000f6'], [20, '#0012fd'], [22.5, '#0037fd'],
        [25, '#0059fd'], [27.5, '#007bfd'], [30, '#009dfd'], [32.5, '#00bffd'], [35, '#00e7fe'],
        [37.5, '#0bfcf3'], [40, '#24fcd9'], [42.5, '#40fcbe'], [45, '#5ffc9e'], [47.5, '#77fc86'],
        [50, '#94fd69'], [52.5, '#b2fd4b'], [55, '#cdfd30'], [57.5, '#ebfe13'], [60, '#fef800'],
        [62.5, '#fdd900'], [65, '#fdbe00'], [67.5, '#fda500'], [70, '#fd8700'], [72.5, '#fd6900'],
        [75, '#fd4d00'], [77.5, '#fd3200'], [80, '#fd1700'], [82.5, '#f90000'], [85, '#e00000'],
        [87.5, '#cb0000'], [90, '#b30000'], [92.5, '#9c0000'], [95, '#840000'], [97.5, '#640000'],
        [100, '#420000'],
    ],
    mslp: [
        [940, '#00007f'], [950, '#0000a8'], [960, '#0000d4'], [970, '#0031e9'], [980, '#0067fb'],
        [990, '#10aeed'], [1000, '#22f6db'], [1010, '#77fc86'], [1020, '#d9fd24'], [1030, '#eabb13'],
        [1040, '#fd6d00'], [1050, '#ec3b00'], [1060, '#d80000'], [1070, '#af0000'], [1080, '#7f0000'],
    ],
    wind: [
        [0, '#00007f'], [1.29, '#0000a4'], [2.57, '#0002cc'], [3.86, '#0019ea'], [5.14, '#0036fd'],
        [6.43, '#0074fd'], [7.72, '#03affa'], [9, '#0ae8f3'], [10.29, '#2cfcd1'], [11.57, '#62fc9b'],
        [12.86, '#90fc6d'], [14.15, '#c2fd3b'], [15.43, '#e2eb1b'], [16.72, '#fdd400'], [18.01, '#fd9f00'],
        [19.29, '#fd6d00'], [20.58, '#fd3b00'], [21.86, '#f21900'], [23.15, '#d50700'], [24.44, '#b10000'],
        [25.72, '#850000'], [27.01, '#6b0000'], [28.29, '#550000'],
    ],
    // 0 mm (dry) is white; GeoMet leaves anything below 0.1 mm transparent
    precip: [
        [0, '#ffffff'], [0.1, '#c2d9fe'], [1.05, '#bad5fe'], [2, '#aed1fe'], [3.5, '#9fc5fe'],
        [5, '#8eb8fe'], [7.5, '#6ea5fe'], [10, '#509afb'], [15, '#2ca6eb'], [20, '#1cb7e1'], [25, '#21d7dc'],
        [30, '#26e4d6'], [35, '#2ce2d0'], [40, '#35edc7'], [45, '#42fdbb'], [50, '#61fe9c'], [55, '#85fe78'],
        [60, '#c7fe37'], [65, '#fefc00'], [70, '#fee700'], [75, '#fec300'], [80, '#fe7100'], [85, '#fc3400'],
        [90, '#f20d00'], [95, '#e30000'], [100, '#cb0000'], [110, '#aa0000'], [120, '#840000'],
        [135, '#4a0000'], [150, '#000000'],
    ],
    sst: [
        [-2, '#002cd8'], [1.2, '#0247fb'], [4.4, '#158ee8'], [7.6, '#26cdd7'], [10.8, '#44fcb9'],
        [14, '#90fd6e'], [17.2, '#dcfe22'], [20.4, '#fedc00'], [23.6, '#fd8700'], [26.8, '#fd4300'],
        [30, '#dd2500'],
    ],
    waves: [
        [0, '#0003e8'], [0.5, '#001ff2'], [1, '#003ffd'], [1.5, '#005bfd'], [2, '#0075fd'], [2.5, '#0091fd'],
        [3, '#00aefd'], [3.5, '#00cbfd'], [4, '#04e3f9'], [4.5, '#11f5ec'], [5, '#24fcd9'], [5.5, '#41fcbc'],
        [6, '#5bfca2'], [6.5, '#78fd85'], [7, '#97fd66'], [7.5, '#b3fd4a'], [8, '#cefd2f'], [8.5, '#e8fd15'],
        [9, '#f3ec0a'], [9.5, '#fdda00'], [10, '#fdbd00'], [10.5, '#fda300'], [11, '#fd8300'],
        [11.5, '#fd6900'], [12, '#fd4a00'], [12.5, '#fd2f00'], [13, '#fd1300'], [13.5, '#f50600'],
        [14, '#e80000'], [14.5, '#d40000'], [15, '#bd0000'],
    ],
};
const METRICS = {
    temp: { group: 'Air', wms: 'GDPS_15km_AirTemp_2m', label: 'Temperature', unit: '°C', ids: [12101, 12001], convert: (v) => v - 273.15,
        stops: GEOMET_STOPS.temp },
    dew: { group: 'Air', wms: 'GDPS_15km_DewPoint_2m', label: 'Dew point', unit: '°C', ids: [12103, 12003], convert: (v) => v - 273.15,
        stops: GEOMET_STOPS.temp },
    rh: { group: 'Air', wms: 'GDPS_15km_RelativeHumidity_2m', label: 'Humidity', unit: '%', ids: [13003],
        stops: GEOMET_STOPS.rh },
    mslp: { group: 'Air', wms: 'GDPS_15km_Pressure_MSL', label: 'Pressure (MSL)', unit: 'hPa', ids: [10051], convert: (v) => v / 100,
        stops: GEOMET_STOPS.mslp },
    wind: { group: 'Air', wms: 'GDPS_15km_WindSpeed_10m', label: 'Wind speed', unit: 'm/s', ids: [11002],
        stops: GEOMET_STOPS.wind },
    precip1: { group: 'Precipitation', wms: 'GDPS_15km_Precip-Accum1h', label: 'Precipitation, last hour', unit: 'mm', period: 1, ids: [13019], stops: GEOMET_STOPS.precip },
    precip6: { group: 'Precipitation', wms: 'GDPS_15km_Precip-Accum6h', label: 'Precipitation, last 6 hours', unit: 'mm', period: 6, ids: [13021], stops: GEOMET_STOPS.precip },
    precip24: { group: 'Precipitation', wms: 'GDPS_15km_Precip-Accum24h', label: 'Precipitation, last 24 hours', unit: 'mm', period: 24, ids: [13023], stops: GEOMET_STOPS.precip },
    // Marine: ships and buoys
    sst: { group: 'Sea surface (ships and buoys)', wms: 'GDPS_15km_SeaWaterTemp', label: 'Sea temperature', unit: '°C', ids: [22043, 22049, 22042], convert: (v) => v - 273.15,
        stops: GEOMET_STOPS.sst },
    waves: { group: 'Sea surface (ships and buoys)', wms: 'GDWPS_25km_HTSGW_PT1H', label: 'Wave height', unit: 'm', ids: [22070, 22021, 22022],
        stops: GEOMET_STOPS.waves },
    // Satellites: `targets` points these at the satellite groups instead of stations, ships and buoys
    satWind: { group: 'Space-based (satellites)', targets: 'satellite', label: 'Cloud-level wind speed', unit: 'm/s', ids: [11002],
        stops: GEOMET_STOPS.wind },
    cloudTop: { group: 'Space-based (satellites)', targets: 'satellite', label: 'Cloud-top pressure', unit: 'hPa', ids: [20016], convert: (v) => v / 100,
        stops: [[100, '#fde725'], [250, '#7ad151'], [400, '#22a884'], [550, '#2a788e'], [700, '#414487'], [1000, '#440154']] },
    brightness: { group: 'Space-based (satellites)', targets: 'satellite', label: 'Brightness temperature', unit: 'K', ids: [12163],
        stops: [[180, '#000004'], [210, '#320a5e'], [235, '#781c6d'], [255, '#bc3754'], [270, '#ed6925'], [290, '#fbb61a'], [320, '#fcffa4']] },
    // Matched to the model's total cloud cover (GeoMet's greyscale style: dark clear, white overcast)
    cloudAmount: { group: 'Space-based (satellites)', targets: 'satellite', wms: 'GDPS_15km_TotalCloudCover', label: 'Cloud amount', unit: '%', ids: [20081],
        stops: [[0, '#202020'], [10, '#292929'], [20, '#454545'], [30, '#575757'], [40, '#737373'], [50, '#868686'],
            [60, '#a1a1a1'], [70, '#bdbdbd'], [80, '#d0d0d0'], [90, '#ebebeb'], [100, '#fefefe']] },
};
// Surface observations that can be coloured by a measure: stations, ships and buoys, cache and GTS
const COLOURABLE = [...['station', 'ship', 'buoy'].flatMap((k) => [`cache-${k}`, `gts-${k}`, `replay-${k}`]), 'airports'];
const SATELLITE_LAYERS = ['cache-satellite', 'gts-satellite', 'replay-satellite'];
const IS_STATION = ['in', ['get', 'layer'], ['literal', COLOURABLE]];

// The layers a measure colours (stations, ships and buoys unless it says satellites)
function colourTargets(m) {
    return m && m.targets === 'satellite' ? SATELLITE_LAYERS : COLOURABLE;
}

function isColourTarget() {
    return ['in', ['get', 'layer'], ['literal', colourTargets(METRICS[colourBy])]];
}
const IS_AIRCRAFT = ['in', ['get', 'layer'], ['literal', ['cache-aircraft', 'gts-aircraft', 'replay-aircraft']]];
const NO_VALUE_COLOR = '#ced4da';
const METRIC_QUEUE_MAX = 5000;  // Station files waiting to be decoded, newest kept (most carry their data inline, a few ms each)
let colourBy = 'kind';
let colouredOnly = false;  // Hide every point not coloured by the measure
let metricQueue = [];
let metricBusy = false;

// GTS sublayers that start off. Their bulletins aren't downloaded until they're
// switched on, so their rows appear when the first such notification arrives
// (see revealGatewayRows) rather than when a report is plotted.
const GTS_OPT_IN = ['aircraft'];
// Satellites from every source share one row (and one row per satellite) in their
// own section. Each report keeps its source's layer (SATELLITE_LAYERS), which sits under that row.

// Legend rows, grouped by source; each can be switched on and off. Rows other
// than opt-in ones stay hidden until a point of that kind has arrived. Opt-in
// rows are decoded in the browser, since their notifications carry no location.
const LAYER_GROUPS = [
    { key: 'wis2', label: 'WIS2', subtitle: 'Published directly through the WMO Information System', layers: [
        { key: 'obs', label: 'Cache', color: OBS_CLASSES.station.color, optIn: true },  // Always listed
        // Sublayers sit under their parent and are off whenever it is off
        ...Object.entries(OBS_CLASSES).filter(([key]) => key !== 'satellite').map(([key, c]) => ({ key: `cache-${key}`, parent: 'obs', label: c.label, color: c.color, title: c.title })),
        { key: 'radar', parent: 'obs', label: 'Weather radar', color: COLORS.radar,
            title: 'Reflectivity from the lowest scan of each radar volume (ODIM HDF5) in the cache, drawn around the radar; downloaded only while this is on' },
        { key: 'origin', label: 'Origin', color: COLORS.origin, ring: true },
        { key: 'replay', label: 'Global Replay', color: COLORS.replay, optIn: true,
            title: 'Fill the view with past WIS2 core-data notifications from the Global Replay service (wis2-grep.weather.gc.ca); how far back is set by the slider below. Older points are fainter.' },
        // Replayed messages sorted like the cache's, each row shown once something arrives in it
        ...Object.entries(OBS_CLASSES).filter(([key]) => key !== 'satellite').map(([key, c]) => ({ key: `replay-${key}`, parent: 'replay', label: c.label, color: c.color, title: c.title })),
    ] },
    { key: 'gts', label: 'GTS gateways', subtitle: 'Bulletins relayed with the GTS', layers: [
        { key: 'gts', label: 'GTS-to-WIS2 (decode required)', color: COLORS.gts, optIn: true,
            title: 'Download and decode the BUFR bulletins republished from the GTS into WIS2 (centres ending -gts-to-wis2), and plot the reports inside' },
        // Each decoded report is sorted by the identifiers it carries (see reportClass)
        ...Object.entries(OBS_CLASSES).filter(([key, c]) => !c.cacheOnly && key !== 'satellite').flatMap(([key, c]) => [
            { key: `gts-${key}`, parent: 'gts', label: c.label, color: c.color,
                title: c.title + (GTS_OPT_IN.includes(key) ? '; downloaded only while this is on' : '') },
            // Aircraft can be drawn as flight paths; shown once the Aircraft row is
            ...(key === 'aircraft' ? [{ key: 'gts-tracks', parent: 'gts-aircraft', label: 'Tracks', follow: true, track: true,
                color: 'linear-gradient(90deg, #99e9f2, #22b8cf, #1971c2, #5f3dc4)',
                title: 'Each aircraft drawn in the air at its altitude: a path coloured by height (light low, dark high), chevrons pointing the way it is flying, and a red arrowhead at its latest report. Tilt the map to see it in 3D. Off: every report is a point on the ground.' }] : []),
        ]),
        { key: 'wis2gts', label: 'WIS2-to-GTS (decode required)', color: COLORS.wis2gts, optIn: true,
            title: 'Download and decode the BUFR that WIS2 centres pass on to the GTS (centres ending -wis2-to-gts), and plot the reports inside' },
    ] },
    { key: 'space', label: 'Satellites', subtitle: 'Space-based observations from WIS2 and the GTS', layers: [
        { key: 'satellite', label: OBS_CLASSES.satellite.label, color: OBS_CLASSES.satellite.color,
            title: OBS_CLASSES.satellite.title + ', from the WIS2 cache, the GTS gateways and the Global Replay. Files without a location are downloaded and decoded only while this is on.' },
        // Off: every report is its own point, e.g. to read cloud-motion winds one by one
        { key: 'sat-coverage', parent: 'satellite', option: true, label: 'Draw as coverage areas',
            title: 'Draw files with many reports as shaded coverage, and satellites as tracks. Off: every report is a point, coloured by the selected measure.' },
    ] },
    { key: 'other', label: 'Other sources', subtitle: 'Not from WIS2: fetched directly from the provider', layers: [
        { key: 'airports', label: 'Airports worldwide (METAR)', color: OBS_CLASSES.station.color, optIn: true,
            title: 'The latest METAR from every airport the Iowa Environmental Mesonet collects, refreshed every 20 minutes. The airports nearest the view load first.' },
    ] },
];
// Off at first: radar, airports, WIS2-to-GTS, satellites, aircraft and ground-based GNSS (cache, GTS and replay), and aircraft tracks.
// The Global Replay is on, reaching back REPLAY_DEFAULT_MINUTES, so the map isn't empty at first
const hiddenLayers = new Set(['radar', 'cache-gnss', 'gts-gnss', 'replay-gnss', 'airports', 'wis2gts', 'satellite', 'cache-aircraft', 'gts-aircraft', 'replay-aircraft', 'gts-tracks']);
// How far back the Global Replay reaches, set by a continuous slider on a log scale:
// 12 hours ago at the left, 5 minutes at the right, so time runs left to right and
// recent windows get most of the track. Long windows over a busy view stop at
// REPLAY_MAX, newest first, so they reach back less far there
const REPLAY_RANGE_MINUTES = [720, 5];
const REPLAY_TICKS = [720, 360, 180, 60, 30, 15, 5];
const REPLAY_DEFAULT_MINUTES = 5;
let replayWindowMs = REPLAY_DEFAULT_MINUTES * 60 * 1000;

// Slider position (0 to 1) for a window in minutes, and back, rounded to whole
// minutes under an hour and to 5 minutes above
function replayPosition(minutes) {
    var [far, near] = REPLAY_RANGE_MINUTES.map(Math.log);
    return (Math.log(minutes) - far) / (near - far);
}

function replayMinutesAt(position) {
    var [far, near] = REPLAY_RANGE_MINUTES.map(Math.log);
    var minutes = Math.exp(far + (near - far) * position);
    return minutes < 60 ? Math.round(minutes) : Math.round(minutes / 5) * 5;
}
const LAYER_PARENTS = Object.fromEntries([
    ...LAYER_GROUPS.flatMap((g) => g.layers).filter((l) => l.parent).map((l) => [l.key, l.parent]),
    // Replayed satellites also go when the Global Replay is off (see applyMapFilter)
    ...SATELLITE_LAYERS.map((k) => [k, 'satellite']),
    // Files without a location are always decoded while Cache is on; the reports inside join its groups
    ['files', 'obs'],
    // Text SYNOPs join GTS-to-WIS2's groups, so they're decoded while it is on
    ['gts-text', 'gts'],
    // The replay window slider is greyed out with its row
    ['replay-window', 'replay'],
]);

function ancestors(key) {
    var out = [];
    for (var k = LAYER_PARENTS[key]; k; k = LAYER_PARENTS[k]) out.push(k);
    return out;
}

// Layers switched off directly, plus sublayers with any ancestor off
function effectiveHidden() {
    return [...new Set([...hiddenLayers, ...Object.keys(LAYER_PARENTS).filter((k) => ancestors(k).some((a) => hiddenLayers.has(a)))])];
}
const seenLayers = new Set();
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let projection = 'globe';
try {
    projection = localStorage.getItem('wis-projection') === 'mercator' ? 'mercator' : 'globe';
} catch (err) {
    // Storage unavailable; use the default
}

// Start near the visitor without asking for their location: the time zone's
// UTC offset gives a longitude and its region a rough latitude. Nothing is sent
// anywhere. If they have already let this site see their location, use it.
function guessCentre() {
    // The standard (winter) offset, so daylight saving doesn't shift the guess an hour east
    var year = new Date().getFullYear();
    var offset = Math.max(new Date(year, 0, 1).getTimezoneOffset(), new Date(year, 6, 1).getTimezoneOffset());
    var lon = Math.max(-170, Math.min(170, -offset / 60 * 15));
    var zone = '';
    try {
        zone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    } catch (err) {
        // No time zone support; the offset alone will do
    }
    var region = zone.split('/')[0];
    var lat = {
        America: zone.includes('Argentina') || /Sao_Paulo|Santiago|Lima|Bogota|Montevideo|La_Paz|Asuncion|Caracas/.test(zone) ? -15 : 38,
        Europe: 50, Africa: 5, Asia: 30, Australia: -27, Pacific: -15, Atlantic: 30, Indian: -10, Antarctica: -75,
    }[region];
    return [lon, lat === undefined ? 30 : lat];
}

function centreOnVisitor() {
    if (!navigator.permissions || !navigator.geolocation) return;
    navigator.permissions.query({ name: 'geolocation' }).then((status) => {
        if (status.state !== 'granted') return;
        navigator.geolocation.getCurrentPosition(
            (pos) => map.easeTo({ center: [pos.coords.longitude, pos.coords.latitude], duration: 1500 }),
            () => {},  // Keep the guess
            { maximumAge: 60 * 60 * 1000, timeout: 10000 });
    }).catch(() => {});
}

const map = new maplibregl.Map({
    container: 'map',
    style: {
        version: 8,
        sources: {
            basemap: {
                type: 'raster',
                tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}'],
                tileSize: 256,
                maxzoom: 16,
                attribution: 'Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ',
            },
        },
        layers: [{ id: 'basemap', type: 'raster', source: 'basemap' }],
        projection: { type: projection },
        // Atmosphere halo around the globe, fading out as you zoom in, and a
        // pale sky above the horizon when the map is tilted
        sky: {
            'sky-color': '#cfe2f3',
            'horizon-color': '#eef4fa',
            'sky-horizon-blend': 0.6,
            'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 7, 0],
        },
    },
    center: guessCentre(),
    zoom: 2,
    minZoom: 0,
    maxZoom: 15,
    // Added below as its own control, so it can be kept closed
    attributionControl: false,
});
// The ⓘ button: tile credits plus what this page is
const attribution = new maplibregl.AttributionControl({
    compact: true,
    customAttribution: '<br>WIS 2.0 Live shows real-time weather observations as they are published through the WMO Information System. This page is not affiliated with WMO.',
});

const records = new Map();  // id -> record for every point on the map
const pools = { wis2: new Map(), decoded: new Map(), satellite: new Map() };  // Same records, in arrival order per cap
const POOL_CAPS = { wis2: MAX_POINTS, decoded: MAX_DECODED_POINTS, satellite: MAX_SATELLITE_POINTS };

// Weather radar images, one per radar (drawn in the radar section; the map key reads them)
// dBZ thresholds and colours, light rain to hail; below 5 dBZ isn't drawn
const RADAR_COLORS = [[5, '#9be1ff'], [10, '#4fc3f7'], [15, '#2196f3'], [20, '#00c853'], [25, '#64dd17'], [30, '#ffeb3b'],
    [35, '#ffc107'], [40, '#ff9800'], [45, '#f44336'], [50, '#c62828'], [55, '#e91e63'], [60, '#9c27b0'], [65, '#ffffff']];
const radars = new Map();  // site -> { id, time, quantity, updated }

function poolOf(record) {
    if (!record.decodedLayer) return 'wis2';
    return record.subLayer && record.subLayer.endsWith('-satellite') ? 'satellite' : 'decoded';
}
const byDataId = new Map(); // data_id -> record, so each observation is drawn once
let nextId = 1;
let toAdd = [];
let toRemove = [];
let toUpdate = [];
let pulses = [];            // Recent arrivals, drawn as expanding rings
let animating = false;

// A darker shade of a hex colour, for outlines that match their fill
function darken(hex, amount = 0.45) {
    var n = parseInt(hex.trim().slice(1), 16);
    var channel = (shift) => Math.round(((n >> shift) & 255) * (1 - amount));
    return `#${[16, 8, 0].map((shift) => channel(shift).toString(16).padStart(2, '0')).join('')}`;
}

function isGateway(record) {
    return ['gts', 'gts-satellite', 'gts-text', 'wis2gts'].includes(record.decodedLayer);
}

// The two sources' accent colours, as in the legend sections (style.css)
const SOURCE_COLORS = { wis2: '#1c7ed6', gts: '#7048e8' };

// Layers that draw observation points: WIS2 circles and GTS diamonds
const POINT_LAYERS = ['points', 'points-gts', 'points-ext', 'points-arrow'];
// How far from a point a click still picks it, in pixels: fingers are less exact
const TOUCH = window.matchMedia('(pointer: coarse)');

function nearestPoint(point) {
    var reach = TOUCH.matches ? 14 : 5;
    var box = [[point.x - reach, point.y - reach], [point.x + reach, point.y + reach]];
    var best = null, bestDistance = Infinity;
    for (var f of map.queryRenderedFeatures(box, { layers: POINT_LAYERS.filter((id) => map.getLayer(id)) })) {
        var record = records.get(f.id);
        if (!record) continue;
        var p = map.project(record.coords), d = Math.hypot(p.x - point.x, p.y - point.y);
        if (d < bestDistance) { best = f; bestDistance = d; }
    }
    return best;
}

// Point size by zoom, shared by the WIS2 circles and the GTS diamonds
const POINT_RADIUS = ['interpolate', ['linear'], ['zoom'], 1, 2, 4, 4.5, 8, 8, 15, 16];
const DIAMOND_HALF = 14;  // Half-diagonal of the diamond image, in image pixels (pixel ratio 2)
// icon-size per pixel of circle radius, with diamonds a little larger so their area matches a circle's
const DIAMOND_SCALE = 1.3 / (DIAMOND_HALF / 2);

// A diamond as a signed distance field, so MapLibre can tint it per point and
// draw an outline (halo). Encoding as TinySDF: 0.75 at the edge, 8 px radius.
// A wind arrow pointing up (north), as a signed distance field so it takes any
// colour and a halo. The shape is drawn on a canvas and the field measured from it.
function arrowSdf() {
    var size = 48, c = size / 2, radius = 8, cutoff = 0.25;
    var canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    var ctx = canvas.getContext('2d');
    ctx.beginPath();
    ctx.moveTo(c, c - 16);       // tip
    ctx.lineTo(c + 10, c - 2);
    ctx.lineTo(c + 4, c - 2);
    ctx.lineTo(c + 4, c + 15);   // tail
    ctx.lineTo(c - 4, c + 15);
    ctx.lineTo(c - 4, c - 2);
    ctx.lineTo(c - 10, c - 2);
    ctx.closePath();
    ctx.fill();
    var alpha = ctx.getImageData(0, 0, size, size).data;
    var inside = (i) => alpha[i * 4 + 3] > 127;
    var edges = [];
    for (var i = 0; i < size * size; i++) {
        var x = i % size, y = (i / size) | 0;
        if (inside(i) && [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => !inside((y + dy) * size + x + dx))) edges.push([x, y]);
    }
    var data = new Uint8ClampedArray(size * size * 4);
    for (var j = 0; j < size * size; j++) {
        var px = j % size, py = (j / size) | 0, d = Infinity;
        for (var [ex, ey] of edges) d = Math.min(d, Math.hypot(px - ex, py - ey));
        d = inside(j) ? -d : d;
        data[j * 4] = data[j * 4 + 1] = data[j * 4 + 2] = 255;
        data[j * 4 + 3] = 255 - 255 * (d / radius + cutoff);
    }
    return { width: size, height: size, data };
}

// Wind measures draw points with a direction as arrows (calm ones stay as points)
function windArrows() {
    return colourBy === 'wind' || colourBy === 'satWind';
}

function isArrow() {
    return ['all', isColourTarget(), ['has', 'm_windDir'], ['>', ['coalesce', ['get', `m_${colourBy}`], 0], 0]];
}

// A square as a signed distance field, for points from other sources (airports)
function squareSdf() {
    var half = 10, size = 2 * (half + 8), c = size / 2, radius = 8, cutoff = 0.25;
    var data = new Uint8ClampedArray(size * size * 4);
    for (var y = 0; y < size; y++) {
        for (var x = 0; x < size; x++) {
            var d = Math.max(Math.abs(x + 0.5 - c), Math.abs(y + 0.5 - c)) - half;
            var i = (y * size + x) * 4;
            data[i] = data[i + 1] = data[i + 2] = 255;
            data[i + 3] = 255 - 255 * (d / radius + cutoff);
        }
    }
    return { width: size, height: size, data };
}

function diamondSdf() {
    var size = 2 * (DIAMOND_HALF + 8), c = size / 2, radius = 8, cutoff = 0.25;
    var data = new Uint8ClampedArray(size * size * 4);
    for (var y = 0; y < size; y++) {
        for (var x = 0; x < size; x++) {
            // Distance outside the diamond |x| + |y| = half (negative inside)
            var d = (Math.abs(x + 0.5 - c) + Math.abs(y + 0.5 - c) - DIAMOND_HALF) / Math.SQRT2;
            var i = (y * size + x) * 4;
            data[i] = data[i + 1] = data[i + 2] = 255;
            data[i + 3] = 255 - 255 * (d / radius + cutoff);
        }
    }
    return { width: size, height: size, data };
}

// Altitude in metres to a colour, light near the ground to deep at cruise height
const ALTITUDE_COLORS = ['interpolate', ['linear'], ['coalesce', ['get', 'alt'], 0],
    0, '#99e9f2', 3000, '#22b8cf', 7000, '#1971c2', 11000, '#5f3dc4'];

// Extrusion height in metres from a feature property, exaggerated when zoomed
// out so heights stay visible on the globe
function altitudeHeight(property) {
    var alt = ['get', property];
    return ['interpolate', ['linear'], ['zoom'], 1, ['*', alt, 60], 4, ['*', alt, 20], 8, ['*', alt, 4], 12, alt];
}

// The selected point's details open in a panel on the right, and a ring marks
// the point on the map
let infobar = null;
const selectedMarker = new maplibregl.Marker({ element: Object.assign(document.createElement('div'), { className: 'selected-marker' }) });
const hoverLabel = new maplibregl.Popup({
    closeButton: false,
    closeOnClick: false,
    className: 'hover-label',
    offset: 10,
});

map.on('load', () => {
    var empty = { type: 'FeatureCollection', features: [] };
    map.addSource('points', { type: 'geojson', data: empty });
    map.addSource('pulses', { type: 'geojson', data: empty });
    // Optional model field for the selected measure (ECCC GeoMet WMS), under everything else
    map.addSource('model-field', { type: 'raster', tiles: [modelFieldUrl('temp')], tileSize: 256,
        attribution: 'Model fields: ECCC GDPS/GDWPS via GeoMet' });
    map.addLayer({ id: 'model-field', type: 'raster', source: 'model-field', layout: { visibility: 'none' },
        paint: { 'raster-opacity': 0.55, 'raster-fade-duration': 0 } });
    map.addSource('alert-area', { type: 'geojson', data: empty });
    map.addLayer({
        id: 'alert-area',
        type: 'fill',
        source: 'alert-area',
        paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.25 },
    });
    map.addLayer({
        id: 'alert-area-line',
        type: 'line',
        source: 'alert-area',
        paint: { 'line-color': ['get', 'color'], 'line-width': 2 },
    });
    map.addLayer({
        id: 'pulses',
        type: 'circle',
        source: 'pulses',
        paint: {
            'circle-color': 'rgba(0, 0, 0, 0)',
            // The source's colour from the legend: GTS purple, WIS2 blue
            'circle-stroke-color': ['case', ['get', 'gateway'], SOURCE_COLORS.gts, SOURCE_COLORS.wis2],
            'circle-stroke-width': 1.5,
            'circle-pitch-alignment': 'map',
        },
    });
    // Each decoded satellite file as one footprint (the area its reports cover), under the points
    map.addSource('swaths', { type: 'geojson', data: empty });
    // No antialiasing, so neighbouring cells meet without hairline seams
    map.addLayer({ id: 'swaths-fill', type: 'fill', source: 'swaths', paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.3, 'fill-antialias': false } });
    map.on('click', 'swaths-fill', (e) => {
        if (nearestPoint(e.point)) return;
        openPopup(nearestSwathReport(e.features[0].properties.swath, e.lngLat));
    });
    map.on('mousemove', 'swaths-fill', (e) => {
        if (map.queryRenderedFeatures(e.point, { layers: POINT_LAYERS }).length) return;
        var f = e.features[0].properties;
        map.getCanvas().style.cursor = 'pointer';
        var m = METRICS[colourBy];
        var reading = m && m.targets === 'satellite' && typeof f[`m_${colourBy}`] === 'number' ? ` · ${formatMetric(f[`m_${colourBy}`], m)}` : '';
        var clouds = typeof f.m_cloudAmount === 'number' ? ` · cloud ${Math.round(f.m_cloudAmount)}%` : '';
        hoverLabel.setLngLat(e.lngLat).setText(`${f.label}${reading || clouds}`).addTo(map);
    });
    map.on('mouseleave', 'swaths-fill', () => {
        map.getCanvas().style.cursor = '';
        hoverLabel.remove();
    });
    // Aircraft flight paths and satellite ground tracks, under the points
    map.addSource('tracks', { type: 'geojson', data: empty });
    map.addLayer({
        id: 'tracks',
        type: 'line',
        source: 'tracks',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        filter: ['==', ['geometry-type'], 'LineString'],
        paint: {
            // Aircraft segments are coloured by altitude; satellites by their sublayer
            'line-color': ['case', ['has', 'alt'], ALTITUDE_COLORS, ['get', 'color']],
            'line-width': ['interpolate', ['linear'], ['zoom'], 1, ['case', ['==', ['get', 'kind'], 'satellite'], 1, 2], 6, 3.5],
        },
    });
    // Aircraft paths float at their altitude: a band coloured by height, dark
    // chevrons pointing the way of travel, and a red arrowhead at the latest report
    map.addLayer({
        id: 'track-ribbons',
        type: 'fill-extrusion',
        source: 'tracks',
        filter: ['==', ['geometry-type'], 'Polygon'],
        paint: {
            'fill-extrusion-color': ['match', ['get', 'role'], 'marker', '#e03131', 'arrow', '#212529', ALTITUDE_COLORS],
            'fill-extrusion-height': altitudeHeight('top'),
            'fill-extrusion-base': altitudeHeight('bottom'),
            'fill-extrusion-opacity': 0.9,
        },
    });
    map.addLayer({
        id: 'points',
        type: 'circle',
        source: 'points',
        layout: { 'circle-sort-key': ['get', 'order'] },  // Newest on top
        paint: {
            // Origin-only messages are hollow rings; cache copies are filled, outlined a shade darker
            'circle-color': ['get', 'color'],
            'circle-stroke-color': ['case', ['get', 'origin'], ['get', 'color'], ['get', 'outline']],
            'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 1, 0.75, 6, 1.5],
            'circle-radius': POINT_RADIUS,
            'circle-pitch-alignment': 'map',
        },
    });
    // GTS gateway reports are diamonds with a dark outline, so they stay apart
    // from WIS2 circles even when zoomed out and the outlines are too thin to see
    map.addImage('diamond', diamondSdf(), { sdf: true, pixelRatio: 2 });
    map.addLayer({
        id: 'points-gts',
        type: 'symbol',
        source: 'points',
        layout: {
            'icon-image': 'diamond',
            'icon-size': ['interpolate', ['linear'], ['zoom'], ...POINT_RADIUS.slice(3).map((v, i) => (i % 2 ? v * DIAMOND_SCALE : v))],
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
            'icon-pitch-alignment': 'map',
            'symbol-sort-key': ['get', 'order'],
        },
        paint: {
            'icon-color': ['get', 'color'],
            'icon-halo-color': ['get', 'outline'],
            'icon-halo-width': ['interpolate', ['linear'], ['zoom'], 1, 0.75, 6, 1.5],
        },
    });
    // Wind arrows point the way the wind blows (reports give where it comes from)
    map.addImage('arrow', arrowSdf(), { sdf: true, pixelRatio: 2 });
    map.on('moveend', () => scheduleReplay());
    scheduleReplay(0);  // On at first
    // Points from other sources (airports) are squares
    map.addImage('square', squareSdf(), { sdf: true, pixelRatio: 2 });
    map.addLayer({
        id: 'points-ext',
        type: 'symbol',
        source: 'points',
        layout: {
            'icon-image': 'square',
            'icon-size': ['interpolate', ['linear'], ['zoom'], ...POINT_RADIUS.slice(3).map((v, i) => (i % 2 ? v / 10 : v))],
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
            'icon-pitch-alignment': 'map',
            'symbol-sort-key': ['get', 'order'],
        },
        paint: {
            'icon-color': ['get', 'color'],
            'icon-halo-color': ['get', 'outline'],
            'icon-halo-width': ['interpolate', ['linear'], ['zoom'], 1, 0.75, 6, 1.5],
        },
    });
    map.addLayer({
        id: 'points-arrow',
        type: 'symbol',
        source: 'points',
        filter: ['boolean', false],
        layout: {
            'icon-image': 'arrow',
            'icon-size': ['interpolate', ['linear'], ['zoom'], 1, 0.5, 6, 0.75, 10, 1],
            'icon-rotate': ['+', ['to-number', ['get', 'm_windDir'], 0], 180],
            'icon-rotation-alignment': 'map',
            // Where stations crowd, arrows that would overlap are left out (the
            // strongest winds go first) and come back on zooming in
            'icon-allow-overlap': false,
            'icon-ignore-placement': true,
            'icon-padding': 0,
            'icon-pitch-alignment': 'map',
            'symbol-sort-key': ['get', 'order'],
        },
        paint: {
            'icon-color': ['get', 'color'],
            // A light edge keeps neighbouring arrows apart
            'icon-halo-color': 'rgba(255, 255, 255, 0.9)',
            'icon-halo-width': 1,
        },
    });
    paintAge();
    setInterval(paintAge, 30 * 1000);
    applyMapFilter();
    // Open coloured by temperature, near the visitor
    if (stylePanel) {
        stylePanel.querySelector('.legend-colour select').value = 'temp';
        setColourBy('temp', stylePanel);
    }
    centreOnVisitor();
    preloadDecoder();
    flushPoints();
    setInterval(flushPoints, 500);

    // The point nearest a click or tap, within reach of a finger (or a mouse)
    map.on('click', (e) => {
        var near = nearestPoint(e.point);
        if (near) { openPopup(records.get(near.id)); return; }
        // A click on empty map closes the info panel
        var hit = map.queryRenderedFeatures(e.point, { layers: ['tracks', 'track-ribbons', 'swaths-fill'].filter((id) => map.getLayer(id)) });
        if (!hit.length && document.body.classList.contains('info-open')) closeInfo();
    });
    map.on('click', 'tracks', (e) => {
        // Points take precedence where both are under the pointer
        if (nearestPoint(e.point)) return;
        openPopup(records.get(e.features[0].properties.recordId || e.features[0].properties.lastId));
    });
    map.on('mousemove', 'tracks', (e) => {
        if (map.queryRenderedFeatures(e.point, { layers: POINT_LAYERS }).length) return;
        var f = e.features[0].properties;
        map.getCanvas().style.cursor = 'pointer';
        hoverLabel.setLngLat(e.lngLat).setText(f.alt !== undefined
            ? `${f.label} · ${Math.round(f.alt).toLocaleString()} m` : `${f.label} · ${f.count} reports`).addTo(map);
    });
    map.on('mouseleave', 'tracks', () => {
        map.getCanvas().style.cursor = '';
        hoverLabel.remove();
    });
    map.on('click', 'track-ribbons', (e) => openPopup(records.get(e.features[0].properties.recordId)));
    map.on('mousemove', 'track-ribbons', (e) => {
        var f = e.features[0].properties;
        map.getCanvas().style.cursor = 'pointer';
        hoverLabel.setLngLat(e.lngLat).setText(`${f.label} · ${Math.round(f.alt).toLocaleString()} m${f.role === 'marker' ? ' · latest' : ''}`).addTo(map);
    });
    map.on('mouseleave', 'track-ribbons', () => {
        map.getCanvas().style.cursor = '';
        hoverLabel.remove();
    });
    // Band and arrow sizes are in screen pixels, so rebuild them after zooming
    map.on('zoomend', () => { tracksDirty = true; });
    map.on('mousemove', POINT_LAYERS, (e) => {
        var record = records.get(e.features[0].id);
        map.getCanvas().style.cursor = 'pointer';
        if (!record) return hoverLabel.remove();
        var route = record.subLayer && record.subLayer.endsWith('-aircraft') ? trackRoute([record]) : null;
        // While colouring by a measure, the point's value too
        var m = METRICS[colourBy], value = m && e.features[0].properties[`m_${colourBy}`];
        var text = m && typeof value === 'number' ? formatMetric(value, m)
            : [record.wsi || record.props.metadata_id || record.centre, route].filter(Boolean).join(' · ');
        hoverLabel.setLngLat(record.coords).setText(text).addTo(map);
    });
    map.on('mouseleave', POINT_LAYERS, () => {
        map.getCanvas().style.cursor = '';
        hoverLabel.remove();
    });
});

// Adds a point, or returns the record already drawn for the same observation.
// The origin and every global cache each republish an observation, so a cache
// copy replaces an origin one but later copies are skipped.
// The latest report on the map from each station, so a replayed report that is
// older than one already here can be left out (bounded by the points on the map)
const latestByStation = new Map();  // station id -> record

function observedAt(record) {
    return Date.parse(record.props.datetime || '') || record.born;
}

function addPoint(record) {
    var existing = byDataId.get(record.props.data_id);
    if (existing && records.has(existing.id)) {
        // An update replaces the data published earlier under its data_id; the caches'
        // copies of the same update (same pubtime) are skipped like any other copy
        var newer = record.update && Date.parse(record.props.pubtime || '') > Date.parse(existing.props.pubtime || '');
        if (!newer && (existing.channel === 'cache' || record.channel !== 'cache')) return existing;
        removePoint(existing);
    }
    if (record.props.data_id) byDataId.set(record.props.data_id, record);

    records.set(record.id, record);
    rememberStation(record);
    if (record.wsi) {
        var latest = latestByStation.get(record.wsi);
        if (!latest || !records.has(latest.id) || observedAt(record) >= observedAt(latest)) latestByStation.set(record.wsi, record);
    }
    var feature = {
        type: 'Feature',
        id: record.id,
        geometry: { type: 'Point', coordinates: record.coords },
        properties: {
            color: record.color,
            origin: record.channel !== 'cache' && !record.external,
            born: record.born,
            order: record.id,
            layer: layerOf(record),
            format: record.format,
            channel: record.channel,
            centre: record.centre,
            discipline: record.discipline,
            space: isSpaceRecord(record),
            via: record.decodedLayer || '',
            gateway: isGateway(record),
            sat: satelliteKey(record),
            inSwath: !!record.inSwath,
            ext: !!record.external,
            replay: !!record.replay,
            outline: darken(record.color),
            topic: record.topic.toLowerCase(),
            ...metricValues(record),
        },
    };
    // While tracks are on, an aircraft is drawn only at its latest report and
    // the track line carries the rest
    if (!isLatestOnTrack(record)) feature.properties.superseded = true;
    if (record.track && record.track.startsWith('aircraft:')) feature.properties.tracked = true;
    record.feature = feature;
    toAdd.push(feature);
    if (!reduceMotion && !feature.properties.superseded && !record.external && !record.replay) pulses.push(feature);
    if (!seenLayers.has(feature.properties.layer)) showLegendRow(feature.properties.layer);
    if (feature.properties.sat) addSatelliteRow(feature.properties.sat);
    // Other sources are bounded by their own station lists, and stay put
    if (record.external) return record;

    var pool = pools[poolOf(record)];
    pool.set(record.id, record);
    if (pool.size > POOL_CAPS[poolOf(record)]) {
        removePoint(pool.values().next().value);
    }
    return record;
}

// The latest report on each aircraft track: a report takes over from the
// track's previous latest, unless that one was observed later
const latestOnTrack = new Map();  // aircraft track key -> record

function isLatestOnTrack(record) {
    if (!record.track || !record.track.startsWith('aircraft:')) return true;
    var current = latestOnTrack.get(record.track);
    if (current && records.has(current.id)) {
        if (current.observed > record.observed) return false;
        supersede(current);
    }
    latestOnTrack.set(record.track, record);
    return true;
}

// Flags a point as no longer its aircraft's latest, in place if it hasn't been drawn yet
function supersede(record) {
    record.feature.properties.superseded = true;
    if (!toAdd.includes(record.feature)) {
        toUpdate.push({ id: record.id, addOrUpdateProperties: [{ key: 'superseded', value: true }] });
    }
}

function layerOf(record) {
    if (record.subLayer) return record.subLayer;
    if (record.decodedLayer) return record.decodedLayer;
    if (record.channel !== 'cache') return 'origin';
    return `cache-${topicClass(record)}`;
}

// The kind of observation a cache notification holds, from its topic
// (data/core/<discipline>/<kind of observation>/...)
function topicClass(record) {
    var t = record.topic.toLowerCase();
    if (record.webcam) return 'webcam';
    if (record.props.cap_info || /warning|alert|advisor|\/cap(\/|$)/.test(t)) return 'warning';
    if (/space-based-observations/.test(t)) return 'satellite';
    // Before upper air: the Met Office publishes under upper-air-observations/lightning
    if (/lightning/.test(t)) return 'lightning';
    if (/aircraft|amdar|aviation/.test(t)) return 'aircraft';
    if (/upper-air|radiosonde|\/temp(\/|$)|\/pilot(\/|$)|profil/.test(t)) return 'upperair';
    if (/gnss|gpsmet|\/ztd(\/|$)/.test(t)) return 'gnss';
    if (/\/ship/.test(t)) return 'ship';
    if (/buoy|float|argo|glider|mooring|tide-gauge|ocean\//.test(t)) return 'buoy';
    if (/surface-based-observations|synop|\/climate\//.test(t)) return 'station';
    return 'other';
}

function removePoint(record) {
    if (record.track) tracksDirty = true;
    if (record.fileKey) swathsDirty = true;
    records.delete(record.id);
    pools[poolOf(record)].delete(record.id);
    if (byDataId.get(record.props.data_id) === record) byDataId.delete(record.props.data_id);
    if (record.track && latestOnTrack.get(record.track) === record) latestOnTrack.delete(record.track);
    if (record.wsi && latestByStation.get(record.wsi) === record) latestByStation.delete(record.wsi);
    var queued = toAdd.length;
    toAdd = toAdd.filter((f) => f.id !== record.id);
    if (toAdd.length === queued) toRemove.push(record.id);
    toUpdate = toUpdate.filter((u) => u.id !== record.id);
}

// Batch updates so the map isn't redrawn for every message
function flushPoints() {
    var source = map.getSource('points');
    if (!source) return;
    if (toAdd.length || toRemove.length || toUpdate.length) {
        source.updateData({ add: toAdd, remove: toRemove, update: toUpdate });
        toAdd = [];
        toRemove = [];
        toUpdate = [];
    }
    var now = Date.now();
    if (swathsDirty && now - swathsBuilt > TRACK_REBUILD_MS) {
        swathsDirty = false;
        swathsBuilt = now;
        map.getSource('swaths').setData({ type: 'FeatureCollection', features: buildSwaths() });
    }
    if (tracksDirty && now - tracksBuilt > TRACK_REBUILD_MS) {
        tracksDirty = false;
        tracksBuilt = now;
        map.getSource('tracks').setData({ type: 'FeatureCollection', features: buildTracks() });
    }
    pulses = pulses.filter((f) => now - f.properties.born < PULSE_MS);
    map.getSource('pulses').setData({ type: 'FeatureCollection', features: pulses });
    if (pulses.length && !animating) {
        animating = true;
        requestAnimationFrame(animatePulses);
    }
}

// Rings grow and fade out; driven by the current time since paint
// expressions can't read the clock themselves
function animatePulses() {
    var age = ['-', Date.now(), ['get', 'born']];
    map.setPaintProperty('pulses', 'circle-radius', ['interpolate', ['linear'], age, 0, 3, PULSE_MS, 22]);
    map.setPaintProperty('pulses', 'circle-stroke-opacity', ['interpolate', ['linear'], age, 0, 0.9, PULSE_MS, 0]);
    if (pulses.length) {
        requestAnimationFrame(animatePulses);
    } else {
        animating = false;
    }
}

function paintAge() {
    var opacity = ['interpolate', ['linear'], ['-', Date.now(), ['get', 'born']], 0, 1, FADE_MS, 0.35];
    // While stations are coloured by a measure, everything else steps back
    // (aircraft keep their own colour and opacity: they aren't coloured by the measures)
    if (colourBy !== 'kind') {
        // Surface measures leave aircraft alone (they aren't coloured); satellite measures dim them too
        var kept = METRICS[colourBy] && METRICS[colourBy].targets === 'satellite' ? isColourTarget() : ['any', isColourTarget(), IS_AIRCRAFT];
        opacity = ['case', kept, opacity, ['*', opacity, 0.25]];
    }
    map.setPaintProperty('points', 'circle-opacity', ['case', ['get', 'origin'], 0, opacity]);
    map.setPaintProperty('points', 'circle-stroke-opacity', opacity);
    map.setPaintProperty('points-gts', 'icon-opacity', opacity);
    map.setPaintProperty('points-ext', 'icon-opacity', opacity);
    map.setPaintProperty('points-arrow', 'icon-opacity', opacity);
    // Satellite coverage: even shading, fading with age like the points. Only while
    // colouring by cloud amount does opacity follow it (clear 0.05, overcast 0.8).
    var cloud = colourBy !== 'cloudAmount' ? 0.3
        : ['case', ['has', 'm_cloudAmount'], ['interpolate', ['linear'], ['get', 'm_cloudAmount'], 0, 0.05, 100, 0.8], 0.3];
    map.setPaintProperty('swaths-fill', 'fill-opacity', ['*', cloud, ['interpolate', ['linear'], ['-', Date.now(), ['get', 'born']], 0, 1, FADE_MS, 0.4]]);
    map.setPaintProperty('tracks', 'line-opacity', ['interpolate', ['linear'], ['-', Date.now(), ['get', 'born']], 0, 0.9, FADE_MS, 0.35]);
}

class ProjectionControl {
    onAdd(map) {
        var container = document.createElement('div');
        container.className = 'maplibregl-ctrl maplibregl-ctrl-group';
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'projection-toggle';
        var label = () => {
            var globe = projection === 'globe';
            button.textContent = globe ? 'Flat' : 'Globe';
            button.title = globe ? 'Switch to a flat (Mercator) map' : 'Switch to a globe';
        };
        label();
        button.addEventListener('click', () => {
            projection = projection === 'globe' ? 'mercator' : 'globe';
            map.setProjection({ type: projection });
            label();
            try {
                localStorage.setItem('wis-projection', projection);
            } catch (err) {
                // Storage unavailable; the choice just isn't remembered
            }
        });
        container.appendChild(button);
        return container;
    }

    onRemove() {
        // Nothing to do here
    }
}

class LegendControl {
    onAdd(map) {
        var container = document.createElement('div');
        container.className = 'legend layer-panel';
        container.innerHTML = `
            ${LAYER_GROUPS.map((g) => `
            <section class="legend-section legend-section-${g.key}">
            <div class="legend-group">${g.label}<small>${g.subtitle}</small></div>
            <div class="legend-style"><span class="legend-dot legend-sample"></span>${g.key === 'gts' ? 'Diamonds on the map' : g.key === 'other' ? 'Squares on the map' : g.key === 'space' ? 'Coverage on the map: circles from WIS2, diamonds from the GTS' : 'Circles on the map'}</div>
            ${g.layers.map((l) => `
            ${l.option ? `
            <label class="legend-toggle legend-option form-switch" data-layer="${l.key}"${l.title ? ` title="${l.title}"` : ''}>
                <input type="checkbox" class="form-check-input" role="switch"${hiddenLayers.has(l.key) ? '' : ' checked'}>
                <span>${l.label}${l.hint ? `<small>${l.hint}</small>` : ''}</span>
            </label>` : `
            <label class="legend-toggle${l.parent ? ` legend-sub legend-depth-${ancestors(l.key).length}` : ''}${isGroupRow(g, l) ? ' legend-parent' : ''}" data-layer="${l.key}"${l.optIn || g.layers.some((c) => c.parent === l.key && c.optIn) ? '' : ' hidden'}${l.title ? ` title="${l.title}"` : ''}>
                <input type="checkbox" class="form-check-input"${hiddenLayers.has(l.key) ? '' : ' checked'}>
                ${isGroupRow(g, l) ? '' : `<span class="legend-dot${l.ring ? ' legend-ring' : ''}${l.track ? ' legend-line' : ''}" style="--color: ${l.color}${l.track ? '' : `; --outline: ${darken(l.color)}`}"></span>`}${l.label}
            </label>`}`).join('')}
            </section>`).join('')}`;

        // How far back the Global Replay reaches, under its row: earlier on the left, now on the right
        container.querySelector('.legend-toggle[data-layer="replay"]').insertAdjacentHTML('afterend', `
            <label class="legend-option legend-range" data-layer="replay-window">
                <span class="legend-range-value">Since <output></output></span>
                <input type="range" min="0" max="1000" step="1" value="${Math.round(replayPosition(replayWindowMs / 60000) * 1000)}"
                    aria-label="How far back the Global Replay reaches">
                <span class="legend-range-ticks" aria-hidden="true">${REPLAY_TICKS.map((m) =>
                    `<span style="--at: ${replayPosition(m)}">${m < 60 ? `${m}m` : `${m / 60}h`}</span>`).join('')}</span>
            </label>`);
        var range = container.querySelector('.legend-range input');
        var minutesShown = () => replayMinutesAt(range.value / 1000);
        var showWindow = () => {
            var minutes = minutesShown();
            var since = new Date(Date.now() - minutes * 60000).toISOString().slice(11, 16);
            container.querySelector('.legend-range output').textContent = `${since} UTC (${replayWindowLabel(minutes)} ago)`;
            range.setAttribute('aria-valuetext', `${replayWindowLabel(minutes)}, since ${since} UTC`);
        };
        showWindow();
        setInterval(showWindow, 30 * 1000);  // The start time moves with the clock
        range.addEventListener('input', showWindow);
        range.addEventListener('change', () => setReplayWindow(minutesShown()));

        container.querySelectorAll('.legend-toggle[data-layer]').forEach((row) => {
            var key = row.dataset.layer;
            row.querySelector('input').addEventListener('change', (e) => {
                e.target.checked ? hiddenLayers.delete(key) : hiddenLayers.add(key);
                syncDecoding();
                syncSublayers();
                applyMapFilter();
                if (key === 'obs' || key === 'origin') rebuildQueue();
                if (key === 'airports' && e.target.checked) queueAirports();
                if (key === 'replay' && e.target.checked) scheduleReplay(0);
            });
        });
        // Sublayers are greyed out while their parent is off
        var syncSublayers = () => container.querySelectorAll('.legend-sub, .legend-option').forEach((sub) => {
            var parentOff = ancestors(sub.dataset.layer).some((a) => hiddenLayers.has(a));
            sub.querySelector('input').disabled = parentOff;
            sub.classList.toggle('legend-disabled', parentOff);
        });
        // Decoding runs for a layer or option that is on and whose parents are on too
        var syncDecoding = () => {
            var hidden = effectiveHidden();
            Object.keys(DECODE_LAYERS).forEach((k) => {
                var on = !hidden.includes(k);
                if (on !== decodeEnabled.has(k)) setDecodeEnabled(k, on);
            });
        };
        syncSublayers();
        // The decode layers are defined further down the script, so start once it has run
        setTimeout(syncDecoding);
        return container;
    }

    onRemove() {
        // Nothing to do here
    }
}

// A row whose points are all drawn by the groups under it (Cache, GTS-to-WIS2),
// so it has no symbol of its own
function isGroupRow(group, layer) {
    return group.layers.some((c) => c.parent === layer.key && !c.option && !c.follow);
}

function selectQueueTab(tab) {
    document.querySelectorAll('.queue-tabs button').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === tab));
    document.querySelectorAll('.queue-pane').forEach((pane) => { pane.hidden = pane.dataset.pane !== tab; });
    if (tab === 'messages') flushQueue();
}

// The key on the map. On top, how points are styled: what they're coloured by,
// its scale, and the options that go with it. Below, only what is drawn now.
class MapKey {
    onAdd() {
        this.container = document.createElement('div');
        this.container.className = 'maplibregl-ctrl map-key';
        this.container.append(buildStylePanel());
        mapKeyBody = this.container.appendChild(document.createElement('div'));
        this.container.addEventListener('click', (e) => {
            if (e.target.closest('.map-key-edit')) {
                document.body.classList.add('queue-open');
                selectQueueTab('layers');
                return;
            }
            // On phones the key opens to its options, notes and shapes on a tap anywhere but a control
            if (PHONE.matches && !e.target.closest('select, input, label')) this.container.classList.toggle('map-key-open');
        });
        updateMapKey();
        return this.container;
    }

    onRemove() {
        // Nothing to do here
    }
}
let mapKeyBody = null;
let stylePanel = null;

// Color by and the options that go with it, at the top of the map key
function buildStylePanel() {
    stylePanel = document.createElement('div');
    stylePanel.className = 'map-key-style';
    stylePanel.innerHTML = `
        <div class="legend-colour">
            <label class="key-colour-by">Style by
                <select class="form-select form-select-sm" aria-label="Color points by">
                    <option value="kind">Observation type</option>
                    ${[...new Set(Object.values(METRICS).map((m) => m.group))].map((group) => `
                    <optgroup label="${group}">
                        ${Object.entries(METRICS).filter(([, m]) => m.group === group).map(([key, m]) => `<option value="${key}">${m.label}</option>`).join('')}
                    </optgroup>`).join('')}
                </select>
            </label>
            <div class="legend-scale" hidden><span></span><i></i><span></span></div>
            <div class="key-options">
                <label class="legend-coloured-only" hidden title="Only points with a value for the measure are drawn"><input type="checkbox" class="form-check-input"> Require value</label>
            </div>
            <div class="legend-note legend-colour-status" hidden></div>
            <label class="legend-model form-switch" hidden title="Draw Environment and Climate Change Canada's global model field for the same measure, at the current hour, under the points, so observations can be compared with the model">
                <input type="checkbox" class="form-check-input" role="switch">
                <span>Model base layer<small class="legend-model-note"></small></span>
            </label>
            <div class="legend-model-info" hidden><img alt="Model field legend"></div>
        </div>`;
    stylePanel.querySelector('select').addEventListener('change', (e) => setColourBy(e.target.value, stylePanel));
    stylePanel.querySelector('.legend-coloured-only input').addEventListener('change', (e) => {
        colouredOnly = e.target.checked;
        applyMapFilter();
    });
    stylePanel.querySelector('.legend-model input').addEventListener('change', (e) => {
        modelFieldOn = e.target.checked;
        updateModelField(stylePanel);
    });
    setInterval(() => showColourStatus(stylePanel), 1000);
    return stylePanel;
}

function updateMapKey() {
    if (!mapKeyBody) return;
    var hidden = effectiveHidden();
    var drawn = (key) => seenLayers.has(key) && !hidden.includes(key);
    var symbol = (shape, color) => `<span class="legend-dot${shape === 'diamond' ? ' key-diamond' : ''}${shape === 'square' ? ' key-square' : ''}${shape === 'ring' ? ' legend-ring' : ''}" style="--color: ${color}; --outline: ${darken(color)}"></span>`;
    var rows = [];
    var m = METRICS[colourBy];
    if (m) {
        // The measure and its scale are in the style panel above
        // With "Require value" on, points without one aren't drawn, so there's nothing to explain
        if (!colouredOnly) rows.push(`<div class="key-note">${symbol('circle', NO_VALUE_COLOR)}No value, or not measured</div>`);
    } else {
        for (var [key, c] of Object.entries(OBS_CLASSES)) {
            var shapes = [drawn(`cache-${key}`) && 'circle', drawn(`gts-${key}`) && 'diamond'].filter(Boolean);
            if (shapes.length) rows.push(`<div class="key-row">${shapes.map((shape) => symbol(shape, c.color)).join('')}${esc(c.label)}</div>`);
        }
    }
    if (drawn('satellite') && !hidden.includes('sat-coverage') && swathMembers.size) {
        rows.push(`<div class="key-row"><span class="legend-dot key-swath"></span>Satellite coverage${colourBy === 'cloudAmount' ? ', darker = cloudier' : ''}</div>`);
    }
    if (drawn('wis2gts')) rows.push(`<div class="key-row">${symbol('diamond', COLORS.wis2gts)}WIS2-to-GTS</div>`);
    if (!hidden.includes('radar') && radars.size) {
        rows.push(`<div class="key-title">Radar reflectivity (dBZ)</div>`);
        rows.push(`<div class="legend-scale"><span>5</span><i style="background: linear-gradient(90deg, ${RADAR_COLORS.map(([, c]) => c).join(', ')})"></i><span>65</span></div>`);
    }
    if (!hidden.includes('gts-tracks') && seenLayers.has('gts-aircraft')) {
        rows.push(`<div class="key-row"><span class="legend-dot legend-line" style="--color: linear-gradient(90deg, #99e9f2, #22b8cf, #1971c2, #5f3dc4)"></span>Aircraft tracks by altitude</div>`);
    }
    if (modelFieldOn && m && m.wms) rows.push(`<div class="key-note">Base layer: ECCC model ${esc(m.label.toLowerCase())}</div>`);
    if (windArrows()) {
        rows.push('<div class="key-note"><span class="key-arrow">➜</span>Arrows point the way the wind blows; longer is stronger. Zoom in for more.</div>');
        rows.push(`<div class="key-note">${symbol('ring', m.stops[0][1])}Calm</div>`);
    }
    rows.push('<div class="key-note">Pulses mark new arrivals; points fade over an hour</div>');
    // How each source is drawn: WIS2 cache circles, WIS2 origin rings, GTS diamonds
    // Each symbol stays on one line with its label
    var shape = (kind, color, label) => `<span class="key-shape">${symbol(kind, color)}${label}</span>`;
    rows.push(`<div class="key-shapes">${shape('circle', '#adb5bd', 'WIS2')}${drawn('origin') ? shape('ring', COLORS.origin, 'WIS2 origin') : ''}${shape('diamond', '#adb5bd', 'GTS')}${drawn('airports') ? shape('square', '#adb5bd', 'Airports') : ''}<button type="button" class="btn btn-link btn-sm map-key-edit">Edit layers</button></div>`);
    mapKeyBody.innerHTML = rows.join('');
}

function showLegendRow(key) {
    if (SATELLITE_LAYERS.includes(key) && !seenLayers.has('satellite')) showLegendRow('satellite');
    seenLayers.add(key);
    updateMapKey();
    var row = document.querySelector(`.legend-toggle[data-layer="${key}"]`);
    if (row) row.hidden = false;
    // Rows that follow their parent, such as aircraft tracks
    LAYER_GROUPS.flatMap((g) => g.layers).filter((l) => l.follow && l.parent === key).forEach((l) => {
        var child = document.querySelector(`.legend-toggle[data-layer="${l.key}"]`);
        if (child) child.hidden = false;
    });
}

// Info panel
function openPopup(record) {
    if (!record) return;
    hoverLabel.remove();
    if (!infobar) {
        infobar = document.createElement('aside');
        infobar.className = 'infobar';
        infobar.setAttribute('aria-label', 'Selected observation');
        infobar.innerHTML = '<button type="button" class="btn-close infobar-close" aria-label="Close" title="Close (Esc)"></button><div class="infobar-body"></div>';
        infobar.querySelector('.infobar-close').addEventListener('click', closeInfo);
        // On a phone, swiping the sheet up opens it to full screen, and pulling it
        // down from the top returns it to half (a tap on the grab bar toggles)
        var body = infobar.querySelector('.infobar-body'), startY = null;
        infobar.addEventListener('touchstart', (e) => { startY = e.touches[0].clientY; }, { passive: true });
        infobar.addEventListener('touchmove', (e) => {
            if (!PHONE.matches || startY === null) return;
            var dy = e.touches[0].clientY - startY;
            if (dy < -30 && !infobar.classList.contains('infobar-full')) { infobar.classList.add('infobar-full'); startY = null; }
            else if (dy > 40 && body.scrollTop <= 0 && infobar.classList.contains('infobar-full')) { infobar.classList.remove('infobar-full'); startY = null; }
        }, { passive: true });
        body.addEventListener('scroll', () => { if (PHONE.matches && body.scrollTop > 24) infobar.classList.add('infobar-full'); }, { passive: true });
        infobar.addEventListener('click', (e) => {
            if (PHONE.matches && e.target === infobar && e.clientY - infobar.getBoundingClientRect().top < 20) infobar.classList.toggle('infobar-full');
        });
        document.body.appendChild(infobar);
    }
    // On narrow screens the two panels can't both fit
    if (window.innerWidth < 760) document.body.classList.remove('queue-open');
    infobar.querySelector('.infobar-body').replaceChildren(buildPopup(record));
    infobar.querySelector('.infobar-body').scrollTop = 0;
    infobar.classList.remove('infobar-full');
    document.body.classList.add('info-open');
    var inAir = record.track && record.track.startsWith('aircraft:') && !effectiveHidden().includes('gts-tracks');
    selectedMarker.setLngLat(record.coords);
    if (inAir) selectedMarker.remove(); else selectedMarker.addTo(map);
    keepPopupInView();
}

document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.target.closest('input, select, textarea, dialog')) return;
    if (document.body.classList.contains('info-open')) closeInfo();
    else document.body.classList.remove('queue-open');
});

function closeInfo() {
    document.body.classList.remove('info-open');
    selectedMarker.remove();
}

function buildPopup(record) {
    var props = record.props;
    var canonical = record.links.find((l) => isDataLink(l));
    var oscar = record.links.find((l) => l.rel == 'via' && /oscar/.test(l.href));
    var image = record.webcam && canonical;
    var wis2box = record.external ? null : wis2boxOf(record);

    var div = document.createElement('div');
    div.className = 'pp';
    div.innerHTML = `
        <header class="pp-head">
            <span class="pp-dot${record.channel !== 'cache' && !record.external ? ' pp-ring' : ''}${isGateway(record) ? ' is-gts' : ''}${record.external ? ' is-ext' : ''}" style="--color: ${record.color}; --outline: ${darken(record.color)}"></span>
            <div>
                <div class="pp-title"></div>
                <div class="pp-sub">
                    ${esc(record.centre)}
                    <span class="pp-badge pp-${record.channel}">${record.external ? esc(record.badge) : esc(record.channel)}</span>
                    ${record.replay ? '<span class="pp-badge pp-replay" title="From the Global Replay service">replay</span>' : ''}
                    ${props.pubtime ? `<span title="${esc(props.pubtime)}">${timeAgo(props.pubtime)}</span>` : ''}
                </div>
            </div>
        </header>
        ${image ? `<a href="${esc(image.href)}" target="_blank" rel="noopener"><img class="pp-image" src="${esc(image.href)}" alt="Webcam image"></a>` : ''}
        <dl class="pp-meta">
            ${record.wsi ? `<dt>Station</dt><dd>${oscar
                ? `<a href="${esc(oscar.href)}" target="_blank" rel="noopener">${esc(record.wsi)}</a>`
                : esc(record.wsi)}</dd>` : ''}
            ${props.datetime ? `<dt>Observed</dt><dd>${esc(new Date(props.datetime).toLocaleString())} (${timeAgo(props.datetime)})</dd>` : ''}
            <dt>Topic</dt><dd class="pp-mono">${esc(record.path)}</dd>
            ${wis2box ? `<dt>wis2box</dt><dd>${[wis2box.version && esc(wis2box.version), wis2box.url
                && `<a href="${esc(wis2box.url)}" target="_blank" rel="noopener" title="Open the wis2box this message came from">${esc(new URL(wis2box.url).host)}</a>`].filter(Boolean).join(' · ')}</dd>` : ''}
        </dl>
        <div class="pp-actions"></div>
        <div class="pp-tabs" role="tablist">
            <button type="button" role="tab" data-tab="data" aria-selected="true">Data</button>
            ${isSpaceBased(record.topic) || /-satellite$/.test(layerOf(record)) ? '' : '<button type="button" role="tab" data-tab="forecast" aria-selected="false">Model forecast</button>'}
            ${record.external ? '' : '<button type="button" role="tab" data-tab="message" aria-selected="false">Message</button>'}
        </div>
        <div class="pp-decoded" data-panel="data"></div>
        <div class="pp-forecast" data-panel="forecast" hidden></div>
        <div class="pp-message" data-panel="message" hidden></div>`;

    var title = div.querySelector('.pp-title');
    title.textContent = record.wsi || props.metadata_id || record.centre;

    var actions = div.querySelector('.pp-actions');
    var out = div.querySelector('.pp-decoded');
    if (canonical && !image) {
        var download = document.createElement('a');
        download.className = 'btn btn-sm btn-outline-secondary';
        download.href = canonical.href;
        download.target = '_blank';
        download.rel = 'noopener';
        download.textContent = `Download ${formatLabel(canonical.type)}${canonical.length ? ` (${formatBytes(canonical.length)})` : ''}`;
        actions.appendChild(download);
    }
    // Data and model forecast tabs; the forecast is only fetched once its tab is opened
    var forecastOut = div.querySelector('.pp-forecast');
    var messageOut = div.querySelector('.pp-message');
    div.querySelectorAll('.pp-tabs button').forEach((button) => button.addEventListener('click', () => {
        var key = button.dataset.tab;
        div.querySelectorAll('.pp-tabs button').forEach((b) => b.setAttribute('aria-selected', b === button));
        div.querySelectorAll('[data-panel]').forEach((panel) => { panel.hidden = panel.dataset.panel !== key; });
        if (key === 'forecast' && !forecastOut.hasChildNodes()) showForecast(forecastOut, record);
        if (key === 'message' && !messageOut.hasChildNodes()) showMessage(messageOut, record);
        keepPopupInView();
    }));
    if (!record.source && !record.decoded) {
        out.innerHTML = '<div class="pp-status">No data to decode for this message.</div>';
    }
    // Opening a popup means wanting the data, so decode straight away
    if (record.decoded) {
        showDecoded(out, title, record.decoded);
    } else if (record.source) {
        decodeRecord(record, out, title);
    }
    return div;
}

async function decodeRecord(record, out, title) {
    try {
        record.decoded = await decodeSource(record.source, record.wsi, out);
        setFeatureProperties(record, metricValues(record));
        showDecoded(out, title, record.decoded);
        var forecast = out.parentNode && out.parentNode.querySelector('.pp-forecast');
        if (forecast && forecast.rerender) forecast.rerender();
    } catch (err) {
        showDecodeError(out, err, () => decodeRecord(record, out, title));
    }
    keepPopupInView();
}

function showDecodeError(out, err, retry) {
    out.innerHTML = `<div class="pp-status pp-error">Could not decode: ${esc(err.message)}</div>`;
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-sm btn-outline-primary pp-retry';
    button.textContent = 'Retry';
    button.addEventListener('click', retry);
    out.appendChild(button);
}

// Downloads and decodes a message's data: BUFR is decoded, text (e.g. a GTS
// bulletin) is returned as-is
async function decodeSource(source, wsi, out) {
    out.innerHTML = '<div class="pp-status">Downloading data…</div>';
    try {
        var data = await fetchData(source);
    } catch (err) {
        // CAP servers often block browser downloads; the notification still
        // carries the alert's urgency, severity and certainty
        if (source.cap) return { cap: null, capInfo: source.cap, href: source.urls[0] };
        throw err;
    }
    if (!data.bufr) {
        var text = new TextDecoder(isUtf8(data.bytes) ? 'utf-8' : 'latin1').decode(data.bytes);
        if (/<alert[\s>]/.test(text) && /emergency:cap/.test(text)) return { cap: text, href: data.url };
        if (/^\s*(<\?xml[^>]*\?>\s*)?<[A-Za-z]/.test(text)) return { xml: text, href: data.url };
        return { text: text };
    }

    out.innerHTML = `<div class="pp-status">${decoderReady ? 'Decoding…' : 'Loading decoder (first time only)…'}</div>`;
    var key = source.dataId || data.url || String(Date.now());
    var result = JSON.parse(await callDecoder('decode_bufr', data.bytes, wsi || '', key));
    result.key = key;
    return result;
}

function showDecoded(out, title, decoded) {
    if (decoded.cap !== undefined) {
        renderCap(out, title, decoded);
    } else if (decoded.xml !== undefined) {
        renderXml(out, title, decoded);
    } else if (decoded.text !== undefined) {
        out.innerHTML = '<pre class="pp-text"></pre>';
        out.firstChild.textContent = decoded.text.trim();
    } else {
        renderDecoded(out, title, decoded);
    }
}

// XML: Environment Canada citypage forecasts get their own view; anything else
// is shown as a collapsible tree, with the raw text a click away
function renderXml(out, title, decoded) {
    var doc = new DOMParser().parseFromString(decoded.xml, 'application/xml');
    if (doc.querySelector('parsererror')) {
        out.innerHTML = '<pre class="pp-text"></pre>';
        out.firstChild.textContent = decoded.xml.trim();
        return;
    }
    if (doc.documentElement.nodeName === 'siteData' && doc.querySelector('location > name')) {
        renderCitypage(out, title, doc);
    } else {
        out.innerHTML = '<div class="xml-tree"></div>';
        out.firstChild.appendChild(xmlTree(doc.documentElement, 0, { count: 0 }));
    }
    var raw = document.createElement('details');
    raw.className = 'pp-more';
    raw.innerHTML = '<summary>Raw XML</summary><pre class="pp-text"></pre>';
    raw.querySelector('pre').textContent = decoded.xml.trim();
    out.appendChild(raw);
}

// Elements holding only text are shown as "name: value"; the rest open and close
const XML_TREE_MAX = 3000;  // Nodes drawn before the rest is cut off

function xmlTree(el, depth, drawn) {
    var attrs = [...el.attributes].filter((a) => !/^xmlns|^xsi:/.test(a.name));
    var label = document.createElement('span');
    label.className = 'xml-tag';
    label.textContent = el.localName;
    var attrText = attrs.map((a) => `${a.name}="${a.value}"`).join(' ');
    var children = [...el.children];
    if (++drawn.count > XML_TREE_MAX) {
        var more = document.createElement('div');
        more.className = 'pp-status';
        more.textContent = '… (truncated, see the raw XML)';
        return more;
    }
    if (!children.length) {
        var leaf = document.createElement('div');
        leaf.className = 'xml-leaf';
        var value = document.createElement('span');
        value.className = 'xml-value';
        value.textContent = el.textContent.trim();
        leaf.append(label, value);
        if (attrText) leaf.title = attrText;
        return leaf;
    }
    var node = document.createElement('details');
    node.className = 'xml-node';
    node.open = depth < 3;
    var summary = document.createElement('summary');
    summary.appendChild(label);
    if (attrText) {
        var a = document.createElement('span');
        a.className = 'xml-attrs';
        a.textContent = attrText;
        summary.appendChild(a);
    }
    node.appendChild(summary);
    for (var child of children) {
        if (drawn.count > XML_TREE_MAX) break;
        node.appendChild(xmlTree(child, depth + 1, drawn));
    }
    return node;
}

// ---------- Environment Canada citypage weather (MSC, siteData schema)
function renderCitypage(out, title, doc) {
    var q = (el, sel) => (el ? el.querySelector(sel) : null);
    var tx = (el, sel) => {
        var n = sel ? q(el, sel) : el;
        var t = n && n.textContent.trim();
        return t || null;
    };
    // Local time of a named dateTime, e.g. "11:30 NDT"
    var local = (parent, name) => {
        var all = [...(parent ? parent.querySelectorAll(`:scope > dateTime[name="${name}"]`) : [])];
        var d = all.find((n) => n.getAttribute('zone') !== 'UTC') || all[0];
        return d ? `${tx(d, 'hour')}:${tx(d, 'minute')} ${d.getAttribute('zone')}` : null;
    };
    var unit = (n) => (n && n.getAttribute('units') ? ` ${n.getAttribute('units')}` : '');
    var withUnit = (el, sel) => {
        var n = q(el, sel), t = tx(n);
        return t === null ? null : `${t}${unit(n).replace(' C', ' °C')}`;
    };

    var place = tx(doc, 'location > name');
    var region = [tx(doc, 'location > region'), tx(doc, 'location > province')].filter(Boolean).join(', ');
    if (title && place) title.textContent = place;

    // Warnings and watches in effect
    var warnings = [...doc.querySelectorAll('warnings > event')].map((e) => ({
        type: e.getAttribute('type') || '',
        priority: e.getAttribute('priority') || '',
        text: e.getAttribute('description') || tx(e, 'textSummary') || '',
    }));
    var warningsUrl = q(doc, 'warnings') && q(doc, 'warnings').getAttribute('url');

    // Current conditions
    var cc = q(doc, 'currentConditions');
    var temp = tx(cc, ':scope > temperature');
    var pressure = q(cc, ':scope > pressure');
    var tendency = pressure && pressure.getAttribute('tendency');
    var wind = q(cc, ':scope > wind');
    var windText = wind && tx(wind, 'speed') ? [
        tx(wind, 'direction'), `${tx(wind, 'speed')} km/h`, tx(wind, 'gust') ? `gusting ${tx(wind, 'gust')}` : null,
    ].filter(Boolean).join(' ') : null;
    var station = tx(cc, 'station');

    // Forecast periods
    var periods = [...doc.querySelectorAll('forecastGroup > forecast')].map((f) => {
        var period = q(f, ':scope > period');
        var t = q(f, 'temperatures > temperature');
        return {
            name: (period && period.getAttribute('textForecastName')) || tx(period),
            short: tx(f, 'abbreviatedForecast > textSummary'),
            summary: tx(f, ':scope > textSummary'),
            pop: tx(f, 'abbreviatedForecast > pop'),
            temp: t && tx(t) !== null ? { value: tx(t), cls: t.getAttribute('class') } : null,
        };
    });

    // Hourly forecast, with hours shown in local time
    var issue = [...doc.querySelectorAll('hourlyForecastGroup > dateTime')].find((d) => d.getAttribute('zone') !== 'UTC');
    var offset = issue ? Number(issue.getAttribute('UTCOffset')) || 0 : 0;
    var hours = [...doc.querySelectorAll('hourlyForecastGroup > hourlyForecast')].map((h) => {
        var u = h.getAttribute('dateTimeUTC') || '';
        var time = new Date(Date.UTC(+u.slice(0, 4), +u.slice(4, 6) - 1, +u.slice(6, 8), +u.slice(8, 10), +u.slice(10, 12)));
        var t = tx(h, 'temperature');
        return {
            hour: new Date(time.getTime() + offset * 3600e3).getUTCHours(),
            temp: t === null ? null : Number(t),
            lop: Number(tx(h, 'lop')) || 0,
            condition: tx(h, 'condition'),
            wind: [tx(h, 'wind > direction'), tx(h, 'wind > speed') ? `${tx(h, 'wind > speed')} km/h` : null].filter(Boolean).join(' '),
        };
    }).filter((h) => h.temp !== null);

    var yesterday = q(doc, 'yesterdayConditions');
    var high = q(yesterday, 'temperature[class="high"]'), low = q(yesterday, 'temperature[class="low"]');
    var round = (n) => (tx(n) !== null ? Math.round(Number(tx(n))) : null);
    var sun = [local(q(doc, 'riseSet'), 'sunrise'), local(q(doc, 'riseSet'), 'sunset')];

    // Day and night periods share a row: "Friday  Mainly cloudy  7° / 2°"
    var days = [];
    for (var p of periods) {
        var last = days[days.length - 1];
        if (last && !last.night && p.temp && p.temp.cls === 'low' && (!last.temp || last.temp.cls === 'high')) {
            last.night = p;
        } else {
            days.push({ ...p, night: null });
        }
    }
    var degrees = (t) => (t ? `<span class="citypage-${esc(t.cls)}">${esc(t.value)}°</span>` : '');
    var now = cc && temp !== null ? [
        withUnit(cc, ':scope > dewpoint') ? `Dew point ${withUnit(cc, ':scope > dewpoint')}` : null,
        withUnit(cc, ':scope > relativeHumidity') ? `RH ${withUnit(cc, ':scope > relativeHumidity').replace(' %', '%')}` : null,
        pressure && tx(pressure) ? `${tx(pressure)} kPa${tendency ? ` ${{ rising: '↑', falling: '↓' }[tendency] || '→'}` : ''}` : null,
        windText,
        tx(cc, ':scope > windChill') ? `Wind chill ${tx(cc, ':scope > windChill')}` : null,
        tx(cc, ':scope > humidex') ? `Humidex ${tx(cc, ':scope > humidex')}` : null,
        withUnit(cc, ':scope > visibility') ? `Visibility ${withUnit(cc, ':scope > visibility')}` : null,
    ].filter(Boolean) : [];
    var extras = [
        ['Sunrise', sun[0]], ['Sunset', sun[1]],
        ['Yesterday', high || low ? [round(high) !== null ? `high ${round(high)}°` : null, round(low) !== null ? `low ${round(low)}°` : null].filter(Boolean).join(' · ') : null],
        ['Normals', tx(doc, 'regionalNormals > textSummary')],
        ['Forecast issued', local(q(doc, 'forecastGroup'), 'forecastIssue')],
    ].filter(([, v]) => v);
    var tabs = [
        hours.length > 1 ? ['hourly', 'Next hours'] : null,
        days.length ? ['forecast', 'Forecast'] : null,
        extras.length || periods.length ? ['details', 'Details'] : null,
    ].filter(Boolean);

    out.innerHTML = `
        <div class="citypage">
            ${!title && place ? `<div class="pp-name">${esc(place)}</div>` : ''}
            ${warnings.map((w) => `
            <div class="citypage-warning citypage-type-${esc(w.type.toLowerCase())}">
                <strong>${esc(w.text || w.type)}</strong>
                ${warningsUrl ? `<a href="${esc(warningsUrl)}" target="_blank" rel="noopener">Details</a>` : ''}
            </div>`).join('')}
            ${now.length ? `
            <div class="citypage-now">
                <div class="citypage-temp">${esc(Math.round(Number(temp)))}°</div>
                <div>
                    <div class="citypage-condition">${esc(tx(cc, ':scope > condition') || 'Now')}</div>
                    <div class="pp-status">${esc([station, local(cc, 'observation')].filter(Boolean).join(' · '))}</div>
                </div>
            </div>
            <div class="citypage-stats">${now.map(esc).join(' · ')}</div>` : region ? `<div class="pp-status">${esc(region)}</div>` : ''}
            ${tabs.length ? `
            <div class="citypage-tabs" role="tablist">${tabs.map(([key, label], i) => `
                <button type="button" role="tab" data-tab="${key}" aria-selected="${i === 0}">${label}</button>`).join('')}
            </div>
            <div class="citypage-panel" data-panel="hourly"><div class="citypage-hourly"></div></div>
            <div class="citypage-panel" data-panel="forecast">
                <ol class="citypage-periods">${days.map((d) => `
                    <li title="${esc([d.summary, d.night && `${d.night.name}: ${d.night.summary}`].filter(Boolean).join('\n\n'))}">
                        <span class="citypage-period">${esc(d.name || '')}</span>
                        <span class="citypage-short">${esc(d.short || '')}${d.pop ? ` <em>${esc(d.pop)}%</em>` : ''}</span>
                        <span class="citypage-hilo">${[degrees(d.temp), d.night ? degrees(d.night.temp) : ''].filter(Boolean).join(' / ')}</span>
                    </li>`).join('')}
                </ol>
            </div>
            <div class="citypage-panel" data-panel="details">
                ${extras.length ? `<dl class="citypage-extra">${extras.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : ''}
                ${periods.length ? `
                <details class="pp-more">
                    <summary>Full forecast text</summary>
                    <dl class="citypage-text">${periods.map((p) => `<dt>${esc(p.name || '')}</dt><dd>${esc(p.summary || '')}</dd>`).join('')}</dl>
                </details>` : ''}
            </div>` : ''}
        </div>`;
    if (hours.length > 1) renderHourly(out.querySelector('.citypage-hourly'), hours.slice(0, 24), { width: 300, height: 100 });
    var show = (key) => {
        out.querySelectorAll('.citypage-tabs button').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === key));
        out.querySelectorAll('.citypage-panel').forEach((panel) => { panel.hidden = panel.dataset.panel !== key; });
        keepPopupInView();
    };
    out.querySelectorAll('.citypage-tabs button').forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));
    if (tabs.length) show(tabs[0][0]);
}

// Temperature line over bars for the likelihood of precipitation, one per hour
function renderHourly(container, hours, opts) {
    var W = opts.width, H = opts.height;
    var m = { top: 14, right: 8, bottom: 18, left: 8 };
    var w = W - m.left - m.right, h = H - m.top - m.bottom;
    var temps = hours.map((p) => p.temp);
    var tMin = Math.min(...temps), tMax = Math.max(...temps);
    if (tMax - tMin < 4) { tMin -= 2; tMax += 2; }
    var step = w / hours.length;
    var x = (i) => m.left + step * (i + 0.5);
    var yT = (t) => m.top + h * 0.7 * (tMax - t) / (tMax - tMin);
    var yL = (l) => m.top + h - h * 0.35 * l / 100;

    var svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'hourly', role: 'img',
        'aria-label': 'Hourly temperature and chance of precipitation' });
    hours.forEach((p, i) => {
        if (p.lop) svgEl('rect', { x: x(i) - step / 2 + 1, y: yL(p.lop), width: step - 2, height: m.top + h - yL(p.lop), class: 'hourly-lop' }, svg);
        if (i % 3 === 0) svgEl('text', { x: x(i), y: H - 4, class: 'skewt-label', 'text-anchor': 'middle' }, svg).textContent = `${p.hour}h`;
    });
    svgEl('line', { x1: m.left, x2: m.left + w, y1: m.top + h, y2: m.top + h, class: 'skewt-tick' }, svg);
    svgEl('polyline', { points: hours.map((p, i) => `${x(i).toFixed(1)},${yT(p.temp).toFixed(1)}`).join(' '), class: 'hourly-temp' }, svg);
    // Label the warmest and coldest hours
    [temps.indexOf(Math.max(...temps)), temps.indexOf(Math.min(...temps))].forEach((i, k) => {
        svgEl('circle', { cx: x(i), cy: yT(hours[i].temp), r: 2.5, class: 'hourly-dot' }, svg);
        svgEl('text', { x: x(i), y: yT(hours[i].temp) + (k ? 12 : -5), class: 'skewt-label', 'text-anchor': 'middle' }, svg).textContent = `${hours[i].temp}°`;
    });

    var readout = svgEl('text', { x: W - m.right, y: 10, class: 'skewt-readout', 'text-anchor': 'end' }, svg);
    var guide = svgEl('line', { y1: m.top, y2: m.top + h, class: 'skewt-guide', visibility: 'hidden' }, svg);
    svg.addEventListener('mousemove', (e) => {
        var box = svg.getBoundingClientRect();
        var i = Math.max(0, Math.min(hours.length - 1, Math.floor(((e.clientX - box.left) * W / box.width - m.left) / step)));
        var p = hours[i];
        guide.setAttribute('x1', x(i));
        guide.setAttribute('x2', x(i));
        guide.setAttribute('visibility', 'visible');
        readout.textContent = [`${p.hour}h`, `${p.temp}°`, p.condition, p.lop ? `${p.lop}% precip.` : null, p.wind].filter(Boolean).join(' · ');
    });
    svg.addEventListener('mouseleave', () => {
        guide.setAttribute('visibility', 'hidden');
        readout.textContent = '';
    });
    container.replaceChildren(svg);
}

const SEVERITY_COLORS = {
    Extreme: '#8b1a1a',
    Severe: '#d9363e',
    Moderate: '#f08c00',
    Minor: '#e6b800',
    Unknown: '#868e96',
};

// Common Alerting Protocol: a readable card instead of raw XML. Without the
// XML (blocked download), falls back to the notification's cap_info.
function renderCap(out, title, decoded) {
    var alert = decoded.cap ? parseCap(decoded.cap) : { info: decoded.capInfo || {}, areas: [] };
    var info = alert.info;
    var severity = SEVERITY_COLORS[info.severity] ? info.severity : 'Unknown';
    var when = (v) => v ? esc(new Date(v).toLocaleString()) : '';
    if (title && info.event) title.textContent = info.event;

    out.innerHTML = `
        <div class="cap" style="--severity: ${SEVERITY_COLORS[severity]}">
            ${!title && info.event ? `<div class="cap-event">${esc(info.event)}</div>` : ''}
            <div class="cap-badges">
                <span class="cap-severity">${esc(severity)}</span>
                ${info.urgency ? `<span>${esc(info.urgency)}</span>` : ''}
                ${info.certainty ? `<span>${esc(info.certainty)}</span>` : ''}
            </div>
            ${info.headline ? `<div class="cap-headline">${esc(info.headline)}</div>` : ''}
            <dl class="pp-meta">
                ${alert.areaDesc ? `<dt>Area</dt><dd>${esc(alert.areaDesc)}</dd>` : ''}
                ${info.onset || info.effective ? `<dt>From</dt><dd>${when(info.onset || info.effective)}</dd>` : ''}
                ${info.expires ? `<dt>Until</dt><dd>${when(info.expires)}</dd>` : ''}
                ${info.senderName ? `<dt>Issued by</dt><dd>${esc(info.senderName)}</dd>` : ''}
            </dl>
            ${info.description ? `<p class="cap-text">${esc(info.description)}</p>` : ''}
            ${info.instruction ? `<p class="cap-text cap-instruction">${esc(info.instruction)}</p>` : ''}
            <div class="pp-actions"></div>
            ${decoded.cap ? '' : '<div class="pp-status">The full alert can\'t be downloaded in the browser; open it to read the details.</div>'}
            ${decoded.cap ? `<details class="pp-more"><summary>Alert XML</summary><pre class="pp-text"></pre></details>` : ''}
        </div>`;
    if (decoded.cap) out.querySelector('pre').textContent = decoded.cap;

    var actions = out.querySelector('.pp-actions');
    if (alert.areas.length) {
        var show = document.createElement('button');
        show.type = 'button';
        show.className = 'btn btn-sm btn-outline-secondary';
        show.textContent = 'Show area on map';
        show.addEventListener('click', () => showAlertArea(alert.areas, SEVERITY_COLORS[severity]));
        actions.appendChild(show);
    }
    var link = info.web || decoded.href;
    if (link) {
        var open = document.createElement('a');
        open.className = 'btn btn-sm btn-outline-secondary';
        open.href = link;
        open.target = '_blank';
        open.rel = 'noopener';
        open.textContent = info.web ? 'Issuer\'s page' : 'Open alert';
        actions.appendChild(open);
    }
}

function parseCap(xml) {
    var doc = new DOMParser().parseFromString(xml, 'application/xml');
    var child = (el, name) => el && el.getElementsByTagNameNS('*', name)[0];
    var text = (el, name) => { var c = child(el, name); return c ? c.textContent.trim() : ''; };
    // Prefer English when the alert is issued in several languages
    var infos = [...doc.getElementsByTagNameNS('*', 'info')];
    var infoEl = infos.find((i) => /^en/i.test(text(i, 'language'))) || infos[0];
    var info = {};
    ['event', 'urgency', 'severity', 'certainty', 'effective', 'onset', 'expires', 'senderName',
        'headline', 'description', 'instruction', 'web'].forEach((k) => { info[k] = text(infoEl, k); });

    var areaEls = infoEl ? [...infoEl.getElementsByTagNameNS('*', 'area')] : [];
    var areas = [];
    for (var area of areaEls) {
        // "lat,lon lat,lon ..." rings
        for (var poly of area.getElementsByTagNameNS('*', 'polygon')) {
            var ring = poly.textContent.trim().split(/\s+/).map((p) => p.split(',').map(Number).reverse());
            if (ring.length >= 4 && ring.every((c) => c.length === 2 && c.every(isFinite))) areas.push(ring);
        }
    }
    return {
        info: info,
        areaDesc: areaEls.map((a) => text(a, 'areaDesc')).filter(Boolean).join('; '),
        areas: areas,
    };
}

function showAlertArea(rings, color) {
    map.getSource('alert-area').setData({
        type: 'FeatureCollection',
        features: rings.map((ring) => ({
            type: 'Feature',
            geometry: { type: 'Polygon', coordinates: [ring] },
            properties: { color: color },
        })),
    });
    var bounds = new maplibregl.LngLatBounds();
    rings.flat().forEach((c) => bounds.extend(c));
    var sidebar = document.body.classList.contains('queue-open')
        ? document.querySelector('.queue').getBoundingClientRect().width : 0;
    map.fitBounds(bounds, { padding: { top: 60, bottom: 60, left: sidebar + 60, right: 60 }, maxZoom: 9 });
}

function isUtf8(bytes) {
    try {
        new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        return true;
    } catch (err) {
        return false;
    }
}

async function showReport(out, title, key, index) {
    try {
        var result = JSON.parse(await callDecoder('decode_bufr', null, '', key, index));
        result.key = key;
        renderDecoded(out, title, result);
    } catch (err) {
        out.innerHTML = `<div class="pp-status pp-error">Could not decode: ${esc(err.message)}</div>`;
    }
}

// Pan so the selected point isn't hidden under the sidebar or the info panel
function keepPopupInView() {
    var lngLat = selectedMarker.getLngLat();
    if (!lngLat || !document.body.classList.contains('info-open')) return;
    var point = map.project(lngLat);
    var view = map.getContainer().getBoundingClientRect();
    var phone = PHONE.matches;
    var left = !phone && document.body.classList.contains('queue-open') ? document.querySelector('.queue').getBoundingClientRect().right - view.left : 0;
    var right = phone ? view.width : infobar.getBoundingClientRect().left - view.left;
    var bottom = phone ? infobar.getBoundingClientRect().top - view.top : view.height;
    var margin = 40;
    var dx = point.x < left + margin ? point.x - (left + margin) : point.x > right - margin ? point.x - (right - margin) : 0;
    var dy = point.y < margin ? point.y - margin : point.y > bottom - margin ? point.y - (bottom - margin) : 0;
    if (!dx && !dy) return;
    try {
        map.panBy([dx, dy]);
    } catch (err) {
        // On the zoomed-out globe a large pan can run past a pole; leave the view as is
    }
}

// Headline values shown as tiles, by BUFR descriptor
const KEY_VALUES = [
    { label: 'Altitude', ids: [7010, 10070] },
    { label: 'Temperature', ids: [12101, 12001] },
    { label: 'Dew point', ids: [12103, 12003] },
    { label: 'Humidity', ids: [13003] },
    { label: 'Pressure (MSL)', ids: [10051] },
    { label: 'Station pressure', ids: [10004], unless: [10051] },
    { label: 'Wind speed', ids: [11002], wind: true },
    { label: 'Visibility', ids: [20001] },
    { label: 'Cloud cover', ids: [20010] },
    { label: 'Precipitation', ids: [13011] },
    { label: 'Zenith path delay', ids: [15031] },
    { label: 'Precipitable water', ids: [13016] },
];

// Wind as separate cards: speed (m/s and knots), the strongest gust when
// reported, and direction with an arrow showing where the wind blows to
const COMPASS_POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

// ---------- Satellite reports: what made them and what they measure.
// Code tables 0 01 007 (satellite) and 0 02 019 (instrument), common entries only;
// anything else shows its code.
const SATELLITE_NAMES = { 3: 'Metop-B', 4: 'Metop-A', 5: 'Metop-C', 55: 'Meteosat-8', 56: 'Meteosat-9', 57: 'Meteosat-10',
    70: 'Meteosat-11', 173: 'Himawari-8', 174: 'Himawari-9', 209: 'NOAA-18', 223: 'NOAA-19', 224: 'Suomi NPP',
    225: 'NOAA-20', 226: 'NOAA-21', 270: 'GOES-16', 271: 'GOES-17', 272: 'GOES-18',
    750: 'COSMIC-2 E1', 751: 'COSMIC-2 E2', 752: 'COSMIC-2 E3', 753: 'COSMIC-2 E4', 754: 'COSMIC-2 E5', 755: 'COSMIC-2 E6' };
const INSTRUMENT_NAMES = { 203: 'MHS', 221: 'IASI', 570: 'AMSU-A', 591: 'AVHRR/3', 616: 'VIIRS', 620: 'CrIS', 621: 'ATMS' };

function satelliteTiles(rows, values) {
    var tile = (label, html) => `<div class="pp-tile"><div>${esc(label)}</div><strong>${html}</strong></div>`;
    var number = (id) => (values.has(id) && typeof values.get(id)[0] === 'number' ? values.get(id)[0] : null);
    var count = (id) => rows.filter((r) => r[0] === id).length;
    var all = (id) => rows.filter((r) => r[0] === id && typeof r[2] === 'number').map((r) => r[2]);
    var tiles = [];

    var sat = number(1007), inst = number(2019);
    var name = sat === null ? null : SATELLITE_NAMES[sat] || `Satellite ${sat}`;
    var instrument = inst === null ? null : INSTRUMENT_NAMES[inst] || `instrument ${inst}`;
    tiles.push(tile('Satellite', `${esc(name || 'Unknown')}${instrument ? ` <small>${esc(instrument)}</small>` : ''}`));

    // What kind of product, from the elements it carries
    var product = count(15037) ? 'Radio occultation'
        : values.has(11002) && (values.has(2023) || values.has(11113)) ? 'Cloud-motion winds'
        : count(12163) ? 'Radiances'
        : count(12101) > 5 ? 'Temperature and humidity profile'
        : values.has(10081) ? 'Altimetry'
        : values.has(15021) ? 'Trace gases'
        : 'Satellite data';
    tiles.push(tile('Product', esc(product)));
    if (number(5040) !== null) tiles.push(tile('Orbit', esc(number(5040).toLocaleString())));

    if (product === 'Cloud-motion winds') tiles.push(...windTiles(values));
    if (number(20016) !== null) tiles.push(tile('Cloud-top pressure', `${esc(Math.round(number(20016) / 100))} hPa`));
    if (number(20014) !== null) tiles.push(tile('Cloud-top height', `${esc((number(20014) / 1000).toFixed(1))} km`));
    if (product === 'Cloud-motion winds' && number(12001) !== null) tiles.push(tile('Cloud temperature', `${esc((number(12001) - 273.15).toFixed(1))} °C`));
    if (number(20081) !== null) tiles.push(tile('Cloud amount', `${esc(Math.round(number(20081)))} %`));

    var bt = all(12163);
    if (bt.length) {
        tiles.push(tile('Channels', esc(bt.length)));
        tiles.push(tile('Brightness temperature', `${esc(Math.round(Math.min(...bt)))}–${esc(Math.round(Math.max(...bt)))} K`));
    }
    if (number(12061) !== null) tiles.push(tile('Skin temperature', `${esc((number(12061) - 273.15).toFixed(1))} °C`));
    if (product === 'Temperature and humidity profile') tiles.push(tile('Profile levels', esc(count(12101))));
    if (product === 'Radio occultation') tiles.push(tile('Profile levels', esc(count(15037))));

    // Where the sun and the satellite were, seen from the ground
    var sun = number(7025);
    if (sun !== null) tiles.push(tile('Sun', `${sun < 90 ? 'Day' : 'Night'} <small>${esc(Math.round(sun))}° from overhead</small>`));
    if (number(7024) !== null) tiles.push(tile('Viewing angle', `${esc(Math.round(number(7024)))}° <small>from overhead</small>`));
    return tiles;
}

function windTiles(values) {
    var tile = (label, html) => `<div class="pp-tile"><div>${esc(label)}</div><strong>${html}</strong></div>`;
    var number = (id) => (values.has(id) && typeof values.get(id)[0] === 'number' ? values.get(id)[0] : null);
    var speed = number(11002), dir = number(11001), gust = number(11041);
    var tiles = [];
    if (speed !== null) tiles.push(tile('Wind speed', `${esc(Number(speed.toFixed(1)))} m/s <small>${knots(speed)} kn</small>`));
    if (dir !== null && speed !== 0) {
        var point = COMPASS_POINTS[Math.round(dir / 22.5) % 16];
        tiles.push(tile('Wind direction', `<span class="wind-arrow" style="--to: ${(dir + 180) % 360}deg" aria-hidden="true">↑</span>`
            + `From ${esc(point)} <small>${esc(Math.round(dir))}°</small>`));
    } else if (speed === 0) {
        tiles.push(tile('Wind direction', 'Calm'));
    }
    // A gust no stronger than the mean wind is an unset or unrelated value; leave it out
    if (gust !== null && gust > (speed || 0)) tiles.push(tile('Wind gust', `${esc(Number(gust.toFixed(1)))} m/s <small>${knots(gust)} kn</small>`));
    return tiles;
}

function renderDecoded(out, title, result) {
    var values = new Map();
    for (var [id, name, value, unit] of result.rows) {
        if (!values.has(id)) values.set(id, [value, unit]);
    }
    // Station or site name (001015), falling back to the long name (001019)
    var name = [1015, 1019].map((id) => stationName(values.get(id))).find(Boolean);
    if (name && title) title.textContent = name;

    var profile = result.profile && result.profile.filter((l) => l[0] > 0);
    // Satellite profiles (e.g. radio occultations) aren't radiosonde soundings, so no Skew-T for them
    var sounding = profile && profile.length >= 2 && !values.has(1007);
    var satellite = values.has(1007);
    var marine = sounding ? null : marineDetails(result.rows, satellite);
    var tiles = sounding ? soundingTiles(profile) : satellite ? satelliteTiles(result.rows, values) : [];
    for (var key of sounding || satellite ? [] : KEY_VALUES) {
        var id = key.ids.find((i) => values.has(i));
        if (!id || (key.unless && key.unless.some((i) => values.has(i)))) continue;
        if (key.wind) {
            tiles.push(...windTiles(values));
            continue;
        }
        var text = formatValue(...values.get(id)).join(' ');
        tiles.push(`<div class="pp-tile"><div>${esc(key.label)}</div><strong>${esc(text)}</strong></div>`);
    }
    // Aircraft: where the flight is from and going, and what it's doing
    var route = flightRoute(values.has(1111) && values.get(1111)[0], values.has(1112) && values.get(1112)[0]);
    if (route) tiles.unshift(`<div class="pp-tile"><div>Route</div><strong>${esc(route)}</strong></div>`);
    var phase = values.has(8009) ? flightPhase(values.get(8009)[0]) : null;
    if (phase) tiles.push(`<div class="pp-tile"><div>Flight phase</div><strong>${esc(phase)}</strong></div>`);

    out.innerHTML = `
        ${result.subsets > 1 ? `
        <div class="pp-pager">
            <button type="button" class="btn btn-sm btn-outline-secondary" data-step="-1" aria-label="Previous report"${result.index > 0 ? '' : ' disabled'}>&lsaquo;</button>
            <span class="pp-status">Report ${result.index + 1} of ${result.subsets}</span>
            <button type="button" class="btn btn-sm btn-outline-secondary" data-step="1" aria-label="Next report"${result.index < result.subsets - 1 ? '' : ' disabled'}>&rsaquo;</button>
        </div>` : ''}
        ${name && !title ? `<div class="pp-name">${esc(name)}</div>` : ''}
        ${sounding ? `
        <div class="sounding"></div>
        <button type="button" class="btn btn-sm btn-outline-secondary sounding-expand">Expand sounding</button>` : ''}
        ${tiles.length ? `<div class="pp-tiles">${tiles.join('')}</div>` : ''}
        ${marine ? `
        <div class="pp-section">${satellite ? 'Sea state from space' : marine.ship ? 'Sea state and ship' : 'Sea state'}</div>
        <div class="pp-marine">
            ${marine.compass}
            <div class="pp-tiles">${marine.tiles.join('')}</div>
        </div>
        ${marine.spectrum ? `<div class="pp-section">Wave spectrum</div>
        ${marine.spectrum.peak ? '<div class="wave-spectrum"></div>'
            : '<div class="pp-status">Calm: every band is below the 0.1 m²/Hz the buoy reports to</div>'}` : ''}` : ''}
        <details class="pp-more"${tiles.length ? '' : ' open'}>
            <summary>All decoded fields (${result.rows.length})</summary>
            <table class="table table-sm">${result.rows.map(([id, name, value, unit]) => `
                <tr><td>${esc(titleCase(name))}</td><td>${esc(formatValue(value, unit).join(' ').trim())}</td></tr>`).join('')}
            </table>
        </details>
        ${result.tac ? `
        <details class="pp-more" open>
            <summary>Report as sent (SYNOP code)</summary>
            <pre class="pp-text">${esc(result.tac)}</pre>
        </details>` : ''}`;
    out.querySelectorAll('.pp-pager button').forEach((button) => button.addEventListener('click', () => {
        showReport(out, title, result.key, result.index + Number(button.dataset.step));
    }));
    if (marine && marine.spectrum && marine.spectrum.peak) {
        renderWaveSpectrum(out.querySelector('.wave-spectrum'), marine.spectrum, { width: 300, height: 190 });
    }
    if (sounding) {
        var label = name || (title && title.textContent) || 'Sounding';
        renderSkewT(out.querySelector('.sounding'), profile, { width: 300, height: 390, time: soundingTime(values) });
        out.querySelector('.sounding-expand').addEventListener('click', () => openSounding(profile, label, values));
    }
}

// Ships, buoys and other marine reports: sea temperature, waves, swell, ice and
// the platform's own motion. Wave and swell groups can repeat (e.g. a first and
// second swell system), so every occurrence is kept. Returns null when the
// report has none of these.
// From a satellite, the platform's motion (001012/001013) is the satellite's, not a ship's
function marineDetails(rows, satellite) {
    var all = new Map();
    for (var [id, , value] of rows) {
        if (typeof value !== 'number') continue;
        all.has(id) ? all.get(id).push(value) : all.set(id, [value]);
    }
    var first = (...ids) => ids.map((id) => all.get(id)).find(Boolean)?.[0];
    var nth = (id, i) => (all.get(id) || [])[i];
    var tile = (label, text) => `<div class="pp-tile"><div>${esc(label)}</div><strong>${esc(text)}</strong></div>`;
    var wave = (height, period, from) => [
        height !== undefined ? `${Number(height.toFixed(1))} m` : null,
        period !== undefined ? `${period} s` : null,
        from !== undefined ? `from ${from}°` : null,
    ].filter(Boolean).join(' · ');

    var tiles = [];
    var sea = first(22043, 22049, 22042);
    if (sea !== undefined) tiles.push(tile('Sea temperature', `${(sea - 273.15).toFixed(1)} °C`));
    var salinity = first(22062);
    if (salinity !== undefined) tiles.push(tile('Salinity', `${salinity} ‰`));
    // Wave buoys: significant and maximum height, mean period and the direction
    // of the dominant waves; the peak period comes from the spectrum when there
    // is one, since the reported value is often unset
    var spectrum = waveSpectrum(rows);
    var peak = spectrum && spectrum.peak ? 1 / spectrum.peak.f : first(22071) > 1 ? first(22071) : undefined;
    var dominant = first(22076);
    if (all.has(22070)) {
        tiles.push(tile('Wave height', [`${first(22070)} m significant`, all.has(22073) ? `max ${first(22073)} m` : null].filter(Boolean).join(' · ')));
    }
    if (all.has(22074) || peak !== undefined) {
        tiles.push(tile('Wave period', [all.has(22074) ? `mean ${first(22074)} s` : null, peak !== undefined ? `peak ${peak.toFixed(1)} s` : null,
            dominant !== undefined ? `from ${dominant}°` : null].filter(Boolean).join(' · ')));
    }
    // Instrumental waves (022021/022011), then estimated wind waves (022022/022012)
    if (all.has(22021) || all.has(22011)) tiles.push(tile('Waves (measured)', wave(first(22021), first(22011))));
    if (all.has(22022) || all.has(22012)) tiles.push(tile('Wind waves', wave(first(22022), first(22012))));
    var swells = Math.max(...[22003, 22013, 22023].map((id) => (all.get(id) || []).length));
    var swellDirs = [];
    for (var i = 0; i < swells; i++) {
        swellDirs.push(nth(22003, i));
        tiles.push(tile(swells > 1 ? `Swell ${i + 1}` : 'Swell', wave(nth(22023, i), nth(22013, i), nth(22003, i))));
    }
    var course = first(1012), speed = first(1013);
    if (course !== undefined || speed !== undefined) {
        tiles.push(tile(satellite ? 'Satellite heading' : 'Ship heading', speed === 0 ? 'Stopped'
            : [course !== undefined ? `${course}°` : null, speed !== undefined ? `${speed} m/s (${knots(speed)} kn)` : null].filter(Boolean).join(' at ')));
    }
    var ice = first(20031);
    if (ice !== undefined) tiles.push(tile('Ice on deck', `${Math.round(ice * 100)} cm`));
    if (!tiles.length) return null;

    var waveDirs = [dominant, ...swellDirs].filter((d) => d !== undefined);
    return { tiles, spectrum, ship: course !== undefined || speed !== undefined, compass: marineCompass(first(11001), waveDirs, speed ? course : undefined) };
}

function knots(ms) {
    return Math.round(ms * 1.943844);
}

// Directional wave spectrum: one entry per frequency band with its energy
// density (022069) and the direction the waves come from, from the first-order
// directional Fourier coefficients (042011 a1, 042012 b1). Returns null when the
// report has no spectrum.
function waveSpectrum(rows) {
    var bands = [], band = null;
    for (var [id, , value] of rows) {
        if (id === 22080) bands.push(band = { f: value, e: null, a1: null, b1: null });
        else if (!band) continue;
        else if (id === 22069) band.e = value;
        else if (id === 42011) band.a1 = value;
        else if (id === 42012) band.b1 = value;
    }
    bands = bands.filter((b) => b.f > 0 && b.e !== null);
    if (bands.length < 3) return null;
    for (var b of bands) {
        b.dir = b.a1 !== null && b.b1 !== null && (b.a1 || b.b1)
            ? (Math.atan2(b.b1, b.a1) * 180 / Math.PI + 360) % 360 : null;
    }
    var peak = bands.reduce((a, b) => (b.e > a.e ? b : a));
    return { bands, peak: peak.e > 0 ? peak : null };
}

// Energy against frequency (labelled as period), with a strip above showing
// where each band's waves come from
function renderWaveSpectrum(container, spectrum, opts) {
    var W = opts.width, H = opts.height;
    var m = { top: 8, right: 10, bottom: 30, left: 36 };
    var stripH = 46, gap = 10;
    var w = W - m.left - m.right;
    var dirTop = m.top, dirBottom = m.top + stripH;
    var eTop = dirBottom + gap, eBottom = H - m.bottom;
    var bands = spectrum.bands;
    // Log frequency, so long-period swell isn't squeezed against the axis
    var fMin = Math.min(0.03, bands[0].f * 0.9), fMax = Math.max(0.5, bands[bands.length - 1].f * 1.05);
    var eMax = Math.max(...bands.map((b) => b.e)) * 1.1 || 1;
    var x = (f) => m.left + w * Math.log(f / fMin) / Math.log(fMax / fMin);
    var yE = (e) => eBottom - (eBottom - eTop) * e / eMax;
    var yD = (d) => dirTop + stripH * d / 360;

    var svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'wavespec', role: 'img',
        'aria-label': 'Wave energy spectrum by period, with wave direction for each band' });
    svgEl('rect', { x: 0, y: 0, width: W, height: H, class: 'skewt-bg' }, svg);

    // Bars span halfway to each neighbouring band
    bands.forEach((b, i) => {
        var lo = i ? (bands[i - 1].f + b.f) / 2 : b.f - (bands[1].f - b.f) / 2;
        var hi = i < bands.length - 1 ? (b.f + bands[i + 1].f) / 2 : b.f + (b.f - bands[i - 1].f) / 2;
        b.lo = lo;
        b.hi = hi;
        if (b.e > 0) svgEl('rect', { x: x(lo) + 0.5, y: yE(b.e), width: Math.max(1, x(hi) - x(lo) - 1), height: eBottom - yE(b.e),
            class: b === spectrum.peak ? 'wavespec-bar wavespec-peak' : 'wavespec-bar' }, svg);
    });

    // Direction strip: a dot per band with energy, sized by its share of the peak
    for (var d of [0, 90, 180, 270, 360]) {
        svgEl('line', { x1: m.left, x2: m.left + w, y1: yD(d), y2: yD(d), class: 'skewt-isobar' }, svg);
        if (d < 360) svgEl('text', { x: m.left - 5, y: yD(d) + 3.5, class: 'skewt-label', 'text-anchor': 'end' }, svg).textContent = 'NESW'[d / 90];
    }
    var maxE = spectrum.peak ? spectrum.peak.e : 0;
    for (var b of bands) {
        if (b.dir === null || !(b.e > 0)) continue;
        svgEl('circle', { cx: x(b.f), cy: yD(b.dir), r: 1.5 + 3 * Math.sqrt(b.e / maxE), class: 'wavespec-dir' }, svg);
    }
    svgEl('rect', { x: m.left, y: dirTop, width: w, height: stripH, class: 'skewt-frame' }, svg);

    // Energy axis
    var step = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100].find((s) => eMax / s <= 4) || 200;
    for (var e = step; e < eMax; e += step) {
        svgEl('line', { x1: m.left, x2: m.left + w, y1: yE(e), y2: yE(e), class: 'skewt-isobar' }, svg);
        svgEl('text', { x: m.left - 5, y: yE(e) + 3.5, class: 'skewt-label', 'text-anchor': 'end' }, svg).textContent = Number(e.toFixed(1));
    }
    svgEl('text', { x: 0, y: 0, class: 'skewt-label', 'text-anchor': 'middle',
        transform: `translate(9 ${(eTop + eBottom) / 2}) rotate(-90)` }, svg).textContent = 'm²/Hz';
    // Period labels along the frequency axis
    for (var period of [25, 15, 10, 7, 5, 4, 3, 2]) {
        var f = 1 / period;
        if (f > fMax) continue;
        svgEl('line', { x1: x(f), x2: x(f), y1: eBottom, y2: eBottom + 4, class: 'skewt-tick' }, svg);
        svgEl('text', { x: x(f), y: eBottom + 14, class: 'skewt-label', 'text-anchor': 'middle' }, svg).textContent = period;
    }
    svgEl('text', { x: m.left + w / 2, y: H - 3, class: 'skewt-axis', 'text-anchor': 'middle' }, svg).textContent = 'Wave period (s)';
    svgEl('rect', { x: m.left, y: eTop, width: w, height: eBottom - eTop, class: 'skewt-frame' }, svg);

    // Hover readout for the band under the pointer
    var readout = svgEl('text', { x: m.left + w - 4, y: eTop + 12, class: 'skewt-readout', 'text-anchor': 'end' }, svg);
    svg.addEventListener('mousemove', (e) => {
        var box = svg.getBoundingClientRect();
        var px = (e.clientX - box.left) * W / box.width;
        var band = bands.find((b) => px >= x(b.lo) && px < x(b.hi));
        readout.textContent = band ? [`${(1 / band.f).toFixed(1)} s`, `${band.e} m²/Hz`,
            band.dir !== null && band.e > 0 ? `from ${Math.round(band.dir)}°` : null].filter(Boolean).join(' · ') : '';
    });
    svg.addEventListener('mouseleave', () => { readout.textContent = ''; });

    container.replaceChildren(svg);
}

// Compass showing where the wind and swell come from (arrows pointing in) and
// where the ship is heading (arrow pointing out)
function marineCompass(windFrom, swellFrom, heading) {
    if (windFrom === undefined && !swellFrom.length && heading === undefined) return '';
    var c = 50;
    var at = (deg, r) => [c + r * Math.sin(deg * Math.PI / 180), c - r * Math.cos(deg * Math.PI / 180)];
    var arrow = (deg, from, to, cls) => {
        var [x1, y1] = at(deg, from), [x2, y2] = at(deg, to);
        var a = Math.atan2(y2 - y1, x2 - x1);
        var head = [a + 2.6, a - 2.6].map((b) => `${(x2 + 7 * Math.cos(b)).toFixed(1)},${(y2 + 7 * Math.sin(b)).toFixed(1)}`);
        return `<g class="${cls}"><line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`
            + `<polygon points="${x2.toFixed(1)},${y2.toFixed(1)} ${head.join(' ')}"/></g>`;
    };
    var key = [
        windFrom !== undefined ? '<span><i class="pp-key-wind"></i>Wind</span>' : '',
        swellFrom.length ? '<span><i class="pp-key-swell"></i>Waves</span>' : '',
        heading !== undefined ? '<span><i class="pp-key-ship"></i>Ship</span>' : '',
    ].join('');
    return `
        <figure class="pp-compass">
            <svg viewBox="0 0 100 100" width="100" height="100" role="img" aria-label="Wind, swell and ship heading">
                <circle cx="${c}" cy="${c}" r="38" class="pp-compass-ring"/>
                ${['N', 'E', 'S', 'W'].map((d, i) => {
                    var [x, y] = at(i * 90, 46);
                    return `<text x="${x}" y="${y + 3.5}" text-anchor="middle">${d}</text>`;
                }).join('')}
                ${swellFrom.map((d) => arrow(d, 38, 8, 'pp-compass-swell')).join('')}
                ${windFrom !== undefined ? arrow(windFrom, 38, 8, 'pp-compass-wind') : ''}
                ${heading !== undefined ? arrow(heading, 0, 30, 'pp-compass-ship') : ''}
            </svg>
            <figcaption>${key}</figcaption>
        </figure>`;
}

// ---------- Model forecasts at a point, from the dynamical.org point API
// GFS and ECMWF's AIFS (its AI model) are both deterministic runs; an ensemble
// model would be drawn as its median with the 10th-90th percentile spread.
// Fetched only when asked for, one batch for all models.
const FORECAST_API = 'https://api.dynamical.org/v1/forecasts';
const FORECAST_HOURS = 168;
// Each model is asked only for variables it has (the API rejects the rest);
// together they cover every observed quantity the popup compares against
const FORECAST_COMMON = ['temperature_2m', 'wind_u_10m', 'wind_v_10m', 'precipitation_surface', 'pressure_reduced_to_mean_sea_level',
    'pressure_surface', 'total_cloud_cover_atmosphere', 'downward_short_wave_radiation_flux_surface'];
const FORECAST_MODELS = [
    // GFS precipitation and radiation are averaged since the last 6-hourly reset rather than over each step
    { id: 'noaa-gfs-forecast', label: 'GFS', cls: 'gfs', source: 'NOAA GFS', precipReset: 6,
        variables: [...FORECAST_COMMON, 'relative_humidity_2m', 'maximum_temperature_2m', 'minimum_temperature_2m'] },
    { id: 'ecmwf-aifs-single-forecast', label: 'ECMWF AIFS', cls: 'ecmwf', source: 'ECMWF AIFS Single',
        variables: [...FORECAST_COMMON, 'dew_point_temperature_2m', 'temperature_850hpa', 'temperature_925hpa',
            'geopotential_height_500hpa', 'geopotential_height_850hpa', 'geopotential_height_925hpa'] },
];
const FORECAST_CACHE_MS = 15 * 60 * 1000;
const forecastCache = new Map();  // rounded "lat,lon" -> { time, promise }

// The WIS2 notification the point came from (for a decoded report, the
// notification of the file it was decoded from), as highlighted JSON
function showMessage(out, record) {
    var message = record.notification;
    if (!message) {
        out.innerHTML = '<div class="pp-status">No notification kept for this point.</div>';
        return;
    }
    var json = JSON.stringify(message, null, 2);
    out.innerHTML = `
        <div class="pp-message-head">
            <span class="pp-status">WIS2 notification${isGateway(record) || record.decodedLayer ? ' for the file this report was decoded from' : ''}</span>
            <button type="button" class="btn btn-sm btn-outline-secondary">Copy</button>
        </div>
        <div class="pp-mono pp-message-topic"></div>
        <pre class="pp-json"></pre>`;
    out.querySelector('.pp-message-topic').textContent = record.topic;
    out.querySelector('.pp-json').innerHTML = highlightJson(json);
    var copy = out.querySelector('button');
    copy.addEventListener('click', () => {
        navigator.clipboard.writeText(json).then(() => {
            copy.textContent = 'Copied';
            setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
        }).catch(() => { copy.textContent = 'Copy failed'; });
    });
}

// Escapes JSON text and wraps keys, strings, numbers and literals for colouring;
// URLs become links
function highlightJson(json) {
    return esc(json).replace(/(&#34;(?:[^&]|&(?!#34;))*?&#34;)(\s*:)?|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b|\b(true|false|null)\b/g,
        (match, str, colon, num, lit) => {
            if (str && colon) return `<span class="json-key">${str}</span>${colon}`;
            if (str) {
                var inner = str.slice(5, -5);
                return /^https?:\/\//.test(inner)
                    ? `<span class="json-string">&#34;<a href="${inner}" target="_blank" rel="noopener">${inner}</a>&#34;</span>`
                    : `<span class="json-string">${str}</span>`;
            }
            if (num !== undefined) return `<span class="json-number">${num}</span>`;
            return `<span class="json-literal">${lit}</span>`;
        });
}

async function showForecast(out, record) {
    out.innerHTML = `<div class="pp-status">Loading ${FORECAST_MODELS.map((m) => m.label).join(' and ')} forecasts…</div>`;
    keepPopupInView();
    try {
        var models = await fetchForecast(record.coords);
        renderForecast(out, models, observedNow(record));
        // Redrawn when the observation finishes decoding, to add the comparison
        out.rerender = () => renderForecast(out, models, observedNow(record));
    } catch (err) {
        out.innerHTML = `<div class="pp-status pp-error">${esc(err.message)}</div>`;
        var retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'btn btn-sm btn-outline-primary pp-retry';
        retry.textContent = 'Retry';
        retry.addEventListener('click', () => showForecast(out, record));
        out.appendChild(retry);
    }
    keepPopupInView();
}

// Nearby points share a grid cell, so reuse a recent answer rather than asking again
function fetchForecast([lon, lat]) {
    var key = `${(Math.round(lat * 4) / 4).toFixed(2)},${(Math.round(lon * 4) / 4).toFixed(2)}`;
    var hit = forecastCache.get(key);
    if (hit && Date.now() - hit.time < FORECAST_CACHE_MS) return hit.promise;
    var promise = (async () => {
        var response = await fetch(FORECAST_API, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ queries: FORECAST_MODELS.map((m) => ({
                dataProductId: m.id,
                location: { latitude: lat, longitude: lon },
                variables: m.variables,
                maxLeadTimeHours: FORECAST_HOURS,
            })) }),
        });
        if (response.status === 429) throw new Error('The forecast service is busy; try again in a few seconds.');
        if (!response.ok) throw new Error(`The forecast service answered ${response.status}.`);
        var body = await response.json();
        return FORECAST_MODELS.map((m, i) => parseForecast(m, body.results[i])).filter(Boolean);
    })();
    promise.catch(() => forecastCache.delete(key));
    forecastCache.set(key, { time: Date.now(), promise });
    if (forecastCache.size > 50) forecastCache.delete(forecastCache.keys().next().value);
    return promise;
}

// Chart steps ({ t (ms), temp, dew, wind, precip (mm/h) }, with ensemble
// percentiles when the model has members) and every variable as its own series
// (the ensemble median) for comparing with observations
function parseForecast(model, result) {
    var run = result && result.forecasts && result.forecasts[0];
    if (!run) return null;
    var times = run.validTimes.map((t) => Date.parse(t));
    var members = run.ensembleMembers ? run.ensembleMembers.map((m) => m.data) : [run.data];
    var median = (name) => times.map((t, i) => quantile(members.map((d) => (d[name] || [])[i]).filter((v) => v !== null && v !== undefined && isFinite(v)), 0.5));
    var series = {};
    for (var name of model.variables) series[name] = median(name);
    var perMember = (data) => times.map((t, i) => {
        var u = (data.wind_u_10m || [])[i], v = (data.wind_v_10m || [])[i], p = (data.precipitation_surface || [])[i];
        return {
            temp: (data.temperature_2m || [])[i] ?? null,
            wind: u === null || v === null || u === undefined ? null : Math.hypot(u, v),
            precip: p === null || p === undefined ? null : p * 3600,  // kg m-2 s-1 to mm/h
        };
    });
    var all = members.map(perMember);
    var pick = (key, q) => times.map((t, i) => quantile(all.map((m) => m[i][key]).filter((v) => v !== null && isFinite(v)), q));
    var forecast = { ...model, init: run.initTime, ensemble: members.length > 1, members: members.length, times, series,
        point: result.point && result.point.selected };
    forecast.steps = times.map((t, i) => ({
        t,
        temp: pick('temp', 0.5)[i], tempLo: pick('temp', 0.1)[i], tempHi: pick('temp', 0.9)[i],
        dew: forecastAt(forecast, 'dew', t),
        wind: pick('wind', 0.5)[i], windLo: pick('wind', 0.1)[i], windHi: pick('wind', 0.9)[i],
        precip: mean(all.map((m) => m[i].precip).filter((v) => v !== null && isFinite(v))),
    }));
    return forecast;
}

// ---------- Observation vs forecast. Each quantity says which BUFR elements hold
// the observation and how a model gives the same thing, so a report is compared
// on everything it has that a model also forecasts.
const MAGNUS_A = 17.625, MAGNUS_B = 243.04;

function dewPoint(t, rh) {
    if (t === null || rh === null || !(rh > 0)) return null;
    var g = Math.log(rh / 100) + MAGNUS_A * t / (MAGNUS_B + t);
    return MAGNUS_B * g / (MAGNUS_A - g);
}

function relHumidity(t, td) {
    if (t === null || td === null) return null;
    return Math.min(100, 100 * Math.exp(MAGNUS_A * td / (MAGNUS_B + td) - MAGNUS_A * t / (MAGNUS_B + t)));
}

// Linear interpolation of a series at time t; null outside the run
function seriesAt(forecast, name, t) {
    var values = forecast.series[name], times = forecast.times;
    if (!values || t < times[0] || t > times[times.length - 1]) return null;
    var i = times.findIndex((x) => x >= t);
    if (times[i] === t || i === 0) return values[i];
    var a = values[i - 1], b = values[i];
    if (a === null || b === null) return a === null ? b : a;
    return a + (b - a) * (t - times[i - 1]) / (times[i] - times[i - 1]);
}

// Instantaneous quantities, derived where a model lacks the variable itself
function forecastAt(forecast, key, t) {
    var get = (name) => seriesAt(forecast, name, t);
    var has = (name) => !!forecast.series[name];
    switch (key) {
        case 'temp': return get('temperature_2m');
        case 'dew': return has('dew_point_temperature_2m') ? get('dew_point_temperature_2m') : dewPoint(get('temperature_2m'), get('relative_humidity_2m'));
        case 'rh': return has('relative_humidity_2m') ? get('relative_humidity_2m') : relHumidity(get('temperature_2m'), get('dew_point_temperature_2m'));
        case 'mslp': return get('pressure_reduced_to_mean_sea_level') === null ? null : get('pressure_reduced_to_mean_sea_level') / 100;
        case 'pres': return get('pressure_surface') === null ? null : get('pressure_surface') / 100;
        case 'wind':
        case 'dir': {
            var u = get('wind_u_10m'), v = get('wind_v_10m');
            if (u === null || v === null) return null;
            return key === 'wind' ? Math.hypot(u, v) : (Math.atan2(-u, -v) * 180 / Math.PI + 360) % 360;
        }
        case 'cloud': return get('total_cloud_cover_atmosphere');
        case 't850': return get('temperature_850hpa');
        case 't925': return get('temperature_925hpa');
        case 'z500': return get('geopotential_height_500hpa');
        case 'z850': return get('geopotential_height_850hpa');
        case 'z925': return get('geopotential_height_925hpa');
    }
    return null;
}

// Running total of a rate variable (kg m-2 s-1 or W m-2) at each step, so any
// window's total is a difference. GFS averages since its last 6-hourly reset;
// otherwise each step's rate covers the time since the step before.
function cumulative(forecast, name) {
    var values = forecast.series[name], times = forecast.times;
    if (!values) return null;
    var init = Date.parse(forecast.init), out = [0], base = 0, prevBlock = 0, prevAccum = 0;
    for (var i = 1; i < times.length; i++) {
        var rate = values[i] || 0;
        if (forecast.precipReset) {
            var lead = (times[i] - init) / 3600e3, block = Math.floor((lead - 1e-6) / forecast.precipReset);
            if (block !== prevBlock) { base += prevAccum; prevBlock = block; }
            prevAccum = rate * (lead - block * forecast.precipReset) * 3600;
            out.push(base + prevAccum);
        } else {
            out.push(out[i - 1] + rate * (times[i] - times[i - 1]) / 1000);
        }
    }
    return out;
}

function windowTotal(forecast, name, start, end) {
    var c = cumulative(forecast, name), times = forecast.times;
    if (!c || start < times[0] || end > times[times.length - 1]) return null;
    var at = (t) => {
        var i = times.findIndex((x) => x >= t);
        if (i <= 0) return c[0];
        return c[i - 1] + (c[i] - c[i - 1]) * (t - times[i - 1]) / (times[i] - times[i - 1]);
    };
    return at(end) - at(start);
}

// Highest or lowest 2 m temperature in a window, from hourly or 6-hourly
// samples plus GFS's own max/min fields
function windowExtreme(forecast, start, end, max) {
    var times = forecast.times;
    if (start < times[0] || end > times[times.length - 1]) return null;
    var values = [forecastAt(forecast, 'temp', start), forecastAt(forecast, 'temp', end)];
    var extra = forecast.series[max ? 'maximum_temperature_2m' : 'minimum_temperature_2m'];
    times.forEach((t, i) => {
        if (t > start && t <= end) {
            values.push(forecast.series.temperature_2m[i]);
            if (extra) values.push(extra[i]);
        }
    });
    values = values.filter((v) => v !== null && v !== undefined && isFinite(v));
    return values.length ? (max ? Math.max(...values) : Math.min(...values)) : null;
}

// Every comparable quantity in a decoded report: instantaneous elements by
// descriptor, period elements (precipitation, max/min temperature, solar
// radiation) with the period given by the 004024/004025 before them, and
// sounding levels from the profile
function observedNow(record) {
    var decoded = record.decoded, rows = decoded && decoded.rows;
    if (!rows) return null;
    var first = new Map();
    for (var [id, , value] of rows) {
        if (!first.has(id) && typeof value === 'number') first.set(id, value);
    }
    var t = Date.parse(record.props.datetime || reportTime(first) || '');
    if (!isFinite(t)) return null;

    var items = [];
    var add = (key, label, unit, value, digits, extra) => {
        if (value !== null && value !== undefined && isFinite(value)) items.push({ key, label, unit, value, digits, ...extra });
    };
    var pick = (...ids) => ids.map((id) => first.get(id)).find((v) => v !== undefined);
    var kelvin = (v) => (v === undefined ? null : v - 273.15);
    add('temp', 'Temperature', '°C', kelvin(pick(12101, 12001)), 1);
    add('dew', 'Dew point', '°C', kelvin(pick(12103, 12003)), 1);
    add('rh', 'Humidity', '%', pick(13003), 0);
    add('mslp', 'Pressure (MSL)', 'hPa', pick(10051) / 100, 1);
    add('pres', 'Station pressure', 'hPa', pick(10004) / 100, 1);
    add('wind', 'Wind speed', 'm/s', pick(11002), 1);
    add('dir', 'Wind direction', '°', pick(11001), 0);
    add('cloud', 'Cloud cover', '%', pick(20010), 0);

    // Period elements: 004024 (hours) or 004025 (minutes) give the window, as a
    // start offset, optionally followed by an end offset
    var start = null, end = 0, prevId = null, seen = new Set();
    for (var [id, , value] of rows) {
        if ((id === 4024 || id === 4025) && typeof value === 'number') {
            var offset = value * (id === 4024 ? 3600e3 : 60e3);
            if (prevId === id) { end = offset; } else { start = offset; end = 0; }
        } else if (start !== null && start < end && typeof value === 'number') {
            var from = t + start, to = t + end, hours = (to - from) / 3600e3;
            var span = hours >= 1 ? `${Number(hours.toFixed(1))} h` : `${Math.round(hours * 60)} min`;
            var key = `${id}:${from}:${to}`;
            if (!seen.has(key)) {
                seen.add(key);
                if (id === 13011) add('precip', `Precipitation (${span})`, 'mm', value, 1, { from, to });
                if (id === 12111) add('tmax', `Max temperature (${span})`, '°C', value - 273.15, 1, { from, to });
                if (id === 12112) add('tmin', `Min temperature (${span})`, '°C', value - 273.15, 1, { from, to });
                if (id === 14021 || id === 14028) add('solar', `Mean solar radiation (${span})`, 'W/m²', value / ((to - from) / 1000), 0, { from, to });
            }
        }
        prevId = id;
    }

    // Soundings: standard levels the AI model also forecasts
    var profile = decoded.profile || [];
    var level = (p) => profile.find((l) => Math.abs(l[0] - p) < 0.5);
    [[925, 't925', 'z925'], [850, 't850', 'z850'], [500, null, 'z500']].forEach(([p, tk, zk]) => {
        var l = level(p);
        if (!l) return;
        if (tk) add(tk, `Temperature at ${p} hPa`, '°C', l[2], 1);
        add(zk, `Height of ${p} hPa`, 'm', l[1], 0);
    });

    var value = (key) => (items.find((i) => i.key === key) || {}).value ?? null;
    return { t, items, temp: value('temp'), dew: value('dew'), wind: value('wind') };
}

// A model's value for an observed item, or null when it doesn't forecast it
function forecastFor(forecast, item, t) {
    if (item.key === 'precip') return windowTotal(forecast, 'precipitation_surface', item.from, item.to);
    if (item.key === 'solar') {
        var joules = windowTotal(forecast, 'downward_short_wave_radiation_flux_surface', item.from, item.to);
        return joules === null ? null : joules / ((item.to - item.from) / 1000);
    }
    if (item.key === 'tmax' || item.key === 'tmin') return windowExtreme(forecast, item.from, item.to, item.key === 'tmax');
    return forecastAt(forecast, item.key, t);
}

function compareTable(models, observed) {
    var rows = observed.items.map((item) => ({ item, values: models.map((m) => forecastFor(m, item, observed.t)) }))
        .filter((r) => r.values.some((v) => v !== null && isFinite(v)));
    if (!rows.length) return '';
    var fmt = (v, d) => Number(v).toFixed(d);
    var diff = (item, v) => {
        var d = item.key === 'dir' ? ((v - item.value + 540) % 360) - 180 : v - item.value;
        var text = `${d >= 0 ? '+' : '−'}${fmt(Math.abs(d), item.digits)}`;
        return `<small class="forecast-diff">${text}</small>`;
    };
    var when = new Date(observed.t).toISOString().slice(11, 16);
    return `
        <table class="table table-sm forecast-compare">
            <thead><tr><th>Observed ${esc(when)} UTC</th><th></th>${models.map((m) => `<th class="forecast-${m.cls}">${esc(m.label)}</th>`).join('')}</tr></thead>
            <tbody>${rows.map(({ item, values }) => `
                <tr>
                    <td>${esc(item.label)}</td>
                    <td><strong>${esc(fmt(item.value, item.digits))}</strong> ${esc(item.unit)}</td>
                    ${values.map((v) => (v === null || !isFinite(v) ? '<td>–</td>' : `<td>${esc(fmt(v, item.digits))} ${diff(item, v)}</td>`)).join('')}
                </tr>`).join('')}
            </tbody>
        </table>`;
}

function quantile(values, q) {
    if (!values.length) return null;
    var sorted = values.slice().sort((a, b) => a - b);
    var pos = (sorted.length - 1) * q, lo = Math.floor(pos);
    return sorted[lo] + (sorted[Math.min(lo + 1, sorted.length - 1)] - sorted[lo]) * (pos - lo);
}

function mean(values) {
    return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

// Precipitation as 6-hour totals, so hourly and 3-hourly steps compare. Each
// step's rate covers the time back to the step before it, except where the
// model averages since a 6-hourly reset: then the step at each reset holds
// the average of the whole 6 hours.
function sixHourly(steps, model) {
    var bins = new Map();
    if (model && model.precipReset) {
        var init = Date.parse(model.init), every = model.precipReset * 3600e3;
        steps.forEach((s) => {
            if (s.t > init && (s.t - init) % every === 0 && s.precip !== null) bins.set(s.t - every, s.precip * model.precipReset);
        });
        return [...bins].map(([t, mm]) => ({ t, mm }));
    }
    steps.forEach((s, i) => {
        if (!i || s.precip === null) return;
        var hours = (s.t - steps[i - 1].t) / 3600e3;
        var bin = Math.floor((s.t - 1) / 21600e3) * 21600e3;
        bins.set(bin, (bins.get(bin) || 0) + s.precip * hours);
    });
    return [...bins].map(([t, mm]) => ({ t, mm }));
}

function renderForecast(out, models, observed) {
    if (!models.length) {
        out.innerHTML = '<div class="pp-status">No forecast for this location.</div>';
        return;
    }
    var runs = models.map((m) => `${m.label} ${m.init.slice(11, 13)}Z ${m.init.slice(5, 10)}`).join(' · ');
    out.innerHTML = `
        ${observed ? compareTable(models, observed) : '<div class="pp-status">Decoded observations will be compared here once the Data tab has loaded.</div>'}
        <div class="pp-status">Next 7 days at this location</div>
        <div class="forecast-chart"></div>
        <div class="forecast-key">
            ${models.map((m) => `<span><i class="forecast-key-${m.cls}"></i>${esc(m.label)}${m.ensemble ? ` median, 10–90% of ${m.members} members` : ''}</span>`).join('')}
            <span><i class="forecast-key-dew"></i>Dew point</span>
            ${observed ? '<span><i class="forecast-key-obs"></i>Observed</span>' : ''}
        </div>
        <div class="pp-status forecast-credit">Runs: ${esc(runs)} UTC. Data: ${esc(models.map((m) => m.source).join(' and '))} via
            <a href="https://dynamical.org/" target="_blank" rel="noopener">dynamical.org</a>, CC BY 4.0.</div>`;
    renderForecastChart(out.querySelector('.forecast-chart'), models, observed, { width: 300, height: 250 });
}

// Temperature, wind and 6-hour precipitation panels on one time axis
function renderForecastChart(container, models, observed, opts) {
    var W = opts.width, H = opts.height;
    var m = { top: 6, right: 8, bottom: 18, left: 30 };
    var w = W - m.left - m.right;
    var gap = 8, panelH = (H - m.top - m.bottom - 2 * gap) / 3;
    var panels = [0, 1, 2].map((i) => ({ top: m.top + i * (panelH + gap), bottom: m.top + i * (panelH + gap) + panelH }));
    var t0 = Math.min(...models.map((mo) => mo.steps[0].t), observed ? observed.t : Infinity);
    var t1 = Math.min(Date.now() + FORECAST_HOURS * 3600e3, Math.max(...models.map((mo) => mo.steps[mo.steps.length - 1].t)));
    var x = (t) => m.left + w * (t - t0) / (t1 - t0);
    var inRange = (s) => s.t >= t0 && s.t <= t1;

    var svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'forecast', role: 'img',
        'aria-label': 'Forecast temperature, wind speed and precipitation from GFS and ECMWF AIFS' });
    svgEl('rect', { x: 0, y: 0, width: W, height: H, class: 'skewt-bg' }, svg);

    // Day boundaries (UTC) with labels along the bottom
    var day = new Date(t0);
    day.setUTCHours(24, 0, 0, 0);
    for (var d = day.getTime(); d < t1; d += 86400e3) {
        svgEl('line', { x1: x(d), x2: x(d), y1: m.top, y2: H - m.bottom, class: 'skewt-isobar' }, svg);
        if (x(d) < m.left + w - 12) {
            svgEl('text', { x: x(d) + 2, y: H - 5, class: 'skewt-label' }, svg)
                .textContent = new Date(d).toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' });
        }
    }
    if (Date.now() > t0 && Date.now() < t1) {
        svgEl('line', { x1: x(Date.now()), x2: x(Date.now()), y1: m.top, y2: H - m.bottom, class: 'forecast-now' }, svg);
    }

    var panel = (i, key, unit, floor) => {
        var { top, bottom } = panels[i];
        var vals = [];
        // The temperature panel also carries dew point
        var keys = key === 'temp' ? [key, 'dew'] : [key];
        models.forEach((mo) => mo.steps.filter(inRange).forEach((s) => keys.forEach((k) => vals.push(s[k], s[k + 'Lo'], s[k + 'Hi']))));
        keys.forEach((k) => observed && observed[k] !== null && observed[k] !== undefined && vals.push(observed[k]));
        vals = vals.filter((v) => v !== null && v !== undefined && isFinite(v));
        if (!vals.length) return null;
        var lo = floor !== undefined ? floor : Math.floor(Math.min(...vals)), hi = Math.ceil(Math.max(...vals));
        if (hi - lo < 4) { hi = lo + 4; }
        var y = (v) => bottom - (bottom - top) * (v - lo) / (hi - lo);
        svgEl('rect', { x: m.left, y: top, width: w, height: bottom - top, class: 'skewt-frame' }, svg);
        [lo, hi].forEach((v) => {
            svgEl('text', { x: m.left - 3, y: y(v) + 3.5, class: 'skewt-label', 'text-anchor': 'end' }, svg).textContent = v;
        });
        svgEl('text', { x: m.left + 3, y: top + 9, class: 'skewt-label forecast-unit' }, svg).textContent = unit;
        return y;
    };
    var line = (steps, key, y, cls) => {
        var pts = steps.filter((s) => inRange(s) && s[key] !== null).map((s) => `${x(s.t).toFixed(1)},${y(s[key]).toFixed(1)}`);
        if (pts.length > 1) svgEl('polyline', { points: pts.join(' '), class: cls }, svg);
    };
    var band = (steps, key, y, cls) => {
        var ok = steps.filter((s) => inRange(s) && s[key + 'Lo'] !== null && s[key + 'Hi'] !== null);
        if (ok.length < 2) return;
        var pts = ok.map((s) => `${x(s.t).toFixed(1)},${y(s[key + 'Hi']).toFixed(1)}`)
            .concat(ok.slice().reverse().map((s) => `${x(s.t).toFixed(1)},${y(s[key + 'Lo']).toFixed(1)}`));
        svgEl('polygon', { points: pts.join(' '), class: cls }, svg);
    };

    [['temp', '°C'], ['wind', 'wind m/s', 0]].forEach(([key, unit, floor], i) => {
        var y = panel(i, key, unit, floor);
        if (!y) return;
        models.filter((mo) => mo.ensemble).forEach((mo) => band(mo.steps, key, y, `forecast-band forecast-${mo.cls}`));
        models.forEach((mo) => line(mo.steps, key, y, `forecast-line forecast-${mo.cls}`));
        if (key === 'temp') models.forEach((mo) => line(mo.steps, 'dew', y, `forecast-line forecast-dew forecast-${mo.cls}`));
        if (observed && observed[key] !== null && observed[key] !== undefined && observed.t >= t0) {
            svgEl('circle', { cx: x(observed.t), cy: y(observed[key]), r: 3, class: 'forecast-obs' }, svg);
        }
        if (key === 'temp' && observed && observed.dew !== null && observed.t >= t0) {
            svgEl('circle', { cx: x(observed.t), cy: y(observed.dew), r: 2.5, class: 'forecast-obs forecast-obs-dew' }, svg);
        }
    });

    // Precipitation: 6-hour totals, one narrow bar per model side by side
    var totals = models.map((mo) => sixHourly(mo.steps, mo).filter((b) => b.t + 21600e3 > t0 && b.t < t1));
    var maxMm = Math.max(1, ...totals.flat().map((b) => b.mm));
    var { top, bottom } = panels[2];
    var yP = (v) => bottom - (bottom - top) * v / maxMm;
    svgEl('rect', { x: m.left, y: top, width: w, height: bottom - top, class: 'skewt-frame' }, svg);
    svgEl('text', { x: m.left - 3, y: top + 6, class: 'skewt-label', 'text-anchor': 'end' }, svg).textContent = Number(maxMm.toFixed(maxMm < 10 ? 1 : 0));
    svgEl('text', { x: m.left - 3, y: bottom + 3, class: 'skewt-label', 'text-anchor': 'end' }, svg).textContent = 0;
    svgEl('text', { x: m.left + 3, y: top + 9, class: 'skewt-label forecast-unit' }, svg).textContent = 'mm / 6 h';
    var barW = Math.max(1, (x(t0 + 21600e3) - x(t0)) / models.length - 0.5);
    totals.forEach((bins, k) => bins.forEach((b) => {
        if (b.mm < 0.05) return;
        var left = Math.max(m.left, x(b.t) + k * barW);
        svgEl('rect', { x: left, y: yP(b.mm), width: barW, height: bottom - yP(b.mm), class: `forecast-bar forecast-${models[k].cls}` }, svg);
    }));

    // Hover readout
    var readout = svgEl('text', { x: W - m.right - 3, y: m.top + 9, class: 'skewt-readout', 'text-anchor': 'end' }, svg);
    var guide = svgEl('line', { y1: m.top, y2: H - m.bottom, class: 'skewt-guide', visibility: 'hidden' }, svg);
    svg.addEventListener('mousemove', (e) => {
        var box = svg.getBoundingClientRect();
        var t = t0 + ((e.clientX - box.left) * W / box.width - m.left) / w * (t1 - t0);
        if (t < t0 || t > t1) return;
        guide.setAttribute('x1', x(t));
        guide.setAttribute('x2', x(t));
        guide.setAttribute('visibility', 'visible');
        var at = (mo) => mo.steps.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a));
        readout.textContent = [
            new Date(t).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', timeZone: 'UTC' }) + ' UTC',
            ...models.map((mo) => {
                var s = at(mo);
                return `${mo.label} ${s.temp !== null ? s.temp.toFixed(0) + '°' : '–'} ${s.wind !== null ? s.wind.toFixed(0) + ' m/s' : ''}`.trim();
            }),
        ].join(' · ');
    });
    svg.addEventListener('mouseleave', () => {
        guide.setAttribute('visibility', 'hidden');
        readout.textContent = '';
    });
    container.replaceChildren(svg);
}

// ---------- Upper-air sounding (TEMP) viewer: Skew-T log-P diagram
// profile levels: [pressure hPa, height gpm, temperature C, dewpoint C, wind dir, wind m/s, dlat, dlon]
const STANDARD_LEVELS = [1000, 925, 850, 700, 500, 400, 300, 250, 200, 150, 100, 70, 50, 30, 20, 10];
const SVG_NS = 'http://www.w3.org/2000/svg';

function soundingTiles(profile) {
    var tile = (label, text) => `<div class="pp-tile"><div>${esc(label)}</div><strong>${esc(text)}</strong></div>`;
    var surface = profile.reduce((a, b) => (b[0] > a[0] ? b : a));
    var top = profile.reduce((a, b) => (b[0] < a[0] ? b : a));
    var windy = profile.filter((l) => l[5] !== null).reduce((a, b) => (!a || b[5] > a[5] ? b : a), null);
    var tiles = [];
    if (surface[2] !== null) tiles.push(tile(`Temperature at ${Math.round(surface[0])} hPa`, `${surface[2].toFixed(1)} °C`));
    if (surface[3] !== null) tiles.push(tile('Dew point', `${surface[3].toFixed(1)} °C`));
    tiles.push(tile('Highest level', top[1] !== null ? `${(top[1] / 1000).toFixed(1)} km (${formatPressure(top[0])} hPa)` : `${formatPressure(top[0])} hPa`));
    if (windy) tiles.push(tile('Strongest wind', `${windy[5].toFixed(0)} m/s at ${formatPressure(windy[0])} hPa`));
    tiles.push(tile('Levels', profile.length.toLocaleString()));
    return tiles;
}

function formatPressure(p) {
    return p >= 10 ? Math.round(p) : p.toFixed(1);
}

function svgEl(name, attrs, parent) {
    var el = document.createElementNS(SVG_NS, name);
    for (var k in attrs) el.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(el);
    return el;
}

// Pressure lines labelled on the chart, and the minor ticks between them
const SKEWT_LABELS = [1000, 850, 700, 500, 300, 200, 100, 50, 20, 10];
const SKEWT_TICKS = [1000, 900, 800, 700, 600, 500, 400, 300, 200, 100, 90, 80, 70, 60, 50, 40, 30, 20, 10];
const SKEWT_SKEW = 16;  // Isotherms lean right by this many °C per e-fold of pressure

function renderSkewT(container, profile, opts) {
    var W = opts.width, H = opts.height;
    var m = { top: 40, right: 10, bottom: 34, left: 46 };
    var w = W - m.left - m.right, h = H - m.top - m.bottom;

    // From just below 1000 hPa (or the surface) up to the highest level reported
    var ps = profile.map((l) => l[0]);
    var pMax = Math.max(1050, Math.max(...ps));
    var pMin = Math.max(1, Math.min(100, Math.min(...ps) * 0.95));
    var y = (p) => m.top + h * (Math.log(p) - Math.log(pMin)) / (Math.log(pMax) - Math.log(pMin));
    var tLeft = -50, tRight = 50;
    var x = (t, p) => m.left + w * (t + SKEWT_SKEW * Math.log(1000 / p) - tLeft) / (tRight - tLeft);

    var svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'skewt', role: 'img',
        'aria-label': 'Skew-T log-P diagram of temperature and dew point against pressure' });
    var clipId = `skewt-clip-${Math.random().toString(36).slice(2)}`;
    svgEl('rect', { x: m.left, y: m.top, width: w, height: h }, svgEl('clipPath', { id: clipId }, svgEl('defs', {}, svg)));
    svgEl('rect', { x: 0, y: 0, width: W, height: H, class: 'skewt-bg' }, svg);
    var plot = svgEl('g', { 'clip-path': `url(#${clipId})` }, svg);

    // Title
    svgEl('text', { x: m.left + w / 2, y: 15, class: 'skewt-title', 'text-anchor': 'middle' }, svg).textContent = 'Skew-T log-P Diagram';
    if (opts.time) {
        var stamp = opts.time.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
        svgEl('text', { x: m.left + w / 2, y: 30, class: 'skewt-title', 'text-anchor': 'middle' }, svg).textContent = stamp;
    }

    // Skewed isotherms, with 0 °C dashed, and the pressure grid
    for (var t = -160; t <= 50; t += 10) {
        svgEl('line', { x1: x(t, pMax), y1: y(pMax), x2: x(t, pMin), y2: y(pMin), class: t === 0 ? 'skewt-zero' : 'skewt-isotherm' }, plot);
    }
    for (var p of SKEWT_LABELS.filter((p) => p <= pMax && p >= pMin)) {
        svgEl('line', { x1: m.left, y1: y(p), x2: m.left + w, y2: y(p), class: 'skewt-isobar' }, plot);
        svgEl('text', { x: m.left - 6, y: y(p) + 3.5, class: 'skewt-label', 'text-anchor': 'end' }, svg).textContent = p;
    }
    for (var p of SKEWT_TICKS.filter((p) => p <= pMax && p >= pMin)) {
        var major = SKEWT_LABELS.includes(p);
        svgEl('line', { x1: m.left - (major ? 4 : 2), y1: y(p), x2: m.left, y2: y(p), class: 'skewt-tick' }, svg);
    }
    for (var t = tLeft; t <= tRight; t += 10) {
        var xb = m.left + w * (t - tLeft) / (tRight - tLeft);
        svgEl('line', { x1: xb, y1: m.top + h, x2: xb, y2: m.top + h + 4, class: 'skewt-tick' }, svg);
        svgEl('text', { x: xb, y: m.top + h + 14, class: 'skewt-label', 'text-anchor': 'middle' }, svg).textContent = t;
    }
    svgEl('text', { x: m.left + w / 2, y: H - 4, class: 'skewt-axis', 'text-anchor': 'middle' }, svg).textContent = 'Temperature (°C)';
    svgEl('text', { x: 0, y: 0, class: 'skewt-axis', 'text-anchor': 'middle',
        transform: `translate(11 ${m.top + h / 2}) rotate(-90)` }, svg).textContent = 'Pressure (hPa)';

    // Temperature and dew point profiles, highest pressure (lowest altitude) first
    var sorted = profile.slice().sort((a, b) => b[0] - a[0]);
    var line = (i, cls) => {
        var pts = sorted.filter((l) => l[i] !== null && l[0] >= pMin).map((l) => `${x(l[i], l[0]).toFixed(1)},${y(l[0]).toFixed(1)}`);
        if (pts.length > 1) svgEl('polyline', { points: pts.join(' '), class: cls }, plot);
    };
    line(3, 'skewt-dewpoint');
    line(2, 'skewt-temperature');
    svgEl('rect', { x: m.left, y: m.top, width: w, height: h, class: 'skewt-frame' }, svg);

    // Legend, top right
    var legend = svgEl('g', { transform: `translate(${m.left + w - 92} ${m.top + 6})` }, svg);
    svgEl('rect', { x: 0, y: 0, width: 86, height: 34, rx: 3, class: 'skewt-legend' }, legend);
    [['Temperature', 'skewt-temperature'], ['Dewpoint', 'skewt-dewpoint']].forEach(([text, cls], i) => {
        svgEl('line', { x1: 6, y1: 11 + i * 13, x2: 22, y2: 11 + i * 13, class: cls }, legend);
        svgEl('text', { x: 27, y: 14.5 + i * 13, class: 'skewt-label skewt-legend-text' }, legend).textContent = text;
    });

    // Hover readout
    var readout = svgEl('text', { x: m.left + 4, y: m.top + h - 6, class: 'skewt-readout' }, svg);
    var guide = svgEl('line', { x1: m.left, x2: m.left + w, class: 'skewt-guide', visibility: 'hidden' }, svg);
    svg.addEventListener('mousemove', (e) => {
        var box = svg.getBoundingClientRect();
        var py = (e.clientY - box.top) * H / box.height;
        var level = sorted.reduce((a, b) => (Math.abs(y(b[0]) - py) < Math.abs(y(a[0]) - py) ? b : a));
        guide.setAttribute('y1', y(level[0]));
        guide.setAttribute('y2', y(level[0]));
        guide.setAttribute('visibility', 'visible');
        readout.textContent = [
            `${formatPressure(level[0])} hPa`,
            level[1] !== null ? `${Math.round(level[1]).toLocaleString()} m` : null,
            level[2] !== null ? `T ${level[2].toFixed(1)}°` : null,
            level[3] !== null ? `Td ${level[3].toFixed(1)}°` : null,
            level[5] !== null ? `${level[5].toFixed(0)} m/s ${level[4] !== null ? level[4] + '°' : ''}` : null,
        ].filter(Boolean).join(' · ');
    });
    svg.addEventListener('mouseleave', () => {
        guide.setAttribute('visibility', 'hidden');
        readout.textContent = '';
    });

    container.replaceChildren(svg);
}

// Launch time from the report's year/month/day/hour/minute, or null
function soundingTime(values) {
    var time = [4001, 4002, 4003, 4004, 4005].map((id) => values.get(id) && values.get(id)[0]);
    return time[0] ? new Date(Date.UTC(time[0], time[1] - 1, time[2], time[3] || 0, time[4] || 0)) : null;
}

// Larger view in a dialog, with a table of the standard levels
function openSounding(profile, label, values) {
    var dialog = document.querySelector('.sounding-dialog');
    if (!dialog) {
        dialog = document.createElement('dialog');
        dialog.className = 'sounding-dialog';
        dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
        document.body.appendChild(dialog);
    }
    var nearest = (p) => profile.reduce((a, b) => (Math.abs(b[0] - p) < Math.abs(a[0] - p) ? b : a));
    var rows = STANDARD_LEVELS
        .map((p) => nearest(p))
        .filter((l, i, all) => Math.abs(l[0] - STANDARD_LEVELS[i]) / STANDARD_LEVELS[i] < 0.03 && all.indexOf(l) === i);
    var cell = (v, digits) => (v === null || v === undefined ? '–' : Number(v).toFixed(digits));
    var launched = soundingTime(values);

    dialog.innerHTML = `
        <div class="sounding-head">
            <div>
                <strong></strong>
                <div class="pp-status">${launched ? `Launched ${esc(launched.toUTCString().replace(':00 GMT', ' UTC'))} · ` : ''}${profile.length.toLocaleString()} levels</div>
            </div>
            <button type="button" class="btn-close" aria-label="Close"></button>
        </div>
        <div class="sounding-body">
            <div class="sounding-chart"></div>
            ${rows.length ? `
            <table class="table table-sm sounding-table">
                <thead><tr><th>hPa</th><th>Height m</th><th>T °C</th><th>Td °C</th><th>Wind</th></tr></thead>
                <tbody>${rows.map((l) => `
                    <tr><td>${formatPressure(l[0])}</td><td>${cell(l[1], 0)}</td><td>${cell(l[2], 1)}</td><td>${cell(l[3], 1)}</td>
                    <td>${l[5] === null ? '–' : `${cell(l[5], 0)} m/s${l[4] === null ? '' : ` ${l[4]}°`}`}</td></tr>`).join('')}
                </tbody>
            </table>` : ''}
        </div>`;
    dialog.querySelector('strong').textContent = label;
    dialog.querySelector('.btn-close').addEventListener('click', () => dialog.close());
    var width = Math.min(480, window.innerWidth - 48);
    renderSkewT(dialog.querySelector('.sounding-chart'), profile, { width: width, height: Math.round(width * 1.3), time: launched });
    dialog.showModal();
}

// Returns a cleaned station name, or null when the decoded value isn't usable:
// not text, padding or control characters only, undecodable bytes, a
// placeholder such as "MISSING", or no letters at all (e.g. "0000", "///")
function stationName(entry) {
    if (!entry || typeof entry[0] !== 'string') return null;
    var name = entry[0].replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (name.length < 2 || name.length > 64) return null;
    if (name.includes('\ufffd')) return null;
    if (!/[a-z]/i.test(name)) return null;
    if (/^(missing|unknown|none|null|n\/?a|test|station)$/i.test(name)) return null;
    return name;
}

function formatValue(value, unit) {
    if (typeof value !== 'number') return [value, ''];
    if (unit === 'K') return [(value - 273.15).toFixed(1), '°C'];
    if (unit === 'Pa') return [(value / 100).toFixed(1), 'hPa'];
    if (unit === 'm' && value >= 1000) return [Number((value / 1000).toFixed(1)), 'km'];
    if (unit === 'KG M-2') return [value, 'mm'];
    if (unit === 'CODE TABLE' || unit === 'FLAG TABLE') return [value, '(code)'];
    if (['Numeric', 'CCITT IA5', 'a', 'mon', 'd', 'h', 'min'].includes(unit)) return [value, ''];
    return [Number(value.toFixed(5)), unit];
}

function formatLabel(type) {
    if (/bufr/.test(type || '')) return 'BUFR';
    if (/grib/.test(type || '')) return 'GRIB';
    return 'data';
}

function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function timeAgo(time) {
    var seconds = Math.round((Date.now() - new Date(time)) / 1000);
    if (isNaN(seconds)) return '';
    if (seconds < 10) return 'just now';
    if (seconds < 60) return `${seconds} sec ago`;
    if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
    if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
    return `${Math.round(seconds / 86400)} d ago`;
}

function hostname(href) {
    try {
        return new URL(href).hostname;
    } catch (err) {
        return href;
    }
}

function titleCase(name) {
    return name.toLowerCase().replace(/(^|[\s(\/-])\w/g, (c) => c.toUpperCase());
}

function esc(value) {
    return String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// Sidebar listing incoming messages, newest first
const QUEUE_MAX = 200;    // Rows shown in the sidebar
const RECENT_MAX = 1000;  // Messages kept for re-filtering
const recent = [];
let pending = [];
let queueTotal = 0;
let queuePaused = false;
let queueNew = null;  // The button that shows messages held while reading
let queueList, queueCount, queueFilter, queueMapped, queuePause, queueToggle;

// Filters shared by the map and the sidebar
const DISCIPLINES = {
    'weather': 'Weather',
    'climate': 'Climate',
    'hydrology': 'Hydrology',
    'ocean': 'Ocean',
    'atmospheric-composition': 'Atmosphere',
    'cryosphere': 'Cryosphere',
    'space-weather': 'Space',  // Also matches satellite data (see matchesDiscipline)
    'other': 'Other',
};
const FORMATS = {
    'bufr': 'BUFR',
    'grib': 'GRIB',
    'xml': 'XML / CAP',
    'csv': 'CSV',
    'json': 'JSON',
    'text': 'Text',
    'image': 'Image',
    'hdf': 'HDF / NetCDF',
    'other': 'Other',
};
const filters = { text: '', centres: new Set(), format: '', disciplines: new Set() };
// Each filter either keeps only what matches ('only') or hides what matches ('hide')
const filterModes = { text: 'only', centres: 'only', format: 'only', disciplines: 'only' };

// The link to a notification's data: canonical, or update when it replaces data
// published earlier under the same data_id (WIS2 Notification Message, 9.x)
function isDataLink(link) {
    return link.rel == 'canonical' || link.rel == 'update';
}

function isUpdate(feature) {
    return (feature.links || []).some((l) => l.rel == 'update');
}

// File type of a notification's data, from the canonical link's media type,
// falling back to the file extension for generic types
function formatOf(feature) {
    var link = (feature.links || []).find((l) => isDataLink(l));
    if (!link) return 'other';
    var type = (link.type || '').toLowerCase();
    var ext = ((link.href || '').split(/[?#]/)[0].match(/\.([a-z0-9]+)$/i) || [])[1] || '';
    ext = ext.toLowerCase();
    if (/bufr/.test(type) || /^bufr\d?$/.test(ext)) return 'bufr';
    if (/grib/.test(type) || /^(grib2?|grb2?)$/.test(ext)) return 'grib';
    if (/xml|cap/.test(type) || ext === 'xml') return 'xml';
    if (/csv/.test(type) || ext === 'csv') return 'csv';
    if (/json/.test(type) || /^(geo)?json$/.test(ext)) return 'json';
    if (/^image\//.test(type) || /^(jpe?g|png|gif|webp)$/.test(ext)) return 'image';
    if (/hdf|netcdf/.test(type) || /^(h5|hdf5?|nc)$/.test(ext)) return 'hdf';
    if (/^text\//.test(type) || ext === 'txt') return 'text';
    // GTS bulletins often come with a generic type and no extension (DWD's relays, NCM's
    // numbered copies), but the heading's T1 says what they are (WMO-No. 386, table A)
    var t1 = (gtsHeading(feature) || '')[0];
    if (/[IJ]/.test(t1)) return 'bufr';
    if (/[DGHOY]/.test(t1)) return 'grib';
    if (/[LX]/.test(t1)) return 'xml';
    if (/[ABCFKNSTUVW]/.test(t1)) return 'text';
    return 'other';
}

// TTAAii of a GTS bulletin, from the notification or its data_id (…/INCX50EUMP191659_C_EDZW…)
function gtsHeading(feature) {
    var props = feature.properties || {};
    if (props.gts && props.gts.ttaaii) return props.gts.ttaaii;
    var match = /(?:^|[/_])([A-Z]{4}\d{2})[A-Z]{4}\d{6}/.exec(props.data_id || '');
    return match ? match[1] : null;
}
const centres = new Map();  // centre-id -> its item in the picker
let centreList, centreSearch, centreToggle, centreChips;

// GTS gateway centres, in either direction (e.g. de-dwd-gts-to-wis2, uk-metoffice-wis2-to-gts)
const GATEWAY_CENTRE = /-(gts-to-wis2|wis2-to-gts)$/;
const GATEWAY_TOPIC = /\/a\/wis2\/[^/]+-(gts-to-wis2|wis2-to-gts)\//;
const GATEWAY_SATELLITE = /-(gts-to-wis2|wis2-to-gts)\/data\/core\/I\/[NE]\//;
// Aircraft bulletins (T1T2A1 = IUA: AMDAR and similar)
const GATEWAY_AIRCRAFT = /-gts-to-wis2\/data\/core\/I\/U\/A\//;
const GATEWAY_UPPER_AIR = /-gts-to-wis2\/data\/core\/I\/U\//;

// WIS2 space-based-observations topics, and GTS satellite bulletins (T1T2 = IN, IE)
function isSpaceBased(topic) {
    return /\/space-based-observations\//.test(topic) || GATEWAY_SATELLITE.test(topic);
}

// centre/data/core/<discipline>/...; GTS bulletin topics have none
function disciplineOf(t) {
    var parts = t.split('/');
    if (DISCIPLINES.hasOwnProperty(parts[3])) return parts[3];
    // GTS bulletins: T1 = I (BUFR observations), T2 = S/U (weather) or O (ocean).
    // Satellites (N, E) go with weather too, as WIS2 files them under weather/space-based-observations,
    // so both sources answer the discipline chips the same way (and Space matches both)
    if (GATEWAY_CENTRE.test(parts[0]) && parts[3] === 'I') {
        if (parts[4] === 'S' || parts[4] === 'U' || parts[4] === 'N' || parts[4] === 'E') return 'weather';
        if (parts[4] === 'O') return 'ocean';
    }
    return 'other';
}

// A small switch at the start of a filter row: Only (keep matches) or Hide (drop matches)
function filterModeButton(key) {
    return `<button type="button" class="filter-mode" data-filter="${key}" aria-pressed="false" title="Only: show just what matches. Hide: show everything except what matches.">Only</button>`;
}

function paintFilterMode(button) {
    var hide = filterModes[button.dataset.filter] === 'hide';
    button.textContent = hide ? 'Hide' : 'Only';
    button.setAttribute('aria-pressed', hide);
    // Selected chips and centres turn red while their filter hides them
    document.body.classList.toggle(`hide-${button.dataset.filter}`, hide);
}

function matchesFilters(item) {
    // The Cache and Origin layer switches apply to the message list as well
    var hidden = effectiveHidden();
    var test = (key, active, matches) => !active || (filterModes[key] === 'hide' ? !matches : matches);
    return !(item.channel === 'cache' ? hidden.includes('obs') : hidden.includes('origin'))
        && test('centres', filters.centres.size, filters.centres.has(item.centre))
        && test('format', filters.format, item.format === filters.format)
        && test('disciplines', filters.disciplines.size, matchesDiscipline(item))
        && test('text', filters.text, item.topic.toLowerCase().includes(filters.text));
}

// The Space chip covers space weather and satellite observations, whatever discipline
// their topic gives (WIS2 space-based-observations, GTS IN and IE bulletins)
function matchesDiscipline(item) {
    return filters.disciplines.has(item.discipline) || (filters.disciplines.has('space-weather')
        && (isSpaceBased(item.topic) || (item.record && isSpaceRecord(item.record))));
}

// Satellite data by its topic, or by what it decoded to: GTS bulletins under other
// headings can carry satellite reports (identified by 001007)
function isSpaceRecord(record) {
    return isSpaceBased(record.topic) || /-satellite$/.test(layerOf(record));
}

function filtersActive() {
    return !!(filters.text || filters.centres.size || filters.format || filters.disciplines.size);
}

function applyMapFilter() {
    var expr = ['all'];
    var add = (key, condition) => expr.push(filterModes[key] === 'hide' ? ['!', condition] : condition);
    if (filters.centres.size) add('centres', ['in', ['get', 'centre'], ['literal', [...filters.centres]]]);
    if (filters.format) add('format', ['==', ['get', 'format'], filters.format]);
    if (filters.disciplines.size) add('disciplines', ['any', ['in', ['get', 'discipline'], ['literal', [...filters.disciplines]]],
        filters.disciplines.has('space-weather') && ['==', ['get', 'space'], true]]);
    if (filters.text) add('text', ['in', filters.text, ['get', 'topic']]);
    if (hiddenLayers.size) {
        var hidden = effectiveHidden();
        expr.push(['!', ['in', ['get', 'layer'], ['literal', hidden]]]);
        // Reports decoded by a switched-off option or layer go too, whatever group they're in
        var hiddenVia = Object.keys(DECODE_LAYERS).filter((k) => hidden.includes(k));
        if (hiddenVia.length) expr.push(['!', ['in', ['coalesce', ['get', 'via'], ''], ['literal', hiddenVia]]]);
        // Individual satellites switched off under Space-based
        var hiddenSats = [...hiddenLayers].filter((k) => k.startsWith('sat:'));
        if (hiddenSats.length) expr.push(['!', ['in', ['coalesce', ['get', 'sat'], ''], ['literal', hiddenSats]]]);
    }
    if (effectiveHidden().includes('replay')) expr.push(['!=', ['get', 'replay'], true]);
    if (!map.getLayer('points')) return;
    var tracksOn = !effectiveHidden().includes('gts-tracks');
    // With aircraft tracks on, tracked aircraft are drawn in the air instead of on the ground
    // Optionally only the points coloured by the selected measure
    if (colouredOnly && METRICS[colourBy]) expr.push(['all', isColourTarget(), ['has', `m_${colourBy}`]]);
    // Satellite reports drawn as part of a swath aren't drawn as points as well,
    // unless coverage is switched off and every report is a point
    var coverage = !effectiveHidden().includes('sat-coverage');
    var notInSwath = coverage ? [['!=', ['get', 'inSwath'], true]] : [];
    var shown = [...(tracksOn ? [...expr, ['!=', ['get', 'tracked'], true]] : expr), ...notInSwath];
    var arrows = windArrows();
    map.setFilter('points-arrow', arrows ? [...shown, isArrow()] : ['boolean', false]);
    if (arrows) shown = [...shown, ['!', isArrow()]];
    map.setFilter('points', [...shown, ['!=', ['get', 'gateway'], true], ['!=', ['get', 'ext'], true]]);
    map.setFilter('points-gts', [...shown, ['==', ['get', 'gateway'], true]]);
    map.setFilter('points-ext', [...shown, ['==', ['get', 'ext'], true]]);
    map.setFilter('pulses', [...(tracksOn ? [...expr, ['!=', ['get', 'tracked'], true]] : expr), ...notInSwath]);
    map.setFilter('swaths-fill', !coverage ? ['boolean', false] : expr.length > 1 ? expr : null);
    var trackExpr = coverage ? expr : [...expr, ['!=', ['get', 'kind'], 'satellite']];
    map.setFilter('tracks', [...trackExpr, ['==', ['geometry-type'], 'LineString']]);
    updateMapKey();
    map.setFilter('track-ribbons', [...trackExpr, ['==', ['geometry-type'], 'Polygon']]);
    var radarShown = effectiveHidden().includes('radar') ? 'none' : 'visible';
    radars.forEach((r) => map.getLayer(r.id) && map.setLayoutProperty(r.id, 'visibility', radarShown));
}

function applyFilters() {
    applyMapFilter();
    rebuildQueue();
    var active = filtersActive();
    queueToggle.classList.toggle('filtered', active);
    queueToggle.title = active ? 'Layers and messages (filters on)' : 'Layers and messages';
    document.querySelector('.queue-reset').hidden = !active;
}

function zoomToCentres(selected) {
    var bounds = new maplibregl.LngLatBounds();
    for (var record of records.values()) {
        if (selected.has(record.centre)) bounds.extend(record.coords);
    }
    if (bounds.isEmpty()) return;
    var sidebar = document.querySelector('.queue').getBoundingClientRect().width;
    map.fitBounds(bounds, { padding: { top: 60, bottom: 60, left: sidebar + 60, right: 60 }, maxZoom: 7 });
}

// Adds a centre to the picker, or names one already listed
function addCentreOption(centre, name) {
    var item = centres.get(centre);
    if (!item) {
        item = document.createElement('li');
        item.innerHTML = '<label><input type="checkbox" class="form-check-input"><strong></strong><span></span></label>';
        item.dataset.centre = centre;
        item.querySelector('input').value = centre;
        item.querySelector('input').checked = filters.centres.has(centre);
        item.querySelector('strong').textContent = centre;
        var next = [...centreList.children].find((li) => li.dataset.centre > centre);
        centreList.insertBefore(item, next || null);
        centres.set(centre, item);
    }
    if (name) item.querySelector('span').textContent = name;
    item.dataset.search = `${centre} ${item.querySelector('span').textContent}`.toLowerCase();
    item.hidden = !item.dataset.search.includes(centreSearch.value.trim().toLowerCase());
}

function searchCentres() {
    var query = centreSearch.value.trim().toLowerCase();
    for (var item of centres.values()) {
        item.hidden = !item.dataset.search.includes(query);
    }
}

function toggleCentre(centre, on) {
    on ? filters.centres.add(centre) : filters.centres.delete(centre);
    var item = centres.get(centre);
    if (item) item.querySelector('input').checked = on;
    showSelectedCentres();
    applyFilters();
    if (on) zoomToCentres(filters.centres);
}

// Summarises the selection on the picker button and lists it as removable chips
function showSelectedCentres() {
    var selected = [...filters.centres].sort();
    centreToggle.textContent = !selected.length ? 'All centres'
        : selected.length === 1 ? selected[0] : `${selected.length} centres`;
    centreChips.replaceChildren(...selected.map((centre) => {
        var chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'queue-chip';
        chip.setAttribute('aria-pressed', 'true');
        chip.title = `Remove ${centre}`;
        chip.textContent = `${centre} ×`;
        chip.addEventListener('click', () => toggleCentre(centre, false));
        return chip;
    }));
}

// The picker lists every centre in the WMO register; centres seen in messages
// but not registered are still added as they arrive. The register's CORS
// headers are unreliable, so fall back to a bundled snapshot.
const CENTRE_REGISTER = 'https://codes.wmo.int/wis/topic-hierarchy/centre-id?_format=jsonld';
const CENTRE_SNAPSHOT = 'assets/data/centre-id.json';

async function loadCentres() {
    var list;
    try {
        list = parseCentreRegister(await fetchJson(CENTRE_REGISTER));
    } catch (err) {
        console.debug('Could not load the centre-id register, using the snapshot');
        list = await fetchJson(CENTRE_SNAPSHOT).catch(() => []);
    }
    list.forEach(([centre, name]) => addCentreOption(centre, name));
}

// Returns [[centre-id, description], ...] for the centres not retired
function parseCentreRegister(register) {
    var list = (register['@graph'] || [])
        .filter((item) => item['@type'] === 'skos:Concept' && item['skos:notation'])
        .filter((item) => (item['reg:status'] || {})['@id'] !== 'reg:statusRetired')
        .map((item) => [item['skos:notation'], (item['dct:description'] || {})['@value'] || '']);
    if (!list.length) throw new Error('empty centre-id register');
    return list;
}

async function fetchJson(url) {
    var response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: ${response.status}`);
    return response.json();
}

class QueueControl {
    onAdd(map) {
        var container = document.createElement('div');
        container.className = 'maplibregl-ctrl maplibregl-ctrl-group';
        var toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'queue-toggle';
        queueToggle = toggle;
        toggle.title = 'Layers and messages';
        toggle.innerHTML = '&#9776;';
        container.appendChild(toggle);
        toggle.addEventListener('click', function(){
            document.body.classList.toggle('queue-open');
            flushQueue();
        });

        var sidebar = document.createElement('aside');
        sidebar.className = 'queue';
        sidebar.innerHTML = `
            <!-- Filters shared by the map and the message list -->
            <div class="queue-header queue-filters">
                <div class="queue-title"><strong>Filters</strong>
                    <button type="button" class="btn btn-sm btn-link queue-reset" hidden>Reset filters</button>
                </div>
                <div class="filter-row">${filterModeButton('text')}<input type="search" class="form-control form-control-sm" placeholder="Filter topics"></div>
                <div class="queue-selects">
                    <div class="filter-row">${filterModeButton('centres')}<div class="centre-picker">
                        <button type="button" class="form-select form-select-sm centre-toggle" aria-label="Centres" aria-expanded="false">All centres</button>
                        <div class="centre-menu" hidden>
                            <input type="search" class="form-control form-control-sm" placeholder="Search centres" aria-label="Search centres">
                            <ul class="centre-list" aria-label="Centres"></ul>
                        </div>
                    </div></div>
                    <div class="queue-chips centre-chips" aria-label="Selected centres"></div>
                    <div class="filter-row">${filterModeButton('format')}<select class="form-select form-select-sm queue-format" aria-label="File type">
                        <option value="">All file types</option>
                        ${Object.entries(FORMATS).map(([key, label]) => `<option value="${key}">${label}</option>`).join('')}
                    </select></div>
                </div>
                <div class="queue-chips" role="group" aria-label="Earth system discipline">
                    ${filterModeButton('disciplines')}
                    ${Object.entries(DISCIPLINES).map(([key, label]) =>
                        `<button type="button" class="queue-chip" data-discipline="${key}" aria-pressed="false">${label}</button>`).join('')}
                </div>
            </div>
            <div class="queue-tabs" role="tablist">
                <button type="button" role="tab" data-tab="layers" aria-selected="true">Layers</button>
                <button type="button" role="tab" data-tab="messages" aria-selected="false">Messages</button>
            </div>
            <div class="queue-pane queue-pane-layers" data-pane="layers"></div>
            <div class="queue-pane queue-pane-messages" data-pane="messages" hidden>
                <div class="queue-controls">
                    <select class="form-select form-select-sm queue-mapped" aria-label="Messages to list">
                        <option value="">All messages</option>
                        <option value="on">On map</option>
                        <option value="off">Not on map</option>
                    </select>
                    <span class="queue-count"></span>
                    <button type="button" class="btn btn-sm btn-outline-secondary queue-pause">Pause</button>
                </div>
                <button type="button" class="queue-new" hidden></button>
                <ol class="queue-list"></ol>
            </div>`;
        sidebar.querySelector('.queue-filters .queue-title').insertAdjacentHTML('beforeend',
            '<button type="button" class="btn btn-sm btn-outline-secondary queue-close" title="Close (Esc)">Close</button>');
        sidebar.querySelector('.queue-close').addEventListener('click', () => document.body.classList.remove('queue-open'));
        document.body.appendChild(sidebar);
        sidebar.querySelectorAll('.queue-tabs button').forEach((button) => button.addEventListener('click', () => selectQueueTab(button.dataset.tab)));
        queueList = sidebar.querySelector('.queue-list');
        queueCount = sidebar.querySelector('.queue-count');
        queueFilter = sidebar.querySelector('input[type=search]');
        queueMapped = sidebar.querySelector('.queue-mapped');
        queuePause = sidebar.querySelector('.queue-pause');
        centreList = sidebar.querySelector('.centre-list');
        centreSearch = sidebar.querySelector('.centre-menu input');
        centreToggle = sidebar.querySelector('.centre-toggle');
        centreChips = sidebar.querySelector('.centre-chips');
        var centreMenu = sidebar.querySelector('.centre-menu');
        loadCentres();
        var queueFormat = sidebar.querySelector('.queue-format');
        queueFormat.addEventListener('change', function(){
            filters.format = queueFormat.value;
            applyFilters();
        });
        var chips = [...sidebar.querySelectorAll('.queue-chip')];

        queueFilter.addEventListener('input', function(){
            filters.text = queueFilter.value.trim().toLowerCase();
            applyFilters();
        });
        var openCentreMenu = (open) => {
            centreMenu.hidden = !open;
            centreToggle.setAttribute('aria-expanded', open);
            if (open) centreSearch.focus();
        };
        centreToggle.addEventListener('click', () => openCentreMenu(centreMenu.hidden));
        centreSearch.addEventListener('input', searchCentres);
        centreSearch.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                openCentreMenu(false);
                centreToggle.focus();
            } else if (e.key === 'Enter') {
                // Toggle the only match, or the first one
                var match = [...centreList.children].find((li) => !li.hidden);
                if (match) toggleCentre(match.dataset.centre, !filters.centres.has(match.dataset.centre));
            }
        });
        centreList.addEventListener('change', (e) => toggleCentre(e.target.value, e.target.checked));
        document.addEventListener('click', (e) => {
            if (!centreMenu.hidden && !e.target.closest('.centre-picker')) openCentreMenu(false);
        });
        chips.forEach((chip) => chip.addEventListener('click', function(){
            var key = chip.dataset.discipline;
            filters.disciplines.has(key) ? filters.disciplines.delete(key) : filters.disciplines.add(key);
            chip.setAttribute('aria-pressed', filters.disciplines.has(key));
            applyFilters();
        }));
        sidebar.querySelectorAll('.filter-mode').forEach((button) => button.addEventListener('click', () => {
            var key = button.dataset.filter;
            filterModes[key] = filterModes[key] === 'only' ? 'hide' : 'only';
            paintFilterMode(button);
            applyFilters();
        }));
        sidebar.querySelector('.queue-reset').addEventListener('click', function(){
            Object.keys(filterModes).forEach((key) => { filterModes[key] = 'only'; });
            sidebar.querySelectorAll('.filter-mode').forEach(paintFilterMode);
            filters.text = filters.format = '';
            filters.disciplines.clear();
            filters.centres.clear();
            queueFilter.value = queueFormat.value = centreSearch.value = '';
            chips.forEach((chip) => chip.setAttribute('aria-pressed', 'false'));
            centreList.querySelectorAll('input').forEach((input) => { input.checked = false; });
            searchCentres();
            showSelectedCentres();
            applyFilters();
        });
        queueMapped.addEventListener('change', rebuildQueue);
        queuePause.addEventListener('click', function(){
            queuePaused = !queuePaused;
            flushQueue();
        });
        // Back to the newest messages
        queueNew = sidebar.querySelector('.queue-new');
        queueNew.addEventListener('click', () => {
            queueList.scrollTop = 0;
            flushQueue(true);
        });
        // Scrolling back to the top lets the held messages in
        queueList.addEventListener('scroll', () => { if (queueList.scrollTop <= 4) flushQueue(); }, { passive: true });

        // Often enough to feel live, seldom enough to read between updates
        setInterval(flushQueue, 1500);
        return container;
    }

    onRemove() {
        // Nothing to do here
    }
}

function queueMessage(topic, message, record, feature) {
    var [channel, t] = topic.split('/a/wis2/');
    var entry = {
        time: new Date(),
        topic: topic,
        channel: channel,
        centre: t.split('/', 1)[0],
        path: t.slice(t.indexOf('/') + 1),
        discipline: disciplineOf(t),
        format: feature ? formatOf(feature) : 'other',
        dataId: feature && feature.properties ? feature.properties.data_id : null,
        decodeKey: feature ? decodeKey(topic, feature) : null,
        // The decode layer this message goes to, when that layer is on. Origin copies
        // aren't downloaded, but are linked to what their cache copy decodes to.
        decodeKind: feature && !record ? Object.keys(DECODE_LAYERS).find((k) => decodeEnabled.has(k)
            && DECODE_LAYERS[k](topic.replace(/^origin\//, 'cache/'), feature) && !satelliteSkipped(k, topic)) : null,
        message: message,
        wis2box: wis2boxVersion(feature),
        record: record,
        row: null,
    };
    queueTotal++;
    if (entry.decodeKind && entry.decodeKey) {
        // A cache that announces the file after it has been decoded links straight away
        var decoded = decodedFirst.get(entry.decodeKey);
        if (decoded && records.has(decoded.id)) entry.record = decoded;
        else awaitDecode(entry);
    }
    if (centreList && !centres.has(entry.centre)) addCentreOption(entry.centre);
    recent.push(entry);
    if (recent.length > RECENT_MAX) recent.shift();
    if (matchesQueueFilter(entry)) {
        pending.push(entry);
        if (pending.length > QUEUE_MAX) pending.shift();
    }
}

function matchesQueueFilter(entry) {
    if (queueMapped && queueMapped.value && (queueMapped.value === 'on') !== !!entry.record) return false;
    return matchesFilters(entry);
}

function flushQueue(force) {
    if (!queueList || !document.body.classList.contains('queue-open')) return;

    queueCount.textContent = `${queueTotal.toLocaleString()} received`;
    queuePause.textContent = queuePaused ? `Resume (${pending.length} new)` : 'Pause';
    // While someone is reading (scrolled down, or the mouse is over the list), new
    // messages wait behind a button instead of pushing the rows down
    var reading = !force && (queueList.scrollTop > 4 || (!TOUCH.matches && queueList.matches(':hover')));
    queueNew.hidden = queuePaused || !reading || !pending.length;
    queueNew.textContent = `↑ ${pending.length.toLocaleString()} new message${pending.length === 1 ? '' : 's'}`;
    if (queuePaused || reading || !pending.length) return;

    // Oldest first, so each message either joins a recent group (which moves to the
    // top) or becomes the new top row
    for (var entry of pending) {
        var key = groupKey(entry), group = findGroup(key, entry.time, isSpaceBased(entry.topic));
        if (group) {
            addToGroup(group, entry);
            queueList.prepend(group);
        } else {
            var row = renderQueueRow(entry);
            row.dataset.group = key;
            row.groupEntries = [entry];
            row.latest = entry.time;
            queueList.prepend(row);
        }
    }
    pending = [];
    while (queueList.childElementCount > QUEUE_MAX) {
        queueList.lastElementChild.remove();
    }
}

// Messages that arrive in runs share a row with a count: back-to-back ones with
// the same topic, and satellite series (one message per granule or bulletin)
const GROUP_WINDOW_MS = 2 * 60 * 1000;

function groupKey(entry) {
    // Satellite bulletin numbers vary within a series (e.g. I/N/C/X/40/EUMP, .../41/EUMP)
    var path = isSpaceBased(entry.topic) ? entry.path.replace(/\/\d+(?=\/|$)/g, '/…') : entry.path;
    return `${entry.channel} ${entry.centre} ${path}`;
}

// The row this message joins: any topic merges with an identical row directly
// above it (back to back); satellite series, which interleave with other
// traffic, also look further down the recent rows
const GROUP_SEARCH_ROWS = 40;
function findGroup(key, time, satellite) {
    var row = queueList.firstElementChild;
    for (var i = 0; row && i < (satellite ? GROUP_SEARCH_ROWS : 1); i++, row = row.nextElementSibling) {
        if (row.dataset.group === key && time - row.latest <= GROUP_WINDOW_MS) return row;
    }
    return null;
}

function addToGroup(row, entry) {
    row.groupEntries.push(entry);
    row.latest = entry.time;
    row.querySelector('.queue-meta').textContent = `${entry.channel} · ${entry.time.toLocaleTimeString()}`;
    row.querySelector('.queue-topic').textContent = row.dataset.group.split(' ').slice(2).join(' ');
    var badge = row.querySelector('.queue-group-count');
    if (!badge) {
        badge = document.createElement('span');
        badge.className = 'queue-group-count';
        row.firstElementChild.appendChild(badge);
        row.title = 'Click to list these messages';
    }
    badge.textContent = `× ${row.groupEntries.length}`;
    var list = row.querySelector('.queue-group');
    if (list) list.prepend(renderQueueRow(entry));
}

// Opens or closes the list of messages in a group row
function toggleGroup(row) {
    var list = row.querySelector('.queue-group');
    if (list) {
        list.remove();
        row.classList.remove('queue-group-open');
        return;
    }
    list = document.createElement('ol');
    list.className = 'queue-group';
    list.addEventListener('click', (e) => e.stopPropagation());  // Rows inside act on their own
    row.groupEntries.slice().reverse().forEach((entry) => list.appendChild(renderQueueRow(entry)));
    row.appendChild(list);
    row.classList.add('queue-group-open');
    // Pause so the group isn't pushed out of the list while it's open
    queuePaused = true;
    flushQueue();
}

function rebuildQueue() {
    queueList.replaceChildren();
    pending = recent.filter(matchesQueueFilter).slice(-QUEUE_MAX);
    var paused = queuePaused;
    queuePaused = false;
    flushQueue(true);
    queuePaused = paused;
}

// Expanded view of a message that isn't on the map: decode its data or show the raw JSON
function renderQueueDetail(entry) {
    var text = entry.message.toString();
    try {
        var message = JSON.parse(text);
        text = JSON.stringify(message, null, 2);
    } catch (err) {
        message = null;
    }
    var props = (message && message.properties) || {};
    var source = message && bufrSource(message, props);

    var detail = document.createElement('div');
    detail.className = 'queue-detail';
    detail.innerHTML = `
        <div class="pp-actions"></div>
        <div class="pp-decoded"></div>
        <pre hidden></pre>`;
    detail.addEventListener('click', (e) => e.stopPropagation());  // Keep it open
    var actions = detail.querySelector('.pp-actions');
    var out = detail.querySelector('.pp-decoded');
    var pre = detail.querySelector('pre');
    pre.textContent = text;

    // Expanding a row means wanting the data, so decode straight away
    var decode = async () => {
        try {
            showDecoded(out, null, await decodeSource(source, stationId(props), out));
        } catch (err) {
            showDecodeError(out, err, decode);
        }
    };
    if (source) decode();
    var json = document.createElement('button');
    json.type = 'button';
    json.className = 'btn btn-sm btn-outline-secondary';
    json.textContent = 'Show message';
    json.addEventListener('click', () => {
        pre.hidden = !pre.hidden;
        json.textContent = pre.hidden ? 'Show message' : 'Hide message';
    });
    actions.appendChild(json);
    return detail;
}

// The row's dot describes the message itself, matching the map: origin
// messages are rings in the origin colour (even when a cache copy is what's
// drawn), cache messages are filled with their point's colour, and messages
// waiting to be decoded have a dashed ring in their layer's colour; anything
// not on the map gets a small grey dot, so it can't be mistaken for a ring
function paintQueueDot(dot, entry) {
    dot.className = 'queue-dot';
    dot.style.background = dot.style.borderColor = '';
    if (entry.channel !== 'cache' && entry.record) {
        dot.classList.add('queue-dot-ring');
        dot.style.borderColor = COLORS.origin;
    } else if (entry.record) {
        dot.style.background = entry.record.color;
        dot.style.borderColor = darken(entry.record.color);
        if (isGateway(entry.record)) dot.classList.add('is-gts');
    } else if (entry.decodeKind) {
        dot.classList.add('queue-dot-pending');
        if (['gts', 'gts-satellite', 'gts-text', 'wis2gts'].includes(entry.decodeKind)) dot.classList.add('is-gts');
        dot.style.borderColor = COLORS[entry.decodeKind];
    } else {
        dot.classList.add('queue-dot-none');  // Not on the map
    }
}

// The point a message is drawn as now: a cache copy may have replaced the
// origin point it was first linked to
function currentRecord(entry) {
    if (!entry.record) return null;
    if (records.has(entry.record.id)) return entry.record;
    var latest = byDataId.get(entry.record.props.data_id);
    return latest && records.has(latest.id) ? latest : null;
}

// Entries waiting for their file to be decoded, by decodeKey. Kept apart from
// the recent list, which busy brokers cycle through in seconds, so a row still
// on screen can be linked however long decoding takes.
const DECODE_WAITING_MAX = 5000;
const decodeWaiting = new Map();
const decodedFirst = new Map();  // decodeKey -> first report plotted from that file

// The same GTS bulletin is relayed by more than one gateway (DWD and JMA) under
// different data_ids, so gateway files are known by their abbreviated heading
// (TTAAii CCCC YYGGgg, plus BBB for amendments) and decoded once
function decodeKey(topic, feature) {
    var props = feature.properties || {}, dataId = props.data_id;
    var heading = GATEWAY_TOPIC.test(topic) && /([A-Z]{4}\d{2}[A-Z]{4}\d{6}(?:[A-Z]{3})?)(?=[_/]|$)/.exec(dataId || '');
    var key = heading ? `gts:${heading[1]}` : dataId;
    // An update reuses its data_id, but is a new file to decode
    return key && isUpdate(feature) ? `${key}@${props.pubtime}` : key;
}

function awaitDecode(entry) {
    var list = decodeWaiting.get(entry.decodeKey) || [];
    list.push(entry);
    decodeWaiting.set(entry.decodeKey, list);
    if (decodeWaiting.size > DECODE_WAITING_MAX) decodeWaiting.delete(decodeWaiting.keys().next().value);
}

// Once reports decoded from a message are plotted, link its sidebar entries
// to the first of them and repaint their rows
function linkDecoded(key, record) {
    if (!key) return;
    decodedFirst.set(key, record);
    if (decodedFirst.size > DECODE_WAITING_MAX) decodedFirst.delete(decodedFirst.keys().next().value);
    var waiting = decodeWaiting.get(key);
    if (!waiting) return;
    decodeWaiting.delete(key);
    for (var entry of waiting) {
        if (entry.record) continue;
        entry.record = record;
        if (entry.row) {
            paintQueueDot(entry.row.querySelector('.queue-dot'), entry);
            entry.row.title = 'Show on map';
        }
    }
}

function renderQueueRow(entry) {
    var row = document.createElement('li');
    row.className = 'queue-row';
    row.title = entry.record ? 'Show on map' : 'Not on map: click to decode or view the message';

    var head = document.createElement('div');
    var dot = document.createElement('span');
    paintQueueDot(dot, entry);
    var centre = document.createElement('strong');
    centre.textContent = entry.centre;
    var meta = document.createElement('span');
    meta.className = 'queue-meta';
    meta.textContent = `${entry.channel} · ${entry.time.toLocaleTimeString()}`;
    head.append(dot, centre, meta);
    if (entry.wis2box || wis2boxByCentre.has(entry.centre)) {
        var version = document.createElement('span');
        version.className = 'queue-wis2box';
        version.textContent = entry.wis2box ? `wis2box ${entry.wis2box}` : 'wis2box';
        version.title = entry.wis2box ? 'Published by wis2box' : 'This centre runs wis2box';
        head.append(version);
    }

    var path = document.createElement('div');
    path.className = 'queue-topic';
    path.textContent = entry.path;
    row.append(head, path);

    entry.row = row;
    row.addEventListener('click', function(){
        if (row.groupEntries && row.groupEntries.length > 1) return toggleGroup(row);
        var target = currentRecord(entry);
        if (target) {
            openPopup(target);
            map.flyTo({ center: target.coords, zoom: Math.max(map.getZoom(), 5) });
            return;
        }
        var detail = row.querySelector('.queue-detail');
        if (detail) return detail.remove();
        row.appendChild(renderQueueDetail(entry));
        // Pause so the row isn't pushed out of the list while it's being read
        queuePaused = true;
        flushQueue();
    });
    return row;
}

// Public WIS2 Global Brokers reachable from a browser (WSS only)
const hosts = [
    'wss://globalbroker.meteo.fr:443/mqtt',
    'wss://globalbroker.inmet.gov.br:443/mqtt',
];
const topics = ['origin/a/wis2/#', 'cache/a/wis2/#'];
const options = {
    username: 'everyone',
    password: '00650076006500720079006f006e0065'.hexDecode(),
    keepalive: 60,
    protocolVersion: 5,
    reconnectPeriod: 1000,
    connectTimeout: 30 * 1000,
};

let client = null;

// Race all brokers and keep the first one that connects and subscribes
function connectFastest() {
    console.log('Connecting mqtt client');
    let failures = 0;

    hosts.forEach((host) => {
        const candidate = mqtt.connect(host, { ...options, reconnectPeriod: 0 });
        candidate.setMaxListeners(10);
        let failed = false;

        const fail = () => {
            if (failed || candidate === client) return;
            failed = true;
            candidate.end(true);
            if (!client && ++failures === hosts.length) {
                console.log('All brokers failed, retrying...');
                setTimeout(connectFastest, 5000);
            }
        };

        candidate.once('connect', () => {
            candidate.subscribe(topics, (err, granted) => {
                if (err || granted.some((g) => g.qos >= 128)) {
                    console.log(`Subscribe failed on ${host}`);
                    return fail();
                }
                if (client) return candidate.end(true); // Another broker won

                client = candidate;
                client.options.reconnectPeriod = options.reconnectPeriod;
                client.on('message', (topic, message) => {
                    var feature = parseMessage(topic, message);
                    queueMessage(topic, message, feature && onMessage(topic, feature), feature);
                });
                client.on('reconnect', () => console.log('Reconnecting...'));
                console.log(`Connected to ${host}!`);
            });
        });

        candidate.on('error', (err) => {
            console.log(`Connection error (${host}): `, err.message);
            if (candidate === client) {
                candidate.end(true);
                client = null;
                connectFastest();
            } else {
                fail();
            }
        });

        candidate.on('close', fail);
    });
}

map.addControl(new QueueControl(), 'top-left');
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-left');
map.addControl(new ProjectionControl(), 'top-left');
// Layer switches and styling live in the sidebar's Layers tab; the map shows a
// read-only key of what is currently drawn
document.querySelector('.queue-pane-layers').appendChild(new LegendControl().onAdd(map));
map.addControl(new MapKey(), 'top-right');
map.addControl(attribution, 'bottom-right');

// The ⓘ attribution starts closed and stays closed unless the visitor opens it:
// MapLibre opens the compact attribution again whenever its text changes
(function keepAttributionClosed() {
    var el = document.querySelector('.maplibregl-ctrl-attrib');
    if (!el) return;
    var openedByVisitor = false;
    // Captured before MapLibre's own handler toggles it, so this is the state the visitor is choosing
    el.addEventListener('click', (e) => {
        if (e.target.closest('.maplibregl-ctrl-attrib-button')) openedByVisitor = !el.classList.contains('maplibregl-compact-show');
    }, true);
    var close = () => {
        if (!openedByVisitor && el.classList.contains('maplibregl-compact-show')) el.classList.remove('maplibregl-compact-show');
    };
    new MutationObserver(close).observe(el, { attributes: true, attributeFilter: ['class'] });
    close();
})();

// Keep the globe (the map's centre) in the middle of the area the panels leave
// uncovered: the sidebar and info panel become map padding as they open and close
let panelPadding = '';
// On phones the info panel is a sheet across the bottom and the sidebar covers the map
const PHONE = window.matchMedia('(max-width: 600px)');

function updateMapPadding() {
    var queue = document.querySelector('.queue');
    var info = document.body.classList.contains('info-open') && infobar;
    var left = 0, right = 0, bottom = 0;
    if (PHONE.matches) {
        bottom = info ? Math.min(infobar.offsetHeight, window.innerHeight * 0.55) : 0;
    } else {
        left = document.body.classList.contains('queue-open') && queue ? queue.getBoundingClientRect().width : 0;
        right = info ? infobar.getBoundingClientRect().width : 0;
    }
    var key = `${left}|${right}|${bottom}`;
    if (key === panelPadding) return;
    panelPadding = key;
    map.easeTo({ padding: { left, right, top: 0, bottom }, duration: 200 });
}
new MutationObserver(updateMapPadding).observe(document.body, { attributes: true, attributeFilter: ['class'] });
window.addEventListener('resize', () => { panelPadding = ''; updateMapPadding(); });

connectFastest();

const ignoredTopics = [
    '/a/wis2/de-dwd-gts-to-wis2/',
    '/a/wis2/ca-eccc-msc/data/core/weather/prediction',
];
const regex = /(?!WIGOS_)(\d-\d+-\d-[\d0-9a-zA-Z]+)/g;

function stationId(props) {
    var match = (props.data_id || '').match(regex);
    return props.wigos_station_identifier || (match ? match.pop() : null);
}

function parseMessage(topic, message) {
    // message is Buffer
    try {
        return JSON.parse(message.toString());
    } catch (err) {
        console.debug(`Message from ${topic} is not valid JSON`);
        return null;
    }
}

// Turns a notification into a map point, returning its record (or nothing)
function onMessage(topic, feature, replay) {
    // Kept for every message so the sidebar can find a downloadable copy
    rememberLinks((feature.properties || {}).data_id, feature.links || []);
    revealGatewayRows(topic, feature);
    // Replayed messages are only drawn: decoding a past hour of files would swamp the decoder
    var kind = !replay && Object.keys(DECODE_LAYERS).find((key) => DECODE_LAYERS[key](topic, feature));
    if (kind && decodeEnabled.has(kind)) queueDecode(kind, topic, feature);

    if (ignoredTopics.some((t) => topic.includes(t))) {
        return; // Ignore this topic
    }
    if (!feature.geometry || !feature.geometry.hasOwnProperty('type')){
        console.debug(`Message from ${topic} missing geometry`);
        return;
    }

    var coords = pointFor(feature.geometry);
    if (!coords) {
        console.debug(`Message from ${topic} has invalid or too large geometry`);
        return;
    }

    var props = feature.properties || {};
    var links = feature.links || [];
    // A replayed report the map already has a report as recent from the same station
    // for is neither drawn nor decoded
    if (replay) {
        var station = stationId(props), latest = station && latestByStation.get(station);
        if (latest && records.has(latest.id) && observedAt(latest) >= (Date.parse(props.datetime || '') || 0)) return null;
        // Replays come newest published first, so a late-published older report may be
        // here already; the newer one takes its place
        if (latest && records.has(latest.id) && latest.replay) removePoint(latest);
    }

    var [channel, t] = topic.split('/a/wis2/');
    var webcam = t.includes('webcam');
    var record = {
        id: nextId++,
        coords: coords,
        topic: topic,
        channel: channel,
        centre: t.split('/', 1)[0],
        path: t.slice(t.indexOf('/') + 1),
        discipline: disciplineOf(t),
        webcam: webcam,
        props: props,
        links: links,
        wsi: stationId(props),
        format: formatOf(feature),
        color: COLORS.origin,
        source: webcam ? null : bufrSource(feature, props),
        update: isUpdate(feature),
        notification: feature,
        decoded: null,
        replay: !!replay,
        // Replayed points fade by when they were published
        born: replay ? Math.min(Date.parse(props.pubtime) || Date.now(), Date.now()) : Date.now(),
    };
    if (channel === 'cache' || replay) record.color = OBS_CLASSES[topicClass(record)].color;
    if (replay) record.subLayer = `replay-${topicClass(record)}`;
    var added = addPoint(record);
    if (added === record) queueStationDecode(record);
    return added;
}

// Points as-is; small areas (e.g. station Polygons) at their center.
// Large areas such as model domains are skipped since a center is meaningless.
function pointFor(geometry) {
    var positions = [];
    collectPositions(geometry.type === 'GeometryCollection'
        ? geometry.geometries.map((g) => g.coordinates)
        : geometry.coordinates, positions);
    if (!positions.length) return null;
    if (geometry.type === 'Point') return positions[0].slice(0, 2);

    var xs = positions.map((p) => p[0]);
    var ys = positions.map((p) => p[1]);
    var [west, east, south, north] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    if (east - west > 10 || north - south > 10) return null;
    return [(west + east) / 2, (south + north) / 2];
}

function collectPositions(coords, out) {
    if (!Array.isArray(coords)) return;
    if (typeof coords[0] === 'number') {
        if (isFinite(coords[0]) && isFinite(coords[1])) out.push(coords);
        return;
    }
    coords.forEach((c) => collectPositions(c, out));
}

// BUFR decoding in the browser with Pyodide + pybufrkit, loaded on first use
const PYODIDE_URL = 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/';
const PYBUFRKIT_WHEEL = 'assets/py/pybufrkit-0.2.25-py3-none-any.whl';
const PYBUFRKIT_WHEEL_CDN = 'https://cdn.jsdelivr.net/gh/webb-ben/wis-live@main/' + PYBUFRKIT_WHEEL;
// wis2box names itself and its version in generated_by ("wis2box 1.3.0"), and
// serves data under <base>/data/<date>/wis/..., so the base of an origin link is
// the wis2box itself. Cache copies find it through the origin's link for the same data.
const WIS2BOX_DATA = /^(https?:\/\/[^?#]+?)\/data\/\d{4}-\d{2}-\d{2}\/wis\//;

function wis2boxVersion(feature) {
    var by = feature && (feature.generated_by || (feature.properties && feature.properties.generated_by));
    var match = typeof by === 'string' && by.match(/^wis2box\s+(\S+)/i);
    return match ? match[1] : null;
}

// Known wis2box deployments by centre (from the wis2box deployments list, a
// snapshot since that list can't be fetched from a browser), for centres whose
// messages don't link back to their wis2box
const WIS2BOX_DEPLOYMENTS = 'assets/data/wis2box-deployments.json';
const wis2boxByCentre = new Map();  // centre-id -> wis2box URL
fetch(WIS2BOX_DEPLOYMENTS).then((r) => (r.ok ? r.json() : null))
    .then((list) => (list && list.deployments || []).forEach((d) => wis2boxByCentre.set(d.centre, d.url)))
    .catch(() => {});

function wis2boxOf(record) {
    var version = wis2boxVersion(record.notification);
    var hrefs = [...record.links.map((l) => l.href), ...(dataLinks.get(record.props.data_id) || [])];
    var base = hrefs.map((h) => (String(h).match(WIS2BOX_DATA) || [])[1]).find(Boolean) || wis2boxByCentre.get(record.centre);
    if (!version && !base) return null;
    return { version, url: base || null };
}

const DATA_LINKS_MAX = 20000;
const dataLinks = new Map();  // data_id -> hrefs seen from every cache
const decoderWorkers = {};  // lane ('main' or 'files') -> worker
let decoderReady = false;
let nextCall = 1;
const decoderCalls = new Map();  // call id -> { resolve, reject }

const DECODE_PY = `
import json
from pybufrkit.decoder import Decoder
from pybufrkit.descriptors import ElementDescriptor

def _value(v):
    if isinstance(v, bytes):
        try:
            v = v.decode('utf-8')
        except UnicodeDecodeError:
            v = v.decode('latin-1')
        return v.strip('\\x00 ')
    return v

def _wsi(rows):
    v = {d: x for d, _, x, _ in rows}
    try:
        if all(k in v for k in (1125, 1126, 1127, 1128)):
            return f"{v[1125]}-{v[1126]}-{v[1127]}-{v[1128]}"
        if 1001 in v and 1002 in v:
            return f"0-20000-0-{int(v[1001]):02d}{int(v[1002]):03d}"
    except (TypeError, ValueError):
        return None

_cache = {}  # key -> decoded subsets, so reports can be paged without re-decoding

# Some files hold many BUFR messages back to back (e.g. a 60-message IASI pass),
# so each is found by the length in its section 0. Big files are sampled: up to
# _MAX_MESSAGES spread across the file, so one pass can't hold up the decoder.
_MAX_MESSAGES = 8

def _messages(b):
    out, start = [], b.find(b'BUFR')
    while start >= 0:
        length = int.from_bytes(b[start + 4:start + 7], 'big')
        if length < 8 or start + length > len(b):
            out.append(b[start:])
            break
        out.append(b[start:start + length])
        start = b.find(b'BUFR', start + length)
    if len(out) > _MAX_MESSAGES:
        out = [out[i * len(out) // _MAX_MESSAGES] for i in range(_MAX_MESSAGES)]
    return out

def _decode(data):
    subsets = []
    for i, b in enumerate(_messages(bytes(data.to_py()))):
        try:
            subsets.extend(_decode_message(b))
        except Exception:
            if i == 0:
                raise  # Later messages that fail are skipped
    return subsets

def _decode_message(b):
    td = Decoder().process(b).template_data.value
    subsets = []
    for descs, vals in zip(td.decoded_descriptors_all_subsets, td.decoded_values_all_subsets):
        rows = []
        for d, v in zip(descs, vals):
            # Skip sequences, operators, replication factors and missing values
            if not isinstance(d, ElementDescriptor) or v is None or d.id // 1000 == 31:
                continue
            v = _value(v)
            if v == '':
                continue
            rows.append((d.id, d.name, v, d.unit))
        subsets.append(rows)
    return subsets

# Soundings (TEMP) repeat a block per level: time offset and significance,
# then pressure, height, drift, temperature, dewpoint and wind. Rather than
# thousands of rows, return the header rows plus one compact entry per level:
# [pressure hPa, height gpm, temperature C, dewpoint C, wind dir, wind m/s, dlat, dlon]
_LEVEL = {10009: 1, 12101: 2, 12103: 3, 11001: 4, 11002: 5, 5015: 6, 6015: 7}

def _profile(rows):
    if sum(1 for r in rows if r[0] == 7004) < 3:
        return rows, None
    header, levels, level = [], [], None
    for d, name, v, unit in rows:
        if d == 7004:
            level = [v / 100, None, None, None, None, None, None, None]
            levels.append(level)
        elif level is None:
            if d not in (4086, 8042):
                header.append((d, name, v, unit))
        elif d in _LEVEL and level[_LEVEL[d]] is None and isinstance(v, (int, float)):
            level[_LEVEL[d]] = round(v - 273.15, 2) if d in (12101, 12103) else v
    return header, levels

def ready():
    return 'ok'

# ---- Weather radar (ODIM HDF5 polar volumes). Returns the lowest-elevation
# reflectivity scan, DBZH before TH, as bytes of (dBZ + 32) * 2, 0 for no echo.
def _attr(groups, name, default=None):
    for g in groups:
        if g is not None and name in g.attrs:
            v = g.attrs[name]
            if isinstance(v, bytes):
                return v.decode()
            return v.item() if hasattr(v, 'item') else v
    return default

# GAMIC volumes (scan0, scan1, ... each with moment_N datasets) instead of ODIM's
# dataset1/data1: values span dyn_range_min..max over 1..2^bits-1 (0 is no data),
# and each ray's azimuth is in ray_header, so rays are put back on whole degrees
def _gamic_scan(f, np, base64):
    best = None
    for name, s in f.items():
        if not name.startswith('scan') or 'how' not in s:
            continue
        el = _attr([s['how']], 'elevation')
        for m in s:
            q = _attr([s[m]], 'moment') if m.startswith('moment_') else None
            if q in ('Zh', 'UZh') and el is not None:
                rank = (q != 'Zh', float(el))
                if best is None or rank < best[0]:
                    best = (rank, s, s[m], q)
    if best is None:
        return None
    _, s, m, q = best
    raw = m[()]
    bits = 16 if raw.dtype == np.uint16 else 8
    lo, hi = float(_attr([m], 'dyn_range_min')), float(_attr([m], 'dyn_range_max'))
    dbz = lo + (raw.astype('float32') - 1) * (hi - lo) / (2 ** bits - 2)
    q8 = np.clip(np.round((dbz + 32) * 2), 1, 254).astype('uint8')
    q8[raw == 0] = 0
    rays = s['ray_header'][()]
    start, stop = rays['azimuth_start'], rays['azimuth_stop']
    azimuth = (start + ((stop - start) % 360) / 2) % 360
    out = np.zeros((360, raw.shape[1]), 'uint8')
    out[azimuth.astype(int) % 360] = q8
    # Fine range gates (100 m out to 250 km) are thinned to at most 1250 bins
    step = max(1, -(-raw.shape[1] // 1250))
    out = np.ascontiguousarray(out[:, ::step])
    when = str(_attr([f['what']], 'date', ''))
    how = s['how']
    return json.dumps({
        'quantity': 'DBZH' if q == 'Zh' else 'TH',
        'source': {'NOD': _attr([f.get('how')], 'site_name') or _attr([f.get('how')], 'host_name') or ''},
        'lat': float(_attr([f['where']], 'lat')),
        'lon': float(_attr([f['where']], 'lon')),
        'elangle': float(_attr([how], 'elevation')),
        'rscale': float(_attr([how], 'range_step')) * step,     # m
        'rstart': float(_attr([how], 'range_start', 0.0)) / 1000,  # km
        'nrays': 360,
        'nbins': int(out.shape[1]),
        'date': when[:10].replace('-', ''),
        'time': when[11:19].replace(':', ''),
        'data': base64.b64encode(out.tobytes()).decode(),
    })

def radar_scan(data):
    import io, base64
    import h5py
    import numpy as np
    f = h5py.File(io.BytesIO(bytes(data.to_py())), 'r')
    if any(k.startswith('scan') for k in f):
        return _gamic_scan(f, np, base64) or json.dumps(None)
    best = None
    for name, ds in f.items():
        if not name.startswith('dataset') or 'where' not in ds:
            continue
        el = _attr([ds['where']], 'elangle')
        if el is None:
            continue
        for dname, d in ds.items():
            if not dname.startswith('data') or 'data' not in d:
                continue
            q = _attr([d.get('what'), ds.get('what')], 'quantity')
            if q not in ('DBZH', 'TH'):
                continue
            rank = (q != 'DBZH', float(el))
            if best is None or rank < best[0]:
                best = (rank, ds, d, q)
    if best is None:
        return json.dumps(None)
    _, ds, d, q = best
    whats = [d.get('what'), ds.get('what'), f.get('what')]
    raw = d['data'][()]
    dbz = raw.astype('float32') * float(_attr(whats, 'gain', 1.0)) + float(_attr(whats, 'offset', 0.0))
    out = np.clip(np.round((dbz + 32) * 2), 1, 254).astype('uint8')
    for flag in ('nodata', 'undetect'):
        v = _attr(whats, flag)
        if v is not None:
            out[raw == v] = 0
    where = [ds['where'], f.get('where')]
    source = _attr([f.get('what')], 'source', '')
    return json.dumps({
        'quantity': q,
        'source': dict(p.split(':', 1) for p in source.split(',') if ':' in p),
        'lat': float(_attr([f.get('where')], 'lat')),
        'lon': float(_attr([f.get('where')], 'lon')),
        'elangle': float(_attr([ds['where']], 'elangle')),
        'rscale': float(_attr(where, 'rscale')),        # m
        'rstart': float(_attr(where, 'rstart', 0.0)),   # km
        'nrays': int(raw.shape[0]),
        'nbins': int(raw.shape[1]),
        'date': _attr([ds.get('what'), f.get('what')], 'startdate') or _attr([f.get('what')], 'date'),
        'time': _attr([ds.get('what'), f.get('what')], 'starttime') or _attr([f.get('what')], 'time'),
        'data': base64.b64encode(out.tobytes()).decode(),
    })

def decode_subsets(data, limit=0):
    subsets = _decode(data)
    if limit and len(subsets) > limit:
        # Spread the reports kept across the whole file, e.g. a satellite swath
        subsets = subsets[::-(-len(subsets) // limit)]
    return json.dumps([_profile(rows) for rows in subsets])

def decode_bufr(data, wsi, key, index=-1):
    if key not in _cache:
        if data is None:
            raise ValueError('this file is no longer cached, decode it again')
        _cache[key] = _decode(data)
        if len(_cache) > 20:
            _cache.pop(next(iter(_cache)))
    subsets = _cache[key]
    if not 0 <= index < len(subsets):
        index = next((i for i, rows in enumerate(subsets) if _wsi(rows) == wsi), 0)
    rows, profile = _profile(subsets[index])
    return json.dumps({
        'subsets': len(subsets),
        'index': index,
        'rows': rows,
        'profile': profile,
    })
`;

// Pyodide runs in a worker so decoding never blocks the map. The worker is
// built from a string, which also works when the page is opened from file://
const DECODER_WORKER = `
importScripts('${PYODIDE_URL}pyodide.js');
let ready = null;
let h5py = null;  // Loaded on the first radar file

async function init(wheelUrls) {
    const py = await loadPyodide({ indexURL: '${PYODIDE_URL}' });
    await py.loadPackage('micropip');
    await py.pyimport('micropip').install(['bitstring==3.1.9', 'six']);
    // pybufrkit only ships as an sdist, so we serve our own pure-Python wheel,
    // falling back to the CDN copy when the local one can't be fetched
    let wheel = null;
    for (const url of wheelUrls) {
        try {
            const response = await fetch(url);
            if (response.ok) { wheel = await response.arrayBuffer(); break; }
        } catch (err) {}
    }
    if (!wheel) throw new Error('could not download the BUFR decoder');
    py.unpackArchive(wheel, 'wheel');
    py.runPython(${JSON.stringify(DECODE_PY)});
    return py;
}

onmessage = async (e) => {
    const { id, fn, args, wheelUrls } = e.data;
    try {
        if (!ready) ready = init(wheelUrls);
        const py = await ready;
        if (fn === 'radar_scan') await (h5py = h5py || py.loadPackage('h5py'));
        postMessage({ id, result: py.globals.get(fn)(...args) });
    } catch (err) {
        ready = null;  // Allow a retry after a failed start
        postMessage({ id, error: err.message });
    }
};
`;

// Warm the decoder up once the map is idle so the first Decode is quick.
// Skipped on data-saver or very slow connections (it's roughly 15 MB on first visit).
function preloadDecoder() {
    var connection = navigator.connection;
    if (connection && (connection.saveData || /2g/.test(connection.effectiveType || ''))) return;
    var start = () => callDecoder('ready').catch((err) => console.debug(`Decoder preload failed: ${err.message}`));
    if ('requestIdleCallback' in window) {
        requestIdleCallback(start, { timeout: 10000 });
    } else {
        setTimeout(start, 3000);
    }
}

// Two decoders where the device can afford them: whole files (GTS bulletins,
// satellite swaths, up to half a second each) go to one, so popups and station
// colouring (a few ms each) never wait behind them. Phones and small devices
// keep one, since each holds its own copy of Python. The second loads only once
// the first is ready (loading both at once slows the first), and takes files
// once it is ready itself.
let filesDecoderReady = false;

function roomyForTwoDecoders() {
    return !window.matchMedia('(max-width: 600px)').matches
        && (navigator.deviceMemory || 8) >= 4 && (navigator.hardwareConcurrency || 4) >= 4;
}

function decoderLane(fn) {
    return (fn === 'decode_subsets' || fn === 'radar_scan') && filesDecoderReady ? 'files' : 'main';
}

function startFilesDecoder() {
    if (decoderWorkers.files || !roomyForTwoDecoders()) return;
    callDecoderOn('files', 'ready').then(() => { filesDecoderReady = true; })
        .catch((err) => console.debug(`Second decoder failed: ${err.message}`));
}

function callDecoder(fn, ...args) {
    return callDecoderOn(decoderLane(fn), fn, ...args);
}

function callDecoderOn(lane, fn, ...args) {
    var worker = decoderWorkers[lane];
    if (!worker) {
        worker = decoderWorkers[lane] = new Worker(URL.createObjectURL(new Blob([DECODER_WORKER], { type: 'text/javascript' })));
        worker.onmessage = (e) => {
            var call = decoderCalls.get(e.data.id);
            decoderCalls.delete(e.data.id);
            if (e.data.error) return call.reject(new Error(e.data.error));
            if (lane === 'main' && !decoderReady) {
                decoderReady = true;
                startFilesDecoder();
            }
            call.resolve(e.data.result);
        };
    }
    var wheelUrls = [new URL(PYBUFRKIT_WHEEL, document.baseURI).href, PYBUFRKIT_WHEEL_CDN];
    return new Promise((resolve, reject) => {
        var id = nextCall++;
        decoderCalls.set(id, { resolve, reject });
        worker.postMessage({ id, fn, args, wheelUrls });
    });
}

// Optional layers decoded in the background: some notifications carry no
// geometry, but the reports inside the BUFR file do, so download and decode the
// file and plot each report.
// GTS-to-WIS2: every BUFR bulletin series (T1 = I); reports are sorted into
// sublayers once decoded
const GTS_TOPIC = /\/a\/wis2\/[^/]+-gts-to-wis2\/data\/core\/I\//;
// WIS2-to-GTS: whatever BUFR those centres pass on (any size limit the link states applies)
const WIS2_GTS_TOPIC = /\/a\/wis2\/[^/]+-wis2-to-gts\//;
// Files: any other small cached file without geometry that may be BUFR, plus
// XML whose location is inside the file (Environment Canada citypage forecasts)
const DECODE_FILE_MAX_BYTES = 200 * 1024;
const DECODE_FILE_MAX_REPORTS = 300;  // Per file, so a satellite swath can't flood the map
const NOT_BUFR = ['grib', 'xml', 'csv', 'json', 'image', 'hdf', 'text'];
// Satellite files, from the cache or the GTS, are decoded while the Satellites row
// is on, whatever Cache and GTS-to-WIS2 say, and may be larger than other files
const SATELLITE_FILE_MAX_BYTES = 16 * 1024 * 1024;  // Big passes (IASI runs to 15 MB) are sampled, see _messages
const RADAR_FILE_MAX_BYTES = 50 * 1024 * 1024;
// Volumes bigger than this (Cyprus's GAMIC files run 27-39 MB) are fetched at most every
// RADAR_LARGE_EVERY_MS per radar, rather than every few minutes
const RADAR_LARGE_BYTES = 5 * 1024 * 1024;
const RADAR_LARGE_EVERY_MS = 15 * 60 * 1000;
const radarLargeFetched = new Map();  // radar (data_id without its time) -> when last fetched
const DECODE_LAYERS = {
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
    // Any space-based file not drawn from its notification: no geometry, or a swath too large to plot
    'cache-satellite': (topic, feature) => topic.startsWith('cache/') && !GATEWAY_TOPIC.test(topic) && isSpaceBased(topic)
        && !(feature.geometry && feature.geometry.type && pointFor(feature.geometry)) && !NOT_BUFR.includes(formatOf(feature))
        && !(feature.links || []).some((l) => isDataLink(l) && l.length > SATELLITE_FILE_MAX_BYTES),
};

function decodableFile(topic, feature) {
    return !feature.geometry
        && (!NOT_BUFR.includes(formatOf(feature)) || (formatOf(feature) === 'xml' && /citypage/i.test(topic + JSON.stringify(feature.links || [])))
            || (formatOf(feature) === 'text' && /lightning/i.test(topic)))
        && (feature.links || []).some((l) => isDataLink(l) && l.length > 0 && l.length <= DECODE_FILE_MAX_BYTES);
}

const DECODE_FETCH_TIMEOUT_MS = 20000;
const DECODE_QUEUE_MAX = 100;  // Oldest files are dropped when decoding falls behind
const decodeEnabled = new Set();
const decodePlotted = { gts: 0, 'gts-satellite': 0, 'gts-text': 0, wis2gts: 0, files: 0, 'cache-satellite': 0, radar: 0 };
let decodeQueue = [];
let decodeBusy = false;
const decodeSeen = new Set();

// Shows the GTS Aircraft and the Satellites rows once such a file has been
// announced, even though it isn't downloaded while the row is off
function revealGatewayRows(topic, feature) {
    if (!seenLayers.has('satellite') && isSpaceBased(topic)) showLegendRow('satellite');
    if (!seenLayers.has('radar') && DECODE_LAYERS.radar(topic, feature)) showLegendRow('radar');
    if (!seenLayers.has('gts-aircraft') && GATEWAY_AIRCRAFT.test(topic)) showLegendRow('gts-aircraft');
}

// GTS aircraft files are only fetched while their group is on (satellite files
// have decode layers of their own, on only while Satellites is)
function satelliteSkipped(kind, topic) {
    if (kind === 'gts' && GATEWAY_AIRCRAFT.test(topic)) return effectiveHidden().includes('gts-aircraft');
    return false;
}

function queueDecode(kind, topic, feature) {
    var key = decodeKey(topic, feature);
    // Each cache republishes the file; take the first copy a browser can download,
    // falling back on any link already seen for it (e.g. the origin's) when this
    // cache's own server blocks browser downloads
    var link = (feature.links || []).find((l) => isDataLink(l) && corsFriendly(l.href));
    var href = link ? link.href : [...(dataLinks.get((feature.properties || {}).data_id) || [])].find(corsFriendly);
    if (!href || !key || decodeSeen.has(key)) return;
    if (satelliteSkipped(kind, topic)) return;
    if (kind === 'radar' && radarThrottled(feature)) return;
    decodeSeen.add(key);
    if (decodeSeen.size > DATA_LINKS_MAX) decodeSeen.delete(decodeSeen.values().next().value);
    // XML needs no decoder, so it skips the queue rather than waiting behind BUFR
    if (formatOf(feature) === 'xml') {
        fetch(href, { signal: AbortSignal.timeout(DECODE_FETCH_TIMEOUT_MS) })
            .then((response) => (response.ok ? response.text() : null))
            .then((xml) => xml && decodeEnabled.has(kind) && plotCitypage({ kind, key, topic, feature, href }, xml))
            .catch((err) => console.debug(`Could not fetch ${href}: ${err.message}`));
        return;
    }
    // So do text SYNOPs (JMA sends them as .txt, DWD with no extension)
    if (kind === 'gts-text') {
        fetch(href, { signal: AbortSignal.timeout(DECODE_FETCH_TIMEOUT_MS) })
            .then((response) => (response.ok ? response.text() : null))
            .then((text) => text && decodeEnabled.has(kind) && plotSynopBulletin({ kind, key, topic, feature, href }, text))
            .catch((err) => console.debug(`Could not fetch ${href}: ${err.message}`));
        return;
    }
    // And text lightning reports, which are a short CSV
    if (formatOf(feature) === 'text') {
        fetch(href, { signal: AbortSignal.timeout(DECODE_FETCH_TIMEOUT_MS) })
            .then((response) => (response.ok ? response.text() : null))
            .then((text) => text && decodeEnabled.has(kind) && plotLightningText({ kind, key, topic, feature, href }, text))
            .catch((err) => console.debug(`Could not fetch ${href}: ${err.message}`));
        return;
    }
    decodeQueue.push({ kind, key, topic, feature, href });
    if (decodeQueue.length > DECODE_QUEUE_MAX) decodeQueue.shift();
    pumpDecode();
}

// Downloads take far longer than decoding (tens of ms), so several files are
// fetched at once while the decoder works through the ones already here
const DECODE_FETCHES = 4;
let decodeFetching = 0;
const decodeReady = [];  // { job, bytes } downloaded and waiting for the decoder

function pumpDecode() {
    while (decodeFetching < DECODE_FETCHES && decodeReady.length < DECODE_FETCHES && decodeQueue.length) {
        fetchForDecode(decodeQueue.pop());  // Newest first, to stay close to real time
    }
}

async function fetchForDecode(job) {
    decodeFetching++;
    try {
        // A stalled server would otherwise hold up the queue
        // Radar volumes can run to tens of MB, so they get longer
        var response = await fetch(job.href, { signal: AbortSignal.timeout(DECODE_FETCH_TIMEOUT_MS * (job.kind === 'radar' ? 4 : 1)) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        var raw = new Uint8Array(await response.arrayBuffer());
        var bytes = job.kind === 'radar' ? raw : bufrPart(raw);
        if (bytes) decodeReady.push({ job, bytes });
    } catch (err) {
        decodeSeen.delete(job.key);  // Let another cache's copy try
        console.debug(`Could not fetch ${job.href}: ${err.message}`);
    }
    decodeFetching--;
    decodeNext();
    pumpDecode();
}

async function decodeNext() {
    if (decodeBusy || !decodeReady.length) return;
    decodeBusy = true;
    var { job, bytes } = decodeReady.shift();
    try {
        if (job.kind === 'radar') {
            plotRadar(job, JSON.parse(await callDecoder('radar_scan', bytes)));
        } else {
            var subsets = JSON.parse(await callDecoder('decode_subsets', bytes, DECODE_FILE_MAX_REPORTS));
            subsets.forEach(([rows, profile], i) => plotDecodedReport(job, rows, profile, i, subsets.length));
        }
    } catch (err) {
        console.debug(`Could not decode ${job.href}: ${err.message}`);
    }
    decodeBusy = false;
    decodeNext();
    pumpDecode();
}

function plotDecodedReport(job, rows, profile, index, total) {
    var values = new Map();
    for (var [id, name, value] of rows) {
        if (!values.has(id)) values.set(id, value);
    }
    var lat = [5001, 5002].map((id) => values.get(id)).find((v) => typeof v === 'number');
    var lon = [6001, 6002].map((id) => values.get(id)).find((v) => typeof v === 'number');
    if (lat === undefined || lon === undefined || Math.abs(lat) > 90 || Math.abs(lon) > 180) return;

    var props = job.feature.properties || {};
    var [channel, t] = job.topic.split('/a/wis2/');
    // GTS reports join GTS-to-WIS2's groups and decoded cache files join Cache's
    // The bulletin header says what it holds for aircraft (IUA) and satellites (IN, IE)
    var cls = GATEWAY_AIRCRAFT.test(job.topic) ? 'aircraft' : GATEWAY_SATELLITE.test(job.topic) ? 'satellite' : reportClass(values, profile);
    // Upper-air bulletins (IU…: TEMP, PILOT, wind profiler) carry station numbers, but aren't weather stations
    if (cls === 'station' && GATEWAY_UPPER_AIR.test(job.topic)) cls = 'upperair';
    // WIS2 topics say what they hold (…/moored-buoys-and-moorings), which beats guessing from
    // the identifiers: buoys and ships with WIGOS ids would otherwise read as weather stations
    if (!GATEWAY_TOPIC.test(job.topic)) {
        var fromTopic = topicClass({ topic: job.topic, webcam: false, props });
        // Lightning is cache-only too, but does come as BUFR
        if (fromTopic !== 'other' && (fromTopic === 'lightning' || !OBS_CLASSES[fromTopic].cacheOnly)) cls = fromTopic;
    }
    var subLayer = job.kind === 'gts' || job.kind === 'gts-satellite' ? `gts-${cls}` : job.kind === 'files' || job.kind === 'cache-satellite' ? `cache-${cls}` : null;
    if (cls === 'lightning' && seenFlash(flashTime(values), lat, lon)) return;
    if (subLayer && subLayer.endsWith('-satellite') && effectiveHidden().includes(subLayer)) return;
    var record = {
        id: nextId++,
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
        decoded: { subsets: 1, index: 0, rows: subLayer && subLayer.endsWith('-satellite') ? trimRows(rows) : rows, profile: profile },
        alt: aircraftAltitude(values, t),
        born: Date.now(),
    };
    if (subLayer && subLayer.endsWith('-satellite')) {
        record.fileKey = props.data_id;  // Reports from one file make one swath
        // A file big enough for coverage is drawn as coverage from the start, so its points never flash up
        if (total >= SWATH_MIN_REPORTS) record.inSwath = true;
        swathsDirty = true;
    }
    addPoint(record);
    if (record.track) tracksDirty = true;
    decodePlotted[job.kind]++;
    // The first report with a location stands for the file; report 0 may have none
    if (!job.linked) {
        job.linked = true;
        linkDecoded(job.key, record);
    }
}

// The first SATELLITE_ROWS_MAX values, plus the first of any value a measure colours by
function trimRows(rows) {
    if (rows.length <= SATELLITE_ROWS_MAX) return rows;
    var wanted = new Set(Object.values(METRICS).flatMap((m) => m.ids || []));
    var kept = rows.slice(0, SATELLITE_ROWS_MAX);
    kept.forEach((r) => wanted.delete(r[0]));
    for (var i = SATELLITE_ROWS_MAX; i < rows.length && wanted.size; i++) {
        if (wanted.delete(rows[i][0])) kept.push(rows[i]);
    }
    return kept;
}

// ---------- Weather radar. Each radar's latest lowest scan is drawn as an image
// around it, reprojected from range and azimuth onto the map's Mercator grid.
const RADAR_MAX = 100;  // Radars drawn at once
const RADAR_STALE_MS = 30 * 60 * 1000;  // A radar with nothing newer is taken off
const RADAR_IMAGE_PX = 600;
let radarIds = 0;
let radarLookup = null;

// RGBA for each byte the decoder sends: (dBZ + 32) * 2, 0 for no echo
function radarColours() {
    if (radarLookup) return radarLookup;
    radarLookup = new Uint8ClampedArray(256 * 4);
    for (var v = 1; v < 255; v++) {
        var dbz = v / 2 - 32, step = RADAR_COLORS.filter(([t]) => dbz >= t).pop();
        if (!step) continue;
        var hex = step[1];
        radarLookup.set([parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16), 255], v * 4);
    }
    return radarLookup;
}

function renderRadar(scan) {
    var bytes = Uint8Array.from(atob(scan.data), (c) => c.charCodeAt(0));
    var R = 6371008.8, rad = Math.PI / 180;
    var start = scan.rstart * 1000, range = start + scan.nbins * scan.rscale;
    var dLat = range / R / rad, dLon = dLat / Math.cos(scan.lat * rad);
    var north = scan.lat + dLat, south = scan.lat - dLat, west = scan.lon - dLon, east = scan.lon + dLon;
    var merc = (lat) => Math.log(Math.tan(Math.PI / 4 + lat * rad / 2));
    var yN = merc(north), yS = merc(south), size = RADAR_IMAGE_PX;
    var canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    var ctx = canvas.getContext('2d'), image = ctx.createImageData(size, size), lut = radarColours();
    for (var py = 0; py < size; py++) {
        // Rows are evenly spaced in Mercator y, as the map draws the image
        var lat = (2 * Math.atan(Math.exp(yN + (py + 0.5) / size * (yS - yN))) - Math.PI / 2) / rad;
        var dy = (lat - scan.lat) * rad * R, kx = rad * R * Math.cos(lat * rad);
        for (var px = 0; px < size; px++) {
            var dx = (west + (px + 0.5) / size * (east - west) - scan.lon) * kx;
            var bin = Math.floor((Math.hypot(dx, dy) - start) / scan.rscale);
            if (bin < 0 || bin >= scan.nbins) continue;
            // Rays run clockwise from north
            var ray = Math.floor(((Math.atan2(dx, dy) / rad + 360) % 360) / 360 * scan.nrays) % scan.nrays;
            var v = bytes[ray * scan.nbins + bin];
            if (v && lut[v * 4 + 3]) image.data.set(lut.subarray(v * 4, v * 4 + 4), (py * size + px) * 4);
        }
    }
    ctx.putImageData(image, 0, 0);
    return { url: canvas.toDataURL('image/png'), coordinates: [[west, north], [east, north], [east, south], [west, south]] };
}

// A large volume from a radar fetched less than RADAR_LARGE_EVERY_MS ago is skipped.
// The radar is the data_id with its timestamp taken out (LONGRANGE_LCA_20261019180257_00.h5)
function radarThrottled(feature) {
    var link = (feature.links || []).find((l) => isDataLink(l));
    if (!link || !(link.length > RADAR_LARGE_BYTES)) return false;
    var radar = String((feature.properties || {}).data_id).replace(/\d{8}T?\d{4,6}/g, '');
    if (Date.now() - (radarLargeFetched.get(radar) || 0) < RADAR_LARGE_EVERY_MS) return true;
    radarLargeFetched.set(radar, Date.now());
    if (radarLargeFetched.size > RADAR_MAX) radarLargeFetched.delete(radarLargeFetched.keys().next().value);
    return false;
}

// RMI sends reflectivity and velocity under different headings (PAGW, PAGY, PAHZ):
// a heading whose file held no reflectivity isn't downloaded again
const radarNoReflectivity = new Set();

function radarHeading(feature) {
    var gts = (feature.properties || {}).gts;
    return gts && gts.ttaaii ? `${gts.ttaaii} ${gts.cccc}` : null;
}

function plotRadar(job, scan) {
    if (!scan) {
        var heading = radarHeading(job.feature);
        if (heading && radarNoReflectivity.size < 1000) radarNoReflectivity.add(heading);
        return;
    }
    if (!map.getLayer('points') || !decodeEnabled.has('radar')) return;
    var src = scan.source || {};
    var site = src.NOD || src.RAD || src.WMO || `${scan.lat},${scan.lon}`;
    var d = String(scan.date || ''), t = String(scan.time || '').padStart(6, '0');
    var time = Date.parse(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}Z`) || Date.now();
    var existing = radars.get(site);
    // Filtered reflectivity (DBZH) beats unfiltered (TH) from the same radar, unless it has gone stale
    if (existing && (time < existing.time
        || (scan.quantity !== 'DBZH' && existing.quantity === 'DBZH' && time - existing.time < RADAR_STALE_MS))) return;
    var { url, coordinates } = renderRadar(scan);
    var id = existing ? existing.id : `radar-${radarIds++}`;
    if (existing) {
        map.getSource(id).updateImage({ url, coordinates });
    } else {
        map.addSource(id, { type: 'image', url, coordinates });
        // Under the coverage, tracks and points
        var before = ['swaths-fill', 'tracks', 'points'].find((l) => map.getLayer(l));
        map.addLayer({ id, type: 'raster', source: id, paint: { 'raster-opacity': 0.75, 'raster-fade-duration': 0 },
            layout: { visibility: effectiveHidden().includes('radar') ? 'none' : 'visible' } }, before);
    }
    radars.delete(site);  // Re-insert so the least recently updated is first
    radars.set(site, { id, time, quantity: scan.quantity, updated: Date.now() });
    if (radars.size > RADAR_MAX) removeRadar(radars.keys().next().value);
    decodePlotted.radar++;
    updateMapKey();
}

function removeRadar(site) {
    var r = radars.get(site);
    radars.delete(site);
    if (map.getLayer(r.id)) map.removeLayer(r.id);
    if (map.getSource(r.id)) map.removeSource(r.id);
}

setInterval(() => {
    for (var [site, r] of [...radars]) {
        if (Date.now() - r.updated > RADAR_STALE_MS) removeRadar(site);
    }
    updateMapKey();
}, 60 * 1000);

// ---------- Text SYNOPs from the GTS: FM 12 (land stations, AAXX) and FM 13 (ships,
// BBXX) in traditional alphanumeric code, under S/M (main hours), S/N (other hours)
// and S/I (intermediate hours). Ships carry their position. A land station's comes
// from the same station already plotted from BUFR (WIS2 or GTS); until it has been,
// its latest report waits.
const SYNOP_TOPIC = /\/a\/wis2\/[^/]+-gts-to-wis2\/data\/core\/S\/[MNI]\//;
const SYNOP_WAITING_MAX = 5000;
const STATION_COORDS_MAX = 50000;
const stationCoords = new Map();  // WIGOS id -> [lon, lat], from every station plotted
const synopWaiting = new Map();  // WIGOS id -> { job, report } for stations not yet seen

// Present weather, code table 4677 (manned stations)
function presentWeather(ww) {
    var named = { 4: 'Smoke', 5: 'Haze', 6: 'Dust', 7: 'Blowing dust or sand', 8: 'Dust whirls', 9: 'Duststorm', 10: 'Mist',
        11: 'Shallow fog', 12: 'Shallow fog', 13: 'Lightning', 17: 'Thunder', 18: 'Squalls', 19: 'Funnel cloud',
        20: 'Recent drizzle', 21: 'Recent rain', 22: 'Recent snow', 23: 'Recent rain and snow', 24: 'Recent freezing rain',
        25: 'Recent rain showers', 26: 'Recent snow showers', 27: 'Recent hail', 28: 'Recent fog', 29: 'Recent thunderstorm',
        40: 'Fog at a distance', 41: 'Fog patches', 48: 'Freezing fog', 49: 'Freezing fog',
        56: 'Light freezing drizzle', 57: 'Freezing drizzle', 58: 'Light drizzle and rain', 59: 'Drizzle and rain',
        66: 'Light freezing rain', 67: 'Freezing rain', 68: 'Light rain and snow', 69: 'Rain and snow',
        76: 'Diamond dust', 77: 'Snow grains', 78: 'Snow crystals', 79: 'Ice pellets',
        80: 'Light rain showers', 81: 'Rain showers', 82: 'Violent rain showers', 83: 'Rain and snow showers', 84: 'Rain and snow showers',
        85: 'Light snow showers', 86: 'Snow showers', 87: 'Snow pellet showers', 88: 'Snow pellet showers', 89: 'Hail showers', 90: 'Hail showers',
        91: 'Light rain, thunder earlier', 92: 'Rain, thunder earlier', 93: 'Snow or hail, thunder earlier', 94: 'Snow or hail, thunder earlier',
        95: 'Thunderstorm', 96: 'Thunderstorm with hail', 97: 'Heavy thunderstorm', 98: 'Thunderstorm with dust or sand', 99: 'Heavy thunderstorm with hail' };
    if (named[ww]) return named[ww];
    var graded = (light, moderate, heavy) => [light, light, moderate, moderate, heavy, heavy][ww % 10];
    if (ww >= 14 && ww <= 16) return 'Precipitation in sight';
    if (ww >= 30 && ww <= 35) return 'Dust or sandstorm';
    if (ww >= 36 && ww <= 39) return 'Blowing snow';
    if (ww >= 42 && ww <= 47) return 'Fog';
    if (ww >= 50 && ww <= 55) return graded('Light drizzle', 'Drizzle', 'Heavy drizzle');
    if (ww >= 60 && ww <= 65) return graded('Light rain', 'Rain', 'Heavy rain');
    if (ww >= 70 && ww <= 75) return graded('Light snow', 'Snow', 'Heavy snow');
    return null;  // 00-03 describe how the clouds are changing
}

// Visibility (VV, code table 4377) in metres
function synopVisibility(vv) {
    if (vv <= 50) return vv * 100;
    if (vv >= 56 && vv <= 80) return (vv - 50) * 1000;
    if (vv >= 81 && vv <= 89) return (vv - 80) * 5000 + 30000;
    return { 90: 0, 91: 50, 92: 200, 93: 500, 94: 1000, 95: 2000, 96: 4000, 97: 10000, 98: 20000, 99: 50000 }[vv] ?? null;
}

// Pressure in tenths of hPa with the thousands left off (0123 is 1012.3 hPa), in Pa
function synopPressure(g) {
    if (!/^\d{4}$/.test(g)) return null;
    var hpa = Number(g) / 10;
    return (hpa < 100 ? hpa + 1000 : hpa) * 100;
}

// Section 1 (and the parts of 2 and 3 worth showing) as BUFR-style rows, so the
// popup, wind arrows and colouring treat them like decoded BUFR
function synopRows(groups, windUnit) {
    var rows = [], knots = windUnit === '3' || windUnit === '4';
    var digits = (s) => (/^\d+$/.test(s) ? Number(s) : null);
    var temperature = (g) => (/^[01]\d{3}$/.test(g) ? (g[0] === '1' ? -1 : 1) * Number(g.slice(1)) / 10 + 273.15 : null);
    var [ixhvv, nddff] = groups;
    if (!ixhvv || !nddff || ixhvv.length !== 5 || nddff.length !== 5) return null;
    var manned = /[123]/.test(ixhvv[1]);
    var vv = digits(ixhvv.slice(3));
    if (vv !== null && synopVisibility(vv) !== null) rows.push([20001, 'Horizontal visibility', synopVisibility(vv), 'm']);
    var n = digits(nddff[0]), dd = digits(nddff.slice(1, 3)), ff = digits(nddff.slice(3));
    if (n !== null && n <= 8) rows.push([20010, 'Cloud cover (total)', n * 12.5, '%']);
    var i = 2;
    if (ff === 99 && /^00\d{3}$/.test(groups[2] || '')) ff = Number(groups[i++].slice(2));
    if (ff !== null) {
        var speed = knots ? ff * 0.514444 : ff;
        if (dd !== null && dd <= 36) rows.push([11001, 'Wind direction', dd * 10, 'deg']);
        rows.push([11002, 'Wind speed', speed, 'm/s']);
    }
    var section = 1;
    for (; i < groups.length; i++) {
        var g = groups[i];
        if (/^(222|333|444|555)/.test(g)) { section = Number(g[0]); continue; }
        if (g.length !== 5) continue;
        if (section === 1) {
            if (g[0] === '1' && temperature(g.slice(1)) !== null) rows.push([12101, 'Temperature', temperature(g.slice(1)), 'K']);
            else if (g[0] === '2' && g[1] === '9' && digits(g.slice(2)) !== null) rows.push([13003, 'Relative humidity', Number(g.slice(2)), '%']);
            else if (g[0] === '2' && temperature(g.slice(1)) !== null) rows.push([12103, 'Dew-point temperature', temperature(g.slice(1)), 'K']);
            else if (g[0] === '3' && synopPressure(g.slice(1)) !== null) rows.push([10004, 'Station pressure', synopPressure(g.slice(1)), 'Pa']);
            // 4PPPP; 4a3hhh (a standard level's height, from high stations) starts 41, 42, 45, 47 or 48
            else if (g[0] === '4' && /[09]/.test(g[1]) && synopPressure(g.slice(1)) !== null) rows.push([10051, 'Pressure reduced to mean sea level', synopPressure(g.slice(1)), 'Pa']);
            else if (g[0] === '5' && /^[0-8]\d{3}$/.test(g.slice(1))) {
                var change = Number(g.slice(2)) * 10 * (g[1] >= '5' ? -1 : g[1] === '4' ? 0 : 1);
                rows.push([10061, '3-hour pressure change', change, 'Pa']);
            } else if (g[0] === '6' && /^\d{4}$/.test(g.slice(1))) {
                var rrr = Number(g.slice(1, 4)), hours = { 1: 6, 2: 12, 3: 18, 4: 24, 5: 1, 6: 2, 7: 3, 8: 9, 9: 15 }[g[4]];
                var mm = rrr < 990 ? rrr : (rrr - 990) / 10;  // 990 is a trace, 991-999 tenths of a mm
                var id = { 1: 13019, 6: 13021, 24: 13023 }[hours];
                if (hours) rows.push([4024, 'Time period', -hours, 'h'], [13011, 'Total precipitation', mm, 'kg m-2']);
                if (id) rows.push([id, `Precipitation, past ${hours} h`, mm, 'kg m-2']);
            } else if (g[0] === '7' && manned && digits(g.slice(1, 3)) !== null && presentWeather(Number(g.slice(1, 3)))) {
                rows.push([20003, 'Present weather', presentWeather(Number(g.slice(1, 3))), '']);
            }
        } else if (section === 2 && g[0] === '0' && temperature(g.slice(1)) !== null) {
            rows.push([22043, 'Sea surface temperature', temperature(g.slice(1)), 'K']);
        } else if (section === 3) {
            if (g[0] === '1' && temperature(g.slice(1)) !== null) rows.push([12111, 'Maximum temperature', temperature(g.slice(1)), 'K']);
            else if (g[0] === '2' && temperature(g.slice(1)) !== null) rows.push([12112, 'Minimum temperature', temperature(g.slice(1)), 'K']);
            else if (/^91[01]\d\d$/.test(g)) rows.push([11041, 'Maximum wind gust speed', Number(g.slice(3)) * (knots ? 0.514444 : 1), 'm/s']);
        }
    }
    return rows;
}

// YYGGiw: day and hour, in the month of the notification (or the one before, just after midnight on the 1st)
function synopTime(yygg, pubtime) {
    var pub = new Date(Date.parse(pubtime) || Date.now());
    var day = Number(yygg.slice(0, 2)), hour = Number(yygg.slice(2, 4));
    if (!(day >= 1 && day <= 31 && hour <= 23)) return null;
    var month = pub.getUTCMonth() - (day > pub.getUTCDate() + 1 ? 1 : 0);
    return Date.UTC(pub.getUTCFullYear(), month, day, hour);
}

function parseSynopBulletin(text, pubtime) {
    var lines = text.replace(/\r/g, '').split('\n');
    // Skip the abbreviated heading (TTAAii CCCC YYGGgg [BBB])
    var heading = lines.findIndex((l) => /^[A-Z]{4}\d{2} [A-Z]{4} \d{6}/.test(l.trim()));
    var reports = [], kind = null, header = null;
    for (var chunk of lines.slice(heading + 1).join(' ').split('=')) {
        var groups = chunk.trim().split(/\s+/).filter(Boolean);
        if (groups[0] === 'AAXX') { kind = 'land'; header = groups[1] || ''; groups = groups.slice(2); }
        else if (groups[0] === 'BBXX') { kind = 'ship'; groups = groups.slice(1); }
        if (!kind || groups.length < 3 || groups.includes('NIL')) continue;
        if (kind === 'land') {
            if (!/^\d{5}$/.test(groups[0])) continue;
            var time = synopTime(header, pubtime), rows = synopRows(groups.slice(1), header[4]);
            if (time && rows && rows.length) reports.push({ kind, wsi: `0-20000-0-${groups[0]}`, station: groups[0], time, rows, text: `AAXX ${header}\n${groups.join(' ')}=` });
        } else {
            // D....D YYGGiw 99LaLaLa QcLoLoLoLo: Qc 1 north-east, 3 south-east, 5 south-west, 7 north-west
            var [callSign, yyggi, la, lo] = groups;
            if (!/^99\d{3}$/.test(la || '') || !/^[1357]\d{4}$/.test(lo || '')) continue;
            var lat = Number(la.slice(2)) / 10 * (/[35]/.test(lo[0]) ? -1 : 1);
            var lon = Number(lo.slice(1)) / 10 * (/[57]/.test(lo[0]) ? -1 : 1);
            var shipTime = synopTime(yyggi, pubtime), shipRows = synopRows(groups.slice(4), yyggi[4]);
            if (shipTime && shipRows && lon <= 180) reports.push({ kind, callSign, coords: [lon, lat], time: shipTime, rows: shipRows, text: `BBXX\n${groups.join(' ')}=` });
        }
    }
    return reports;
}

function plotSynopBulletin(job, text) {
    var pubtime = (job.feature.properties || {}).pubtime;
    for (var report of parseSynopBulletin(text, pubtime)) {
        if (report.kind === 'ship') plotSynop(job, report, report.coords);
        else if (stationCoords.has(report.wsi)) plotSynop(job, report, stationCoords.get(report.wsi));
        else {
            synopWaiting.delete(report.wsi);  // The latest report stands in for the station
            synopWaiting.set(report.wsi, { job, report });
            if (synopWaiting.size > SYNOP_WAITING_MAX) synopWaiting.delete(synopWaiting.keys().next().value);
        }
    }
}

function plotSynop(job, report, coords) {
    var wsi = report.kind === 'land' ? report.wsi : null;
    // Skip a station already on the map with a report as recent (usually its BUFR copy)
    var latest = wsi && latestByStation.get(wsi);
    if (latest && records.has(latest.id) && observedAt(latest) >= report.time) return;
    var [channel, t] = job.topic.split('/a/wis2/');
    var cls = report.kind === 'land' ? 'station' : 'ship';
    var date = new Date(report.time);
    var rows = [
        ...(report.kind === 'land'
            ? [[1001, 'WMO block number', Number(report.station.slice(0, 2)), 'Numeric'], [1002, 'WMO station number', Number(report.station.slice(2)), 'Numeric']]
            : [[1011, 'Ship or mobile land station identifier', report.callSign, 'CCITT IA5']]),
        [4001, 'Year', date.getUTCFullYear(), 'a'], [4002, 'Month', date.getUTCMonth() + 1, 'mon'], [4003, 'Day', date.getUTCDate(), 'd'],
        [4004, 'Hour', date.getUTCHours(), 'h'], [4005, 'Minute', 0, 'min'],
        [5001, 'Latitude', coords[1], 'deg'], [6001, 'Longitude', coords[0], 'deg'],
        ...report.rows,
    ];
    var record = addPoint({
        id: nextId++,
        coords: coords,
        topic: job.topic,
        channel: channel,
        centre: t.split('/', 1)[0],
        path: t.slice(t.indexOf('/') + 1),
        discipline: disciplineOf(t),
        webcam: false,
        decodedLayer: job.kind,
        subLayer: `gts-${cls}`,
        synop: true,
        observed: report.time,
        props: { data_id: `synop:${wsi || report.callSign}:${report.time}`, pubtime: (job.feature.properties || {}).pubtime, datetime: date.toISOString() },
        links: job.feature.links || [],
        notification: job.feature,
        wsi: wsi,
        format: 'text',
        color: OBS_CLASSES[cls].color,
        source: null,
        // The report as sent, shown under the decoded values
        decoded: { subsets: 1, index: 0, rows: rows, profile: null, tac: report.text },
        born: Date.now(),
    });
    decodePlotted[job.kind]++;
    if (!job.linked) {
        job.linked = true;
        linkDecoded(job.key, record);
    }
}

// Every station plotted gives its position to text SYNOPs from it, including any waiting
function rememberStation(record) {
    if (!record.wsi || record.synop || !record.coords) return;
    stationCoords.delete(record.wsi);
    stationCoords.set(record.wsi, record.coords);
    if (stationCoords.size > STATION_COORDS_MAX) stationCoords.delete(stationCoords.keys().next().value);
    var waiting = synopWaiting.get(record.wsi);
    if (!waiting) return;
    synopWaiting.delete(record.wsi);
    // Not while the station's own point is still being added
    setTimeout(() => decodeEnabled.has(waiting.job.kind) && plotSynop(waiting.job, waiting.report, record.coords));
}

// ---------- Lightning. The Met Office sends each batch of flashes as BUFR (one
// subset per flash: its position, then the sensors that located it) and as a
// CSV; both are plotted, so a flash seen in one is skipped in the other.
const FLASHES_MAX = 5000;
const flashesSeen = new Set();

function seenFlash(time, lat, lon) {
    var key = `${Math.round(time / 100)}:${lat.toFixed(2)},${lon.toFixed(2)}`;
    if (flashesSeen.has(key)) return true;
    flashesSeen.add(key);
    if (flashesSeen.size > FLASHES_MAX) flashesSeen.delete(flashesSeen.values().next().value);
    return false;
}

// Time of a BUFR flash to the millisecond (seconds are 004006)
function flashTime(values) {
    var [y, mo, d, h, mi, sec] = [4001, 4002, 4003, 4004, 4005, 4006].map((id) => values.get(id));
    return Date.UTC(y, mo - 1, d, h, mi || 0) + Math.round((sec || 0) * 1000);
}

// date,time,microseconds,FLP ID,quality,latitude,longitude,error
// 19/10/2026,04:20:48,286057,1,G,50.206,-1.228,10.62
function plotLightningText(job, text) {
    var props = job.feature.properties || {};
    var [channel, t] = job.topic.split('/a/wis2/');
    var line = /^(\d{2})\/(\d{2})\/(\d{4}),(\d{2}):(\d{2}):(\d{2}),(\d+),[^,]*,([^,]*),(-?[\d.]+),(-?[\d.]+)/;
    var first = null;
    text.split('\n').forEach((row, i) => {
        var m = line.exec(row.trim());
        if (!m) return;
        var [, d, mo, y, h, mi, sec, micro, quality] = m;
        var lat = Number(m[9]), lon = Number(m[10]);
        if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
        var time = Date.UTC(y, mo - 1, d, h, mi, sec) + Math.round(Number(micro) / 1000);
        if (seenFlash(time, lat, lon)) return;
        var rows = [
            [4001, 'Year', Number(y), 'a'], [4002, 'Month', Number(mo), 'mon'], [4003, 'Day', Number(d), 'd'],
            [4004, 'Hour', Number(h), 'h'], [4005, 'Minute', Number(mi), 'min'], [4006, 'Second', Number(sec) + Number(micro) / 1e6, 's'],
            [5001, 'Latitude', lat, 'deg'], [6001, 'Longitude', lon, 'deg'],
            [0, 'Quality', quality, ''],  // The CSV's error column has no stated unit, so it's left out
        ];
        var record = addPoint({
            id: nextId++,
            coords: [lon, lat],
            topic: job.topic,
            channel: channel,
            centre: t.split('/', 1)[0],
            path: t.slice(t.indexOf('/') + 1),
            discipline: disciplineOf(t),
            webcam: false,
            decodedLayer: job.kind,
            subLayer: 'cache-lightning',
            observed: time,
            props: { data_id: `${props.data_id}#${i}`, pubtime: props.pubtime, datetime: new Date(time).toISOString() },
            links: job.feature.links || [],
            notification: job.feature,
            wsi: null,
            format: 'text',
            color: OBS_CLASSES.lightning.color,
            source: null,
            decoded: { subsets: 1, index: 0, rows: rows, profile: null },
            born: Date.now(),
        });
        decodePlotted[job.kind]++;
        if (!first) linkDecoded(job.key, first = record);
    });
}

// Citypage forecasts come in English and French for each site and are reissued
// through the day: keep one point per site, the latest, preferring English
function plotCitypage(job, xml) {
    var doc = new DOMParser().parseFromString(xml, 'application/xml');
    var site = doc.querySelector('siteData > location > name');
    if (!site) return;
    var coord = (v) => {
        var m = /^([\d.]+)([NSEW])$/.exec((v || '').trim());
        return m ? Number(m[1]) * (/[SW]/.test(m[2]) ? -1 : 1) : NaN;
    };
    var lat = coord(site.getAttribute('lat')), lon = coord(site.getAttribute('lon'));
    if (!isFinite(lat) || !isFinite(lon)) return;

    var french = /_fr\.xml$/i.test(job.href);
    var key = `citypage:${site.getAttribute('code') || site.textContent.trim()}`;
    var existing = byDataId.get(key);
    if (existing && records.has(existing.id)) {
        if (french && !existing.french) return;
        removePoint(existing);
    }
    var props = job.feature.properties || {};
    var [channel, t] = job.topic.split('/a/wis2/');
    var record = addPoint({
        id: nextId++,
        coords: [lon, lat],
        topic: job.topic,
        channel: channel,
        centre: t.split('/', 1)[0],
        path: t.slice(t.indexOf('/') + 1),
        discipline: disciplineOf(t),
        webcam: false,
        decodedLayer: job.kind,
        subLayer: 'cache-warning',  // Forecasts carry the warnings in effect for the site
        props: { data_id: key, pubtime: props.pubtime, metadata_id: site.textContent.trim() },
        links: job.feature.links || [],
        notification: job.feature,
        wsi: null,
        french: french,
        format: 'xml',
        color: OBS_CLASSES.warning.color,
        source: null,
        decoded: { xml: xml },
        born: Date.now(),
    });
    decodePlotted[job.kind]++;
    linkDecoded(job.key, record);
}

// ---------- Colouring stations, ships and buoys by a measured value. Values come from
// decoded data: GTS and decoded-file reports have it already; cache stations
// are downloaded and decoded in the background while a measure is selected.
// Precipitation totals (013011) by the window before them (004024, hours ago)
function precipitationTotals(rows) {
    var totals = new Map(), period = null;
    for (var [id, , value] of rows) {
        if (id === 4024 && typeof value === 'number') period = -value;
        else if (id === 13011 && typeof value === 'number' && period > 0 && !totals.has(period)) totals.set(period, value);
    }
    return totals;
}

// Scale ends with at most one decimal (e.g. 28.3 m/s, not 28.29)
function scaleLabel(v) {
    return Number(v.toFixed(1));
}

function formatMetric(value, m) {
    var digits = m.unit === '%' ? 0 : 1;
    return `${value.toFixed(digits)} ${m.unit}`;
}

// Feature properties ("m_temp", ...) for the measures a record's decoded data holds
function metricValues(record) {
    var rows = record.decoded && record.decoded.rows;
    if (!rows) return {};
    var out = {};
    var totals = precipitationTotals(rows);
    for (var [key, m] of Object.entries(METRICS)) {
        var row = m.ids.map((id) => rows.find((r) => r[0] === id && typeof r[2] === 'number')).find(Boolean);
        var value = m.period && totals.has(m.period) ? totals.get(m.period) : row ? row[2] : undefined;
        // Negative precipitation codes trace amounts
        if (m.period && value < 0) value = 0;
        if (value !== undefined) out[`m_${key}`] = m.convert ? m.convert(value) : value;
    }
    // Not a measure of its own: turns points into arrows while wind speed is the colour
    var direction = rows.find((r) => r[0] === 11001 && typeof r[2] === 'number');
    if (direction) out.m_windDir = direction[2];
    return out;
}

function setColourBy(key, legend) {
    colourBy = key;
    var m = METRICS[key];
    var color = ['get', 'color'];
    var swathColor = color;
    var originRing = ['get', 'color'];
    if (m) {
        var value = ['get', `m_${key}`];
        var target = isColourTarget();
        var scaled = ['interpolate', ['linear'], value, ...m.stops.flat()];
        // Everything the measure doesn't colour is grey, so no kind's colour reads as a
        // value on the scale; aircraft keep theirs under surface measures (never coloured)
        var kept = m.targets === 'satellite' ? false : IS_AIRCRAFT;
        color = ['case',
            ['all', target, ['has', `m_${key}`]], scaled,
            kept, ['get', 'color'],
            NO_VALUE_COLOR];
        swathColor = ['case', ['all', target, ['has', `m_${key}`]], scaled, ['get', 'color']];
        originRing = ['case', kept, ['get', 'color'], NO_VALUE_COLOR];
        // Outlines follow the same scale, darkened
        var outline = ['case',
            ['all', target, ['has', `m_${key}`]], ['interpolate', ['linear'], value, ...m.stops.flatMap(([v, c]) => [v, darken(c)])],
            kept, ['get', 'outline'],
            darken(NO_VALUE_COLOR)];
    }
    // Calm reports under a wind measure are empty: an outline with no fill
    var pointColor = windArrows()
        ? ['case', ['all', target, ['==', ['to-number', ['get', `m_${key}`], -1], 0]], 'rgba(0, 0, 0, 0)', color]
        : color;
    map.setPaintProperty('points', 'circle-color', pointColor);
    map.setPaintProperty('points-gts', 'icon-halo-color', m ? outline : ['get', 'outline']);
    map.setPaintProperty('points', 'circle-stroke-color', ['case', ['get', 'origin'], originRing, m ? outline : ['get', 'outline']]);
    map.setPaintProperty('points-gts', 'icon-color', pointColor);
    map.setPaintProperty('points-ext', 'icon-color', pointColor);
    map.setPaintProperty('points-ext', 'icon-halo-color', m ? outline : ['get', 'outline']);
    map.setPaintProperty('points-arrow', 'icon-color', color);
    if (windArrows()) {
        // Longer arrows for stronger winds, which also win where arrows would overlap
        var speed = ['to-number', ['get', `m_${key}`], 0];
        var length = ['interpolate', ['linear'], speed, 0, 0.55, 5, 0.8, 15, 1.15, 25, 1.4];
        map.setLayoutProperty('points-arrow', 'icon-size', ['interpolate', ['linear'], ['zoom'],
            1, ['*', 0.6, length], 6, ['*', 0.9, length], 10, ['*', 1.2, length]]);
        map.setLayoutProperty('points-arrow', 'symbol-sort-key', ['-', 0, speed]);
    }
    map.setPaintProperty('swaths-fill', 'fill-color', swathColor);
    paintAge();
    var scale = legend.querySelector('.legend-scale');
    if (scale) scale.hidden = !m;
    var colouredOnlyRow = legend.querySelector('.legend-coloured-only');
    if (colouredOnlyRow) colouredOnlyRow.hidden = !m;
    updateModelField(legend);
    applyMapFilter();
    if (m) {
        if (scale && scale.children.length === 3) {
            var [lo, bar, hi] = scale.children;
            lo.textContent = `${scaleLabel(m.stops[0][0])}`;
            hi.textContent = `${scaleLabel(m.stops[m.stops.length - 1][0])} ${m.unit}`;
            bar.style.background = `linear-gradient(90deg, ${m.stops.map(([v, c]) => c).join(', ')})`;
        }
        if (m.targets === 'satellite') metricQueue = [];
        else queueStationDecodes();
    } else {
        metricQueue = [];
    }
    showColourStatus(legend);
}

function showColourStatus(legend) {
    var el = legend.querySelector('.legend-colour-status');
    if (colourBy === 'kind') { el.hidden = true; return; }
    var targets = colourTargets(METRICS[colourBy]);
    var points = [...records.values()].filter((r) => targets.includes(layerOf(r)));
    var known = points.filter((r) => r.feature && r.feature.properties[`m_${colourBy}`] !== undefined).length;
    el.hidden = false;
    el.textContent = `${known.toLocaleString()} of ${points.length.toLocaleString()} have a value` + (metricQueue.length ? ` · decoding ${metricQueue.length}` : '');
}

// Cache stations, ships and buoys without decoded data, newest first
function queueStationDecodes() {
    metricQueue = [...pools.wis2.values()]
        .filter((r) => !r.decoded && r.source && !r.metricTried && COLOURABLE.includes(layerOf(r)))
        .slice(-METRIC_QUEUE_MAX);
    pumpStationDecodes();
}

function queueStationDecode(record) {
    if (colourBy === 'kind' || record.decoded || !record.source || !COLOURABLE.includes(layerOf(record))) return;
    metricQueue.push(record);
    if (metricQueue.length > METRIC_QUEUE_MAX) metricQueue.shift();
    pumpStationDecodes();
}

async function pumpStationDecodes() {
    if (metricBusy || !metricQueue.length || colourBy === 'kind') return;
    metricBusy = true;
    var record = metricQueue.pop();
    record.metricTried = true;
    try {
        if (records.has(record.id) && !record.decoded) {
            var data = await fetchData(record.source);
            if (data.bufr) {
                var key = record.source.dataId || data.url;
                var result = JSON.parse(await callDecoder('decode_bufr', data.bytes, record.wsi || '', key));
                result.key = key;
                record.decoded = result;
                setFeatureProperties(record, metricValues(record));
            }
        }
    } catch (err) {
        console.debug(`Could not decode station ${record.wsi}: ${err.message}`);
    }
    metricBusy = false;
    pumpStationDecodes();
}

// Adds properties to a point already on the map (or still waiting to be drawn)
function setFeatureProperties(record, props) {
    if (!record.feature || !Object.keys(props).length) return;
    Object.assign(record.feature.properties, props);
    if (!toAdd.includes(record.feature)) {
        toUpdate.push({ id: record.id, addOrUpdateProperties: Object.entries(props).map(([key, value]) => ({ key, value })) });
    }
}

// ---------- One layer row per satellite, added under Space-based (satellites) as
// each satellite is first seen. The name comes from the satellite identifier
// (001007) when the report is decoded, otherwise from the topic
// (.../space-based-observations/noaa-20/...), so both give the same row.
function satelliteKey(record) {
    if (!/-satellite$/.test(layerOf(record))) return null;
    var name = satelliteName(record);
    return name ? `sat:satellite:${name.toLowerCase()}` : null;
}

// A WIS2 topic names its satellite (sentinel-6b, geo-kompsat-2a), which beats a
// number missing from SATELLITE_NAMES; GTS bulletins only have the number
function satelliteName(record) {
    var row = record.decoded && record.decoded.rows && record.decoded.rows.find((x) => x[0] === 1007);
    if (row && SATELLITE_NAMES[row[2]]) return SATELLITE_NAMES[row[2]];
    var match = /space-based-observations\/([^/]+)/.exec(record.topic);
    if (match) return match[1].toUpperCase();
    return row ? `Satellite ${row[2]}` : null;
}

function addSatelliteRow(key) {
    if (seenLayers.has(key)) return;
    var [, parent] = key.split(':');
    var parentRow = document.querySelector(`.legend-toggle[data-layer="${parent}"]`);
    if (!parentRow) return;
    seenLayers.add(key);
    LAYER_PARENTS[key] = parent;
    var name = key.split(':').slice(2).join(':');
    var row = document.createElement('label');
    row.className = 'legend-toggle legend-sub legend-depth-2 legend-satellite';
    row.dataset.layer = key;
    row.innerHTML = `<input type="checkbox" class="form-check-input"${hiddenLayers.has(key) ? '' : ' checked'}><span class="legend-dot" style="--color: ${OBS_CLASSES.satellite.color}; --outline: ${darken(OBS_CLASSES.satellite.color)}"></span><span></span>`;
    row.lastElementChild.textContent = name.toUpperCase().replace(/^SATELLITE /, 'Satellite ');
    var input = row.querySelector('input');
    var parentOff = ancestors(key).some((a) => hiddenLayers.has(a));
    input.disabled = parentOff;
    row.classList.toggle('legend-disabled', parentOff);
    input.addEventListener('change', () => {
        input.checked ? hiddenLayers.delete(key) : hiddenLayers.add(key);
        applyMapFilter();
    });
    // Alphabetical among this group's satellites, right after the group's row
    var after = parentRow;
    for (var sibling = parentRow.nextElementSibling; sibling && sibling.classList.contains('legend-satellite') && sibling.dataset.layer.startsWith(`sat:${parent}:`); sibling = sibling.nextElementSibling) {
        if (sibling.dataset.layer > key) break;
        after = sibling;
    }
    after.after(row);
}

// Adds a station from another source, or refreshes the readings of one already on the map
function externalStation(stations, s) {
    // Fade by the age of the observation, like WIS2 points
    var born = isFinite(s.observed) ? Math.min(s.observed, Date.now()) : Date.now();
    var datetime = isFinite(s.observed) ? new Date(s.observed).toISOString() : undefined;
    var record = stations.get(s.id);
    if (record) {
        record.decoded = { subsets: 1, index: 0, rows: s.rows };
        record.notification = s.notification;
        if (datetime) record.props.datetime = datetime;
        setFeatureProperties(record, { ...metricValues(record), born });
        return record;
    }
    record = {
        id: nextId++,
        coords: [s.lon, s.lat],
        topic: `${s.layer}/${s.path}`,
        channel: s.layer,
        centre: s.centre,
        path: s.path,
        discipline: 'weather',
        webcam: false,
        external: true,
        badge: s.badge,
        subLayer: s.layer,
        props: { data_id: `${s.layer}:${s.id}`, metadata_id: s.name, ...(datetime ? { datetime } : {}) },
        links: [s.link],
        wsi: s.id,
        format: s.format,
        color: OBS_CLASSES.station.color,
        source: null,
        notification: s.notification,
        decoded: { subsets: 1, index: 0, rows: s.rows },
        born,
    };
    stations.set(s.id, record);
    addPoint(record);
    return record;
}

// ---------- Global Replay: past notifications from the WIS2 Global Replay service
// (OGC API - Features). The view's past replayWindowMs is fetched newest first,
// up to REPLAY_MAX, after each pan; messages carry their data inline, so stations
// can still be coloured. The service keeps a copy from every global cache, so only
// one cache's copies are asked for (core data; recommended data isn't cached).
const REPLAY_API = 'https://wis2-grep.weather.gc.ca/collections/wis2-notification-messages/items';
const REPLAY_CACHE = 'data-metoffice-noaa-global-cache';
const REPLAY_PAGE = 500;
const REPLAY_MAX = 5000;
let replayTimer = null;
let replayAbort = null;
let replayedView = '';

// 5 minutes, 1 hour, 2 h 35 min
function replayWindowLabel(minutes) {
    if (minutes < 60) return `${minutes} minutes`;
    var hours = Math.floor(minutes / 60), rest = minutes % 60;
    if (rest) return `${hours} h ${rest} min`;
    return hours === 1 ? '1 hour' : `${hours} hours`;
}

// The slider under the Global Replay row: a shorter window drops replayed points
// now outside it, and either way the view is fetched again
function setReplayWindow(minutes) {
    replayWindowMs = minutes * 60 * 1000;
    var cutoff = Date.now() - replayWindowMs;
    [...records.values()].filter((r) => r.replay && r.born < cutoff).forEach(removePoint);
    replayedView = '';
    scheduleReplay(300);
}

function scheduleReplay(delay = 800) {
    clearTimeout(replayTimer);
    if (effectiveHidden().includes('replay')) return;
    replayTimer = setTimeout(loadReplay, delay);
}

async function loadReplay() {
    var b = map.getBounds();
    var clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    var bbox = [clamp(b.getWest(), -180, 180), clamp(b.getSouth(), -90, 90), clamp(b.getEast(), -180, 180), clamp(b.getNorth(), -90, 90)]
        .map((v) => v.toFixed(2));
    // A view crossing the antimeridian, or the whole globe, asks for everything
    if (b.getEast() - b.getWest() >= 360 || Number(bbox[0]) >= Number(bbox[2])) bbox = ['-180', '-90', '180', '90'];
    var since = new Date(Date.now() - replayWindowMs).toISOString().replace(/\.\d+Z$/, 'Z');
    var view = `${bbox.join(',')}|${since.slice(0, 15)}`;  // The same view within ten minutes isn't fetched again
    if (view === replayedView) return;
    replayedView = view;
    if (replayAbort) replayAbort.abort();
    var abort = replayAbort = new AbortController();
    var url = `${REPLAY_API}?f=json&sortby=-pubtime&limit=${REPLAY_PAGE}&bbox=${bbox.join(',')}&datetime=${since}/..&global-cache=${REPLAY_CACHE}`;
    try {
        for (var fetched = 0; url && fetched < REPLAY_MAX && !abort.signal.aborted;) {
            var response = await fetch(url, { signal: abort.signal });
            if (!response.ok) throw new Error(`Global Replay answered ${response.status}`);
            var page = await response.json();
            for (var feature of page.features || []) {
                var topic = feature.properties && feature.properties.topic;
                if (topic && topic.includes('/a/wis2/')) onMessage(topic, feature, true);
            }
            fetched += (page.features || []).length;
            var next = (page.links || []).find((l) => l.rel === 'next');
            url = next && (page.features || []).length ? next.href : null;
        }
    } catch (err) {
        if (err.name !== 'AbortError') {
            replayedView = '';  // Try again on the next pan
            console.debug(`Could not load the Global Replay: ${err.message}`);
        }
    }
}

// ---------- Airports worldwide: the latest METAR from each airport, from the Iowa
// Environmental Mesonet, which keeps one network per country (per state in the
// US, per province in Canada). Every network is fetched, a few at a time and
// nearest the view first, and again once AIRPORT_REFRESH_MS old. Readings become
// BUFR-style rows, so the tiles, colouring and forecast comparison work as they
// do for WIS2 stations.
const IEM_API = 'https://mesonet.agron.iastate.edu/api/1';
const AIRPORT_NETWORK = /_ASOS$/;
const AIRPORT_REFRESH_MS = 20 * 60 * 1000;
const AIRPORT_CONCURRENT = 6;
const airportStations = new Map();  // station id -> record, bounded by IEM's station lists
let airportNetworks = null;         // promise of [{ id, name, bounds: [w, s, e, n], fetched, pending }]
let airportActive = 0;

function loadAirportNetworks() {
    if (!airportNetworks) {
        airportNetworks = fetch(`${IEM_API}/networks.json`).then((r) => {
            if (!r.ok) throw new Error(`IEM answered ${r.status}`);
            return r.json();
        }).then((json) => json.data.filter((n) => AIRPORT_NETWORK.test(n.id) && n.extent)
            .map((n) => ({ id: n.id, name: n.name, bounds: wkbBounds(n.extent), fetched: 0, pending: false }))
            .filter((n) => n.bounds))
            .catch((err) => {
                airportNetworks = null;  // Try again next time
                console.debug(`Could not load the IEM networks: ${err.message}`);
                return [];
            });
    }
    return airportNetworks;
}

// The bounding box of a polygon in hex (E)WKB, as IEM gives network extents
function wkbBounds(hex) {
    var bytes = new Uint8Array(hex.match(/../g).map((h) => parseInt(h, 16)));
    var view = new DataView(bytes.buffer), little = bytes[0] === 1;
    var type = view.getUint32(1, little), at = 5 + (type & 0x20000000 ? 4 : 0);
    if ((type & 0xff) !== 3) return null;
    var points = view.getUint32(at + 4, little), w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (var i = 0, p = at + 8; i < points; i++, p += 16) {
        var x = view.getFloat64(p, little), y = view.getFloat64(p + 8, little);
        w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y);
    }
    return points ? [w, s, e, n] : null;
}

async function queueAirports() {
    if (effectiveHidden().includes('airports')) return;
    var networks = await loadAirportNetworks();
    var centre = map.getCenter(), now = Date.now();
    var away = (b) => Math.hypot((b[0] + b[2]) / 2 - centre.lng, (b[1] + b[3]) / 2 - centre.lat);
    var due = networks.filter((n) => !n.pending && now - n.fetched > AIRPORT_REFRESH_MS)
        .sort((a, b) => away(a.bounds) - away(b.bounds));
    for (var n of due) {
        if (airportActive >= AIRPORT_CONCURRENT) break;
        loadAirportNetwork(n);
    }
}

async function loadAirportNetwork(network) {
    airportActive++;
    network.pending = true;
    try {
        var response = await fetch(`${IEM_API}/currents.json?network=${encodeURIComponent(network.id)}`);
        if (!response.ok) throw new Error(`IEM answered ${response.status}`);
        var json = await response.json();
        for (var ob of json.data) updateAirport(ob, network);
    } catch (err) {
        console.debug(`IEM ${network.id}: ${err.message}`);
    } finally {
        network.fetched = Date.now();  // A failed network waits as long as a fetched one
        network.pending = false;
        airportActive--;
        queueAirports();
    }
}

function updateAirport(ob, network) {
    if (!ob.station || !isFinite(ob.lat) || !isFinite(ob.lon)) return;
    var val = (v, scale = 1, offset = 0) => (v === null || v === undefined || !isFinite(v) ? null : v * scale + offset);
    var rows = [];
    var add = (descriptor, name, value, unit) => { if (value !== null && value !== undefined && value !== '') rows.push([descriptor, name, value, unit]); };
    add(1015, 'STATION OR SITE NAME', ob.name, 'CCITT IA5');
    add(12101, 'TEMPERATURE/AIR TEMPERATURE', val(ob.tmpf, 5 / 9, 273.15 - 32 * 5 / 9), 'K');
    add(12103, 'DEWPOINT TEMPERATURE', val(ob.dwpf, 5 / 9, 273.15 - 32 * 5 / 9), 'K');
    add(13003, 'RELATIVE HUMIDITY', val(ob.relh) === null ? null : Math.round(ob.relh), '%');
    add(10051, 'PRESSURE REDUCED TO MEAN SEA LEVEL', val(ob.mslp, 100), 'Pa');
    add(11001, 'WIND DIRECTION', val(ob.drct), 'deg');
    add(11002, 'WIND SPEED', val(ob.sknt, 0.514444), 'm/s');
    add(11041, 'MAXIMUM WIND GUST SPEED', val(ob.gust, 0.514444), 'm/s');
    add(20001, 'HORIZONTAL VISIBILITY', val(ob.vsby, 1609.34), 'm');
    add(0, 'PRESENT WEATHER', ob.wxcodes ? [].concat(ob.wxcodes).join(' ') : null, '');
    add(0, 'METAR', ob.raw, '');
    var id = ob.station;
    externalStation(airportStations, { layer: 'airports', centre: network.name.replace(/ ASOS$/, ''), badge: 'METAR', format: 'metar',
        id, lat: ob.lat, lon: ob.lon, name: ob.name, observed: Date.parse(ob.utc_valid || ''), rows, path: `metar/${id}`,
        notification: { ...ob, source: `${IEM_API}/currents.json?network=${network.id}` },
        link: { rel: 'canonical', href: `${IEM_API}/currents.json?station=${encodeURIComponent(id)}&network=${encodeURIComponent(network.id)}`, type: 'application/json' } });
}

setInterval(() => { if (airportStations.size) queueAirports(); }, 5 * 60 * 1000);

// ---------- Satellite coverage. Each decoded satellite file covers the convex hull
// of its reports; the hulls of one satellite are joined on a grid, so its passes
// read as one area with no seams, and each cell's opacity is the cloud amount of
// the reports in it. Files with only a few reports (e.g. a radio occultation)
// stay as points.
const SWATH_MIN_REPORTS = 5;
const SWATH_CELL = 2;  // Grid cell size in degrees
let swathsDirty = false;
let swathsBuilt = 0;
const swathMembers = new Map();  // swath key -> record ids

// Convex hull (monotone chain) of [lon, lat] points, as a closed ring
function convexHull(points) {
    var pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    var cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    var lower = [], upper = [];
    for (var p of pts) {
        while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
        lower.push(p);
    }
    for (var i = pts.length - 1; i >= 0; i--) {
        while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pts[i]) <= 0) upper.pop();
        upper.push(pts[i]);
    }
    var ring = lower.slice(0, -1).concat(upper.slice(0, -1));
    return ring.length >= 3 ? ring.concat([ring[0]]) : null;
}

// Whether a point is inside a ring, or within `margin` degrees of its edge
// (so neighbouring strips of one pass meet without gaps)
function inOrNearRing([x, y], ring, margin) {
    var inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        var [xi, yi] = ring[i], [xj, yj] = ring[j];
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    if (inside) return true;
    for (var k = 1; k < ring.length; k++) {
        var [ax, ay] = ring[k - 1], [bx, by] = ring[k];
        var dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy || 1;
        var t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len));
        if (Math.hypot(x - ax - t * dx, y - ay - t * dy) <= margin) return true;
    }
    return false;
}

function buildSwaths() {
    var files = new Map();
    for (var record of pools.satellite.values()) {
        if (!record.fileKey || !records.has(record.id)) continue;
        if (!files.has(record.fileKey)) files.set(record.fileKey, []);
        files.get(record.fileKey).push(record);
    }
    swathMembers.clear();
    var cells = new Map();  // satellite + cell -> { sums, counts, file means, first record }
    var metricKeys = Object.keys(METRICS);
    var valueOf = (r, m) => r.feature && r.feature.properties[`m_${m}`];
    for (var [key, reports] of files) {
        if (reports.length < SWATH_MIN_REPORTS) continue;
        var first = reports[0], sat = satelliteKey(first) || `${first.subLayer}:${key}`;
        // Longitudes unwrapped around the first report so a pass across ±180 stays whole
        var lon0 = first.coords[0];
        var unwrapLon = (lon) => {
            while (lon - lon0 > 180) lon -= 360;
            while (lon - lon0 < -180) lon += 360;
            return lon;
        };
        var ring = convexHull(reports.map((r) => [unwrapLon(r.coords[0]), r.coords[1]]));
        if (!ring) continue;
        if (!swathMembers.has(sat)) swathMembers.set(sat, []);
        swathMembers.get(sat).push(...reports.map((r) => r.id));
        reports.forEach((r) => {
            if (!r.inSwath) {
                r.inSwath = true;
                setFeatureProperties(r, { inSwath: true });
            }
        });
        // The file's own means fill cells it covers that hold none of its reports
        var fileMeans = {};
        for (var m of metricKeys) {
            var vals = reports.map((r) => valueOf(r, m)).filter((v) => typeof v === 'number');
            if (vals.length) fileMeans[m] = vals.reduce((a, b) => a + b, 0) / vals.length;
        }
        var cellOf = (lon, lat) => {
            var cx = Math.floor((((lon + 180) % 360 + 360) % 360 - 180) / SWATH_CELL) * SWATH_CELL;
            return `${sat}|${cx}|${Math.floor(lat / SWATH_CELL) * SWATH_CELL}`;
        };
        var cellFor = (id) => {
            if (!cells.has(id)) cells.set(id, { sat, sums: {}, counts: {}, fills: [], first, born: 0, reports: 0 });
            return cells.get(id);
        };
        // Cells the file's footprint covers
        var xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
        for (var lat = Math.floor(Math.min(...ys) / SWATH_CELL) * SWATH_CELL; lat < Math.max(...ys); lat += SWATH_CELL) {
            for (var lon = Math.floor(Math.min(...xs) / SWATH_CELL) * SWATH_CELL; lon < Math.max(...xs); lon += SWATH_CELL) {
                if (!inOrNearRing([lon + SWATH_CELL / 2, lat + SWATH_CELL / 2], ring, SWATH_CELL * 0.75)) continue;
                var cell = cellFor(cellOf(lon, lat));
                cell.fills.push(fileMeans);
                cell.born = Math.max(cell.born, ...reports.map((r) => r.born));
            }
        }
        // Reports in each cell give it its own values
        for (var r of reports) {
            var cell = cellFor(cellOf(r.coords[0], r.coords[1]));
            cell.reports++;
            cell.born = Math.max(cell.born, r.born);
            for (var m of metricKeys) {
                var v = valueOf(r, m);
                if (typeof v !== 'number') continue;
                cell.sums[m] = (cell.sums[m] || 0) + v;
                cell.counts[m] = (cell.counts[m] || 0) + 1;
            }
        }
    }
    var features = [];
    for (var [id, cell] of cells) {
        var [, cx, cy] = id.split('|').map(Number);
        var props = {};
        for (var m of metricKeys) {
            if (cell.counts[m]) props[`m_${m}`] = cell.sums[m] / cell.counts[m];
            else {
                var fills = cell.fills.map((f) => f[m]).filter((v) => typeof v === 'number');
                if (fills.length) props[`m_${m}`] = fills.reduce((a, b) => a + b, 0) / fills.length;
            }
        }
        var first = cell.first, satRow = first.decoded && first.decoded.rows.find((x) => x[0] === 1007);
        features.push({
            type: 'Feature',
            geometry: { type: 'Polygon', coordinates: [[[cx, cy], [cx + SWATH_CELL, cy], [cx + SWATH_CELL, cy + SWATH_CELL], [cx, cy + SWATH_CELL], [cx, cy]]] },
            properties: {
                swath: cell.sat,
                label: satRow ? SATELLITE_NAMES[satRow[2]] || `Satellite ${satRow[2]}` : 'Satellite',
                count: (swathMembers.get(cell.sat) || []).length,
                color: first.color,
                outline: darken(first.color),
                born: cell.born,
                layer: first.subLayer,
                via: first.decodedLayer || '',
                gateway: isGateway(first),
                sat: satelliteKey(first),
                channel: first.channel,
                centre: first.centre,
                format: first.format,
                discipline: first.discipline,
                space: isSpaceRecord(first),
                topic: first.topic.toLowerCase(),
                ...props,
            },
        });
    }
    return features;
}

// The report in a swath closest to where it was clicked
function nearestSwathReport(key, lngLat) {
    var ids = swathMembers.get(key) || [];
    var best = null, bestKm = Infinity;
    for (var id of ids) {
        var r = records.get(id);
        if (!r) continue;
        var km = distanceKm(r.coords, [lngLat.lng, lngLat.lat]);
        if (km < bestKm) { best = r; bestKm = km; }
    }
    return best;
}

// ---------- Tracks. Aircraft reports are joined by identifier in time order.
// A satellite scan has many reports at once, so its track follows the centre of
// each minute's reports; steps that don't move at orbital speed are dropped,
// which leaves polar orbiters' ground tracks and no tracks for geostationary ones.
const TRACK_REBUILD_MS = 2000;
const TRACK_MAX_GAP_MS = 90 * 60e3;
const AIRCRAFT_MAX_KMH = 1300;           // Faster than this means a mixed-up identifier
const ORBIT_KM_PER_MIN = [250, 550];     // Ground speed of a low orbit is about 400 km a minute
const SATELLITE_MIN_STEPS = 4;
let tracksDirty = false;
let tracksBuilt = 0;

function trackKey(subLayer, values) {
    var text = (id) => (typeof values.get(id) === 'string' ? values.get(id).trim() : values.has(id) ? String(values.get(id)) : '');
    if (subLayer === 'gts-aircraft') {
        var id = text(1008) || text(1006);
        return id ? `aircraft:${id}` : null;
    }
    if (subLayer === 'gts-satellite' && values.has(1007)) return `satellite:${values.get(1007)}`;
    return null;
}

function distanceKm([lon1, lat1], [lon2, lat2]) {
    var r = Math.PI / 180;
    var a = Math.sin((lat2 - lat1) * r / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lon2 - lon1) * r / 2) ** 2;
    return 12742 * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Average position of points on the sphere, so a scan across the antimeridian averages correctly
function sphericalMean(coords) {
    var r = Math.PI / 180, x = 0, y = 0, z = 0;
    for (var [lon, lat] of coords) {
        x += Math.cos(lat * r) * Math.cos(lon * r);
        y += Math.cos(lat * r) * Math.sin(lon * r);
        z += Math.sin(lat * r);
    }
    return [Math.atan2(y, x) / r, Math.atan2(z, Math.hypot(x, y)) / r];
}

// Splits time-ordered positions into runs where every step passes the test
function segments(points, ok, minPoints) {
    var out = [], run = [points[0]];
    for (var i = 1; i < points.length; i++) {
        if (ok(points[i - 1], points[i])) {
            run.push(points[i]);
        } else {
            if (run.length >= minPoints) out.push(run);
            run = [points[i]];
        }
    }
    if (run.length >= minPoints) out.push(run);
    return out;
}

// Longitudes carried past ±180 so a line crossing the antimeridian doesn't wrap the globe
function unwrap(coords) {
    var out = [coords[0].slice()];
    for (var i = 1; i < coords.length; i++) {
        var lon = coords[i][0];
        while (lon - out[i - 1][0] > 180) lon -= 360;
        while (lon - out[i - 1][0] < -180) lon += 360;
        out.push([lon, coords[i][1]]);
    }
    return out;
}

function buildTracks() {
    var groups = new Map();
    for (var record of [...pools.decoded.values(), ...pools.satellite.values()]) {
        if (!record.track || !records.has(record.id)) continue;
        if (!groups.has(record.track)) groups.set(record.track, []);
        groups.get(record.track).push(record);
    }
    var features = [];
    for (var [key, reports] of groups) {
        var kind = key.slice(0, key.indexOf(':'));
        reports.sort((a, b) => a.observed - b.observed);
        var points, runs;
        if (kind === 'aircraft') {
            points = reports.map((r) => ({ t: r.observed, c: r.coords, alt: r.alt, id: r.id }));
            runs = segments(points, (a, b) => b.t - a.t <= TRACK_MAX_GAP_MS
                && distanceKm(a.c, b.c) / Math.max((b.t - a.t) / 3600e3, 1 / 60) <= AIRCRAFT_MAX_KMH, 2);
        } else {
            var minutes = new Map();
            for (var r of reports) {
                var m = Math.floor(r.observed / 60e3);
                if (!minutes.has(m)) minutes.set(m, []);
                minutes.get(m).push(r.coords);
            }
            points = [...minutes].sort((a, b) => a[0] - b[0]).map(([m, cs]) => ({ t: m * 60e3, c: sphericalMean(cs) }));
            runs = segments(points, (a, b) => {
                var mins = (b.t - a.t) / 60e3, speed = distanceKm(a.c, b.c) / mins;
                return mins <= 3 && speed >= ORBIT_KM_PER_MIN[0] && speed <= ORBIT_KM_PER_MIN[1];
            }, SATELLITE_MIN_STEPS + 1);
        }
        if (!runs.length) continue;
        var last = reports[reports.length - 1];
        // Satellite tracks carry the same name and layer key as the satellite's row
        // under Space-based, so switching that row off hides the track too
        var sat = kind === 'satellite' ? satelliteKey(last) : null;
        if (sat) addSatelliteRow(sat);
        var common = {
            kind,
            label: kind === 'aircraft' ? `Aircraft ${key.slice(9)}` : satelliteName(last) || `Satellite ${key.slice(10)}`,
            count: reports.length,
            lastId: last.id,
            color: last.color,
            born: last.born,
            layer: last.subLayer,
            sat,
            channel: last.channel,
            centre: last.centre,
            format: last.format,
            discipline: last.discipline,
            space: isSpaceRecord(last),
            topic: last.topic.toLowerCase(),
        };
        if (kind === 'aircraft') {
            var route = trackRoute(reports);
            if (route) common.label += ` · ${route}`;
            features.push(...aircraftShapes(runs, { ...common, layer: 'gts-tracks' }));
            continue;
        }
        features.push({
            type: 'Feature',
            geometry: { type: 'MultiLineString', coordinates: runs.map((run) => unwrap(run.map((p) => p.c))) },
            properties: common,
        });
    }
    return features;
}

// Sizes of the floating aircraft shapes, in screen pixels at the current zoom
const BAND_PX = 3;
const CHEVRON_PX = 9;
const CHEVRON_SPACING_PX = 60;
const MARKER_PX = 16;

// Kilometres per screen pixel at a latitude, for the current zoom
function kmPerPixel(lat) {
    return 40075.016 * Math.max(Math.cos(lat * Math.PI / 180), 0.05) / (512 * 2 ** map.getZoom());
}

// Local flat frame around a point: km east/north to lon/lat offsets
function frame(lat) {
    var kx = 111.32 * Math.max(Math.cos(lat * Math.PI / 180), 0.05);
    return { toLonLat: ([x, y], [lon0, lat0]) => [lon0 + x / kx, lat0 + y / 111.32], kx };
}

// Bands for each step at its altitude, chevrons every so often pointing along
// the path, and an arrowhead at the latest report, all floating in the air
function aircraftShapes(runs, common) {
    var out = [];
    // bottom and top are metres; the band spans its step's climb or descent so steps join up
    var shape = (ring, alt, role, recordId, bottom, top) => out.push({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [ring.concat([ring[0]])] },
        properties: { ...common, role, alt, recordId, bottom, top },
    });
    // Polygon from km offsets (x along travel, y to the left) around a point heading at angle
    var oriented = (centre, angle, pts) => {
        var f = frame(centre[1]);
        return pts.map(([along, left]) => f.toLonLat([along * Math.cos(angle) - left * Math.sin(angle), along * Math.sin(angle) + left * Math.cos(angle)], centre));
    };
    var lastStep = null;
    for (var run of runs) {
        var coords = unwrap(run.map((p) => p.c));
        var sinceChevron = 0;
        for (var i = 1; i < run.length; i++) {
            var a = run[i - 1], b = run[i];
            var alt = a.alt > 0 && b.alt > 0 ? (a.alt + b.alt) / 2 : a.alt > 0 ? a.alt : b.alt;
            if (!(alt > 0)) continue;
            var p1 = coords[i - 1], p2 = coords[i];
            var f = frame((p1[1] + p2[1]) / 2), px = kmPerPixel((p1[1] + p2[1]) / 2);
            var dx = (p2[0] - p1[0]) * f.kx, dy = (p2[1] - p1[1]) * 111.32, len = Math.hypot(dx, dy);
            if (!len) continue;
            var angle = Math.atan2(dy, dx), half = BAND_PX * px / 2;
            // Fill-extrusions have flat tops, so a climb or descent is split into
            // pieces small enough to read as a slope
            var altA = a.alt > 0 ? a.alt : alt, altB = b.alt > 0 ? b.alt : alt;
            var pieces = Math.min(24, Math.max(1, Math.ceil(Math.abs(altB - altA) / (Math.max(altA, altB) * 0.02))));
            for (var k = 0; k < pieces; k++) {
                var lo = altA + (altB - altA) * k / pieces, hi = altA + (altB - altA) * (k + 1) / pieces;
                shape(oriented(p1, angle, [[len * k / pieces, half], [len * (k + 1) / pieces, half], [len * (k + 1) / pieces, -half], [len * k / pieces, -half]]),
                    (lo + hi) / 2, 'band', b.id, Math.min(lo, hi) * 0.985, Math.max(lo, hi) * 1.015);
            }
            // A chevron whenever enough path has passed on screen
            sinceChevron += len / px;
            if (sinceChevron >= CHEVRON_SPACING_PX) {
                sinceChevron = 0;
                var mid = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2], c = CHEVRON_PX * px;
                shape(oriented(mid, angle, [[c / 2, 0], [-c / 2, c / 2], [-c / 4, 0], [-c / 2, -c / 2]]), alt, 'arrow', b.id, alt * 0.97, alt * 1.03);
            }
            lastStep = { point: p2, angle, alt: b.alt > 0 ? b.alt : alt, id: b.id };
        }
    }
    if (lastStep) {
        var m = MARKER_PX * kmPerPixel(lastStep.point[1]);
        shape(oriented(lastStep.point, lastStep.angle, [[m * 0.6, 0], [-m * 0.4, m * 0.45], [-m * 0.2, 0], [-m * 0.4, -m * 0.45]]),
            lastStep.alt, 'marker', lastStep.id, lastStep.alt * 0.95, lastStep.alt * 1.05);
    }
    return out;
}

// Airport codes from 001111 (origination) and 001112 (destination); blanks and
// "???" mean unknown. Returns e.g. "DUB → TFS", "DUB → ?" or null.
function cleanAirport(code) {
    var c = typeof code === 'string' ? code.trim().toUpperCase() : '';
    return /^[A-Z0-9]{3,4}$/.test(c) ? c : null;
}

function flightRoute(from, to) {
    from = cleanAirport(from);
    to = cleanAirport(to);
    return from || to ? `${from || '?'} → ${to || '?'}` : null;
}

// Detailed phase of flight, code table 0 08 009
function flightPhase(code) {
    if ([0, 1, 3, 4].includes(code)) return 'Level flight';
    if (code === 2) return 'Unsteady';
    if (code === 5 || (code >= 7 && code <= 10)) return 'Climbing';
    if (code === 6 || (code >= 11 && code <= 14)) return 'Descending';
    return null;
}

// The route most of a track's reports agree on, since many leave it blank
function trackRoute(reports) {
    var vote = (id) => {
        var counts = new Map();
        for (var r of reports) {
            var row = r.decoded && r.decoded.rows.find((x) => x[0] === id);
            var code = row && cleanAirport(row[2]);
            if (code) counts.set(code, (counts.get(code) || 0) + 1);
        }
        return [...counts].sort((a, b) => b[1] - a[1]).map(([c]) => c)[0];
    };
    return flightRoute(vote(1111), vote(1112));
}

// Which GTS sublayer a report belongs to, from the identifiers it carries.
// Order matters: satellite and aircraft reports can also carry station-like ids.
function reportClass(values, profile) {
    if (values.has(1007)) return 'satellite';
    if (values.has(1008) || values.has(1006) || values.has(7010) || values.has(8009) || values.has(8004)) return 'aircraft';
    if (profile && profile.length >= 2) return 'upperair';
    // Wind profilers and PILOTs name their equipment, even with no levels to report
    if (values.has(2003)) return 'upperair';
    if (values.has(1011)) return 'ship';
    if (values.has(1087) || values.has(1005) || values.has(2149)) return 'buoy';
    // GNSS receivers have site names but report path delays (e.g. template 3 07 022)
    if (values.has(15031) || values.has(15011)) return 'gnss';
    if (values.has(1015) || values.has(1001) || values.has(1125)) return 'station';
    return 'other';
}

// Altitude in metres for aircraft reports (AMDAR and similar), else null:
// flight level, height or altitude, or indicated aircraft altitude
function aircraftAltitude(values, t) {
    var aircraft = values.has(1008) || values.has(1006) || /\/data\/core\/I\/U\/A\//.test(t);
    if (!aircraft) return null;
    var alt = [7010, 10053, 7002, 10070, 7007].map((id) => values.get(id)).find((v) => typeof v === 'number');
    return alt > 0 && alt < 25000 ? alt : null;
}

// WIGOS id, WMO block/station, ship, buoy or aircraft identifier
function reportId(values) {
    var text = (id) => typeof values.get(id) === 'string' && values.get(id).trim();
    if (values.has(1125) && text(1128)) {
        return `${values.get(1125)}-${values.get(1126)}-${values.get(1127)}-${text(1128)}`;
    }
    if (typeof values.get(1001) === 'number' && typeof values.get(1002) === 'number') {
        return `0-20000-0-${String(values.get(1001)).padStart(2, '0')}${String(values.get(1002)).padStart(3, '0')}`;
    }
    return text(1011) || text(1008) || (values.has(1087) && String(values.get(1087)))
        || (values.has(1005) && String(values.get(1005))) || null;
}

function reportTime(values) {
    var [y, mo, d, h, mi] = [4001, 4002, 4003, 4004, 4005].map((id) => values.get(id));
    if (![y, mo, d, h].every((v) => typeof v === 'number')) return undefined;
    return new Date(Date.UTC(y, mo - 1, d, h, mi || 0)).toISOString();
}

function setDecodeEnabled(kind, enabled) {
    enabled ? decodeEnabled.add(kind) : decodeEnabled.delete(kind);
    if (!enabled) decodeQueue = decodeQueue.filter((job) => job.kind !== kind);
    applyMapFilter();
    pumpDecode();
}

function rememberLinks(dataId, links) {
    if (!dataId) return;
    var hrefs = dataLinks.get(dataId) || new Set();
    for (var link of links) {
        if (isDataLink(link)) hrefs.add(link.href);
    }
    dataLinks.delete(dataId);  // Re-insert to keep recently used ids
    dataLinks.set(dataId, hrefs);
    if (dataLinks.size > DATA_LINKS_MAX) {
        dataLinks.delete(dataLinks.keys().next().value);
    }
}

function bufrSource(feature, props) {
    var content = props.content && props.content.encoding === 'base64' ? props.content.value : null;
    // Any canonical link may hold BUFR or text; fetchData checks the content
    var urls = (feature.links || [])
        .filter((l) => isDataLink(l) && !(l.length > 5e6))
        .map((l) => l.href);
    if (!content && !urls.length) return null;
    return { content: content, dataId: props.data_id, urls: urls, cap: props.cap_info || null };
}

// Returns { bytes, bufr, url }: the first BUFR copy found, otherwise the first
// copy that is plain text
async function fetchData(source) {
    var text = null;
    if (source.content) {
        var bytes = Uint8Array.from(atob(source.content), (c) => c.charCodeAt(0));
        if (bufrPart(bytes)) return { bytes: bufrPart(bytes), bufr: true };
        if (isText(bytes)) text = { bytes: bytes, bufr: false };
    }
    // Most caches block cross-origin requests, so try the ones that allow it first
    var urls = [...new Set([...source.urls, ...(dataLinks.get(source.dataId) || [])])];
    urls.sort((a, b) => corsFriendly(b) - corsFriendly(a));
    for (var url of urls) {
        try {
            var response = await fetch(url);
            if (!response.ok) continue;
            var bytes = new Uint8Array(await response.arrayBuffer());
            if (bufrPart(bytes)) return { bytes: bufrPart(bytes), bufr: true, url: url };
            if (!text && isText(bytes)) text = { bytes: bytes, bufr: false, url: url };
        } catch (err) {
            console.debug(`Could not fetch ${url}`);
        }
    }
    if (text) return text;
    throw new Error('no downloadable copy in a supported format (the data servers may block browser downloads)');
}

function isText(bytes) {
    var sample = bytes.subarray(0, 2000);
    var printable = sample.filter((b) => b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127)).length;
    return sample.length > 0 && printable / sample.length > 0.95;
}

// Hosts that let a browser download their files: the S3-backed global caches and
// JMA's own server (which JMA's GTS-to-WIS2 bulletins link to). DWD, KMA, CMA and
// NCM send no CORS headers.
const CORS_HOSTS = ['www.wis-jma.go.jp'];

function corsFriendly(url) {
    var host = hostname(url);
    return host.endsWith('.amazonaws.com') || CORS_HOSTS.includes(host) ? 1 : 0;
}

// GTS bulletins put an abbreviated heading (e.g. "IUAG04 VHHH 141200") before
// the BUFR message, so look a little way in; returns the BUFR bytes or null
function bufrPart(bytes) {
    var head = String.fromCharCode(...bytes.subarray(0, 256));
    var start = head.indexOf('BUFR');
    return start < 0 ? null : bytes.subarray(start);
}
