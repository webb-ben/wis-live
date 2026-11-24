// A GRIB2 field's values, decoded and drawn on the map as a coloured image. Reads the
// first message of a file (data representation, bitmap and data sections), unpacking
// simple packing (template 5.0) and CCSDS (5.42, ECMWF's; aec.js) here, and JPEG 2000
// (5.40, ECCC's) with OpenJPEG (@cornerstonejs/codec-openjpeg, WebAssembly, loaded the
// first time it's needed). PNG (5.41) and complex packing (5.2, 5.3) aren't drawn.
// The image is the field reprojected onto the map's Mercator grid, nearest value per
// pixel, through the grid's own geometry (gridLocator: lat/lon, rotated, Lambert, polar)
import openjpegUrl from '@cornerstonejs/codec-openjpeg/decodewasm?url';
import { gridLocator, reader1, thinnedRows } from './gribHeader.js';
import { aecDecode } from './aec.js';
import { METRICS } from '../../config.js';

export const DRAWN_PACKINGS = { 0: 'simple', 40: 'JPEG 2000', 42: 'CCSDS (AEC)' };

// The widest JPEG 2000 values the decoder reads (see decodeField)
export const JPEG_MAX_BITS = 16;

// Whether a GRIB field's values can be drawn, from its header: its packing, and for
// JPEG 2000 its width
export function fieldDrawable(header) {
    return !!header && DRAWN_PACKINGS[header.packing] !== undefined && !(header.packing === 40 && header.bits > JPEG_MAX_BITS);
}
const PACKING_NAMES = { 2: 'complex', 3: 'complex with spatial differencing', 41: 'PNG', 50: 'spectral', 51: 'spherical harmonics' };

export function packingName(n) {
    return DRAWN_PACKINGS[n] || PACKING_NAMES[n] || `template 5.${n}`;
}

let openjpeg = null;
function loadOpenJpeg() {
    if (!openjpeg) {
        openjpeg = import('@cornerstonejs/codec-openjpeg/decodewasmjs')
            .then((m) => (m.default || m)({ locateFile: () => openjpegUrl, print() {}, printErr() {} }));
    }
    return openjpeg;
}

function sectionsOf(bytes) {
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var start = -1;
    for (var i = 0; i + 4 <= Math.min(bytes.length, 512); i++) {
        if (bytes[i] === 71 && bytes[i + 1] === 82 && bytes[i + 2] === 73 && bytes[i + 3] === 66) { start = i; break; }
    }
    if (start < 0) throw new Error('not GRIB');
    var found = {}, at = start + 16, stop = null;
    while (at + 5 <= bytes.length) {
        var length = view.getUint32(at), number = bytes[at + 4];
        if (length < 5 || number > 7) { stop = `an unreadable section ${number} at byte ${at}`; break; }
        if (at + length > bytes.length) { stop = `section ${number} runs to byte ${(at + length).toLocaleString()}`; break; }
        found[number] = { at, length };
        if (number === 7) break;
        at += length;
    }
    if (!found[5] || !found[7]) {
        throw new Error(`its data wasn't in the ${bytes.length.toLocaleString()} bytes downloaded${stop ? ` (${stop})` : ''}`);
    }
    return { view, found };
}

// Sign-and-magnitude 16-bit (GRIB's scale factors)
const signed16 = (view, at) => { var v = view.getUint16(at); return v & 0x8000 ? -(v & 0x7fff) : v; };

