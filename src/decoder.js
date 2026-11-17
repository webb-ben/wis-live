// BUFR decoding in Web Workers running Pyodide + pybufrkit, started on first use.
// callDecoder(fn, ...args) runs one of the Python functions in DECODE_PY and
// resolves with its (JSON) result; onDecoderSettled(fn) runs fn once the decoder
// has started, or has failed to.

const PYODIDE_URL = 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/';
// Served from public/ at the site's root; the CDN copy is the same file in the repo
const PYBUFRKIT_WHEEL = 'assets/py/pybufrkit-0.2.25-py3-none-any.whl';
const PYBUFRKIT_WHEEL_CDN = 'https://cdn.jsdelivr.net/gh/webb-ben/wis-live@main/public/' + PYBUFRKIT_WHEEL;

const decoderWorkers = {};  // lane ('main' or 'files') -> worker
export let decoderReady = false;
export let decoderGaveUp = false;  // It couldn't start; what waits for it (the Global Replay) goes ahead
let nextCall = 1;
const decoderCalls = new Map();  // call id -> { resolve, reject }
const settledListeners = [];

// fn runs once the decoder is ready or has given up (straight away if it already has)
export function onDecoderSettled(fn) {
    if (decoderReady || decoderGaveUp) fn();
    else settledListeners.push(fn);
}

function settled() {
    settledListeners.splice(0).forEach((fn) => fn());
}

