// Shared settings: colours, the kinds of observation, and the measures the map
// can be coloured by (with their scales). Data only, for every page.

export const COLORS = {
    origin: '#6f9fd8',
    gts: '#9b6cd1',
    wis2gts: '#c2255c',
    files: '#83C95D',
    radar: '#0ca678',
    grib: '#7048e8',    'cache-satellite': '#9c36b5',  // OBS_CLASSES.satellite
    'gts-satellite': '#9c36b5',
    'gts-text': '#9b6cd1',  // COLORS.gts
    replay: '#4c6ef5',
};

// Kinds of observation, shared by the Cache and GTS-to-WIS2 groups so each kind
// has one colour on the map. Cache points are sorted by topic (see topicClass),
// decoded reports by the identifiers they carry (see reportClass).
// Colours follow the domain (land green, sky cyan, sea navy, buoy orange,
// space purple, alert red) and are spread across hues to stay distinct
export const OBS_CLASSES = {
    ship: { label: 'Ships', color: '#1c3d8f', title: 'Observations from ships and other mobile stations' },
    aircraft: { label: 'Aircraft', color: '#15aabf', title: 'Observations from aircraft (AMDAR, AIREP)' },
    station: { label: 'Weather stations', color: '#2f9e44', title: 'Surface observations from fixed stations' },
    radarwind: { label: 'Radar wind profiles', color: '#f59f00', title: 'Winds at heights above a radar, measured from the ground by wind profilers and other radars (e.g. weather radar VAD winds), not soundings' },
    buoy: { label: 'Buoys and floats', color: '#f76707', title: 'Ocean observations from buoys, floats and moorings' },
    gnss: { label: 'Ground-based GNSS', color: '#a5662b', title: 'Atmospheric path delays and water vapour from GNSS receivers (e.g. E-GVAP), not weather observations' },
    warning: { label: 'Warnings and alerts', color: '#e03131', cacheOnly: true, title: 'Weather warnings, alerts and advisories, including CAP messages and Environment Canada city forecasts, and lightning flashes from detection networks (e.g. the Met Office LEELA network)' },
    satellite: { label: 'Space-based (satellites)', short: 'Satellite', color: '#9c36b5', title: 'Observations from satellites (winds, radiances, occultations)' },
    upperair: { label: 'Upper-air soundings', color: '#7048e8', title: 'Profiles through the atmosphere from balloons (radiosondes, TEMP, PILOT)' },
    webcam: { label: 'Webcam images', color: '#fcc419', cacheOnly: true, title: 'Camera images' },
    other: { label: 'Other', color: '#868e96', title: 'Anything not in the groups above' },
};

