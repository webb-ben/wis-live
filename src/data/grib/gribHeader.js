// What a GRIB2 file holds, from the headers of its first message (sections 0 to 4,
// WMO-No. 306, FM 92 GRIB edition 2): who made it, the run, the variable, the level,
// the lead time, ensemble and probability details, and the grid, with an outline of
// the area the grid covers. Only the start of the file is needed (fetchHead). No
// values are decoded. Plain functions, no browser APIs, so they can be tested in Node

import { WMO_PARAMETERS, LOCAL_PARAMETERS, WMO_CATEGORIES, WMO_SURFACES } from './gribTables.js';

// Centres (common code table C-11), the ones seen in WIS2
const CENTRES = { 7: 'NCEP', 34: 'JMA', 38: 'CMA', 40: 'KMA', 54: 'ECCC (Montréal)', 74: 'Met Office', 78: 'DWD',
    80: 'Rome', 85: 'Météo-France', 98: 'ECMWF', 28: 'IMD', 46: 'INPE', 69: 'NIWA' };

// Parameters (code table 4.2), by discipline, category and number: the common ones
const PARAMETERS = {
    0: {  // Meteorological
        0: { 0: 'Temperature', 2: 'Potential temperature', 4: 'Maximum temperature', 5: 'Minimum temperature', 6: 'Dew point', 17: 'Skin temperature' },
        // WMO code table 4.2, discipline 0 category 1 (moisture), 0 to 86
        1: { 0: 'Specific humidity', 1: 'Relative humidity', 2: 'Humidity mixing ratio', 3: 'Precipitable water', 4: 'Vapour pressure',
            5: 'Saturation deficit', 6: 'Evaporation', 7: 'Precipitation rate', 8: 'Total precipitation', 9: 'Large-scale precipitation',
            10: 'Convective precipitation', 11: 'Snow depth', 12: 'Snowfall rate (water equivalent)', 13: 'Snow water equivalent',
            14: 'Convective snow', 15: 'Large-scale snow', 16: 'Snow melt', 17: 'Snow age', 18: 'Absolute humidity', 19: 'Precipitation type',
            20: 'Integrated liquid water', 21: 'Condensate', 22: 'Cloud mixing ratio', 23: 'Ice water mixing ratio', 24: 'Rain mixing ratio',
            25: 'Snow mixing ratio', 26: 'Horizontal moisture convergence', 27: 'Maximum relative humidity', 28: 'Maximum absolute humidity',
            29: 'Total snowfall', 30: 'Precipitable water category', 31: 'Hail', 32: 'Graupel', 33: 'Categorical rain',
            34: 'Categorical freezing rain', 35: 'Categorical ice pellets', 36: 'Categorical snow', 37: 'Convective precipitation rate',
            38: 'Horizontal moisture divergence', 39: 'Percent frozen precipitation', 40: 'Potential evaporation', 41: 'Potential evaporation rate',
            42: 'Snow cover', 43: 'Rain fraction of total cloud water', 44: 'Rime factor', 45: 'Total column rain', 46: 'Total column snow',
            47: 'Large-scale water precipitation', 48: 'Convective water precipitation', 49: 'Total water precipitation',
            50: 'Total snow precipitation', 51: 'Total column water', 52: 'Total precipitation rate', 53: 'Total snowfall rate (water equivalent)',
            54: 'Large-scale precipitation rate', 55: 'Convective snowfall rate (water equivalent)', 56: 'Large-scale snowfall rate (water equivalent)',
            57: 'Total snowfall rate', 58: 'Convective snowfall rate', 59: 'Large-scale snowfall rate', 60: 'Snow depth (water equivalent)',
            61: 'Snow density', 62: 'Snow evaporation', 64: 'Total column water vapour', 65: 'Rain precipitation rate', 66: 'Snow precipitation rate',
            67: 'Freezing rain precipitation rate', 68: 'Ice pellets precipitation rate', 69: 'Total column cloud water', 70: 'Total column cloud ice',
            71: 'Hail mixing ratio', 72: 'Total column hail', 73: 'Hail precipitation rate', 74: 'Total column graupel', 75: 'Graupel precipitation rate',
            76: 'Convective rain rate', 77: 'Large-scale rain rate', 78: 'Total column water (all phases)', 79: 'Evaporation rate',
            80: 'Total condensate', 81: 'Total column condensate', 82: 'Cloud ice mixing ratio', 83: 'Specific cloud liquid water',
            84: 'Specific cloud ice water', 85: 'Specific rain water', 86: 'Specific snow water' },
        2: { 0: 'Wind direction', 1: 'Wind speed', 2: 'Wind (u, eastward)', 3: 'Wind (v, northward)', 8: 'Vertical velocity (pressure)',
            9: 'Vertical velocity', 10: 'Absolute vorticity', 12: 'Relative vorticity', 22: 'Wind gust', 25: 'Vertical wind shear' },
        3: { 0: 'Pressure', 1: 'Pressure reduced to MSL', 2: 'Pressure tendency', 3: 'ICAO standard atmosphere height', 4: 'Geopotential',
            5: 'Geopotential height', 6: 'Geometric height', 7: 'Standard deviation of height', 8: 'Pressure anomaly',
            9: 'Geopotential height anomaly', 10: 'Density', 18: 'Boundary layer height' },
        4: { 7: 'Downward short-wave radiation flux', 9: 'Net short-wave radiation flux' },
        5: { 3: 'Downward long-wave radiation flux', 5: 'Outgoing long-wave radiation' },
        6: { 0: 'Cloud ice', 1: 'Total cloud cover', 2: 'Convective cloud cover', 3: 'Low cloud cover', 4: 'Medium cloud cover',
            5: 'High cloud cover', 6: 'Cloud water', 7: 'Cloud amount', 8: 'Cloud type', 11: 'Cloud base', 12: 'Cloud top',
            13: 'Ceiling', 22: 'Cloud cover', 23: 'Cloud ice mixing ratio', 25: 'Fraction of cloud cover' },
        7: { 6: 'Convective available potential energy (CAPE)', 7: 'Convective inhibition', 8: 'Storm relative helicity' },
        16: { 4: 'Radar reflectivity', 5: 'Composite reflectivity' },
        19: { 0: 'Visibility', 1: 'Albedo', 2: 'Thunderstorm probability' },
    },
    2: {  // Land surface
        0: { 0: 'Land cover', 2: 'Soil temperature', 22: 'Soil moisture' },
        3: { 18: 'Soil temperature', 20: 'Soil moisture' },
    },
    10: {  // Oceanographic
        0: { 3: 'Significant wave height (wind waves and swell)', 4: 'Wind wave direction', 5: 'Significant wind wave height',
            10: 'Primary wave direction', 11: 'Primary wave mean period', 16: 'Coefficient of drag with waves', 17: 'Friction velocity',
            34: 'Peak wave period' },
        3: { 0: 'Sea surface temperature', 1: 'Sea surface height' },
    },
};

