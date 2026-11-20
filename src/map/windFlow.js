// Wind as moving air: while the map is styled by a wind measure, thin streaks flow
// across it the way the wind blows, in place of the arrows. Each streak is a particle at
// a place on the Earth (longitude, latitude), carried by the wind there: the winds
// measured (station reports, or the satellite page's cloud-motion winds in their coverage
// cells), blended by distance, only near them, so no flow is drawn where nothing was
// measured. Each keeps its last FLOW_TRAIL_POINTS places, and the canvas over the map is
// drawn afresh every frame, older parts of a trail fainter: so trails never build up, and
// as they're places, not pixels, the streaks carry on while the map pans and zooms (with
// shorter trails meanwhile, each place projected again every frame). Viewers who ask for
// less motion keep the arrows
import { map } from './map.js';
import { state } from '../state.js';
import { records } from './points.js';
import { effectiveHidden } from './layers.js';
import { passesFilters } from '../lib/filters.js';
import { cellCentre, h3SpacingKm, getResolution } from '../lib/geo.js';
import { shownGrid } from '../data/satellite/coverage.js';
import { windArrows } from './colour.js';
import { reduceMotion } from './pulses.js';

export const FLOW_PARTICLES_PER_WIND = 0.5;  // Streaks for each wind measured in view...
export const FLOW_PARTICLES_MAX = 600;  // ...at most
export const FLOW_SPEED_PX = 0.04;  // Screen pixels a frame (at 60 a second) for each m/s, near the map's centre
export const FLOW_AGE_MAX = 200;  // Frames a streak lives (each a little less, at random)
export const FLOW_TRAIL_POINTS = 24;  // Places a trail keeps: its length, in frames
export const FLOW_MOVING_TRAIL_POINTS = 6;  // ...while the map moves, when each is projected again every frame
export const FLOW_STATION_REACH_KM = 250;  // How far a station's wind reaches (a coverage cell's: a cell and a half)
export const FLOW_WINDS_REFRESH_MS = 5000;  // The winds are looked at again this often
const ARROW_LAYERS = ['points-arrow', 'swath-arrows'];
// Brighter for stronger winds: [m/s from, opacity]
const SPEED_SHADES = [[0, 0.35], [4, 0.55], [9, 0.75], [15, 0.95]];
// Along a trail, oldest third to newest: how much of that opacity each part has
const TRAIL_SHADES = [0.25, 0.55, 1];
const D2R = Math.PI / 180;

let canvas = null, ctx = null, dpr = 1;
let winds = null;  // The winds measured, indexed for looking up near a place (indexWinds)
let windsKey = null, checkedAt = 0, lastFrame = 0, arrowsHidden = false;
let moving = false, viewMoved = true;  // The map is moving; it has moved since trails were projected
let particles = [];
let inView = [];  // The winds measured in view, where streaks start

// Whether the streaks are drawn now (rather than the arrows)
export function flowShown() {
    return !reduceMotion && windArrows();
}

export function startWindFlow() {
    if (reduceMotion) return;
    canvas = document.createElement('canvas');
    canvas.className = 'wind-flow';
    map.getCanvasContainer().appendChild(canvas);
    ctx = canvas.getContext('2d');
    map.on('movestart', () => { moving = true; });
    map.on('move', () => { viewMoved = true; });
    map.on('moveend', () => {
        moving = false;
        viewMoved = true;
        findInView();
    });
    map.on('resize', () => {
        sizeCanvas();
        viewMoved = true;
    });
    sizeCanvas();
    requestAnimationFrame(frame);
}

function sizeCanvas() {
    var mapCanvas = map.getCanvas();
    dpr = mapCanvas.width / Math.max(1, mapCanvas.clientWidth);
    canvas.width = mapCanvas.width;
    canvas.height = mapCanvas.height;
    canvas.style.width = `${mapCanvas.clientWidth}px`;
    canvas.style.height = `${mapCanvas.clientHeight}px`;
}

