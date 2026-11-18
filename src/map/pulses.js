// A ring that grows and fades around each point as it arrives (not for viewers who
// prefer reduced motion), on the map's 'pulses' layer
import { map } from './map.js';

export const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const PULSE_MS = 1600;           // Length of the ripple on new arrivals
let pulses = [];            // Recent arrivals, drawn as expanding rings
let animating = false;

// A point that has just arrived
export function addPulse(feature) {
    if (!reduceMotion) pulses.push(feature);
}

// Drops rings that have finished, draws the rest, and animates them while there are any
export function tickPulses(now) {
    pulses = pulses.filter((f) => now - f.properties.born < PULSE_MS);
    map.getSource('pulses').setData({ type: 'FeatureCollection', features: pulses });
    if (pulses.length && !animating) {
        animating = true;
        requestAnimationFrame(animatePulses);
    }
}

// Rings grow and fade out; driven by the current time since paint
// expressions can't read the clock themselves
function animatePulses() {
    var age = ['-', Date.now(), ['get', 'born']];
    map.setPaintProperty('pulses', 'circle-radius', ['interpolate', ['linear'], age, 0, 3, PULSE_MS, 22]);
    map.setPaintProperty('pulses', 'circle-stroke-opacity', ['interpolate', ['linear'], age, 0, 0.9, PULSE_MS, 0]);
    if (pulses.length) {
        requestAnimationFrame(animatePulses);
    } else {
        animating = false;
    }
}
