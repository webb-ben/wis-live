// Model forecasts at a point, from the dynamical.org point API (GFS and ECMWF's
// AIFS), compared with what the station observed: a table of observed against
// forecast, and a chart of each model's next week
import { esc, svgEl } from '../lib/util.js';
import { reportTime } from '../data/reports.js';

// GFS and ECMWF's AIFS (its AI model) are both deterministic runs; an ensemble
// model would be drawn as its median with the 10th-90th percentile spread.
// Fetched only when asked for, one batch for all models.
export const FORECAST_API = 'https://api.dynamical.org/v1/forecasts';

export const FORECAST_HOURS = 168;

// Each model is asked only for variables it has (the API rejects the rest);
// together they cover every observed quantity the popup compares against
export const FORECAST_COMMON = ['temperature_2m', 'wind_u_10m', 'wind_v_10m', 'precipitation_surface', 'pressure_reduced_to_mean_sea_level',
    'pressure_surface', 'total_cloud_cover_atmosphere', 'downward_short_wave_radiation_flux_surface'];

export const FORECAST_MODELS = [
    // GFS precipitation and radiation are averaged since the last 6-hourly reset rather than over each step
    { id: 'noaa-gfs-forecast', label: 'GFS', cls: 'gfs', source: 'NOAA GFS', precipReset: 6,
        variables: [...FORECAST_COMMON, 'relative_humidity_2m', 'maximum_temperature_2m', 'minimum_temperature_2m'] },
    { id: 'ecmwf-aifs-single-forecast', label: 'ECMWF AIFS', cls: 'ecmwf', source: 'ECMWF AIFS Single',
        variables: [...FORECAST_COMMON, 'dew_point_temperature_2m', 'temperature_850hpa', 'temperature_925hpa',
            'geopotential_height_500hpa', 'geopotential_height_850hpa', 'geopotential_height_925hpa'] },
];

export const FORECAST_CACHE_MS = 15 * 60 * 1000;

export const forecastCache = new Map();  // rounded "lat,lon" -> { time, promise }

// The forecasts for a point on the map, in out. resized(): the panel's height changed
export async function showForecast(out, record, resized) {
    out.innerHTML = `<div class="pp-status">Loading ${FORECAST_MODELS.map((m) => m.label).join(' and ')} forecasts…</div>`;
    resized();
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
        retry.addEventListener('click', () => showForecast(out, record, resized));
        out.appendChild(retry);
    }
    resized();
}

// Nearby points share a grid cell, so reuse a recent answer rather than asking again
export function fetchForecast([lon, lat]) {
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
export function parseForecast(model, result) {
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

// Observation vs forecast. Each quantity says which BUFR elements hold
// the observation and how a model gives the same thing, so a report is compared
// on everything it has that a model also forecasts.
export const MAGNUS_A = 17.625, MAGNUS_B = 243.04;

export function dewPoint(t, rh) {
    if (t === null || rh === null || !(rh > 0)) return null;
    var g = Math.log(rh / 100) + MAGNUS_A * t / (MAGNUS_B + t);
    return MAGNUS_B * g / (MAGNUS_A - g);
}

export function relHumidity(t, td) {
    if (t === null || td === null) return null;
    return Math.min(100, 100 * Math.exp(MAGNUS_A * td / (MAGNUS_B + td) - MAGNUS_A * t / (MAGNUS_B + t)));
}

// Linear interpolation of a series at time t; null outside the run
export function seriesAt(forecast, name, t) {
    var values = forecast.series[name], times = forecast.times;
    if (!values || t < times[0] || t > times[times.length - 1]) return null;
    var i = times.findIndex((x) => x >= t);
    if (times[i] === t || i === 0) return values[i];
    var a = values[i - 1], b = values[i];
    if (a === null || b === null) return a === null ? b : a;
    return a + (b - a) * (t - times[i - 1]) / (times[i] - times[i - 1]);
}

// Instantaneous quantities, derived where a model lacks the variable itself
export function forecastAt(forecast, key, t) {
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
export function cumulative(forecast, name) {
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

export function windowTotal(forecast, name, start, end) {
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
export function windowExtreme(forecast, start, end, max) {
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
export function observedNow(record) {
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
export function forecastFor(forecast, item, t) {
    if (item.key === 'precip') return windowTotal(forecast, 'precipitation_surface', item.from, item.to);
    if (item.key === 'solar') {
        var joules = windowTotal(forecast, 'downward_short_wave_radiation_flux_surface', item.from, item.to);
        return joules === null ? null : joules / ((item.to - item.from) / 1000);
    }
    if (item.key === 'tmax' || item.key === 'tmin') return windowExtreme(forecast, item.from, item.to, item.key === 'tmax');
    return forecastAt(forecast, item.key, t);
}

export function compareTable(models, observed) {
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

export function quantile(values, q) {
    if (!values.length) return null;
    var sorted = values.slice().sort((a, b) => a - b);
    var pos = (sorted.length - 1) * q, lo = Math.floor(pos);
    return sorted[lo] + (sorted[Math.min(lo + 1, sorted.length - 1)] - sorted[lo]) * (pos - lo);
}

export function mean(values) {
    return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

// Precipitation as 6-hour totals, so hourly and 3-hourly steps compare. Each
// step's rate covers the time back to the step before it, except where the
// model averages since a 6-hourly reset: then the step at each reset holds
// the average of the whole 6 hours.
export function sixHourly(steps, model) {
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

export function renderForecast(out, models, observed) {
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
export function renderForecastChart(container, models, observed, opts) {
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
