// Open model data outside WIS2, listed on the forecasts page apart from WIS2's products (grib.js
// loadOpenModels): NOAA's GFS and HRRR and the Met Office's global model on AWS's open data, and ECMWF's IFS from
// data.ecmwf.int. Each lets a browser read it (Access-Control-Allow-Origin: *) and by range,
// and gives each file an index of where every field is in it (.idx lines for NOAA's, JSON
// lines for ECMWF's), so a field is downloaded on its own when it's drawn.
//
// For a model: the latest run whose files are all there (its last step listed has an index),
// then one field header per variable (its grid, name and level), from the first step that
// has it. Every step after that is listed from the same header; where a step's field is in
// its file is looked up in that step's index only when it's drawn (resolveField)
import { fetchHead } from '../download.js';
import { parseGribHeader } from './gribHeader.js';

const range = (from, to, step) => Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step);
const ymd = (run) => run.toISOString().slice(0, 10).replace(/-/g, '');
const hh = (run) => run.toISOString().slice(11, 13);
const pad = (n, width) => String(n).padStart(width, '0');

// A field: a NOAA .idx line's text (":TMP:2 m above ground:") or ECMWF's index keys; speed: wind
// speed from two such, its u and v components; from: its first step (accumulations have none at 0)
const SPEED = (u, v) => ({ speed: [u, v] });

