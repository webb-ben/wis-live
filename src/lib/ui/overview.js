// World overview in the Equal Earth projection, which keeps areas true to size
// (MapLibre has no Equal Earth). A small map always shown in the bottom-right
// panel. D3 draws the sea, land and the main map's view as a frame; the page
// draws what's on the map (points, satellite coverage) through drawContent. A
// click goes to that place on the map. The D3 pieces it uses, topojson-client and
// the coastlines are a separate bundle, loaded as it starts.
import { cellRing } from '../geo.js';

const OVERVIEW_REFRESH_MS = 2000;
const COVERING = '.queue, .infobar';  // Panels over the map's edges: the sidebar and the info panel
// map: the MapLibre map. drawContent(ctx, projection, d3, width): draws the points
// and coverage. hoveredCell(): the coverage cell ('…|<h3>') under the pointer, if any.
// Returns the section to put on the page, and:
//   draw()               redraws (also every OVERVIEW_REFRESH_MS, and after a pan or zoom)
//   hover(lngLat|null)   marks where the map's hover label is
//   select(sel|null)     marks what the info panel shows: { at: [lon, lat], colour, h3 }, or
//                        for a satellite, border ([lon, lat] segments) in place of h3
export function createOverview({ map, drawContent, hoveredCell }) {
    var section = document.createElement('div');
    section.className = 'key-overview';
    section.innerHTML = `
        <div class="pp-status overview-status">Loading…</div>
        <div class="overview-frame">
            <canvas class="overview-map" role="img" aria-label="World map in the Equal Earth projection; click to go there on the map"
                title="World map, Equal Earth projection (true areas). Click to go there"></canvas>
            <canvas class="overview-hover" aria-hidden="true"></canvas>
        </div>`;
    // What's hovered on the map is drawn on a canvas of its own over the overview, so
    // following the pointer doesn't redraw every point and cell
    var canvas = section.querySelector('.overview-map'), hoverCanvas = section.querySelector('.overview-hover');
    var d3 = null, land = null, projection = null, timer = null, ready = null;
    var hovered = null;  // A LngLat
    var selected = null;

    canvas.addEventListener('click', (e) => {
        if (!projection) return;
        var box = canvas.getBoundingClientRect();
        var lonLat = projection.invert([e.clientX - box.left, e.clientY - box.top]);
        // Outside the outline of the Earth there's nowhere to go
        if (!lonLat || !(Math.abs(lonLat[0]) <= 180 && Math.abs(lonLat[1]) <= 90)) return;
        map.flyTo({ center: lonLat, zoom: Math.max(map.getZoom(), 3) });
    });
    window.addEventListener('resize', draw);
    // Drawn once the panel is on the page and has a size (and the rest of the page's
    // script has run, as the panel is built part way through), then kept up to date
    requestAnimationFrame(() => load().then(() => {
        draw();
        timer = setInterval(draw, OVERVIEW_REFRESH_MS);
        // A pan or zoom shows at once (the view's frame moves), rather than at the next
        // refresh, which then starts over from here
        // Not inside MapLibre's own frame: after an animated move (flyTo, easeTo) moveend fires
        // from its render task, and asking the map for its view there (viewEdge's unproject)
        // runs its task queue again ("Attempting to run(), but is already running")
        map.on('moveend', () => setTimeout(() => {
            clearInterval(timer);
            draw();
            timer = setInterval(draw, OVERVIEW_REFRESH_MS);
        }));
        // So does the sidebar or info panel sliding over the map or away (see viewEdge)
        document.addEventListener('transitionend', (e) => {
            if (e.target.matches && e.target.matches(COVERING)) draw();
        });
    }));

    function load() {
        if (!ready) {
            ready = (async () => {
                var [geo, scale, topojson, topo] = await Promise.all([import('d3-geo'), import('d3-scale'),
                    import('topojson-client'), import('world-atlas/land-110m.json')]);
                d3 = { geoEqualEarth: geo.geoEqualEarth, geoPath: geo.geoPath, geoGraticule10: geo.geoGraticule10, scaleLinear: scale.scaleLinear };
                land = topojson.feature(topo.default, topo.default.objects.land);
                section.querySelector('.overview-status').remove();
            })().catch((err) => {
                section.querySelector('.overview-status').textContent = `Could not load the world map: ${err.message}`;
            });
        }
        return ready;
    }

    function draw() {
        if (!land) return;
        var box = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
        var w = box.width, h = box.height;
        if (!w || !h) return;
        if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
            canvas.width = Math.round(w * dpr);
            canvas.height = Math.round(h * dpr);
        }
        var ctx = canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        projection = d3.geoEqualEarth().fitExtent([[2, 2], [w - 2, h - 2]], { type: 'Sphere' });
        var path = d3.geoPath(projection, ctx);

        // Sea, graticule and land, in the basemap's greys
        ctx.beginPath();
        path({ type: 'Sphere' });
        ctx.fillStyle = '#dde3e6';
        ctx.fill();
        ctx.beginPath();
        path(d3.geoGraticule10());
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.06)';
        ctx.lineWidth = 0.5;
        ctx.stroke();
        ctx.beginPath();
        path(land);
        ctx.fillStyle = '#f4f4f2';
        ctx.fill();
        ctx.strokeStyle = '#c4c9cc';
        ctx.stroke();

        drawContent(ctx, projection, d3, w);
        ctx.globalAlpha = 1;

        // The map's own view, as a frame, so it's clear where a click goes back from
        // Traced along the map's edges (points unprojected from the screen), as a line rather
        // than a polygon of its bounds: D3 takes a polygon's inside from its winding and joins
        // corners by great circles, so on the globe the bounds' box could frame the rest of the
        // world instead. Not when the view takes in most of the world
        ctx.beginPath();
        var frame = viewBox(viewEdge());
        if (frame) {
            path({ type: 'LineString', coordinates: frame });
            ctx.strokeStyle = '#212529';
            ctx.lineWidth = 1.5;
            ctx.stroke();
        }
        drawMarks();
    }

    // The edge of the map's view, round the part of its canvas that can be seen clockwise
    // from the top left, as [lon, lat] every few pixels, each longitude kept within 180° of
    // the one before. The canvas runs under the sidebar (left) and the info panel (right):
    // on a globe what's under them can reach far round it (Russia's coast, behind a sidebar
    // over Canada), so the frame stops at their edges
    function viewEdge() {
        var c = map.getCanvas();
        var w = c.clientWidth, h = c.clientHeight, n = 24;
        var box = c.getBoundingClientRect();
        var x0 = 0, x1 = w;
        document.querySelectorAll(COVERING).forEach((el) => {
            var r = el.getBoundingClientRect();
            // Off the screen (closed: slid out) or not over the map
            if (!r.width || r.right <= box.left || r.left >= box.right || r.left >= window.innerWidth || r.right <= 0) return;
            if (r.left <= box.left + 1) x0 = Math.max(x0, r.right - box.left);
            else if (r.right >= box.right - 1) x1 = Math.min(x1, r.left - box.left);
        });
        if (x1 - x0 < 40) { x0 = 0; x1 = w; }  // A phone, the panel over nearly all of it: the whole map
        var screen = [];
        for (var i = 0; i < n; i++) screen.push([x0 + (x1 - x0) * i / n, 0]);
        for (var i = 0; i < n; i++) screen.push([x1, h * i / n]);
        for (var i = 0; i < n; i++) screen.push([x1 - (x1 - x0) * i / n, h]);
        for (var i = 0; i <= n; i++) screen.push([x0, h * (1 - i / n)]);
        var prev = null;
        return screen.map((xy) => {
            var p = map.unproject(xy);
            var lon = p.lng;
            if (prev != null) lon += Math.round((prev - lon) / 360) * 360;
            prev = lon;
            return [lon, Math.max(-90, Math.min(90, p.lat))];
        });
    }

    // The box of longitudes and latitudes around the view's edge, its sides along meridians
    // and parallels (every 2°, so they follow the overview's graticule rather than great
    // circles): a plain frame, not the globe's curved view. A view round a pole is a band
    // the whole way round; null for one that takes in most of the globe (zoomed out)
    function viewBox(edge) {
        var lons = edge.map((p) => p[0]), lats = edge.map((p) => p[1]);
        var w = Math.min(...lons), e = Math.max(...lons), s = Math.min(...lats), n = Math.max(...lats);
        if (e - w >= 300) { w = -180; e = 180; }
        if (n - s >= 140 || (e - w >= 360 && n - s >= 100)) return null;
        var side = (a, b) => {
            var count = Math.max(2, Math.ceil(Math.abs(b - a) / 2) + 1);
            return Array.from({ length: count }, (_, i) => a + (b - a) * i / (count - 1));
        };
        return [
            ...side(w, e).map((lon) => [lon, n]),
            ...side(n, s).map((lat) => [e, lat]),
            ...side(e, w).map((lon) => [lon, s]),
            ...side(s, n).map((lat) => [w, lat]),
        ];
    }

    // Marks what the info panel shows (selected) and what the map's pointer is over
    // (hovered). The selection: lines along its meridian and parallel across the
    // globe, so it can be found on the small map at a glance, and a dot in its colour
    // in a dark ring (its cell outlined too, for a coverage cell). The hover: a plain
    // ring, and the hovered cell's outline
    function drawMarks() {
        if (!projection) return;
        var dpr = window.devicePixelRatio || 1;
        if (hoverCanvas.width !== canvas.width || hoverCanvas.height !== canvas.height) {
            hoverCanvas.width = canvas.width;
            hoverCanvas.height = canvas.height;
        }
        var ctx = hoverCanvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, hoverCanvas.width / dpr, hoverCanvas.height / dpr);
        var wrap = (lon) => ((lon + 540) % 360) - 180;
        // Black on a white halo, like the hovered cell on the map
        var stroke = (trace, width = 1.5) => {
            [['#ffffff', width + 2], ['#000000', width]].forEach(([colour, w]) => {
                ctx.beginPath();
                trace();
                ctx.strokeStyle = colour;
                ctx.lineWidth = w;
                ctx.stroke();
            });
        };
        var outline = (h3, width) => {
            var ring = cellRing(h3).map(([lon, lat]) => projection([Math.max(-180, Math.min(180, lon)), lat]));
            stroke(() => {
                ring.forEach((xy, i) => (i ? ctx.lineTo(...xy) : ctx.moveTo(...xy)));
                ctx.closePath();
            }, width);
        };

        var picked = selected && projection([wrap(selected.at[0]), selected.at[1]]);
        if (picked) {
            var [lon, lat] = [wrap(selected.at[0]), selected.at[1]];
            var path = d3.geoPath(projection, ctx);
            var parallel = { type: 'LineString', coordinates: Array.from({ length: 73 }, (_, i) => [-180 + i * 5, lat]) };
            var meridian = { type: 'LineString', coordinates: [[lon, -90], [lon, 0], [lon, 90]] };
            ctx.save();
            ctx.setLineDash([3, 3]);
            ctx.globalAlpha = 0.55;
            ctx.strokeStyle = '#212529';
            ctx.lineWidth = 1;
            for (var line of [parallel, meridian]) {
                ctx.beginPath();
                path(line);
                ctx.stroke();
            }
            ctx.restore();
            // A selected satellite's whole coverage outlined, as on the map, where the lines
            // cross is enough to mark the cell: no dot. Otherwise a cell's own outline and the dot
            if (selected.border) {
                stroke(() => selected.border.forEach((segment) => segment.forEach(([x, y], i) => {
                    var xy = projection([Math.max(-180, Math.min(180, x)), y]);
                    i ? ctx.lineTo(...xy) : ctx.moveTo(...xy);
                })));
                return drawHover();
            }
            if (selected.h3) outline(selected.h3, 2);
            stroke(() => ctx.arc(picked[0], picked[1], 8, 0, 2 * Math.PI), 2);
            ctx.beginPath();
            ctx.arc(picked[0], picked[1], 4, 0, 2 * Math.PI);
            ctx.fillStyle = selected.colour || '#212529';
            ctx.fill();
            ctx.lineWidth = 1;
            ctx.strokeStyle = '#ffffff';
            ctx.stroke();
        }
        drawHover();

        // What the map's pointer is over: its cell outlined, in a plain ring
        function drawHover() {
            if (!hovered) return;
            var at = projection([wrap(hovered.lng), hovered.lat]);
            if (!at) return;
            var cell = hoveredCell();
            var h3 = cell && cell.split('|').pop();
            if (h3) outline(h3);
            stroke(() => ctx.arc(at[0], at[1], 6, 0, 2 * Math.PI));
        }
    }

    return {
        section,
        draw,
        hover(lngLat) {
            if (!lngLat && !hovered) return;
            hovered = lngLat;
            drawMarks();
        },
        select(sel) {
            selected = sel;
            drawMarks();
        },
    };
}
