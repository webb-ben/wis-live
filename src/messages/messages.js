// WIS2 notification messages: parsing them, and what their topic, links and
// geometry say (kind of observation, discipline, file type, GTS heading, place).
// Pure functions of the notification, for every page.

export function parseMessage(topic, message) {
    // message is Buffer
    try {
        return JSON.parse(message.toString());
    } catch (err) {
        console.debug(`Message from ${topic} is not valid JSON`);
        return null;
    }
}

export const DISCIPLINES = {
    'weather': 'Weather',
    'climate': 'Climate',
    'hydrology': 'Hydrology',
    'ocean': 'Ocean',
    'atmospheric-composition': 'Atmosphere',
    'cryosphere': 'Cryosphere',
    'space-weather': 'Space',  // Also matches satellite data (see matchesDiscipline)
    'other': 'Other',
};

export const FORMATS = {
    'bufr': 'BUFR',
    'grib': 'GRIB',
    'xml': 'XML/CAP',
    'csv': 'CSV',
    'json': 'JSON',
    'text': 'Text',
    'image': 'Image',
    'hdf': 'HDF/NetCDF',
    'other': 'Other',
};

// The link to a notification's data: canonical, or update when it replaces data
// published earlier under the same data_id (WIS2 Notification Message, 9.x)
export function isDataLink(link) {
    return link.rel == 'canonical' || link.rel == 'update';
}

export function isUpdate(feature) {
    return (feature.links || []).some((l) => l.rel == 'update');
}

// File type of a notification's data, from the canonical link's media type,
// falling back to the file extension for generic types
// File types learnt from a downloaded file's first bytes (see sniffFormat), by data_id:
// these beat what the notification says
export const sniffedFormats = new Map();

const SNIFFED_MAX = 5000;

export function noteSniffedFormat(feature, format) {
    var dataId = feature && feature.properties && feature.properties.data_id;
    if (!dataId || !format) return;
    sniffedFormats.set(dataId, format);
    if (sniffedFormats.size > SNIFFED_MAX) sniffedFormats.delete(sniffedFormats.keys().next().value);
}