export const OPEN_MODELS = {
    gfs: {
        centre: 'us-noaa-nws', label: 'GFS 0.25°, global (NOAA open data)', every: 6,
        url: (run, step) => `https://noaa-gfs-bdp-pds.s3.amazonaws.com/gfs.${ymd(run)}/${hh(run)}/atmos/gfs.t${hh(run)}z.pgrb2.0p25.f${pad(step, 3)}`,
        index: (url) => `${url}.idx`,
        steps: [...range(0, 120, 3), ...range(126, 240, 6)],
        fields: [
            { idx: ':TMP:2 m above ground:' }, { idx: ':DPT:2 m above ground:' }, { idx: ':RH:2 m above ground:' },
            { idx: ':PRMSL:mean sea level:' }, { idx: ':GUST:surface:' },
            SPEED({ idx: ':UGRD:10 m above ground:' }, { idx: ':VGRD:10 m above ground:' }),
            { idx: ':APCP:surface:0-', from: 3 }, { idx: ':TCDC:entire atmosphere:', from: 3 }, { idx: ':CAPE:surface:' },
            { idx: ':HGT:500 mb:' }, { idx: ':TMP:850 mb:' }, { idx: ':TMP:500 mb:' }, { idx: ':RH:850 mb:' },
        ],
    },
    hrrr: {
        centre: 'us-noaa-nws', label: 'HRRR 3 km, United States (NOAA open data)', every: 1,
        url: (run, step) => `https://noaa-hrrr-bdp-pds.s3.amazonaws.com/hrrr.${ymd(run)}/conus/hrrr.t${hh(run)}z.wrfsfcf${pad(step, 2)}.grib2`,
        index: (url) => `${url}.idx`,
        steps: range(0, 18, 1),
        fields: [
            { idx: ':TMP:2 m above ground:' }, { idx: ':DPT:2 m above ground:' }, { idx: ':REFC:entire atmosphere:' },
            { idx: ':GUST:surface:' }, SPEED({ idx: ':UGRD:10 m above ground:' }, { idx: ':VGRD:10 m above ground:' }),
            { idx: ':APCP:surface:0-', from: 1 }, { idx: ':TCDC:entire atmosphere:' }, { idx: ':CAPE:surface:' },
            { idx: ':VIS:surface:' },
        ],
    },
    // The Met Office's global model on AWS: a NetCDF file per variable and step, named by its
    // valid time (…/20261124T0000Z/20261124T0300Z-PT0003H00M-temperature_at_screen_level.nc), read
    // whole by the decoder's NetCDF reader. 00Z and 12Z runs go to 168 h. Single levels only: a
    // file of all the pressure levels runs to 270-430 MB
    ukmo: {
        centre: 'uk-metoffice', label: 'Global 10 km (Met Office open data)', every: 12, format: 'netcdf',
        url: (run, step, variable) => {
            var stamp = (t) => `${ymd(t)}T${hh(t)}00Z`;
            return `https://met-office-atmospheric-model-data.s3.eu-west-2.amazonaws.com/global-deterministic-10km/${stamp(run)}/`
                + `${stamp(new Date(run.getTime() + step * 3600e3))}-PT${pad(step, 4)}H00M-${variable}.nc`;
        },
        steps: [...range(0, 54, 3), ...range(60, 168, 6)],
        fields: [
            { nc: 'temperature_at_screen_level', name: 'Temperature, screen level (1.5 m)' },
            { nc: 'temperature_of_dew_point_at_screen_level', name: 'Dew point, screen level (1.5 m)' },
            { nc: 'relative_humidity_at_screen_level', name: 'Relative humidity, screen level (1.5 m)' },
            { nc: 'pressure_at_mean_sea_level', name: 'Pressure reduced to MSL' },
            { nc: 'wind_speed_at_10m', name: 'Wind speed, 10 m above ground' },
            { nc: 'wind_gust_at_10m', name: 'Wind gust, 10 m above ground' },
            { nc: 'cloud_amount_of_total_cloud', name: 'Total cloud cover' },
            { nc: 'precipitation_rate', name: 'Precipitation rate' },
            { nc: 'precipitation_accumulation-PT01H', name: 'Precipitation, past hour', from: 3 },
            { nc: 'CAPE_surface', name: 'Convective available potential energy (CAPE), surface' },
            { nc: 'visibility_at_screen_level', name: 'Visibility, screen level' },
            { nc: 'snow_depth_water_equivalent', name: 'Snow depth (water equivalent)' },
        ],
    },
    ifs: {
        centre: 'int-ecmwf', label: 'IFS 0.25°, global (ECMWF open data)', every: 12,
        url: (run, step) => `https://data.ecmwf.int/forecasts/${ymd(run)}/${hh(run)}z/ifs/0p25/oper/${ymd(run)}${hh(run)}0000-${step}h-oper-fc.grib2`,
        index: (url) => url.replace(/\.grib2$/, '.index'),
        steps: [...range(0, 144, 3), ...range(150, 240, 6)],
        fields: [
            // ECMWF names mean sea level pressure "Pressure" at MSL, and gives its precipitation in
            // metres under a rate's number: renamed, and made mm, for the app's scales
            { ecmwf: { param: '2t' } }, { ecmwf: { param: '2d' } }, { ecmwf: { param: 'msl' }, name: 'Pressure reduced to MSL' },
            SPEED({ ecmwf: { param: '10u' } }, { ecmwf: { param: '10v' } }),
            { ecmwf: { param: 'tp' }, from: 3, name: 'Total precipitation', factor: 1000 }, { ecmwf: { param: 'tcwv' } },
            { ecmwf: { param: 'gh', levelist: '500' } }, { ecmwf: { param: 't', levelist: '850' } }, { ecmwf: { param: 't', levelist: '500' } },
            { ecmwf: { param: 'r', levelist: '850' } },
        ],
    },
};

// A NetCDF model's run: every field and step, listed without reading any (each file one
// variable at one step, named in the model's spec); a file's size, needed to read it whole,
// is asked for only when it's drawn (resolve)
function netcdfSteps(model, run) {
    var out = [];
    for (var spec of model.fields) {
        for (var step of model.steps) {
            if (step < (spec.from || 0)) continue;
            let url = model.url(run, step, spec.nc);
            out.push({ model, run, step, url, netcdf: true, name: spec.name,
                resolve: async (signal) => {
                    var response = await fetch(url, { method: 'HEAD', signal, cache: 'no-store' });
                    if (!response.ok) throw new Error(`this time step's file isn't there (HTTP ${response.status})`);
                    return { length: Number(response.headers.get('Content-Length')) || null };
                } });
        }
    }
    return out;
}

