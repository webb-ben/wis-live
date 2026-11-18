// Slow networks. Checked every minute: when the broker's round trip or the
// fastest cache's answer is slow, the heaviest downloads are switched off, satellites
// first, then (if it is still slow a minute later) the GTS gateways. They're switched
// off as if by hand, so the Layers tab shows it and they can be switched back on; one
// switched back on isn't switched off again. Nothing is switched back on by itself:
// with the downloads gone the network looks fast again, which would just flip-flop
import { brokerState } from './mqtt.js';
import { state, setState } from '../state.js';
import { hiddenLayers } from '../map/layers.js';
export const SLOW_BROKER_MS = 1500;  // MQTT round trip
export const SLOW_CACHE_MS = 3000;   // Fastest global cache, to answer a request
export const SLOW_CHECK_MS = 60e3;
export const SHED_LAYERS = [{ key: 'satellite', label: 'Satellites' }, { key: 'gts', label: 'GTS gateways' }];
export const shedKept = new Set();  // Switched back on after being shed: left alone

export function slowNetworkReason() {
    if (brokerState.state === 'connected' && brokerState.ms > SLOW_BROKER_MS) return `broker round trip ${Math.round(brokerState.ms)} ms`;
    if (state.cache && state.cache.ms > SLOW_CACHE_MS) return `fastest cache ${Math.round(state.cache.ms)} ms`;
    return null;
}

export function checkNetwork() {
    var shed = state.slowNetwork ? state.slowNetwork.shed : [];
    // One that has been switched back on stays on
    var kept = shed.filter((key) => !hiddenLayers.has(key));
    kept.forEach((key) => shedKept.add(key));
    shed = shed.filter((key) => hiddenLayers.has(key));
    var reason = !document.hidden && slowNetworkReason();
    var next = reason && SHED_LAYERS.find((l) => !hiddenLayers.has(l.key) && !shedKept.has(l.key));
    if (next) {
        var input = document.querySelector(`.legend-toggle[data-layer="${next.key}"] input`);
        if (input) {
            input.checked = false;
            input.dispatchEvent(new Event('change'));
            shed = [...shed, next.key];
            console.log(`Slow network (${reason}): ${next.label} switched off`);
        }
    }
    if (shed.join() !== (state.slowNetwork ? state.slowNetwork.shed.join() : '')) {
        setState({ slowNetwork: shed.length ? { shed, reason: reason || state.slowNetwork.reason } : null });
    }
}
setInterval(checkNetwork, SLOW_CHECK_MS);