// Parameter categories (code table 4.1), for parameters not named above, and for centres'
// own (local, numbered 192 and up)
const CATEGORIES = {
    0: { 0: 'Temperature', 1: 'Moisture', 2: 'Momentum', 3: 'Mass', 4: 'Short-wave radiation', 5: 'Long-wave radiation', 6: 'Cloud',
        7: 'Stability', 13: 'Aerosols', 14: 'Trace gases', 15: 'Radar', 16: 'Forecast radar imagery', 19: 'Physical atmospheric',
        20: 'Atmospheric chemistry' },
    2: { 0: 'Vegetation and biomass', 3: 'Soil', 4: 'Fire weather' },
    10: { 0: 'Waves', 1: 'Currents', 2: 'Ice', 3: 'Sea surface', 4: 'Sub-surface' },
};

const DISCIPLINES = { 0: 'Meteorological', 1: 'Hydrological', 2: 'Land surface', 3: 'Satellite remote sensing', 4: 'Space weather', 10: 'Oceanographic' };

// Fixed surfaces (code table 4.5): a name, and how to show its value
const SURFACES = {
    1: ['Surface'], 2: ['Cloud base'], 3: ['Cloud top'], 4: ['0 °C isotherm'], 6: ['Maximum wind level'], 7: ['Tropopause'],
    8: ['Top of atmosphere'], 10: ['Entire atmosphere'], 100: ['', (v) => `${v / 100} hPa`], 101: ['Mean sea level'],
    102: ['', (v) => `${v} m above sea level`], 103: ['', (v) => `${v} m above ground`], 104: ['', (v) => `Sigma ${v}`],
    105: ['', (v) => `Hybrid level ${v}`], 106: ['', (v) => `${v} m below land surface`], 107: ['', (v) => `${v} K isentrope`],
    108: ['', (v) => `${v / 100} hPa above ground`], 160: ['', (v) => `${v} m below sea level`], 200: ['Entire atmosphere (one layer)'],
};

// Time units (code table 4.4) in hours
const UNIT_HOURS = { 0: 1 / 60, 1: 1, 2: 24, 10: 3, 11: 6, 12: 12, 13: 1 / 3600 };

const PROCESSES = { 0: 'Analysis', 1: 'Initialization', 2: 'Forecast', 3: 'Bias-corrected forecast', 4: 'Ensemble forecast',
    5: 'Probability forecast', 6: 'Forecast error', 7: 'Analysis error', 8: 'Observation' };

const STATISTICS = { 0: 'Average', 1: 'Accumulation', 2: 'Maximum', 3: 'Minimum', 4: 'Difference', 6: 'Standard deviation' };

const DERIVED = { 0: 'Ensemble mean', 1: 'Weighted ensemble mean', 2: 'Ensemble standard deviation', 3: 'Normalised standard deviation',
    4: 'Ensemble spread', 5: 'Large anomaly index', 6: 'Cluster mean' };

const PROBABILITY = { 0: 'below', 1: 'above', 2: 'between', 3: 'above', 4: 'below' };

// A reader over the bytes, by octet number within a section starting at `base` (WMO
// numbers octets from 1). Signed values use the sign bit (not two's complement)
function reader(bytes, base) {
    var at = (n) => bytes[base + n - 1];
    var u = (n, size) => {
        var v = 0;
        for (var i = 0; i < size; i++) v = v * 256 + at(n + i);
        return v;
    };
    var s = (n, size) => {
        var v = u(n, size), top = 2 ** (8 * size - 1);
        return v >= top ? -(v - top) : v;
    };
    return { u1: (n) => at(n), u2: (n) => u(n, 2), u4: (n) => u(n, 4), s4: (n) => s(n, 4), s1: (n) => s(n, 1) };
}