const DECODE_PY = `
import json
from pybufrkit.decoder import Decoder
from pybufrkit.descriptors import ElementDescriptor

def _value(v):
    if isinstance(v, bytes):
        # All-ones bytes are BUFR's padding (and missing) characters, which would read as ÿ
        v = v.replace(b'\\xff', b'')
        try:
            v = v.decode('utf-8')
        except UnicodeDecodeError:
            v = v.decode('latin-1')
        return v.strip('\\x00 ')
    return v

def _wsi(rows):
    v = {d: x for d, _, x, _ in rows}
    try:
        if all(k in v for k in (1125, 1126, 1127, 1128)):
            return f"{v[1125]}-{v[1126]}-{v[1127]}-{v[1128]}"
        if 1001 in v and 1002 in v:
            return f"0-20000-0-{int(v[1001]):02d}{int(v[1002]):03d}"
    except (TypeError, ValueError):
        return None

_cache = {}  # key -> decoded subsets, so reports can be paged without re-decoding

# Some files hold many BUFR messages back to back (e.g. a 60-message IASI pass),
# so each is found by the length in its section 0. Big files are sampled: up to
# _MAX_MESSAGES spread across the file, so one pass can't hold up the decoder.
_MAX_MESSAGES = 8

def _messages(b):
    out, start = [], b.find(b'BUFR')
    while start >= 0:
        length = int.from_bytes(b[start + 4:start + 7], 'big')
        if length < 8 or start + length > len(b):
            out.append(b[start:])
            break
        out.append(b[start:start + length])
        start = b.find(b'BUFR', start + length)
    if len(out) > _MAX_MESSAGES:
        out = [out[i * len(out) // _MAX_MESSAGES] for i in range(_MAX_MESSAGES)]
    return out

def _decode(data):
    subsets = []
    for i, b in enumerate(_messages(bytes(data.to_py()))):
        try:
            subsets.extend(_decode_message(b))
        except Exception:
            if i == 0:
                raise  # Later messages that fail are skipped
    return subsets

def _decode_message(b):
    td = Decoder().process(b).template_data.value
    subsets = []
    for descs, vals in zip(td.decoded_descriptors_all_subsets, td.decoded_values_all_subsets):
        rows = []
        for d, v in zip(descs, vals):
            # Skip sequences, operators, replication factors and missing values
            if not isinstance(d, ElementDescriptor) or v is None or d.id // 1000 == 31:
                continue
            v = _value(v)
            if v == '':
                continue
            rows.append((d.id, d.name, v, d.unit))
        subsets.append(rows)
    return subsets

# Soundings (TEMP) repeat a block per level: time offset and significance,
# then pressure, height, drift, temperature, dewpoint and wind. Rather than
# thousands of rows, return the header rows plus one compact entry per level:
# [pressure hPa, height gpm, temperature C, dewpoint C, wind dir, wind m/s, dlat, dlon]
_LEVEL = {10009: 1, 12101: 2, 12103: 3, 11001: 4, 11002: 5, 5015: 6, 6015: 7}

def _profile(rows):
    if sum(1 for r in rows if r[0] == 7004) < 3:
        return rows, None
    header, levels, level = [], [], None
    for d, name, v, unit in rows:
        if d == 7004:
            level = [v / 100, None, None, None, None, None, None, None]
            levels.append(level)
        elif level is None:
            if d not in (4086, 8042):
                header.append((d, name, v, unit))
        elif d in _LEVEL and level[_LEVEL[d]] is None and isinstance(v, (int, float)):
            level[_LEVEL[d]] = round(v - 273.15, 2) if d in (12101, 12103) else v
    return header, levels

def ready():
    return 'ok'

# ---- Weather radar (ODIM HDF5 polar volumes). Returns the lowest-elevation
# reflectivity scan, DBZH before TH, as bytes of (dBZ + 32) * 2, 0 for no echo.
def _attr(groups, name, default=None):
    for g in groups:
        if g is not None and name in g.attrs:
            v = g.attrs[name]
            if isinstance(v, bytes):
                return v.decode()
            return v.item() if hasattr(v, 'item') else v
    return default

# GAMIC volumes (scan0, scan1, ... each with moment_N datasets) instead of ODIM's
# dataset1/data1: values span dyn_range_min..max over 1..2^bits-1 (0 is no data),
# and each ray's azimuth is in ray_header, so rays are put back on whole degrees
def _gamic_scan(f, np, base64):
    best = None
    for name, s in f.items():
        if not name.startswith('scan') or 'how' not in s:
            continue
        el = _attr([s['how']], 'elevation')
        for m in s:
            q = _attr([s[m]], 'moment') if m.startswith('moment_') else None
            if q in ('Zh', 'UZh') and el is not None:
                rank = (q != 'Zh', float(el))
                if best is None or rank < best[0]:
                    best = (rank, s, s[m], q)
    if best is None:
        return None
    _, s, m, q = best
    raw = m[()]
    bits = 16 if raw.dtype == np.uint16 else 8
    lo, hi = float(_attr([m], 'dyn_range_min')), float(_attr([m], 'dyn_range_max'))
    dbz = lo + (raw.astype('float32') - 1) * (hi - lo) / (2 ** bits - 2)
    q8 = np.clip(np.round((dbz + 32) * 2), 1, 254).astype('uint8')
    q8[raw == 0] = 0
    rays = s['ray_header'][()]
    start, stop = rays['azimuth_start'], rays['azimuth_stop']
    azimuth = (start + ((stop - start) % 360) / 2) % 360
    out = np.zeros((360, raw.shape[1]), 'uint8')
    out[azimuth.astype(int) % 360] = q8
    # Fine range gates (100 m out to 250 km) are thinned to at most 1250 bins
    step = max(1, -(-raw.shape[1] // 1250))
    out = np.ascontiguousarray(out[:, ::step])
    when = str(_attr([f['what']], 'date', ''))
    how = s['how']
    return json.dumps({
        'quantity': 'DBZH' if q == 'Zh' else 'TH',
        'source': {'NOD': _attr([f.get('how')], 'site_name') or _attr([f.get('how')], 'host_name') or ''},
        'lat': float(_attr([f['where']], 'lat')),
        'lon': float(_attr([f['where']], 'lon')),
        'elangle': float(_attr([how], 'elevation')),
        'rscale': float(_attr([how], 'range_step')) * step,     # m
        'rstart': float(_attr([how], 'range_start', 0.0)) / 1000,  # km
        'nrays': 360,
        'nbins': int(out.shape[1]),
        'date': when[:10].replace('-', ''),
        'time': when[11:19].replace(':', ''),
        'data': base64.b64encode(out.tobytes()).decode(),
    })

def radar_scan(data):
    import io, base64
    import h5py
    import numpy as np
    f = h5py.File(io.BytesIO(bytes(data.to_py())), 'r')
    if any(k.startswith('scan') for k in f):
        return _gamic_scan(f, np, base64) or json.dumps(None)
    best = None
    for name, ds in f.items():
        if not name.startswith('dataset') or 'where' not in ds:
            continue
        el = _attr([ds['where']], 'elangle')
        if el is None:
            continue
        for dname, d in ds.items():
            if not dname.startswith('data') or 'data' not in d:
                continue
            q = _attr([d.get('what'), ds.get('what')], 'quantity')
            if q not in ('DBZH', 'TH'):
                continue
            rank = (q != 'DBZH', float(el))
            if best is None or rank < best[0]:
                best = (rank, ds, d, q)
    if best is None:
        return json.dumps(None)
    _, ds, d, q = best
    whats = [d.get('what'), ds.get('what'), f.get('what')]
    raw = d['data'][()]
    dbz = raw.astype('float32') * float(_attr(whats, 'gain', 1.0)) + float(_attr(whats, 'offset', 0.0))
    out = np.clip(np.round((dbz + 32) * 2), 1, 254).astype('uint8')
    for flag in ('nodata', 'undetect'):
        v = _attr(whats, flag)
        if v is not None:
            out[raw == v] = 0
    where = [ds['where'], f.get('where')]
    source = _attr([f.get('what')], 'source', '')
    return json.dumps({
        'quantity': q,
        'source': dict(p.split(':', 1) for p in source.split(',') if ':' in p),
        'lat': float(_attr([f.get('where')], 'lat')),
        'lon': float(_attr([f.get('where')], 'lon')),
        'elangle': float(_attr([ds['where']], 'elangle')),
        'rscale': float(_attr(where, 'rscale')),        # m
        'rstart': float(_attr(where, 'rstart', 0.0)),   # km
        'nrays': int(raw.shape[0]),
        'nbins': int(raw.shape[1]),
        'date': _attr([ds.get('what'), f.get('what')], 'startdate') or _attr([f.get('what')], 'date'),
        'time': _attr([ds.get('what'), f.get('what')], 'starttime') or _attr([f.get('what')], 'time'),
        'data': base64.b64encode(out.tobytes()).decode(),
    })

def decode_subsets(data, limit=0):
    subsets = _decode(data)
    indexes = range(len(subsets))
    if limit and len(subsets) > limit:
        # Spread the reports kept across the whole file, e.g. a satellite swath
        indexes = indexes[::-(-len(subsets) // limit)]
    # Each report's index in the file too, so it can be decoded again later
    return json.dumps([_profile(subsets[i]) + (i,) for i in indexes])

def decode_bufr(data, wsi, key, index=-1):
    if key not in _cache:
        if data is None:
            raise ValueError('this file is no longer cached, decode it again')
        _cache[key] = _decode(data)
        if len(_cache) > 20:
            _cache.pop(next(iter(_cache)))
    subsets = _cache[key]
    if not 0 <= index < len(subsets):
        index = next((i for i, rows in enumerate(subsets) if _wsi(rows) == wsi), 0)
    rows, profile = _profile(subsets[index])
    return json.dumps({
        'subsets': len(subsets),
        'index': index,
        'rows': rows,
        'profile': profile,
    })
`;

