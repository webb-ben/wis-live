// A button under the zoom buttons that puts the globe back in the middle of the screen:
// level (no tilt), north up, and centred in the space the panels leave (padding(): the
// map's padding for the panels open now), looking at the same place as before
import { map } from './map.js';

export class RecentreControl {
    constructor(padding) {
        this.padding = padding;
    }

    onAdd() {
        this.container = document.createElement('div');
        this.container.className = 'maplibregl-ctrl maplibregl-ctrl-group';
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'recentre-button';
        button.title = 'Centre the globe';
        button.setAttribute('aria-label', 'Centre the globe');
        // Crosshairs in a circle
        button.innerHTML = '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><circle cx="10" cy="10" r="5.5" fill="none" stroke="currentColor" stroke-width="1.6"/>'
            + '<path d="M10 1.5v4M10 14.5v4M1.5 10h4M14.5 10h4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
        button.addEventListener('click', () => map.easeTo({ padding: this.padding(), bearing: 0, pitch: 0, duration: 500 }));
        this.container.appendChild(button);
        return this.container;
    }

    onRemove() {
        this.container.remove();
    }
}