// The field's values, one per grid point in the grid's order (NaN where the bitmap says
// there's none): { values: Float32Array, min, max }
export async function decodeField(bytes, points) {
    var grib1 = grib1Start(bytes);
    if (grib1 >= 0) return decodeGrib1(bytes, grib1, points);
    var { view, found } = sectionsOf(bytes);
    var s5 = found[5].at, template = view.getUint16(s5 + 9);
    var count = view.getUint32(s5 + 5);
    var R = view.getFloat32(s5 + 11), E = signed16(view, s5 + 15), D = signed16(view, s5 + 17), bits = bytes[s5 + 19];
    var scale = 2 ** E / 10 ** D, offset = R / 10 ** D;
    var packed;
    if (bits === 0) {
        packed = new Float32Array(count).fill(offset);
    } else if (template === 0) {
        packed = unpackBits(bytes, found[7].at + 5, count, bits, scale, offset);
    } else if (template === 42) {
        // CCSDS: flags, block size and reference sample interval follow the bits per value
        var ints42 = aecDecode(bytes.subarray(found[7].at + 5, found[7].at + found[7].length), count, bits,
            bytes[s5 + 22], view.getUint16(s5 + 23), bytes[s5 + 21]);
        packed = new Float32Array(count);
        for (var q = 0; q < count; q++) packed[q] = offset + ints42[q] * scale;
    } else if (template === 40) {
        var ojp = await loadOpenJpeg();
        var decoder = new ojp.J2KDecoder();
        var stream = bytes.subarray(found[7].at + 5, found[7].at + found[7].length);
        decoder.getEncodedBuffer(stream.length).set(stream);
        decoder.decode();
        var info = decoder.getFrameInfo();
        var raw = decoder.getDecodedBuffer();
        // OpenJPEG's WebAssembly build gives at most 16 bits a sample (wider ones, such as
        // CMA's 24-bit precipitation, come back as all 0s and 1s): those aren't drawn (JPEG_MAX_BITS)
        if (info.bitsPerSample > JPEG_MAX_BITS) throw new Error(`its values are ${info.bitsPerSample}-bit JPEG 2000, more than the decoder reads (${JPEG_MAX_BITS})`);
        var copy = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length);
        var ints = info.bitsPerSample > 8 ? new Uint16Array(copy) : new Uint8Array(copy);
        packed = new Float32Array(Math.min(count, ints.length));
        for (var k = 0; k < packed.length; k++) packed[k] = offset + ints[k] * scale;
        decoder.delete && decoder.delete();
    } else {
        throw new Error(`its values are packed with ${packingName(template)}, which isn't drawn here`);
    }
    // The bitmap (section 6): which grid points have a value
    var values = packed;
    var s6 = found[6];
    if (s6 && bytes[s6.at + 5] === 0) {
        values = new Float32Array(points).fill(NaN);
        var bitmap = s6.at + 6, next = 0;
        for (var p = 0; p < points && next < packed.length; p++) {
            if (bytes[bitmap + (p >> 3)] & (0x80 >> (p & 7))) values[p] = packed[next++];
        }
    }
    var min = Infinity, max = -Infinity;
    for (var v of values) {
        if (v < min) min = v;
        if (v > max) max = v;
    }
    return { values, min, max };
}

// Where a GRIB edition 1 message starts ("GRIB", edition octet 1), past any GTS heading; -1
// for GRIB2 or anything else
function grib1Start(bytes) {
    for (var i = 0; i + 8 <= Math.min(bytes.length, 512); i++) {
        if (bytes[i] === 71 && bytes[i + 1] === 82 && bytes[i + 2] === 73 && bytes[i + 3] === 66) return bytes[i + 7] === 1 ? i : -1;
    }
    return -1;
}

// IBM System/360 single precision (GRIB1's reference value): sign, a base-16 exponent
// biased by 64, and a 24-bit fraction
function ibmFloat(bytes, at) {
    var sign = bytes[at] & 0x80 ? -1 : 1, exponent = (bytes[at] & 0x7f) - 64;
    var fraction = (bytes[at + 1] * 65536 + bytes[at + 2] * 256 + bytes[at + 3]) / 16777216;
    return sign * fraction * 16 ** exponent;
}