// Where each section starts in the first message, as far as the bytes go
function sections(bytes) {
    var start = -1;
    for (var i = 0; i + 4 <= Math.min(bytes.length, 512); i++) {
        if (bytes[i] === 71 && bytes[i + 1] === 82 && bytes[i + 2] === 73 && bytes[i + 3] === 66) { start = i; break; }  // "GRIB"
    }
    if (start < 0) throw new Error('not GRIB');
    var found = { 0: start, edition: bytes[start + 7] };
    if (found.edition === 1) return found;  // Laid out differently (parseGrib1)
    // The message's whole length (octets 9 to 16), to download just the first message
    found.length = reader(bytes, start).u4(13) + reader(bytes, start).u4(9) * 2 ** 32;
    var at = start + 16;
    while (at + 5 <= bytes.length) {
        var r = reader(bytes, at);
        var length = r.u4(1), number = r.u1(5);
        if (length < 5 || number > 7 || found[number] !== undefined) break;
        found[number] = at;
        if (number === 7) break;  // The data: all that's wanted is where it starts
        at += length;
    }
    return found;
}

const level = (type, scale, value) => {
    if (type === 255) return null;
    var v = scale && scale !== 255 ? value / 10 ** scale : value;
    if (SURFACES[type]) {
        var [name, show] = SURFACES[type];
        return show ? show(Math.round(v * 1000) / 1000) : name;
    }
    // WMO's whole table (gribTables.js): its name, and the value where it has a unit
    var wmo = WMO_SURFACES[type];
    if (!wmo) return `Surface type ${type}`;
    var given = wmo[1] && value !== 0xffffffff && value != null && scale !== 255;
    return given ? `${wmo[0]} ${Math.round(v * 1000) / 1000} ${wmo[1]}` : wmo[0];
};

// The details of a GRIB file, from its first bytes (at least sections 0 to 4)
export function parseGribHeader(bytes) {
    var at = sections(bytes);
    if (at.edition === 1) return withLead(parseGrib1(bytes, at[0]), at[0]);
    if (at.edition !== 2) return { edition: at.edition };
    return withLead(parseGrib2(bytes, at), at[0]);
}

// A file can start with a GTS bulletin heading before "GRIB" (JMA's "HVMY03 RJTD 241800"):
// its length then counts from the start of the file, so a field's bytes, downloaded from
// there, take in the whole message, and the next message starts where it says
function withLead(out, start) {
    if (out.length) out.length += start;
    return out;
}

function parseGrib2(bytes, at) {
    var out = { edition: 2 };
    var discipline = bytes[at[0] + 6];
    out.discipline = DISCIPLINES[discipline] || `Discipline ${discipline}`;
    if (at[1] !== undefined) {
        var s1 = reader(bytes, at[1]);
        var centre = s1.u2(6);
        out.centre = CENTRES[centre] || `Centre ${centre}`;
        out.run = new Date(Date.UTC(s1.u2(13), s1.u1(15) - 1, s1.u1(16), s1.u1(17), s1.u1(18), s1.u1(19))).toISOString();
    }
    if (at[3] !== undefined) out.grid = parseGrid(reader(bytes, at[3]));
    if (at[4] !== undefined) Object.assign(out, parseProduct(reader(bytes, at[4]), discipline, out.run, centre));
    out.length = at.length;
    // How the values are packed (code table 5.0): 0 simple, 2 and 3 complex, 40 JPEG 2000,
    // 41 PNG, 42 CCSDS (AEC). gribField.js draws 0 and 40
    if (at[5] !== undefined) {
        out.packing = reader(bytes, at[5]).u2(10);
        out.bits = reader(bytes, at[5]).u1(20);  // Bits per packed value
    }
    return out;
}

// ---------- GRIB edition 1 (WMO-No. 306, FM 92-VIII; still sent on the GTS, e.g. JMA's
// H… and Y… bulletins): section 1 (product definition), 2 (grid, if there is one), 3
// (bitmap) and 4 (binary data), each its length in 3 octets. Read into the same shape as
// GRIB2's, so it's listed, outlined and drawn the same way (gribField.js decodeGrib1)

// Parameters (code table 2, the WMO's own, versions 1 to 3), named as GRIB2's are
const PARAMETERS_1 = { 1: 'Pressure', 2: 'Pressure reduced to MSL', 3: 'Pressure tendency', 6: 'Geopotential', 7: 'Geopotential height',
    8: 'Geometric height', 11: 'Temperature', 12: 'Virtual temperature', 13: 'Potential temperature', 15: 'Maximum temperature',
    16: 'Minimum temperature', 17: 'Dew point', 18: 'Dew point depression', 20: 'Visibility', 31: 'Wind direction', 32: 'Wind speed',
    33: 'Wind (u, eastward)', 34: 'Wind (v, northward)', 35: 'Stream function', 36: 'Velocity potential', 39: 'Vertical velocity (pressure)',
    40: 'Vertical velocity', 41: 'Absolute vorticity', 43: 'Relative vorticity', 44: 'Divergence', 51: 'Specific humidity',
    52: 'Relative humidity', 54: 'Precipitable water', 61: 'Total precipitation', 62: 'Large-scale precipitation',
    63: 'Convective precipitation', 65: 'Water equivalent of accumulated snow depth', 66: 'Snow depth', 71: 'Total cloud cover',
    72: 'Convective cloud cover', 73: 'Low cloud cover', 74: 'Medium cloud cover', 75: 'High cloud cover', 80: 'Sea surface temperature',
    81: 'Land cover', 82: 'Deviation of sea level from mean', 91: 'Ice cover', 100: 'Significant wave height (wind waves and swell)',
    101: 'Wind wave direction', 102: 'Significant wind wave height', 103: 'Mean wind wave period', 104: 'Swell direction',
    105: 'Significant swell height', 106: 'Mean swell period' };