function stop() {
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    winds = null;
    windsKey = null;
    particles = [];
    inView = [];
}

// The arrows go while the streaks are drawn, and come back when they stop
function showArrows(shown) {
    if (arrowsHidden === !shown) return;
    arrowsHidden = !shown;
    for (var id of ARROW_LAYERS) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', shown ? 'visible' : 'none');
}

function frame(now) {
    requestAnimationFrame(frame);
    var on = flowShown();
    showArrows(!on);
    if (!on || document.hidden) {
        if (winds) stop();
        lastFrame = 0;
        return;
    }
    // The winds are looked at again every FLOW_WINDS_REFRESH_MS, and indexed again only
    // if they changed; the streaks carry on through it
    if (!winds || now - checkedAt > FLOW_WINDS_REFRESH_MS) {
        checkedAt = now;
        var measured = measuredWinds(), key = windsSignature(measured);
        if (key !== windsKey) {
            windsKey = key;
            winds = indexWinds(measured);
            findInView();
        }
    }
    // Time since the last frame, in frames at 60 a second: a frame the page was busy for
    // moves the streaks as far as it should have, rather than stalling them
    var steps = lastFrame ? Math.min(3, (now - lastFrame) / (1000 / 60)) : 1;
    lastFrame = now;
    advance(steps);
    draw();
}

// The winds measured, as [lon, lat, east m/s, north m/s, cell spacing km or none], the
// way the air moves (reports give where it comes from). Styled by cloud-level wind, the
// satellites' coverage cells; either way, the points with a wind and its direction. Only
// what the filters leave
function measuredWinds() {
    var measured = [], hidden = new Set(effectiveHidden()), key = state.colourBy;
    if (key === 'satWind') {
        for (var cell of shownGrid().cells.values()) {
            var n = cell.counts.satWind;
            if (!n || !(cell.windX || cell.windY)) continue;
            var file = cell.files.values().next().value;
            if (file && !passesFilters(file.props, hidden)) continue;
            // With how far apart its cells are, which sets how far its wind reaches
            measured.push([...cellCentre(cell.h3), -cell.windX / n, -cell.windY / n, h3SpacingKm(getResolution(cell.h3))]);
        }
    }
    for (var record of records.values()) {
        var p = record.feature && record.feature.properties;
        if (!p || p.superseded) continue;
        var speed = p[`m_${key}`], direction = p.m_windDir;
        if (typeof speed !== 'number' || typeof direction !== 'number' || !passesFilters(p, hidden)) continue;
        var radians = direction * D2R;
        measured.push([record.coords[0], record.coords[1], -speed * Math.sin(radians), -speed * Math.cos(radians)]);
    }
    return measured;
}

// A short summary of the winds measured, which changes when they do
function windsSignature(measured) {
    var signature = measured.length;
    for (var wind of measured) signature = (signature * 31 + Math.round(wind[0] * 100) + Math.round(wind[1] * 100) + Math.round(wind[2] * 10)) % 1e9;
    return signature;
}

function wrapLon(lon) {
    return ((((lon + 180) % 360) + 360) % 360) - 180;
}

// The winds by square of the globe, about their reach across, so the wind at a place
// looks only at those near it. Their reach: for coverage cells a cell and a half (the
// typical cell's spacing), so a lone cell's wind stays round it; for stations
// FLOW_STATION_REACH_KM
function indexWinds(measured) {
    var spacings = measured.filter((w) => w[4]).map((w) => w[4]).sort((a, b) => a - b);
    var reachKm = spacings.length ? spacings[Math.floor(spacings.length / 2)] * 1.5 : FLOW_STATION_REACH_KM;
    var binDeg = reachKm / 111, cols = Math.ceil(360 / binDeg);
    var bins = new Map();
    for (var [lon, lat, u, v] of measured) {
        lon = wrapLon(lon);
        var key = Math.floor((lat + 90) / binDeg) * cols + Math.floor((lon + 180) / binDeg);
        if (!bins.has(key)) bins.set(key, []);
        bins.get(key).push([lon, lat, u, v, Math.hypot(u, v)]);
    }
    return { all: measured, bins, binDeg, cols, reachKm };
}