// A GRIB1 field's values (simple packing, grid point data): Y = (R + X × 2^E) / 10^D, with
// the bitmap (section 3) saying which grid points have one
function decodeGrib1(bytes, start, points) {
    var u3 = (at) => bytes[at] * 65536 + bytes[at + 1] * 256 + bytes[at + 2];
    var signed = (hi, lo) => { var v = hi * 256 + lo; return v & 0x8000 ? -(v & 0x7fff) : v; };
    var s1 = start + 8, s1len = u3(s1), flags = bytes[s1 + 7];
    var D = signed(bytes[s1 + 26], bytes[s1 + 27]);
    var at = s1 + s1len;
    var pl = null;  // A quasi-regular grid's points per row
    if (flags & 0x80) {
        var gds = reader1(bytes, at);
        pl = thinnedRows(gds, gds.u2(9));
        if (pl) points = pl.reduce((a, b) => a + b, 0);  // Its values, before they're spread out
        at += u3(at);
    }
    var bitmapAt = null;
    if (flags & 0x40) {
        if (bytes[at + 4] || bytes[at + 5]) throw new Error('its bitmap is a predefined one, which isn\'t read here');
        bitmapAt = at + 6;
        at += u3(at);
    }
    var bdsLen = u3(at);
    if (at + bdsLen > bytes.length) {
        throw new Error(`its data wasn't in the ${bytes.length.toLocaleString()} bytes downloaded (it runs to byte ${(at + bdsLen).toLocaleString()})`);
    }
    var flag = bytes[at + 3];
    if (flag & 0xc0) throw new Error(`its values are packed with ${flag & 0x80 ? 'spherical harmonics' : 'complex packing'}, which isn't drawn here`);
    var E = signed(bytes[at + 4], bytes[at + 5]), R = ibmFloat(bytes, at + 6), bits = bytes[at + 10];
    var unused = flag & 0x0f;
    var scale = 2 ** E / 10 ** D, offset = R / 10 ** D;
    var count = bitmapAt != null ? 0 : points;
    if (bitmapAt != null) {
        for (var p = 0; p < points; p++) if (bytes[bitmapAt + (p >> 3)] & (0x80 >> (p & 7))) count++;
    } else if (bits) {
        // Or from the section's length, where the grid doesn't say
        count = Math.min(points || Infinity, Math.floor(((bdsLen - 11) * 8 - unused) / bits));
    }
    var packed = bits ? unpackBits(bytes, at + 11, count, bits, scale, offset) : new Float32Array(count).fill(offset);
    var values = packed;
    if (bitmapAt != null) {
        values = new Float32Array(points).fill(NaN);
        for (var q = 0, next = 0; q < points && next < packed.length; q++) {
            if (bytes[bitmapAt + (q >> 3)] & (0x80 >> (q & 7))) values[q] = packed[next++];
        }
    }
    if (pl) values = thinnedToRegular(values, pl);
    var min = Infinity, max = -Infinity;
    for (var v of values) {
        if (v < min) min = v;
        if (v > max) max = v;
    }
    return { values, min, max };
}

// A quasi-regular grid's values (row after row, pl[j] in row j) spread onto a regular grid as
// wide as the widest row: each row's points evenly across the same longitudes, values in
// between taken linearly from the two either side (the nearer one where either has none)
function thinnedToRegular(values, pl) {
    var ni = Math.max(...pl), out = new Float32Array(ni * pl.length);
    var start = 0;
    pl.forEach((n, j) => {
        for (var i = 0; i < ni; i++) {
            var x = n > 1 ? i * (n - 1) / (ni - 1) : 0;
            var k = Math.floor(x), t = x - k;
            var a = values[start + k], b = values[start + Math.min(n - 1, k + 1)];
            out[j * ni + i] = a !== a || b !== b ? (t < 0.5 ? a : b) : a + (b - a) * t;
        }
        start += n;
    });
    return out;
}

// Simple packing: n-bit unsigned integers, big-endian, back to back
function unpackBits(bytes, at, count, bits, scale, offset) {
    var out = new Float32Array(count), bit = at * 8;
    for (var k = 0; k < count; k++, bit += bits) {
        var v = 0;
        for (var b = 0; b < bits; b++) {
            var pos = bit + b;
            v = v * 2 + ((bytes[pos >> 3] >> (7 - (pos & 7))) & 1);
        }
        out[k] = offset + v * scale;
    }
    return out;
}