// Measures stations, ships and buoys can be coloured by (see setColourBy)
// `wms`: the matching ECCC GeoMet model layer (GDPS, or GDWPS for waves), shown
// behind the points on request. `period` (hours): totals over exactly that window, as 013011 after 004024 = -period,
// or the older fixed-window element given in `ids`
// Colour scales sampled from ECCC GeoMet's default legend for each model layer
// (GetLegendGraphic), so a station's colour matches the model field behind it.
// Units converted to the stations' own: sea temperature K to °C, wind knots to m/s.
export const GEOMET_STOPS = {
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
export const METRICS = {
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
    // The first channel's: 012163, or 012063 from ATOVS sounders (AMSU-A, MHS)
    brightness: { group: 'Space-based (satellites)', targets: 'satellite', label: 'Brightness temperature', unit: 'K', ids: [12163, 12063],
        stops: [[180, '#000004'], [210, '#320a5e'], [235, '#781c6d'], [255, '#bc3754'], [270, '#ed6925'], [290, '#fbb61a'], [320, '#fcffa4']] },
    // The first value is the measurement; an uncertainty can follow under the same descriptor
    vapour: { group: 'Space-based (satellites)', targets: 'satellite', label: 'Column water vapour', unit: 'kg/m²', ids: [13095, 13016],
        stops: [[0, '#fff7bc'], [5, '#c7e9b4'], [15, '#7fcdbb'], [25, '#41b6c4'], [40, '#1d91c0'], [55, '#225ea8'], [70, '#0c2c84']] },
    // Scatterometers (ASCAT): the first of the possible winds
    seaWind: { group: 'Space-based (satellites)', targets: 'satellite', label: 'Ocean surface wind speed', unit: 'm/s', ids: [11012],
        stops: GEOMET_STOPS.wind },
    satWaves: { group: 'Space-based (satellites)', targets: 'satellite', label: 'Wave height (altimeter)', unit: 'm', ids: [22070],
        stops: GEOMET_STOPS.waves },
    seaLevel: { group: 'Space-based (satellites)', targets: 'satellite', label: 'Sea-level anomaly', unit: 'cm', ids: [10102], convert: (v) => v * 100,
        stops: [[-30, '#2166ac'], [-10, '#92c5de'], [0, '#f7f7f7'], [10, '#f4a582'], [30, '#b2182b']] },
    // GeoMet has no skin temperature; the 2 m air temperature is the nearest model field
    skinTemp: { group: 'Space-based (satellites)', targets: 'satellite', wms: 'GDPS_15km_AirTemp_2m', wmsLabel: 'air temperature at 2 m', label: 'Surface (skin) temperature', unit: '°C', ids: [12061], convert: (v) => v - 273.15,
        stops: GEOMET_STOPS.temp },
    // Low values purple, so an ozone hole stands out
    ozone: { group: 'Space-based (satellites)', targets: 'satellite', label: 'Total ozone', unit: 'DU', ids: [15001],
        stops: [[150, '#3f007d'], [220, '#807dba'], [280, '#c6dbef'], [330, '#ffffbf'], [400, '#fdae61'], [480, '#d7191c']] },
    // Matched to the model's total cloud cover (GeoMet's greyscale style: dark clear, white overcast)
    cloudAmount: { group: 'Space-based (satellites)', targets: 'satellite', wms: 'GDPS_15km_TotalCloudCover', label: 'Cloud amount', unit: '%', ids: [20081],
        stops: [[0, '#202020'], [10, '#292929'], [20, '#454545'], [30, '#575757'], [40, '#737373'], [50, '#868686'],
            [60, '#a1a1a1'], [70, '#bdbdbd'], [80, '#d0d0d0'], [90, '#ebebeb'], [100, '#fefefe']] },
};

// Surface observations that can be coloured by a measure: stations, ships and buoys from
// the origin, the cache, the GTS and the replay
export const COLOURABLE = [...['station', 'ship', 'buoy'].flatMap((k) => [`origin-${k}`, `cache-${k}`, `gts-${k}`, `replay-${k}`]), 'airports'];
export const SATELLITE_LAYERS = ['cache-satellite', 'gts-satellite', 'replay-satellite'];

// The satellite measures in Style by, most often seen first (cloud-top pressure is rare)
export const SATELLITE_METRIC_ORDER = ['brightness', 'cloudAmount', 'satWind', 'skinTemp', 'vapour', 'seaWind',
    'satWaves', 'seaLevel', 'ozone', 'cloudTop'];

export const NO_VALUE_COLOR = '#ced4da';

// The two sources' accent colours, as in the legend sections (style.css)
export const SOURCE_COLORS = { wis2: '#1c7ed6', gts: '#7048e8' };

// Style by (state.colourBy): each satellite in its own colour (see satelliteColour), not a measure
export const SATELLITE_STYLE = 'satellite';

// Style by: each ship or buoy that reports a wave spectrum drawn as a small polar
// spectrum (see miniWaveSpectrum); everything else grey. Needs their files decoded
export const WAVE_STYLE = 'waves';

export const WAVE_CLASSES = ['ship', 'buoy'];
