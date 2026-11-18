// The MapLibre map: a light grey basemap on a globe (or flat, ProjectionControl),
// starting near the visitor. Every module that draws on the map imports it from here
import maplibregl from 'maplibre-gl';

let projection = 'globe';
try {
    projection = localStorage.getItem('wis-projection') === 'mercator' ? 'mercator' : 'globe';
} catch (err) {
    // Storage unavailable; use the default
}

// Start near the visitor without asking for their location: the time zone's
// UTC offset gives a longitude and its region a rough latitude. Nothing is sent
// anywhere. If they have already let this site see their location, use it.
export function guessCentre() {
    // The standard (winter) offset, so daylight saving doesn't shift the guess an hour east
    var year = new Date().getFullYear();
    var offset = Math.max(new Date(year, 0, 1).getTimezoneOffset(), new Date(year, 6, 1).getTimezoneOffset());
    var lon = Math.max(-170, Math.min(170, -offset / 60 * 15));
    var zone = '';
    try {
        zone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    } catch (err) {
        // No time zone support; the offset alone will do
    }
    var region = zone.split('/')[0];
    var lat = {
        America: zone.includes('Argentina') || /Sao_Paulo|Santiago|Lima|Bogota|Montevideo|La_Paz|Asuncion|Caracas/.test(zone) ? -15 : 38,
        Europe: 50, Africa: 5, Asia: 30, Australia: -27, Pacific: -15, Atlantic: 30, Indian: -10, Antarctica: -75,
    }[region];
    return [lon, lat === undefined ? 30 : lat];
}

export function centreOnVisitor() {
    if (!navigator.permissions || !navigator.geolocation) return;
    navigator.permissions.query({ name: 'geolocation' }).then((status) => {
        if (status.state !== 'granted') return;
        navigator.geolocation.getCurrentPosition(
            (pos) => map.easeTo({ center: [pos.coords.longitude, pos.coords.latitude], duration: 1500 }),
            () => {},  // Keep the guess
            { maximumAge: 60 * 60 * 1000, timeout: 10000 });
    }).catch(() => {});
}

export const map = new maplibregl.Map({
    container: 'map',
    style: {
        version: 8,
        sources: {
            basemap: {
                type: 'raster',
                tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}'],
                tileSize: 256,
                maxzoom: 16,
                attribution: 'Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ',
            },
        },
        // The background is the globe's surface while tiles load; with the basemap off both go,
        // leaving the globe see-through
        layers: [
            { id: 'background', type: 'background', paint: { 'background-color': '#e4e9ee' } },
            { id: 'basemap', type: 'raster', source: 'basemap' },
        ],
        projection: { type: projection },
        // Atmosphere halo around the globe, fading out as you zoom in, and a
        // pale sky above the horizon when the map is tilted
        sky: {
            'sky-color': '#cfe2f3',
            'horizon-color': '#eef4fa',
            'sky-horizon-blend': 0.6,
            'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 7, 0],
        },
    },
    center: guessCentre(),
    zoom: 2,
    minZoom: 0,
    maxZoom: 15,
    // Added below as its own control, so it can be kept closed
    attributionControl: false,
});

export class ProjectionControl {
    onAdd(map) {
        var container = document.createElement('div');
        container.className = 'maplibregl-ctrl maplibregl-ctrl-group';
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'projection-toggle';
        var label = () => {
            var globe = projection === 'globe';
            button.textContent = globe ? 'Flat' : 'Globe';
            button.title = globe ? 'Switch to a flat (Mercator) map' : 'Switch to a globe';
        };
        label();
        button.addEventListener('click', () => {
            projection = projection === 'globe' ? 'mercator' : 'globe';
            map.setProjection({ type: projection });
            label();
            try {
                localStorage.setItem('wis-projection', projection);
            } catch (err) {
                // Storage unavailable; the choice just isn't remembered
            }
        });
        container.appendChild(button);
        return container;
    }

    onRemove() {
        // Nothing to do here
    }
}