// How a variable is coloured: the app's own scales where it has one (in its units), or
// a ramp from the field's lowest to its highest value
const SCALES = [
    [/^(Temperature|Dew point|Maximum temperature|Minimum temperature|Skin temperature)$/, 'temp'],
    [/^Relative humidity$/, 'rh'],
    [/^Pressure reduced to MSL$/, 'mslp'],
    [/^(Wind speed|Wind gust)$/, 'wind'],
    [/^Total precipitation$/, 'precip6'],
    [/^Significant (wave height|wind wave height)/, 'waves'],
    [/^Sea surface temperature$/, 'sst'],
];
const RAMP = ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'];

export function colourScale(parameter, min, max) {
    var key = (SCALES.find(([pattern]) => pattern.test(parameter || '')) || [])[1];
    var m = key && METRICS[key];
    if (m) {
        var stops = m.stops;
        return { unit: m.unit, convert: m.convert || ((v) => v), stops, step: true,
            low: stops[0][0], high: stops[stops.length - 1][0], colours: stops.map(([, c]) => c) };
    }
    // Otherwise a ramp over the field's own range, in the units people read it in
    var [, unit, factor] = UNITS.find(([pattern]) => pattern.test(parameter || '')) || [null, '', 1];
    var lo = min * factor, hi = max * factor;
    var span = hi > lo ? hi - lo : 1;
    return { unit, convert: (v) => v * factor, stops: RAMP.map((c, i) => [lo + span * i / (RAMP.length - 1), c]), step: false,
        low: lo, high: hi, colours: RAMP };
}

