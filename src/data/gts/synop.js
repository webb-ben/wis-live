// Text SYNOPs from the GTS: FM 12 (land stations, AAXX) and FM 13 (ships, BBXX)
// in traditional alphanumeric code, read into BUFR-style rows so they're shown
// and coloured like decoded BUFR, and put on the map. Ships carry their position;
// a land station's comes from the same station already plotted from BUFR (WIS2 or
// GTS), and until it has been, its latest report waits
import { OBS_CLASSES } from '../../config.js';
import { disciplineOf } from '../../messages/messages.js';
import { records, latestByStation, newId, observedAt, addPoint, linkDecoded, countPlotted, decoding } from '../../map/points.js';
import { shipTrackKey } from '../reports.js';

// Where they come: under S/M (main hours), S/N (other hours) and S/I (intermediate hours)
export const SYNOP_TOPIC = /\/a\/wis2\/[^/]+-gts-to-wis2\/data\/core\/S\/[MNI]\//;

// Present weather, code table 4677 (manned stations)
export function presentWeather(ww) {
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
export function synopVisibility(vv) {
    if (vv <= 50) return vv * 100;
    if (vv >= 56 && vv <= 80) return (vv - 50) * 1000;
    if (vv >= 81 && vv <= 89) return (vv - 80) * 5000 + 30000;
    return { 90: 0, 91: 50, 92: 200, 93: 500, 94: 1000, 95: 2000, 96: 4000, 97: 10000, 98: 20000, 99: 50000 }[vv] ?? null;
}

// Pressure in tenths of hPa with the thousands left off (0123 is 1012.3 hPa), in Pa
export function synopPressure(g) {
    if (!/^\d{4}$/.test(g)) return null;
    var hpa = Number(g) / 10;
    return (hpa < 100 ? hpa + 1000 : hpa) * 100;
}

// Section 1 (and the parts of 2 and 3 worth showing) as BUFR-style rows, so the
// popup, wind arrows and colouring treat them like decoded BUFR
export function synopRows(groups, windUnit) {
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
export function synopTime(yygg, pubtime) {
    var pub = new Date(Date.parse(pubtime) || Date.now());
    var day = Number(yygg.slice(0, 2)), hour = Number(yygg.slice(2, 4));
    if (!(day >= 1 && day <= 31 && hour <= 23)) return null;
    var month = pub.getUTCMonth() - (day > pub.getUTCDate() + 1 ? 1 : 0);
    return Date.UTC(pub.getUTCFullYear(), month, day, hour);
}

export function parseSynopBulletin(text, pubtime) {
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

const SYNOP_WAITING_MAX = 5000;
const STATION_COORDS_MAX = 50000;
const stationCoords = new Map();  // WIGOS id -> [lon, lat], from every station plotted
const synopWaiting = new Map();  // WIGOS id -> { job, report } for stations not yet seen

// Plots each report in a bulletin, or keeps it until its station is seen
export function plotSynopBulletin(job, text) {
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
        id: newId(),
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
        track: report.kind === 'ship' ? shipTrackKey(report.callSign) : null,
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
    countPlotted(job.kind);
    if (!job.linked) {
        job.linked = true;
        linkDecoded(job.key, record);
    }
}

// Every station plotted gives its position to text SYNOPs from it, including any waiting
export function rememberStation(record) {
    if (!record.wsi || record.synop || !record.coords) return;
    stationCoords.delete(record.wsi);
    stationCoords.set(record.wsi, record.coords);
    if (stationCoords.size > STATION_COORDS_MAX) stationCoords.delete(stationCoords.keys().next().value);
    var waiting = synopWaiting.get(record.wsi);
    if (!waiting) return;
    synopWaiting.delete(record.wsi);
    // Not while the station's own point is still being added
    setTimeout(() => decoding(waiting.job.kind) && plotSynop(waiting.job, waiting.report, record.coords));
}