// Levels (code table 3): [name] or ['', its value as text] (o11, o12: octets 11 and 12)
function level1(type, o11, o12) {
    var both = o11 * 256 + o12;
    var named = { 1: 'Surface', 2: 'Cloud base', 3: 'Cloud top', 4: '0 °C isotherm', 6: 'Maximum wind level', 7: 'Tropopause',
        8: 'Top of atmosphere', 9: 'Sea bottom', 102: 'Mean sea level', 200: 'Entire atmosphere (one layer)', 201: 'Entire ocean' }[type];
    if (named) return named;
    if (type === 100) return `${both} hPa`;
    if (type === 101) return `${o11 * 10} hPa to ${o12 * 10} hPa`;
    if (type === 103) return `${both} m above sea level`;
    if (type === 105) return `${both} m above ground`;
    if (type === 107) return `Sigma ${both / 10000}`;
    if (type === 109) return `Hybrid level ${both}`;
    if (type === 111) return `${both} cm below land surface`;
    if (type === 113) return `${both} K isentrope`;
    return `Level type ${type}`;
}

// Time units (code table 4) in hours
const UNIT_HOURS_1 = { 0: 1 / 60, 1: 1, 2: 24, 10: 3, 11: 6, 12: 12, 254: 1 / 3600 };

// Octets numbered from 1 within a section, as the standard numbers them
export function reader1(bytes, at) {
    var u = (n, size) => { var v = 0; for (var k = 0; k < size; k++) v = v * 256 + bytes[at + n - 1 + k]; return v; };
    // Sign and magnitude: the top bit is the sign
    var s = (n, size) => { var v = u(n, size), top = 2 ** (8 * size - 1); return v >= top ? -(v - top) : v; };
    return { u1: (n) => bytes[at + n - 1], u2: (n) => u(n, 2), u3: (n) => u(n, 3), s2: (n) => s(n, 2), s3: (n) => s(n, 3) };
}

function parseGrib1(bytes, start) {
    var out = { edition: 1, discipline: 'Meteorological' };
    out.length = reader1(bytes, start).u3(5);
    var s1at = start + 8, s1 = reader1(bytes, s1at);
    var s1len = s1.u3(1);
    out.centre = CENTRES[s1.u1(5)] || `Centre ${s1.u1(5)}`;
    var flags = s1.u1(8);
    var param = s1.u1(9);
    out.parameter = PARAMETERS_1[param] || `Parameter ${param} (table ${s1.u1(4)})`;
    out.level = level1(s1.u1(10), s1.u1(11), s1.u1(12));
    var century = s1.u1(25) || 21;
    var year = (century - 1) * 100 + s1.u1(13);
    out.run = new Date(Date.UTC(year, s1.u1(14) - 1, s1.u1(15), s1.u1(16), s1.u1(17))).toISOString();
    // The lead time, from the time range (code table 5): a forecast at P1; a period from P1 to
    // P2 (averages, accumulations), valid at its end, P2; P1 in two octets (10)
    var unit = UNIT_HOURS_1[s1.u1(18)], p1 = s1.u1(19), p2 = s1.u1(20), range = s1.u1(21);
    if (range === 10) p1 = s1.u2(19);
    if (unit !== undefined) {
        var hours = (v) => Math.round(v * unit * 100) / 100;
        out.leadHours = range === 1 ? 0 : [2, 3, 4, 5].includes(range) ? hours(p2) : hours(p1);
        out.valid = new Date(Date.parse(out.run) + out.leadHours * 3600e3).toISOString();
        if ([3, 4, 5].includes(range)) {
            var kind = { 3: 'Average', 4: 'Accumulation', 5: 'Difference' }[range];
            out.statistic = `${kind} over ${hours(p2 - p1)} h`;
            out.statisticName = p1 === 0 ? `${kind} from the start` : out.statistic;
        }
    }
    out.process = range === 1 ? 'Analysis' : 'Forecast';
    var D = s1.s2(27);
    var at = s1at + s1len;
    if (flags & 0x80) {
        var gds = reader1(bytes, at);
        out.grid = parseGrid1(gds);
        at += gds.u3(1);
    }
    out.bitmap = !!(flags & 0x40);
    if (flags & 0x40 && at + 3 <= bytes.length) at += reader1(bytes, at).u3(1);
    // Binary data section: how the values are packed (flag octet 4: spherical harmonics 0x80,
    // complex 0x40, else simple) and the bits per value
    if (at + 11 <= bytes.length) {
        var bds = reader1(bytes, at);
        var flag = bds.u1(4);
        out.packing = flag & 0x80 ? 50 : flag & 0x40 ? 2 : 0;
        out.bits = bds.u1(11);
    }
    out.decimalScale = D;
    return out;
}

// A quasi-regular grid's points in each row (Ni all ones, 65535): the list after any vertical
// coordinates, where octet 5 says (NV, octet 4, of them, 4 octets each). Null for a regular grid
export function thinnedRows(g, nj) {
    if (g.u2(7) !== 0xffff) return null;
    var nv = g.u1(4), at = g.u1(5);
    if (!at || at === 255) return null;
    var first = nv ? at + 4 * nv : at;
    return Array.from({ length: nj }, (_, j) => g.u2(first + 2 * j));
}

