// Wind arrows drift a little the way they point, and back, so they read as moving air.
// icon-offset is in the arrow's own frame (rotated with it, and the arrow points up
// before it's turned), so one offset moves every arrow along its own direction. It's a
// layout property, which MapLibre lays out again on each change: so only a few steps a
// second, only while arrows are drawn and the tab is shown, and none at all for viewers
// who ask for less motion
import { map } from './map.js';
import { windArrows } from './colour.js';
import { reduceMotion } from './pulses.js';

export const ARROW_LAYERS = ['points-arrow', 'swath-arrows'];
export const ARROW_DRIFT = 3;  // Furthest forward, in the arrow image's pixels (a few on screen)
export const ARROW_PERIOD_MS = 1600;  // Forward and back again
export const ARROW_STEPS_PER_SECOND = 8;

let lastStep = 0;
let still = true;  // The arrows are at rest (no offset), as they are when not moving

export function startArrowMotion() {
    if (reduceMotion) return;
    var step = (now) => {
        requestAnimationFrame(step);
        if (now - lastStep < 1000 / ARROW_STEPS_PER_SECOND) return;
        lastStep = now;
        var moving = windArrows() && !document.hidden;
        if (!moving && still) return;
        // Eased out and back: 0 at rest, ARROW_DRIFT at the middle of the period
        var drift = moving ? ARROW_DRIFT * (0.5 - 0.5 * Math.cos((2 * Math.PI * now) / ARROW_PERIOD_MS)) : 0;
        for (var id of ARROW_LAYERS) {
            if (map.getLayer(id)) map.setLayoutProperty(id, 'icon-offset', [0, -drift]);
        }
        still = !moving;
    };
    requestAnimationFrame(step);
}
