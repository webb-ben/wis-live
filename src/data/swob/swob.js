// ECCC SWOB-ML: Environment Canada's surface weather observations, one station's
// report per XML file (…-CWUK-AUTO-minute-swob.xml), published as recommended data on
// the origin channel only (dd1/dd2.weather.gc.ca, which send no CORS headers: they
// download through a proxy, see localProxyHosts.js). Each file is turned into the rows
// a BUFR report decodes to ([descriptor, name, value], in BUFR's units), so it's drawn,
// coloured and shown like any decoded station. Stations report every minute, hundreds
// a minute in all: only the reports on the hour are read (…-1700-…), each station at most
// once every SWOB_STATION_GAP_MS, newest first. About 1,000 stations an hour, which keeps
// a proxy's requests (the live site's, see proxy/) within reach of a free plan

export const SWOB_STATION_GAP_MS = 50 * 60e3;  // Under an hour, so a late on-the-hour report still goes

// The report's time from its name (2026-11-23-1700-CWUK-AUTO-minute-swob.xml): on the hour?
export function onTheHour(href) {
    var file = (href || '').split(/[?#]/)[0].split('/').pop();
    var m = /^\d{4}-\d{2}-\d{2}-\d{2}(\d{2})-/.exec(file);
    return !!m && m[1] === '00';
}

const FETCHES = 4;  // Downloads at once

const WAITING_MAX = 500;  // Stations waiting; the longest waiting goes when full

const waiting = new Map();  // station -> its newest job not yet fetched
const taken = new Map();  // station -> when it was last downloaded
let fetching = 0;

// The station a file is from: its name after the time (CWUK-AUTO), without minute-swob.xml
export function swobStation(href) {
    var file = (href || '').split(/[?#]/)[0].split('/').pop();
    var m = /^\d{4}-\d{2}-\d{2}-\d{4}-(.+?)(?:-minute)?-swob\.xml$/i.exec(file);
    return m ? m[1].toUpperCase() : file;
}

// A file announced: it replaces any of the same station waiting, unless that station
// was downloaded too recently. fetchFile(job) downloads and plots it, returning a promise
export function queueSwob(job, fetchFile) {
    var link = (job.feature.links || []).find((l) => l.rel === 'canonical' || l.rel === 'update') || {};
    if (!onTheHour(link.href || job.href)) return false;  // Only the report on the hour
    var station = swobStation(link.href || job.href);
    if (Date.now() - (taken.get(station) || 0) < SWOB_STATION_GAP_MS) return false;
    waiting.delete(station);
    waiting.set(station, job);
    if (waiting.size > WAITING_MAX) waiting.delete(waiting.keys().next().value);
    pump(fetchFile);
    return true;
}

export function clearSwob() {
    waiting.clear();
}

function pump(fetchFile) {
    while (fetching < FETCHES && waiting.size) {
        var [station, job] = [...waiting].pop();  // The newest announced
        waiting.delete(station);
        taken.set(station, Date.now());
        if (taken.size > 10000) taken.delete(taken.keys().next().value);
        fetching++;
        fetchFile(job).finally(() => {
            fetching--;
            pump(fetchFile);
        });
    }
}

// SWOB element -> BUFR descriptor and name. Where several elements give one value, the
// first present wins (10-minute averages before 2-minute and 1-minute ones)
const ELEMENTS = [
    [['air_temp'], 12101, 'AIR TEMPERATURE'],
    [['dwpt_temp'], 12103, 'DEWPOINT TEMPERATURE'],
    [['rel_hum'], 13003, 'RELATIVE HUMIDITY'],
    [['mslp'], 10051, 'PRESSURE REDUCED TO MEAN SEA LEVEL'],
    [['stn_pres'], 10004, 'PRESSURE'],
    [['avg_wnd_dir_10m_pst10mts', 'avg_wnd_dir_10m_pst2mts', 'avg_wnd_dir_10m_pst1mt'], 11001, 'WIND DIRECTION'],
    [['avg_wnd_spd_10m_pst10mts', 'avg_wnd_spd_10m_pst2mts', 'avg_wnd_spd_10m_pst1mt'], 11002, 'WIND SPEED'],
    [['max_wnd_spd_10m_pst10mts', 'max_wnd_spd_10m_pst1hr'], 11041, 'MAXIMUM WIND GUST SPEED'],
    [['vis'], 20001, 'HORIZONTAL VISIBILITY'],
    [['snw_dpth', 'avg_snw_dpth_pst5mts'], 13013, 'TOTAL SNOW DEPTH'],
    [['pcpn_amt_pst1hr', 'rnfl_amt_pst1hr'], 13019, 'TOTAL PRECIPITATION PAST 1 HOUR'],
    [['pcpn_amt_pst6hrs'], 13021, 'TOTAL PRECIPITATION PAST 6 HOURS'],
    [['pcpn_amt_pst24hrs'], 13023, 'TOTAL PRECIPITATION PAST 24 HOURS'],
    [['max_air_temp_pst1hr'], 12111, 'MAXIMUM TEMPERATURE, PAST 1 HOUR'],
    [['min_air_temp_pst1hr'], 12112, 'MINIMUM TEMPERATURE, PAST 1 HOUR'],
];

// SWOB's units to BUFR's
const TO_BUFR = {
    '°C': (v) => v + 273.15,
    'hPa': (v) => v * 100,
    'kPa': (v) => v * 1000,
    'km/h': (v) => v / 3.6,
    'cm': (v) => v / 100,
    'km': (v) => v * 1000,
};

// The rows for a SWOB-ML file, or null if it has no location. Also returns the
// station's id: its WMO number as a WIGOS id, else ECCC's own (msc_id)
export function parseSwob(xml) {
    var doc = new DOMParser().parseFromString(xml, 'application/xml');
    var elements = new Map();
    for (var el of doc.getElementsByTagName('element')) {
        var value = el.getAttribute('value');
        if (value == null || value === 'MSNG' || elements.has(el.getAttribute('name'))) continue;
        elements.set(el.getAttribute('name'), { value, uom: el.getAttribute('uom') });
    }
    var number = (name) => {
        var e = elements.get(name);
        var v = e ? Number(e.value) : NaN;
        return isFinite(v) ? (TO_BUFR[e.uom] || ((x) => x))(v) : undefined;
    };
    var lat = Number((elements.get('lat') || {}).value), lon = Number((elements.get('long') || {}).value);
    if (!isFinite(lat) || !isFinite(lon)) return null;
    var rows = [];
    var wmo = (elements.get('wmo_synop_id') || {}).value;
    if (/^\d{5}$/.test(wmo || '')) rows.push([1001, 'WMO BLOCK NUMBER', Number(wmo.slice(0, 2))], [1002, 'WMO STATION NUMBER', Number(wmo.slice(2))]);
    var name = (elements.get('stn_nam') || {}).value;
    if (name) rows.push([1015, 'STATION OR SITE NAME', name]);
    var time = new Date((elements.get('date_tm') || {}).value);
    if (isFinite(time)) {
        rows.push([4001, 'YEAR', time.getUTCFullYear()], [4002, 'MONTH', time.getUTCMonth() + 1], [4003, 'DAY', time.getUTCDate()],
            [4004, 'HOUR', time.getUTCHours()], [4005, 'MINUTE', time.getUTCMinutes()]);
    }
    rows.push([5001, 'LATITUDE (HIGH ACCURACY)', lat], [6001, 'LONGITUDE (HIGH ACCURACY)', lon]);
    var elevation = Number((elements.get('stn_elev') || {}).value);
    if (isFinite(elevation)) rows.push([7030, 'HEIGHT OF STATION GROUND ABOVE MEAN SEA LEVEL', elevation]);
    for (var [names, id, label] of ELEMENTS) {
        var found = names.map(number).find((v) => v !== undefined);
        if (found !== undefined) rows.push([id, label, Math.round(found * 1000) / 1000]);
    }
    var mscId = (elements.get('msc_id') || {}).value;
    var wsi = /^\d{5}$/.test(wmo || '') ? `0-20000-0-${wmo}` : mscId ? `msc:${mscId}` : null;
    return { rows, wsi };
}