// The wind at a place, blended from those within reach ((1 - d²/R²)², none past R):
// { u, v (east and north, m/s), speed }, or null where none reaches. The answer is in
// here, which the next call overwrites (one object, not one per streak per frame)
const here = { u: 0, v: 0, speed: 0 };
function windAt(lon, lat) {
    var { bins, binDeg, cols, reachKm } = winds;
    var row = Math.floor((lat + 90) / binDeg), col = Math.floor((lon + 180) / binDeg);
    var cosLat = Math.max(0.05, Math.cos(lat * D2R));
    var span = Math.min(cols, Math.ceil(1 / cosLat));  // Squares of longitude the reach spans, wider towards the poles
    var su = 0, sv = 0, ss = 0, sw = 0, r2 = reachKm * reachKm;
    for (var dr = -1; dr <= 1; dr++) {
        for (var dc = -span; dc <= span; dc++) {
            var list = bins.get((row + dr) * cols + ((((col + dc) % cols) + cols) % cols));
            if (!list) continue;
            for (var [wlon, wlat, u, v, speed] of list) {
                var dx = (((wlon - lon + 540) % 360) - 180) * cosLat * 111, dy = (wlat - lat) * 111;
                var q = (dx * dx + dy * dy) / r2;
                if (q >= 1) continue;
                var weight = (1 - q) * (1 - q);
                su += u * weight;
                sv += v * weight;
                ss += speed * weight;
                sw += weight;
            }
        }
    }
    if (sw < 0.05) return null;
    here.u = su / sw;
    here.v = sv / sw;
    here.speed = ss / sw;
    return here;
}

// Whether a place is on the side of the globe facing the viewer (within 80° of the
// map's centre): streaks round the back aren't drawn, and start again in view
function facing(lon, lat, centre) {
    var cos = Math.sin(lat * D2R) * Math.sin(centre.lat * D2R)
        + Math.cos(lat * D2R) * Math.cos(centre.lat * D2R) * Math.cos((lon - centre.lng) * D2R);
    return cos > Math.cos(80 * D2R);
}

// The winds measured in view, where streaks start, and so how many there are
function findInView() {
    if (!winds) return;
    var w = canvas.clientWidth, h = canvas.clientHeight, centre = map.getCenter();
    inView = winds.all.filter(([lon, lat]) => {
        if (!facing(lon, lat, centre)) return false;
        var at = map.project([lon, lat]);
        return at.x >= 0 && at.y >= 0 && at.x <= w && at.y <= h;
    });
}

// A streak somewhere near a wind measured in view, a little way from it at random
function spawn(particle) {
    var wind = inView[Math.floor(Math.random() * inView.length)];
    var distance = winds.reachKm * 0.7 * Math.sqrt(Math.random()), angle = Math.random() * 2 * Math.PI;
    particle.lat = Math.max(-89, Math.min(89, wind[1] + (distance * Math.cos(angle)) / 111));
    particle.lon = wrapLon(wind[0] + (distance * Math.sin(angle)) / (111 * Math.max(0.05, Math.cos(wind[1] * D2R))));
    particle.age = Math.floor(Math.random() * FLOW_AGE_MAX * 0.5);
    particle.places = [];
    particle.points = [];
    particle.speed = 0;
    return particle;
}

