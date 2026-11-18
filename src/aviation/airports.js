// Airports worldwide: the latest METAR from each airport, from the Iowa
// Environmental Mesonet, which keeps one network per country (per state in the
// US, per province in Canada). Every network is fetched, a few at a time and
// nearest the view first, and again once AIRPORT_REFRESH_MS old. Readings become
// BUFR-style rows, so the tiles, colouring and forecast comparison work as they
// do for WIS2 stations.
const IEM_API = 'https://mesonet.agron.iastate.edu/api/1';
const AIRPORT_NETWORK = /_ASOS$/;
const AIRPORT_REFRESH_MS = 20 * 60 * 1000;
const AIRPORT_CONCURRENT = 6;
const airportStations = new Map();  // station id -> record, bounded by IEM's station lists
let airportNetworks = null;         // promise of [{ id, name, bounds: [w, s, e, n], fetched, pending }]
let airportActive = 0;
let deps = null;

// shown(): whether the METAR layer is on. centre(): the map's centre (a LngLat).
// addStation(stations, station): puts an airport on the map (the page's
// externalStation), keeping it in stations by id
export function initAirports({ shown, centre, addStation }) {
    deps = { shown, centre, addStation };
    setInterval(() => { if (airportStations.size) queueAirports(); }, 5 * 60 * 1000);
}

function loadAirportNetworks() {
    if (!airportNetworks) {
        airportNetworks = fetch(`${IEM_API}/networks.json`).then((r) => {
            if (!r.ok) throw new Error(`IEM answered ${r.status}`);
            return r.json();
        }).then((json) => json.data.filter((n) => AIRPORT_NETWORK.test(n.id) && n.extent)
            .map((n) => ({ id: n.id, name: n.name, bounds: wkbBounds(n.extent), fetched: 0, pending: false }))
            .filter((n) => n.bounds))
            .catch((err) => {
                airportNetworks = null;  // Try again next time
                console.debug(`Could not load the IEM networks: ${err.message}`);
                return [];
            });
    }
    return airportNetworks;
}

// The bounding box of a polygon in hex (E)WKB, as IEM gives network extents
function wkbBounds(hex) {
    var bytes = new Uint8Array(hex.match(/../g).map((h) => parseInt(h, 16)));
    var view = new DataView(bytes.buffer), little = bytes[0] === 1;
    var type = view.getUint32(1, little), at = 5 + (type & 0x20000000 ? 4 : 0);
    if ((type & 0xff) !== 3) return null;
    var points = view.getUint32(at + 4, little), w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (var i = 0, p = at + 8; i < points; i++, p += 16) {
        var x = view.getFloat64(p, little), y = view.getFloat64(p + 8, little);
        w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y);
    }
    return points ? [w, s, e, n] : null;
}

// Fetches the networks due, nearest the view first, a few at a time
export async function queueAirports() {
    if (!deps.shown()) return;
    var networks = await loadAirportNetworks();
    var centre = deps.centre(), now = Date.now();
    var away = (b) => Math.hypot((b[0] + b[2]) / 2 - centre.lng, (b[1] + b[3]) / 2 - centre.lat);
    var due = networks.filter((n) => !n.pending && now - n.fetched > AIRPORT_REFRESH_MS)
        .sort((a, b) => away(a.bounds) - away(b.bounds));
    for (var n of due) {
        if (airportActive >= AIRPORT_CONCURRENT) break;
        loadAirportNetwork(n);
    }
}

async function loadAirportNetwork(network) {
    airportActive++;
    network.pending = true;
    try {
        var response = await fetch(`${IEM_API}/currents.json?network=${encodeURIComponent(network.id)}`);
        if (!response.ok) throw new Error(`IEM answered ${response.status}`);
        var json = await response.json();
        for (var ob of json.data) updateAirport(ob, network);
    } catch (err) {
        console.debug(`IEM ${network.id}: ${err.message}`);
    } finally {
        network.fetched = Date.now();  // A failed network waits as long as a fetched one
        network.pending = false;
        airportActive--;
        queueAirports();
    }
}

function updateAirport(ob, network) {
    if (!ob.station || !isFinite(ob.lat) || !isFinite(ob.lon)) return;
    var val = (v, scale = 1, offset = 0) => (v === null || v === undefined || !isFinite(v) ? null : v * scale + offset);
    var rows = [];
    var add = (descriptor, name, value, unit) => { if (value !== null && value !== undefined && value !== '') rows.push([descriptor, name, value, unit]); };
    add(1015, 'STATION OR SITE NAME', ob.name, 'CCITT IA5');
    add(12101, 'TEMPERATURE/AIR TEMPERATURE', val(ob.tmpf, 5 / 9, 273.15 - 32 * 5 / 9), 'K');
    add(12103, 'DEWPOINT TEMPERATURE', val(ob.dwpf, 5 / 9, 273.15 - 32 * 5 / 9), 'K');
    add(13003, 'RELATIVE HUMIDITY', val(ob.relh) === null ? null : Math.round(ob.relh), '%');
    add(10051, 'PRESSURE REDUCED TO MEAN SEA LEVEL', val(ob.mslp, 100), 'Pa');
    add(11001, 'WIND DIRECTION', val(ob.drct), 'deg');
    add(11002, 'WIND SPEED', val(ob.sknt, 0.514444), 'm/s');
    add(11041, 'MAXIMUM WIND GUST SPEED', val(ob.gust, 0.514444), 'm/s');
    add(20001, 'HORIZONTAL VISIBILITY', val(ob.vsby, 1609.34), 'm');
    add(0, 'PRESENT WEATHER', ob.wxcodes ? [].concat(ob.wxcodes).join(' ') : null, '');
    add(0, 'METAR', ob.raw, '');
    var id = ob.station;
    deps.addStation(airportStations, { layer: 'airports', centre: network.name.replace(/ ASOS$/, ''), badge: 'METAR', format: 'metar',
        id, lat: ob.lat, lon: ob.lon, name: ob.name, observed: Date.parse(ob.utc_valid || ''), rows, path: `metar/${id}`,
        notification: { ...ob, source: `${IEM_API}/currents.json?network=${network.id}` },
        link: { rel: 'canonical', href: `${IEM_API}/currents.json?station=${encodeURIComponent(id)}&network=${encodeURIComponent(network.id)}`, type: 'application/json' } });
}