// Pyodide runs in a worker so decoding never blocks the map. The worker is
// built from a string (a classic worker script), so no file to serve alongside
const DECODER_WORKER = `
importScripts('${PYODIDE_URL}pyodide.js');
let ready = null;
let h5py = null;  // Loaded on the first radar file

async function init(wheelUrls) {
    const py = await loadPyodide({ indexURL: '${PYODIDE_URL}' });
    await py.loadPackage('micropip');
    await py.pyimport('micropip').install(['bitstring==3.1.9', 'six']);
    // pybufrkit only ships as an sdist, so we serve our own pure-Python wheel,
    // falling back to the CDN copy when the local one can't be fetched
    let wheel = null;
    for (const url of wheelUrls) {
        try {
            const response = await fetch(url);
            if (response.ok) { wheel = await response.arrayBuffer(); break; }
        } catch (err) {}
    }
    if (!wheel) throw new Error('could not download the BUFR decoder');
    py.unpackArchive(wheel, 'wheel');
    py.runPython(${JSON.stringify(DECODE_PY)});
    return py;
}

onmessage = async (e) => {
    const { id, fn, args, wheelUrls } = e.data;
    try {
        if (!ready) ready = init(wheelUrls);
        const py = await ready;
        if (fn === 'radar_scan') await (h5py = h5py || py.loadPackage('h5py'));
        postMessage({ id, result: py.globals.get(fn)(...args) });
    } catch (err) {
        ready = null;  // Allow a retry after a failed start
        postMessage({ id, error: err.message });
    }
};
`;