// Every streak a step along the wind where it is: steps frames' worth, at FLOW_SPEED_PX
// a frame for each m/s near the map's centre (a degree's length on screen there)
function advance(steps) {
    var wanted = inView.length ? Math.min(FLOW_PARTICLES_MAX, Math.max(1, Math.round(inView.length * FLOW_PARTICLES_PER_WIND))) : 0;
    while (particles.length < wanted) particles.push(spawn({}));
    particles.length = wanted;
    if (!wanted) return;
    var centre = map.getCenter();
    var a = map.project(centre), b = map.project([centre.lng, Math.min(89, centre.lat + 0.01)]);
    var degPerPx = 0.01 / (Math.hypot(b.x - a.x, b.y - a.y) || 1);
    var stride = FLOW_SPEED_PX * steps * degPerPx;  // Degrees of latitude for each m/s
    for (var particle of particles) {
        particle.age += steps;
        var wind = particle.age < FLOW_AGE_MAX && facing(particle.lon, particle.lat, centre) && windAt(particle.lon, particle.lat);
        // Calm air (no movement to show) starts again elsewhere too
        if (!wind || wind.speed < 0.3) {
            spawn(particle);
            continue;
        }
        particle.speed = wind.speed;
        particle.lat = Math.max(-89, Math.min(89, particle.lat + wind.v * stride));
        particle.lon = wrapLon(particle.lon + (wind.u * stride) / Math.max(0.05, Math.cos(particle.lat * D2R)));
        particle.places.push([particle.lon, particle.lat]);
        if (particle.places.length > FLOW_TRAIL_POINTS) particle.places.shift();
        // Its place on screen, while the view stays put (see draw for when it moves)
        if (!viewMoved) {
            var at = map.project([particle.lon, particle.lat]);
            particle.points.push([at.x, at.y]);
            if (particle.points.length > FLOW_TRAIL_POINTS) particle.points.shift();
        }
    }
}

function draw() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!particles.length) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // After the view moves, the trails' places on screen again: while it's moving, only
    // their newest few, every frame; once it stops, the whole trail, once
    if (viewMoved) {
        for (var particle of particles) {
            var places = moving ? particle.places.slice(-FLOW_MOVING_TRAIL_POINTS) : particle.places;
            particle.points = places.map((place) => {
                var at = map.project(place);
                return [at.x, at.y];
            });
        }
        if (!moving) viewMoved = false;
    }
    // Each trail's segments by how strong its wind is and how old the segment, so the
    // whole lot is a few strokes: a light line on a faint dark edge, so they show on pale
    // map and dark coverage alike
    var buckets = SPEED_SHADES.map(() => TRAIL_SHADES.map(() => []));
    for (var p of particles) {
        var points = p.points, n = points.length;
        if (n < 2) continue;
        var shade = SPEED_SHADES.length - 1;
        while (shade > 0 && p.speed < SPEED_SHADES[shade][0]) shade--;
        for (var i = 1; i < n; i++) {
            var [x1, y1] = points[i - 1], [x2, y2] = points[i];
            // Don't join places either side of the world (a trail across ±180, or round the back)
            if (Math.abs(x2 - x1) > 50 || Math.abs(y2 - y1) > 50) continue;
            var age = Math.min(TRAIL_SHADES.length - 1, Math.floor((i / n) * TRAIL_SHADES.length));
            buckets[shade][age].push(x1, y1, x2, y2);
        }
    }
    ctx.lineCap = 'round';
    buckets.forEach((byAge, shade) => byAge.forEach((segments, age) => {
        if (!segments.length) return;
        var alpha = SPEED_SHADES[shade][1] * TRAIL_SHADES[age];
        for (var [colour, width] of [[`rgba(15, 30, 55, ${alpha * 0.35})`, 2.6], [`rgba(240, 248, 255, ${alpha})`, 1.3]]) {
            ctx.beginPath();
            for (var k = 0; k < segments.length; k += 4) {
                ctx.moveTo(segments[k], segments[k + 1]);
                ctx.lineTo(segments[k + 2], segments[k + 3]);
            }
            ctx.strokeStyle = colour;
            ctx.lineWidth = width;
            ctx.stroke();
        }
    }));
}