// The grid (code table 6): latitude/longitude (0), Gaussian (4), rotated (10), polar
// stereographic (5) and Lambert (3). Angles in thousandths of a degree
function parseGrid1(g) {
    var type = g.u1(6);
    var names = { 0: 'Latitude/longitude', 3: 'Lambert conformal', 4: 'Gaussian', 5: 'Polar stereographic', 10: 'Rotated latitude/longitude' };
    var grid = { template: type, name: names[type] || `Grid type ${type} (GRIB1)` };
    var deg = (v) => v / 1000;
    if (type === 0 || type === 4 || type === 10) {
        grid.ni = g.u2(7);
        grid.nj = g.u2(9);
        // A quasi-regular (thinned) grid: each row its own number of points, listed in the
        // section (JMA's octants: 2 at the pole to 73 at the equator). Drawn spread onto a
        // regular grid as wide as its widest row (gribField.js thinnedToRegular)
        var pl = thinnedRows(g, grid.nj);
        if (pl) {
            grid.ni = Math.max(...pl);
            grid.thinned = pl.reduce((a, b) => a + b, 0);
            grid.name += ', quasi-regular';
        }
        grid.points = grid.ni * grid.nj;
        var la1 = deg(g.s3(11)), lo1 = deg(g.s3(14)), la2 = deg(g.s3(18)), lo2 = deg(g.s3(21));
        var given = g.u1(17) & 0x80;
        var span = ((lo2 - lo1) % 360 + 360) % 360 || 360;
        var di = given && g.u2(24) !== 0xffff ? deg(g.u2(24)) : span / Math.max(1, grid.ni - (span >= 359.9 ? 0 : 1));
        var dj = given && type === 0 && g.u2(26) !== 0xffff ? deg(g.u2(26)) : Math.abs(la2 - la1) / Math.max(1, grid.nj - 1);
        var pole = type === 10 ? [deg(g.s3(33)), deg(g.s3(36))] : null;
        grid.resolution = `${round(di)}° × ${round(dj)}°`;
        grid.outline = pole ? rotatedOutline(la1, lo1, la2, lo2, pole) : latLonOutline(la1, lo1, la2, lo2, grid.ni, di);
        grid.geo = { kind: pole ? 'rotated' : 'latlon', la1, lo1, di, dj, scan: g.u1(28), pole, ni: grid.ni, nj: grid.nj };
    } else if (type === 3 || type === 5) {
        grid.ni = g.u2(7);
        grid.nj = g.u2(9);
        grid.points = grid.ni * grid.nj;
        var south = (g.u1(27) & 0x80) !== 0;
        var p = { la1: deg(g.s3(11)), lo1: deg(g.s3(14)), lov: deg(g.s3(18)), dx: g.u3(21), dy: g.u3(24), south, scan: g.u1(28),
            nx: grid.ni, ny: grid.nj };
        // Polar stereographic is true at 60° (GRIB1 fixes it); Lambert at its first secant latitude
        if (type === 5) p.lad = south ? -60 : 60;
        else Object.assign(p, { latin1: deg(g.s3(29)), latin2: deg(g.s3(32)), lad: deg(g.s3(29)) });
        grid.resolution = `${round(p.dx / 1000)} km`;
        var template = type === 3 ? 30 : 20;
        grid.outline = projectedOutline(template === 30 ? lambert(p) : polarStereo(p), p);
        grid.geo = { kind: 'projected', template, ...p, ni: grid.ni, nj: grid.nj };
    }
    return grid;
}

// centre: the originating centre's number (section 1), whose local parameters (192 and up) it has
function parseProduct(s4, discipline, run, centre) {
    var template = s4.u2(8);
    var out = { productTemplate: template };
    var category = s4.u1(10), number = s4.u1(11);
    var key = `${discipline}.${category}.${number}`;
    var group = (CATEGORIES[discipline] || {})[category] || WMO_CATEGORIES[`${discipline}.${category}`];
    // The names here first (the colour scales go by them), then the centre's own local table,
    // then all of WMO's (gribTables.js, from ecCodes); a code only where none has it
    out.parameter = ((PARAMETERS[discipline] || {})[category] || {})[number]
        || (LOCAL_PARAMETERS[centre] || {})[key] || WMO_PARAMETERS[key]
        || (group ? `${group} (${number >= 192 ? `${CENTRES[centre] || 'local'} ` : ''}parameter ${number})` : `Parameter ${key}`);
    // Templates 4.0 to 4.15 share these octets
    if (template > 15) return out;
    out.process = PROCESSES[s4.u1(12)] || null;
    var unit = UNIT_HOURS[s4.u1(18)];
    var lead = s4.s4(19);
    if (unit !== undefined) out.leadHours = Math.round(lead * unit * 100) / 100;
    if (run && out.leadHours !== undefined) out.valid = new Date(Date.parse(run) + out.leadHours * 3600e3).toISOString();
    var top = level(s4.u1(23), s4.s1(24), s4.s4(25)), bottom = level(s4.u1(29), s4.s1(30), s4.s4(31));
    out.level = top && bottom ? `${top} to ${bottom}` : top;
    // Ensemble member (4.1, 4.11), derived from an ensemble (4.2, 4.12), probability (4.5, 4.9)
    if (template === 1 || template === 11) {
        out.ensemble = `Member ${s4.u1(36)} of ${s4.u1(37)}`;
    } else if (template === 2 || template === 12) {
        out.ensemble = `${DERIVED[s4.u1(35)] || 'Derived'} of ${s4.u1(36)} members`;
    } else if (template === 5 || template === 9) {
        var type = s4.u1(37);
        var lower = s4.s4(39) / 10 ** s4.s1(38), upper = s4.s4(44) / 10 ** s4.s1(43);
        var limit = type === 2 ? `${lower} and ${upper}` : type === 1 || type === 4 ? upper : lower;
        out.probability = `Probability ${PROBABILITY[type] || 'of'} ${Math.round(limit * 1000) / 1000}`;
    } else if (template === 6 || template === 10) {
        // A percentile of the ensemble (CMA's precipitation at the 10th to 90th)
        var pct = s4.u1(35);
        out.ensemble = `${pct}${pct % 10 === 1 && pct !== 11 ? 'st' : pct % 10 === 2 && pct !== 12 ? 'nd' : pct % 10 === 3 && pct !== 13 ? 'rd' : 'th'} percentile`;
    }
    // Statistics over a period (4.8, 4.9, 4.10, 4.11, 4.12): what, and over how long
    var statsAt = { 8: 47, 9: 60, 10: 48, 11: 50, 12: 49 }[template];
    if (statsAt) {
        var hours = UNIT_HOURS[s4.u1(statsAt + 2)];
        var kind = STATISTICS[s4.u1(statsAt)] || 'Statistic';
        var spanHours = hours !== undefined ? Math.round(s4.u4(statsAt + 3) * hours * 100) / 100 : null;
        out.statistic = `${kind}${spanHours != null ? ` over ${spanHours} h` : ''}`;
        var start = out.leadHours;
        if (spanHours != null && start !== undefined) {
            // The lead time is the end of the period, when it's valid: ECCC's accumulations
            // all start at the run (+0 h), so by their start every lead time read as +0 h
            out.leadHours = Math.round((start + spanHours) * 100) / 100;
            if (run) out.valid = new Date(Date.parse(run) + out.leadHours * 3600e3).toISOString();
        }
        // What names the product: the same for all its lead times. A period from the run
        // grows with the lead time ("over 59 h"), so it's "from the start" instead
        out.statisticName = spanHours != null && start === 0 ? `${kind} from the start` : out.statistic;
    }
    return out;
}