// Indexes read, by address (the latest few: each step's is asked for when it's drawn)
const indexes = new Map();
async function readIndex(url, signal) {
    if (indexes.has(url)) return indexes.get(url);
    var response = await fetch(url, { signal, cache: 'no-store' });
    if (!response.ok) throw new Error(`its index isn't there (HTTP ${response.status})`);
    var text = await response.text();
    indexes.set(url, text);
    if (indexes.size > 60) indexes.delete(indexes.keys().next().value);
    return text;
}

// Where a field is in a file, from the file's index: { offset, length } (length null for a last
// field, read to the end), or null where the index doesn't have it
function findInIndex(text, spec) {
    if (spec.ecmwf) {
        for (var line of text.split('\n')) {
            if (!line.trim()) continue;
            var e = JSON.parse(line);
            if (Object.entries(spec.ecmwf).every(([k, v]) => String(e[k]) === v)) return { offset: e._offset, length: e._length };
        }
        return null;
    }
    var lines = text.split('\n').filter(Boolean).map((l) => l.split(':'));
    for (var i = 0; i < lines.length; i++) {
        if (!`:${lines[i].slice(3).join(':')}`.startsWith(spec.idx)) continue;
        var offset = Number(lines[i][1]);
        var next = lines[i + 1] ? Number(lines[i + 1][1]) : null;
        return { offset, length: next != null ? next - offset : null };
    }
    return null;
}

// Where a step's field is: its file's index read (once), the field found in it
export async function resolveField(model, spec, url, signal) {
    var found = findInIndex(await readIndex(model.index(url), signal), spec);
    if (!found) throw new Error('this time step has no such field');
    return found;
}

// The latest run whose last step listed has its index (so all its steps are there), trying
// back four runs from now
async function latestRun(model) {
    var last = model.steps[model.steps.length - 1];
    var now = Date.now(), every = model.every * 3600e3;
    for (var back = 0; back < 5; back++) {
        var run = new Date(Math.floor(now / every) * every - back * every);
        // A GRIB model's last step's index, or a NetCDF one's last step's first file
        var probe = model.format === 'netcdf' ? model.url(run, last, model.fields[0].nc) : model.index(model.url(run, last));
        try {
            var response = await fetch(probe, { method: 'GET', headers: { Range: 'bytes=0-0' }, cache: 'no-store' });
            if (response.ok) return run;
        } catch (err) {
            // Unreachable for now: an earlier run, or none
        }
    }
    return null;
}

// A field's header (its grid, name, level), from its first step's file: its first 16 KB
async function fieldHeader(model, spec, run) {
    var step = model.steps.find((s) => s >= (spec.from || 0));
    var url = model.url(run, step);
    var { offset, length } = await resolveField(model, spec, url);
    var { bytes } = await fetchHead({ urls: [url], dataId: null, topic: null }, Math.min(length || 16384, 16384), offset);
    return parseGribHeader(bytes);
}

// A model's latest run, to list: [{ header, step, url, resolve, combine }] for every field and
// step, or null where the run can't be found. Wind speed's header is its u component's, named
// Wind speed (so it takes the wind scale); its parts are read and combined when it's drawn
export async function openModelSteps(id) {
    var model = OPEN_MODELS[id];
    var run = await latestRun(model);
    if (!run) return null;
    if (model.format === 'netcdf') return netcdfSteps(model, run);
    var out = [];
    for (var spec of model.fields) {
        var parts = spec.speed || [spec];
        try {
            var headers = await Promise.all(parts.map((part) => fieldHeader(model, part, run)));
        } catch (err) {
            console.debug(`${id}: no ${parts.map((p) => p.idx || JSON.stringify(p.ecmwf)).join(' and ')} (${err.message})`);
            continue;
        }
        var header = spec.speed ? { ...headers[0], parameter: 'Wind speed' } : spec.name ? { ...headers[0], parameter: spec.name } : headers[0];
        for (var step of model.steps) {
            if (step < (spec.from || 0)) continue;
            let url = model.url(run, step);
            out.push({ model, run, step, url, header, factor: spec.factor || null,
                parts: parts.map((part, i) => ({ header: headers[i], href: url, source: { urls: [url], dataId: null, topic: null },
                    resolve: (signal) => resolveField(model, part, url, signal) })) });
        }
    }
    return out;
}
