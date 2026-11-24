// GRIB2 complex packing (data representation templates 5.2 and 5.3; WMO-No. 306, FM 92):
// NOAA's GFS, GEFS, HRRR and NBM, and many centres' WIS2 products. The values are split into
// groups, each with its own reference and bit width, so a field's smooth parts take few bits.
// 5.3 first takes spatial differences (of order 1 or 2) of the values, so what's packed is
// small. Plain functions and typed arrays, so it can be tested in Node (against ecCodes).
//
// Section 5's octets, numbered as the standard numbers them from the section's start:
//   6-9 values packed · 12-15 R (IEEE float) · 16-17 E · 18-19 D (sign and magnitude)
//   20 bits per group reference · 22 group splitting · 23 missing value management
//   32-35 NG groups · 36 group width reference · 37 bits per group width
//   38-41 group length reference · 42 length increment · 43-46 true length of the last group
//   47 bits per scaled group length · 5.3 only: 48 order of differencing · 49 octets per extra
//   descriptor (the first value or two, and the smallest difference, at the data's start)
// Returns the values in the scaled integers' units turned to real ones: Y = (R + X × 2^E) / 10^D,
// NaN where a value is missing (missing value management 1 or 2)

const signed16 = (bytes, at) => { var v = bytes[at] << 8 | bytes[at + 1]; return v & 0x8000 ? -(v & 0x7fff) : v; };
const u32 = (bytes, at) => ((bytes[at] << 24) >>> 0) + (bytes[at + 1] << 16) + (bytes[at + 2] << 8) + bytes[at + 3];

// A reader of big-endian bit fields, from bit `pos` of `bytes`
function bitReader(bytes, start) {
    var pos = start * 8;
    return {
        read(n) {
            if (n === 0) return 0;
            var v = 0;
            for (var left = n; left > 0;) {
                var byte = bytes[pos >> 3], used = pos & 7, take = Math.min(8 - used, left);
                v = v * (1 << take) + ((byte >> (8 - used - take)) & ((1 << take) - 1));
                pos += take;
                left -= take;
            }
            return v;
        },
        // Sign and magnitude, as the extra descriptors are: the top bit the sign
        signed(n) {
            var negative = this.read(1);
            var v = this.read(n - 1);
            return negative ? -v : v;
        },
        align() { pos = (pos + 7) & ~7; },
    };
}

// s5: where section 5 starts; s7: where section 7 starts. Octet n of a section is at s + n - 1
export function complexUnpack(bytes, s5, s7) {
    var o = (n) => s5 + n - 1;
    var template = bytes[o(10)] << 8 | bytes[o(11)];
    var count = u32(bytes, o(6));
    var R = new DataView(bytes.buffer, bytes.byteOffset + o(12), 4).getFloat32(0);
    var E = signed16(bytes, o(16)), D = signed16(bytes, o(18));
    var refBits = bytes[o(20)];
    var missing = bytes[o(23)];
    var groups = u32(bytes, o(32));
    var widthRef = bytes[o(36)], widthBits = bytes[o(37)];
    var lengthRef = u32(bytes, o(38)), lengthInc = bytes[o(42)], lastLength = u32(bytes, o(43)), lengthBits = bytes[o(47)];
    var order = template === 3 ? bytes[o(48)] : 0, extraOctets = template === 3 ? bytes[o(49)] : 0;
    var scale = 2 ** E / 10 ** D, offset = R / 10 ** D;

    var bits = bitReader(bytes, s7 + 5);
    // 5.3: the first value (and second, for order 2) and the smallest difference
    var first = 0, second = 0, minDiff = 0;
    if (order) {
        first = bits.signed(extraOctets * 8);
        if (order === 2) second = bits.signed(extraOctets * 8);
        minDiff = bits.signed(extraOctets * 8);
        bits.align();
    }
    // Each group's reference, then width, then length, each list starting on a whole octet
    var refs = new Float64Array(groups), widths = new Uint8Array(groups), lengths = new Uint32Array(groups);
    for (var g = 0; g < groups; g++) refs[g] = bits.read(refBits);
    bits.align();
    for (g = 0; g < groups; g++) widths[g] = widthRef + bits.read(widthBits);
    bits.align();
    for (g = 0; g < groups; g++) lengths[g] = lengthRef + bits.read(lengthBits) * lengthInc;
    bits.align();
    if (groups) lengths[groups - 1] = lastLength;

    // The values, group by group: reference plus what's packed; all ones (or all ones less one,
    // the secondary) is missing where missing values are managed
    var ints = new Float64Array(count);
    var isMissing = missing ? new Uint8Array(count) : null;
    var refMissing = 2 ** refBits - 1;
    var k = 0;
    for (g = 0; g < groups && k < count; g++) {
        var w = widths[g], n = Math.min(lengths[g], count - k), ref = refs[g];
        if (w === 0) {
            // Every value the group's reference; with missing values managed, an all-ones
            // reference makes the whole group missing
            var gone = missing && (ref === refMissing || (missing === 2 && ref === refMissing - 1));
            for (var i = 0; i < n; i++, k++) {
                ints[k] = ref;
                if (gone) isMissing[k] = 1;
            }
        } else {
            var top = 2 ** w - 1;
            for (i = 0; i < n; i++, k++) {
                var v = bits.read(w);
                if (missing && (v === top || (missing === 2 && v === top - 1))) isMissing[k] = 1;
                else ints[k] = ref + v;
            }
        }
    }

    // 5.3: undo the spatial differences, over the values that aren't missing, in order
    if (order) {
        var seen = 0, prev1 = 0, prev2 = 0;
        for (k = 0; k < count; k++) {
            if (isMissing && isMissing[k]) continue;
            var x;
            if (seen === 0) x = first;
            else if (seen === 1 && order === 2) x = second;
            else if (order === 1) x = ints[k] + minDiff + prev1;
            else x = ints[k] + minDiff + 2 * prev1 - prev2;
            ints[k] = x;
            prev2 = prev1;
            prev1 = x;
            seen++;
        }
    }

    var out = new Float32Array(count);
    for (k = 0; k < count; k++) out[k] = isMissing && isMissing[k] ? NaN : offset + ints[k] * scale;
    return out;
}
