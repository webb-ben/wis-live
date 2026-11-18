// World overview in the Equal Earth projection, which keeps areas true to size
// (MapLibre has no Equal Earth). A small map always shown in the bottom-right
// panel. D3 draws the sea, land and the main map's view as a frame; the page
// draws what's on the map (points, satellite coverage) through drawContent. A
// click goes to that place on the map. The D3 pieces it uses, topojson-client and
// the coastlines are a separate bundle, loaded as it starts.
import { cellRing } from '../geo.js';

const OVERVIEW_REFRESH_MS = 2000;

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
        map.on('moveend', () => {
            clearInterval(timer);
            draw();
            timer = setInterval(draw, OVERVIEW_REFRESH_MS);
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
        ctx.beginPath();
        var b = map.getBounds();
        if (b.getEast() - b.getWest() < 300) {
            path({ type: 'Polygon', coordinates: [[[b.getWest(), b.getSouth()], [b.getWest(), b.getNorth()], [b.getEast(), b.getNorth()],
                [b.getEast(), b.getSouth()], [b.getWest(), b.getSouth()]]] });
            ctx.strokeStyle = '#212529';
            ctx.lineWidth = 1.5;
            ctx.stroke();
        }
        drawMarks();
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