// What a notification's file is: its own bytes if they've been seen, else its link's
// media type or extension, else where the name or topic gives it away, else a GTS
// bulletin's heading. topic, where known, settles files of numerical predictions
// (…/data/core/weather/prediction/…), which say nothing else, as GRIB
export function formatOf(feature, topic) {
    var props = feature.properties || {};
    if (sniffedFormats.has(props.data_id)) return sniffedFormats.get(props.data_id);
    var link = (feature.links || []).find((l) => isDataLink(l));
    if (!link) return 'other';
    var type = (link.type || '').toLowerCase();
    var ext = ((link.href || '').split(/[?#]/)[0].match(/\.([a-z0-9]+)$/i) || [])[1] || '';
    ext = ext.toLowerCase();
    // A .json name beats the type: ECCC announces its GeoJSON (…_HighLowPressure_MSL_…json) as application/grib
    if (/^(geo)?json$/.test(ext)) return 'json';
    if (/bufr/.test(type) || /^bufr\d?$/.test(ext)) return 'bufr';
    if (/grib/.test(type) || /^(grib2?|grb2?)$/.test(ext)) return 'grib';
    if (/xml|cap/.test(type) || ext === 'xml') return 'xml';
    if (/csv/.test(type) || ext === 'csv') return 'csv';
    if (/json/.test(type) || /^(geo)?json$/.test(ext)) return 'json';
    if (/^image\//.test(type) || /^(jpe?g|png|gif|webp)$/.test(ext)) return 'image';
    if (/hdf|netcdf/.test(type) || /^(h5|hdf5?|nc)$/.test(ext)) return 'hdf';
    if (/^text\//.test(type) || ext === 'txt') return 'text';
    // A name with .grib2 in it before a version suffix (the Met Office's …grib2/20261123T163116Z.1276.805)
    if (/\.(grib2?|grb2?)(?:[/.?#]|$)/i.test(link.href || '')) return 'grib';
    if (/\/data\/core\/weather\/prediction\//.test(topic || props.topic || '')) return 'grib';
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
export function gtsHeading(feature) {
    var props = feature.properties || {};
    if (props.gts && props.gts.ttaaii) return props.gts.ttaaii;
    var match = /(?:^|[/_])([A-Z]{4}\d{2})[A-Z]{4}\d{6}/.exec(props.data_id || '');
    return match ? match[1] : null;
}

// GTS gateway centres, in either direction (e.g. de-dwd-gts-to-wis2, uk-metoffice-wis2-to-gts)
export const GATEWAY_CENTRE = /-(gts-to-wis2|wis2-to-gts)$/;

export const GATEWAY_TOPIC = /\/a\/wis2\/[^/]+-(gts-to-wis2|wis2-to-gts)\//;

// GTS satellite bulletins: those headed IN and IE, and EUMETSAT's ISXX bulletins from
// EUSR, satellite products filed under surface data
export const GATEWAY_SATELLITE = /-(gts-to-wis2|wis2-to-gts)\/data\/core\/(I\/[NE]\/|I\/S\/X\/X\/\d+\/EUSR(\/|$))/;

// Aircraft bulletins (T1T2A1 = IUA: AMDAR and similar)
export const GATEWAY_AIRCRAFT = /-gts-to-wis2\/data\/core\/I\/U\/A\//;

export const GATEWAY_UPPER_AIR = /-gts-to-wis2\/data\/core\/I\/U\//;

// WIS2 space-based-observations topics, and GTS satellite bulletins (T1T2 = IN, IE)
export function isSpaceBased(topic) {
    return /\/space-based-observations\//.test(topic) || GATEWAY_SATELLITE.test(topic);
}

// centre/data/core/<discipline>/...; GTS bulletin topics have none
export function disciplineOf(t) {
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

// The kind of observation a cache notification holds, from its topic
// (data/core/<discipline>/<kind of observation>/...)
export function topicClass(record) {
    var t = record.topic.toLowerCase();
    if (record.webcam) return 'webcam';
    if (record.props.cap_info || /warning|alert|advisor|\/cap(\/|$)/.test(t)) return 'warning';
    if (/space-based-observations/.test(t)) return 'satellite';
    // GTS bulletins say what they hold in their heading (data/core/I/E/L/X/...)
    if (GATEWAY_SATELLITE.test(record.topic)) return 'satellite';
    if (GATEWAY_AIRCRAFT.test(record.topic)) return 'aircraft';
    if (GATEWAY_UPPER_AIR.test(record.topic)) return 'upperair';
    if (/-gts-to-wis2\/data\/core\/I\/S\/S\//.test(record.topic)) return 'ship';
    if (/-gts-to-wis2\/data\/core\/I\/S\//.test(record.topic)) return 'station';
    if (/-gts-to-wis2\/data\/core\/I\/O\//.test(record.topic)) return 'buoy';
    // Lightning goes with the warnings; before upper air, as the Met Office publishes
    // it under upper-air-observations/lightning
    if (/lightning/.test(t)) return 'warning';
    if (/aircraft|amdar|aviation/.test(t)) return 'aircraft';
    // Before upper air: wind profilers publish under upper-air-observations too.
    // Ocean profilers (e.g. ocean/.../drifting-ocean-profilers, Argo floats) are buoys
    if (/profil/.test(t) && !/\/ocean\//.test(t)) return 'radarwind';
    if (/upper-air|radiosonde|\/temp(\/|$)|\/pilot(\/|$)/.test(t)) return 'upperair';
    if (/gnss|gpsmet|\/ztd(\/|$)/.test(t)) return 'gnss';
    if (/\/ship/.test(t)) return 'ship';
    if (/buoy|float|argo|glider|mooring|tide-gauge|ocean\//.test(t)) return 'buoy';
    if (/surface-based-observations|synop|\/climate\//.test(t)) return 'station';
    return 'other';
}

// A WIGOS station identifier (0-20000-0-12345) in a data_id
const WIGOS_ID = /(?!WIGOS_)(\d-\d+-\d-[\d0-9a-zA-Z]+)/g;

// The station a notification is from: its WIGOS identifier, given or in its data_id
export function stationId(props) {
    var match = (props.data_id || '').match(WIGOS_ID);
    return props.wigos_station_identifier || (match ? match.pop() : null);
}

// Points as-is; small areas (e.g. station Polygons) at their center.
// Large areas such as model domains are skipped since a center is meaningless.
export function pointFor(geometry) {
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

export function wis2boxVersion(feature) {
    var by = feature && (feature.generated_by || (feature.properties && feature.properties.generated_by));
    var match = typeof by === 'string' && by.match(/^wis2box\s+(\S+)/i);
    return match ? match[1] : null;
}