const GRID_NAMES = { 0: 'Latitude/longitude', 1: 'Rotated latitude/longitude', 10: 'Mercator', 20: 'Polar stereographic',
    30: 'Lambert conformal', 40: 'Gaussian', 90: 'Space view', 101: 'Unstructured' };

const EARTH_RADIUS = 6371229;

function parseGrid(s3) {
    var template = s3.u2(13);
    var grid = { template, name: GRID_NAMES[template] || `Grid template ${template}`, points: s3.u4(7) };
    // Angles in millionths of a degree, unless the grid gives its own unit
    var deg = (v) => v / 1e6;
    if (template === 0 || template === 1 || template === 40) {
        var basic = s3.u4(39), sub = s3.u4(43);
        if (basic && basic !== 0xffffffff && sub && sub !== 0xffffffff) deg = (v) => v * basic / sub;
        grid.ni = s3.u4(31);
        grid.nj = s3.u4(35);
        var la1 = deg(s3.s4(47)), lo1 = deg(s3.s4(51)), la2 = deg(s3.s4(56)), lo2 = deg(s3.s4(60));
        grid.resolution = template === 40 ? `N${s3.u4(68)}` : `${round(deg(s3.u4(64)))}° × ${round(deg(s3.u4(68)))}°`;
        var pole = template === 1 ? [deg(s3.s4(73)), deg(s3.s4(77))] : null;
        grid.outline = pole ? rotatedOutline(la1, lo1, la2, lo2, pole) : latLonOutline(la1, lo1, la2, lo2, grid.ni, deg(s3.u4(64)));
        // Where each value is, for drawing them (gribField.js). Steps from the corners when
        // not given; a Gaussian grid's latitudes are taken as evenly spaced
        var span = ((lo2 - lo1) % 360 + 360) % 360 || 360;
        var di = s3.u4(64) !== 0xffffffff && template !== 40 ? deg(s3.u4(64)) : span / Math.max(1, grid.ni - (span >= 359.9 ? 0 : 1));
        var dj = s3.u4(68) !== 0xffffffff && template !== 40 ? deg(s3.u4(68)) : Math.abs(la2 - la1) / Math.max(1, grid.nj - 1);
        grid.geo = { kind: pole ? 'rotated' : 'latlon', la1, lo1, di, dj, scan: s3.u1(72), pole, ni: grid.ni, nj: grid.nj };
    } else if (template === 10) {
        grid.ni = s3.u4(31);
        grid.nj = s3.u4(35);
        grid.resolution = `${round(s3.u4(65) / 1e6)} km`;
        grid.outline = latLonOutline(deg(s3.s4(39)), deg(s3.s4(43)), deg(s3.s4(52)), deg(s3.s4(56)), 0, 0);
    } else if (template === 20 || template === 30) {
        grid.ni = s3.u4(31);
        grid.nj = s3.u4(35);
        var p = { la1: deg(s3.s4(39)), lo1: deg(s3.s4(43)), lad: deg(s3.s4(48)), lov: deg(s3.s4(52)),
            dx: s3.u4(56) / 1000, dy: s3.u4(60) / 1000, south: (s3.u1(64) & 0x80) !== 0, scan: s3.u1(65), nx: grid.ni, ny: grid.nj };
        if (template === 30) Object.assign(p, { latin1: deg(s3.s4(66)), latin2: deg(s3.s4(70)) });
        grid.resolution = `${round(p.dx / 1000)} km`;
        grid.outline = projectedOutline(template === 30 ? lambert(p) : polarStereo(p), p);
        grid.geo = { kind: 'projected', template, ...p, ni: grid.ni, nj: grid.nj };
    }
    return grid;
}

