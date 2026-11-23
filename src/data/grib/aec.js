// CCSDS 121.0-B lossless decompression (Adaptive Entropy Coding, as libaec implements
// it), which GRIB2's data representation template 5.42 wraps (ECMWF's open data). Plain
// JavaScript, no dependency. Checked against ecCodes on an ECMWF wave field.
//
// The bit stream is a run of reference sample intervals (RSI), each of `rsi` blocks of
// `blockSize` samples. Each block starts with an option identifier (idLen bits):
//   0            low entropy: one more bit says zero blocks (0) or second extension (1)
//   1 .. max-1   split sample, k = id - 1: every sample's high part as a unary count
//                (fundamental sequence), then every sample's k low bits
//   max          no compression: the samples as they are
// With preprocessing (flag 8) the first block of each RSI starts with a reference sample
// (raw), and the rest are mapped prediction differences: undone here against the sample
// before (unit delay predictor). Signed data (flag 1) isn't used by GRIB and isn't handled

const PREPROCESS = 8;
const SIGNED = 1;
const ROS = 5;  // Zero-block count meaning "the rest of the segment"

// Second extension: a code m stands for a pair of values (its table: beta and the code
// where its row starts)
const SE_TABLE = (() => {
    var table = [], k = 0;
    for (var i = 0; i < 13; i++) {
        var start = k;
        for (var j = 0; j <= i; j++, k++) table.push(i, start);
    }
    return table;
})();

// count samples of `bits` bits, from a CCSDS stream: a Uint32Array (or Float64Array
// above 32 bits, which GRIB doesn't use)
export function aecDecode(bytes, count, bits, blockSize, rsi, flags) {
    if (flags & SIGNED) throw new Error('signed CCSDS data');
    var idLen = bits > 16 ? 5 : bits > 8 ? 4 : bits <= 4 && (flags & 16) ? (bits <= 2 ? 1 : 2) : 3;
    var maxId = (1 << idLen) - 1;
    var pp = (flags & PREPROCESS) !== 0;
    var xmax = 2 ** bits - 1;
    var out = new Uint32Array(count);
    var n = 0;

    // Bits, most significant first
    var pos = 0;  // In bits
    var total = bytes.length * 8;
    var read = (len) => {
        var v = 0;
        for (var i = 0; i < len; i++, pos++) v = v * 2 + ((bytes[pos >> 3] >> (7 - (pos & 7))) & 1);
        return v;
    };
    var fs = () => {
        var zeros = 0;
        while (pos < total && !((bytes[pos >> 3] >> (7 - (pos & 7))) & 1)) { zeros++; pos++; }
        pos++;  // The 1 that ends it
        return zeros;
    };

    // Preprocessing undone, as each sample comes: the reference sample of an RSI as it is,
    // the others back from their mapped difference to the one before
    var last = 0;
    var put = (value, reference) => {
        if (n >= count) return;
        if (!pp || reference) {
            last = value;
        } else {
            var theta = Math.min(last, xmax - last);
            var delta;
            if (value <= 2 * theta) delta = value & 1 ? -((value + 1) / 2) : value / 2;
            else delta = theta === last ? value - theta : theta - value;
            last += delta;
        }
        out[n++] = last;
    };

    while (n < count && pos < total) {
        // One RSI
        for (var block = 0; block < rsi && n < count && pos < total; block++) {
            var ref = pp && block === 0 ? 1 : 0;
            var id = read(idLen);
            if (id === 0) {
                var second = read(1);
                if (ref) put(read(bits), true);
                if (second) {
                    // Second extension: pairs from one code each (the first of a pair is
                    // left out where the reference sample took its place)
                    for (var i = ref; i < blockSize && n < count;) {
                        var m = fs();
                        if (m >= SE_TABLE.length / 2) throw new Error('bad CCSDS second-extension code');
                        var d1 = m - SE_TABLE[2 * m + 1];
                        if ((i & 1) === 0) { put(SE_TABLE[2 * m] - d1); i++; }
                        put(d1);
                        i++;
                    }
                } else {
                    // Zero blocks: this one and those after it, perhaps to the end of the
                    // 64-block segment or the RSI
                    var zeroBlocks = fs() + 1;
                    if (zeroBlocks === ROS) zeroBlocks = Math.min(rsi - block, 64 - (block % 64));
                    else if (zeroBlocks > ROS) zeroBlocks--;
                    var zeros = zeroBlocks * blockSize - ref;
                    for (var z = 0; z < zeros; z++) put(0);
                    block += zeroBlocks - 1;
                }
            } else if (id === maxId) {
                // As they are; the reference sample is the first of them
                for (var u = 0; u < blockSize; u++) put(read(bits), ref && u === 0);
            } else {
                var k = id - 1;
                if (ref) put(read(bits), true);
                var size = blockSize - ref;
                var high = new Array(size);
                for (var s = 0; s < size; s++) high[s] = fs();
                for (s = 0; s < size; s++) put(high[s] * 2 ** k + read(k));
            }
        }
        // A new RSI starts on the next byte only when padded (flag 32)
        if (flags & 32) pos = Math.ceil(pos / 8) * 8;
    }
    return out;
}