// Units for variables without one of the app's scales, from GRIB's SI units: the name,
// and what to multiply by (specific humidity's kg/kg, 0 to 0.02, reads as g/kg)
const UNITS = [
    [/^Specific humidity/, 'g/kg', 1000],
    [/^(Pressure|Pressure reduced to MSL)$/, 'hPa', 0.01],
    [/^Geopotential height/, 'gpm', 1],
    [/^Geopotential$/, 'm²/s²', 1],
    [/^(CAPE|Convective inhibition)/, 'J/kg', 1],
    [/cloud cover/i, '%', 1],
    [/^Albedo/, '%', 1],
    [/^(Wind \(|Wind speed|Wind gust|Vertical wind shear)/, 'm/s', 1],
    [/^Vertical velocity \(pressure\)/, 'Pa/s', 1],
    [/^Vertical velocity$/, 'm/s', 1],
    [/vorticity/i, '1/s', 1],
    [/^(Precipitable water|Snow water equivalent|Total snowfall)/, 'kg/m²', 1],
    [/^(Snow depth|Boundary layer height|Cloud base|Cloud top)/, 'm', 1],
    [/^Visibility/, 'm', 1],
    [/rate$/, 'kg/m²/s', 1],
    [/radiation flux|long-wave radiation/i, 'W/m²', 1],
    [/temperature/i, 'K', 1],
    [/wave height|Significant/i, 'm', 1],
    [/period/i, 's', 1],
    [/direction/i, '°', 1],
];

const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

// A lookup of 256 colours over the scale's range, for speed
function lookup(scale) {
    var rgb = scale.stops.map(([v, c]) => [v, hexToRgb(c)]);
    var table = new Uint8ClampedArray(256 * 3);
    for (var k = 0; k < 256; k++) {
        var v = scale.low + (scale.high - scale.low) * k / 255;
        var at = rgb.findIndex(([s]) => s > v);
        var c;
        if (scale.step) c = rgb[Math.max(0, (at < 0 ? rgb.length : at) - 1)][1];
        else if (at <= 0) c = rgb[at < 0 ? rgb.length - 1 : 0][1];
        else {
            var [v0, c0] = rgb[at - 1], [v1, c1] = rgb[at];
            var f = (v - v0) / (v1 - v0);
            c = c0.map((x, i) => x + (c1[i] - x) * f);
        }
        table.set(c, k * 3);
    }
    return table;
}

// A value's colour on a scale (in the variable's own units: the scale converts), as CSS,
// for points drawn by MapLibre rather than into an image (GeoJSON forecasts)
export function colourOn(scale) {
    var rgb = rgbOn(scale);
    return (v) => `rgb(${rgb(v).join(', ')})`;
}

// The same as [r, g, b], for painting pixels (the world overview, overviewForecast in grib.js)
export function rgbOn(scale) {
    var table = lookup(scale), range = scale.high - scale.low || 1;
    return (v) => {
        var t = Math.max(0, Math.min(255, Math.round((scale.convert(v) - scale.low) / range * 255)));
        return [table[t * 3], table[t * 3 + 1], table[t * 3 + 2]];
    };
}

const mercY =(lat) => Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
const latOfY = (y) => (2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180 / Math.PI;

// The field as an image over the grid's outline: { url, coordinates, scale }
export function renderField(header, field) {
    return renderFields([{ header, field }]);
}

// One field split into tiles (the Met Office's, side by side), drawn as one image over
// all of them: each pixel from the first tile that has a value there
export async function renderFields(parts) {
    var header = parts[0].header;
    var points = parts.flatMap((p) => p.header.grid.outline);
    var lons = points.map((p) => p[0]), lats = points.map((p) => p[1]);
    var west = Math.min(...lons), east = Math.max(...lons);
    var south = Math.max(-85, Math.min(...lats)), north = Math.min(85, Math.max(...lats));
    if (east - west >= 359.5) { west = -180; east = 180; }
    var cells = parts.reduce((n, p) => n + (p.header.grid.ni || 0), 0);
    var width = Math.min(1600, Math.max(400, cells || 800));
    var ySpan = mercY(north) - mercY(south), xSpan = (east - west) * Math.PI / 180;
    var height = Math.max(100, Math.min(1600, Math.round(width * ySpan / xSpan)));
    var tiles = parts.map((p) => ({ locate: gridLocator(p.header.grid.geo), values: p.field.values }));
    var min = Math.min(...parts.map((p) => p.field.min)), max = Math.max(...parts.map((p) => p.field.max));
    // A probability (CMA's precipitation above 1 mm…), or an ensemble's spread, isn't in the
    // variable's units: it's coloured over its own range, not on the variable's scale
    var derived = header.probability || /spread|deviation/i.test(header.ensemble || '');
    var scale = colourScale(derived ? null : header.parameter, min, max);
    if (header.probability) scale.unit = '%';
    var table = lookup(scale);
    var canvas = new OffscreenCanvas(width, height);
    var image = new ImageData(width, height);
    var px = image.data, range = scale.high - scale.low || 1;
    for (var y = 0; y < height; y++) {
        var lat = latOfY(mercY(north) - ySpan * (y + 0.5) / height);
        for (var x = 0; x < width; x++) {
            var lon = west + (east - west) * (x + 0.5) / width;
            var v = NaN;
            for (var tile of tiles) {
                var k = tile.locate(lat, lon);
                if (k >= 0 && tile.values[k] === tile.values[k]) { v = tile.values[k]; break; }
            }
            if (!(v === v)) continue;  // NaN: no tile has a value there
            var t = Math.max(0, Math.min(255, Math.round((scale.convert(v) - scale.low) / range * 255)));
            var o = (y * width + x) * 4;
            px[o] = table[t * 3];
            px[o + 1] = table[t * 3 + 1];
            px[o + 2] = table[t * 3 + 2];
            px[o + 3] = 255;
        }
    }
    canvas.getContext('2d').putImageData(image, 0, 0);
    var blob = await canvas.convertToBlob({ type: 'image/png' });
    return { url: URL.createObjectURL(blob), coordinates: [[west, north], [east, north], [east, south], [west, south]], scale };
}