const round = (v) => Math.round(v * 1000) / 1000;
const rad = Math.PI / 180;

// Longitudes made continuous along a ring (no jumps of 360°), so it draws as one shape.
// A ring that goes round a pole (ECCC's RDPS takes in the North Pole) ends 360° from
// where it began: it's closed through that pole
function unwrap(ring) {
    for (var i = 1; i < ring.length; i++) {
        while (ring[i][0] - ring[i - 1][0] > 180) ring[i][0] -= 360;
        while (ring[i][0] - ring[i - 1][0] < -180) ring[i][0] += 360;
    }
    var first = ring[0], last = ring[ring.length - 1];
    if (Math.abs(last[0] - first[0]) > 180) {
        var pole = ring.reduce((sum, p) => sum + p[1], 0) > 0 ? 90 : -90;
        ring.push([last[0], pole], [first[0], pole], first.slice());
    }
    return ring;
}

// Corners from first and last point, with points along each edge so it follows the globe.
// A grid that goes all the way round is the whole band between its latitudes
export function latLonOutline(la1, lo1, la2, lo2, ni, di) {
    var west = ((lo1 % 360) + 360) % 360, east = ((lo2 % 360) + 360) % 360;
    if (east <= west) east += 360;
    if (ni && di && ni * di >= 359.5) { west = -180; east = 180; }
    if (west > 180) { west -= 360; east -= 360; }
    var south = Math.min(la1, la2), north = Math.max(la1, la2);
    var steps = 24, ring = [];
    for (var i = 0; i <= steps; i++) ring.push([west + (east - west) * i / steps, south]);
    for (i = 1; i <= steps; i++) ring.push([east, south + (north - south) * i / steps]);
    for (i = 1; i <= steps; i++) ring.push([east - (east - west) * i / steps, north]);
    for (i = 1; i <= steps; i++) ring.push([west, north - (north - south) * i / steps]);
    return ring.map(([x, y]) => [round(x), round(y)]);
}

// Rotated latitude/longitude to geographic, given the rotated grid's south pole
export function unrotate(lat, lon, [poleLat, poleLon]) {
    var theta = -(90 + poleLat) * rad, phi = -poleLon * rad;
    var x = Math.cos(lon * rad) * Math.cos(lat * rad), y = Math.sin(lon * rad) * Math.cos(lat * rad), z = Math.sin(lat * rad);
    var xn = Math.cos(theta) * Math.cos(phi) * x + Math.sin(phi) * y + Math.sin(theta) * Math.cos(phi) * z;
    var yn = -Math.cos(theta) * Math.sin(phi) * x + Math.cos(phi) * y - Math.sin(theta) * Math.sin(phi) * z;
    var zn = -Math.sin(theta) * x + Math.cos(theta) * z;
    return [Math.atan2(yn, xn) / rad, Math.asin(Math.max(-1, Math.min(1, zn))) / rad];
}

function rotatedOutline(la1, lo1, la2, lo2, pole) {
    // Eastward from the first point to the last, across 0° if need be (ECCC's RDPS: 306° to 49°)
    if (lo2 < lo1) lo2 += 360;
    var steps = 24, ring = [];
    var edge = (fromLat, fromLon, toLat, toLon) => {
        for (var i = 0; i < steps; i++) {
            ring.push(unrotate(fromLat + (toLat - fromLat) * i / steps, fromLon + (toLon - fromLon) * i / steps, pole));
        }
    };
    edge(la1, lo1, la1, lo2);
    edge(la1, lo2, la2, lo2);
    edge(la2, lo2, la2, lo1);
    edge(la2, lo1, la1, lo1);
    ring.push(ring[0].slice());
    return unwrap(ring).map(([x, y]) => [round(x), round(y)]);
}

// Lambert conformal on a sphere: { forward(lat, lon) -> [x, y], inverse(x, y) -> [lon, lat] }
function lambert(p) {
    var f1 = p.latin1 * rad, f2 = p.latin2 * rad, l0 = p.lov * rad;
    var t = (f) => Math.tan(Math.PI / 4 + f / 2);
    var n = Math.abs(f1 - f2) < 1e-9 ? Math.sin(f1) : Math.log(Math.cos(f1) / Math.cos(f2)) / Math.log(t(f2) / t(f1));
    var F = Math.cos(f1) * t(f1) ** n / n;
    var rho = (f) => EARTH_RADIUS * F / t(f) ** n;
    return {
        forward(lat, lon) {
            var r = rho(lat * rad), a = n * (lon * rad - l0);
            return [r * Math.sin(a), -r * Math.cos(a)];
        },
        inverse(x, y) {
            var r = Math.sign(n) * Math.hypot(x, y);
            var a = Math.atan2(Math.sign(n) * x, Math.sign(n) * -y);
            var lat = 2 * Math.atan((EARTH_RADIUS * F / r) ** (1 / n)) - Math.PI / 2;
            return [(l0 + a / n) / rad, lat / rad];
        },
    };
}

// Polar stereographic on a sphere, true at LaD, north or south
function polarStereo(p) {
    var s = p.south ? -1 : 1, l0 = p.lov * rad;
    var k = EARTH_RADIUS * (1 + Math.sin(Math.abs(p.lad) * rad));
    return {
        forward(lat, lon) {
            var r = k * Math.tan(Math.PI / 4 - s * lat * rad / 2), a = lon * rad - l0;
            return [r * Math.sin(a), -s * r * Math.cos(a)];
        },
        inverse(x, y) {
            var r = Math.hypot(x, y), a = Math.atan2(x, -s * y);
            return [(l0 + a) / rad, s * (Math.PI / 2 - 2 * Math.atan(r / k)) / rad];
        },
    };
}