// Warm the decoder up once the map is idle so the first Decode is quick.
// Skipped on data-saver or very slow connections (it's roughly 15 MB on first visit).
export function preloadDecoder() {
    var connection = navigator.connection;
    if (connection && (connection.saveData || /2g/.test(connection.effectiveType || ''))) return;
    var start = () => callDecoder('ready').catch((err) => console.debug(`Decoder preload failed: ${err.message}`));
    if ('requestIdleCallback' in window) {
        requestIdleCallback(start, { timeout: 10000 });
    } else {
        setTimeout(start, 3000);
    }
}

// Two decoders where the device can afford them: whole files (GTS bulletins,
// satellite swaths, up to half a second each) go to one, so popups and station
// colouring (a few ms each) never wait behind them. Phones and small devices
// keep one, since each holds its own copy of Python. The second loads only once
// the first is ready (loading both at once slows the first), and takes files
// once it is ready itself.
let filesDecoderReady = false;

function roomyForTwoDecoders() {
    return !window.matchMedia('(max-width: 600px)').matches
        && (navigator.deviceMemory || 8) >= 4 && (navigator.hardwareConcurrency || 4) >= 4;
}

function decoderLane(fn) {
    return (fn === 'decode_subsets' || fn === 'radar_scan') && filesDecoderReady ? 'files' : 'main';
}

function startFilesDecoder() {
    if (decoderWorkers.files || !roomyForTwoDecoders()) return;
    callDecoderOn('files', 'ready').then(() => { filesDecoderReady = true; })
        .catch((err) => console.debug(`Second decoder failed: ${err.message}`));
}

export function callDecoder(fn, ...args) {
    return callDecoderOn(decoderLane(fn), fn, ...args);
}

function callDecoderOn(lane, fn, ...args) {
    var worker = decoderWorkers[lane];
    if (!worker) {
        worker = decoderWorkers[lane] = new Worker(URL.createObjectURL(new Blob([DECODER_WORKER], { type: 'text/javascript' })));
        worker.onmessage = (e) => {
            var call = decoderCalls.get(e.data.id);
            decoderCalls.delete(e.data.id);
            if (e.data.error) {
                if (lane === 'main' && !decoderReady && !decoderGaveUp) {
                    decoderGaveUp = true;
                    settled();
                }
                return call.reject(new Error(e.data.error));
            }
            if (lane === 'main' && !decoderReady) {
                decoderReady = true;
                startFilesDecoder();
                settled();  // What was held back until now goes ahead
            }
            call.resolve(e.data.result);
        };
    }
    var wheelUrls = [new URL(PYBUFRKIT_WHEEL, document.baseURI).href, PYBUFRKIT_WHEEL_CDN];
    return new Promise((resolve, reject) => {
        var id = nextCall++;
        decoderCalls.set(id, { resolve, reject });
        worker.postMessage({ id, fn, args, wheelUrls });
    });
}