// The edge of a projected grid: its first point projected, then Nx × Ny steps of Dx, Dy
// (in the directions the scanning mode gives)
function projectedOutline(proj, p) {
    var [x0, y0] = proj.forward(p.la1, p.lo1);
    var dx = (p.scan & 0x80 ? -1 : 1) * p.dx, dy = (p.scan & 0x40 ? 1 : -1) * p.dy;
    var at = (i, j) => proj.inverse(x0 + i * dx, y0 + j * dy);
    var steps = 24, ring = [], nx = p.nx - 1, ny = p.ny - 1;
    for (var i = 0; i < steps; i++) ring.push(at(nx * i / steps, 0));
    for (i = 0; i < steps; i++) ring.push(at(nx, ny * i / steps));
    for (i = 0; i < steps; i++) ring.push(at(nx * (1 - i / steps), ny));
    for (i = 0; i < steps; i++) ring.push(at(0, ny * (1 - i / steps)));
    ring.push(ring[0].slice());
    return unwrap(ring).map(([x, y]) => [round(x), round(y)]);
}

// Geographic latitude/longitude to a rotated grid's, given its south pole (unrotate's inverse)
export function rotate(lat, lon, [poleLat, poleLon]) {
    var theta = (90 + poleLat) * rad, phi = poleLon * rad;
    var x = Math.cos(lon * rad) * Math.cos(lat * rad), y = Math.sin(lon * rad) * Math.cos(lat * rad), z = Math.sin(lat * rad);
    var xn = Math.cos(theta) * Math.cos(phi) * x + Math.cos(theta) * Math.sin(phi) * y + Math.sin(theta) * z;
    var yn = -Math.sin(phi) * x + Math.cos(phi) * y;
    var zn = -Math.sin(theta) * Math.cos(phi) * x - Math.sin(theta) * Math.sin(phi) * y + Math.cos(theta) * z;
    return [Math.asin(Math.max(-1, Math.min(1, zn))) / rad, Math.atan2(yn, xn) / rad];
}

// For a grid (grid.geo): (lat, lon) -> the index of the nearest value, or -1 off the grid.
// Values run along i first unless the scanning mode says j (flag 0x20)
export function gridLocator(geo) {
    var { ni, nj, scan } = geo;
    var index = (i, j) => {
        i = Math.round(i);
        j = Math.round(j);
        if (j < 0 || j >= nj) return -1;
        if (i < 0 || i >= ni) {
            if (geo.wraps) i = ((i % ni) + ni) % ni;
            else return -1;
        }
        return scan & 0x20 ? i * nj + j : j * ni + i;
    };
    if (geo.kind === 'projected') {
        var proj = geo.template === 30 ? lambert(geo) : polarStereo(geo);
        var [x0, y0] = proj.forward(geo.la1, geo.lo1);
        var dx = (scan & 0x80 ? -1 : 1) * geo.dx, dy = (scan & 0x40 ? 1 : -1) * geo.dy;
        return (lat, lon) => {
            var [x, y] = proj.forward(lat, lon);
            return index((x - x0) / dx, (y - y0) / dy);
        };
    }
    var iSign = scan & 0x80 ? -1 : 1, jSign = scan & 0x40 ? 1 : -1;
    geo.wraps = ni * geo.di >= 359.5;
    return (lat, lon) => {
        if (geo.pole) [lat, lon] = rotate(lat, lon, geo.pole);
        var dlon = (((lon - geo.lo1) * iSign) % 360 + 360) % 360;
        // Just west of the first column (by up to half a step) is still the first column
        if (dlon > 360 - geo.di / 2) dlon -= 360;
        return index(dlon / geo.di, (lat - geo.la1) * jSign / geo.dj);
    };
}

// One line saying what a GRIB file holds, for lists and hover labels
export function gribSummary(h) {
    if (h.edition !== 2 && h.edition !== 1) return `GRIB edition ${h.edition}`;
    return [h.parameter, h.level, h.leadHours !== undefined ? `+${h.leadHours} h` : null, h.ensemble, h.probability, h.statistic]
        .filter(Boolean).join(' · ');
}

// The details as label and value pairs, for the popup's table
export function gribRows(h) {
    if (h.edition !== 2 && h.edition !== 1) return [['Format', `GRIB edition ${h.edition} (not read here)`]];
    var g = h.grid || {};
    return [
        ['Format', h.edition === 1 ? 'GRIB edition 1' : null],
        ['Variable', h.parameter], ['Level', h.level], ['Discipline', h.discipline], ['Centre', h.centre],
        ['Run', h.run && h.run.replace(/:00\.000Z$/, 'Z').replace('T', ' ')],
        ['Lead time', h.leadHours !== undefined ? `${h.leadHours} h` : null],
        ['Valid', h.valid && h.valid.replace(/:00\.000Z$/, 'Z').replace('T', ' ')],
        ['Process', h.process], ['Ensemble', h.ensemble], ['Probability', h.probability], ['Statistic', h.statistic],
        ['Grid', g.name && `${g.name}${g.ni ? `, ${g.ni} × ${g.nj}` : ''}`], ['Resolution', g.resolution],
        ['Points', g.points && g.points.toLocaleString()],
    ].filter(([, v]) => v != null && v !== '');
}
