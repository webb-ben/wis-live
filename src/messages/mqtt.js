// The live feed: races the public WIS2 Global Brokers and keeps the first that
// connects and subscribes. A page passes what to do with each message and with
// the broker's state.
import mqtt from 'mqtt';
import { registerService, servicePick } from '../lib/services.js';

// Public WIS2 Global Brokers reachable from a browser (WSS only)
const hosts = [
    'wss://globalbroker.meteo.fr:443/mqtt',
    'wss://globalbroker.inmet.gov.br:443/mqtt',
    'wss://wis2broker.globaldata.nws.noaa.gov:443/mqtt',
];
// What's subscribed to: everything, unless the page asks for less (see connectFastest)
export const ALL_TOPICS = ['origin/a/wis2/#', 'cache/a/wis2/#'];
let topics = ALL_TOPICS;

// The everyone/everyone credentials are public; the password is kept as UTF-16 hex
function hexDecode(hex) {
    return (hex.match(/.{1,4}/g) || []).map((h) => String.fromCharCode(parseInt(h, 16))).join('');
}

const options = {
    username: 'everyone',
    password: hexDecode('00650076006500720079006f006e0065'),
    keepalive: 60,
    protocolVersion: 5,
    reconnectPeriod: 1000,
    connectTimeout: 30 * 1000,
};

let client = null;
let attempt = 0;  // Each connectFastest's; candidates of an older one give up
let handlers = { onMessage() {}, onState() {} };

// Which Global Broker the page is on: connecting (racing them all), connected,
// reconnecting (to the same one), or retrying (none could be reached); ms is how long
// it took to connect and subscribe
export let brokerState = { state: 'connecting', host: null, ms: null };

function setBrokerState(state, host, ms) {
    brokerState = { state, host: host === undefined ? brokerState.host : host, ms: ms === undefined ? brokerState.ms : ms };
    handlers.onState(brokerState);
}

// Every minute, how long the broker in use takes to answer: an UNSUBSCRIBE for a topic
// never subscribed to costs nothing and the broker acknowledges it at once. It isn't
// swapped for a faster one, as the brokers carry the same messages and changing would
// drop some; the time is shown in the map key
const PING_MS = 60e3;
function pingBroker() {
    if (!client || !client.connected || document.hidden) return;
    var pinged = client, start = performance.now();
    pinged.unsubscribe('wis-live/latency', () => {
        if (pinged === client && brokerState.state === 'connected') setBrokerState('connected', undefined, performance.now() - start);
    });
}
setInterval(pingBroker, PING_MS);

// Race all brokers and keep the first one that connects and subscribes.
// onMessage(topic, message) gets every message; onState(brokerState) every change;
// subscribe, if given, the topic filters to subscribe to (kept for retries)
export function connectFastest({ onMessage, onState, subscribe } = handlers) {
    handlers = { onMessage: onMessage || handlers.onMessage, onState: onState || handlers.onState };
    if (subscribe) topics = subscribe;
    console.log('Connecting mqtt client');
    setBrokerState('connecting', null, null);
    let failures = 0;
    const mine = ++attempt;
    // The one picked under the world map, or all of them (see services.js)
    const picked = hosts.find((h) => new URL(h).host === servicePick('broker'));
    const racing = picked ? [picked] : hosts;

    racing.forEach((host) => {
        const start = performance.now();
        const candidate = mqtt.connect(host, { ...options, reconnectPeriod: 0 });
        candidate.setMaxListeners(10);
        let failed = false;

        const fail = () => {
            if (failed || candidate === client) return;
            failed = true;
            candidate.end(true);
            if (mine === attempt && !client && ++failures === racing.length) {
                console.log('All brokers failed, retrying...');
                setBrokerState('retrying', null, null);
                setTimeout(() => mine === attempt && connectFastest(), 5000);
            }
        };

        candidate.once('connect', () => {
            candidate.subscribe(topics, (err, granted) => {
                if (err || granted.some((g) => g.qos >= 128)) {
                    console.log(`Subscribe failed on ${host}`);
                    return fail();
                }
                if (client || mine !== attempt) return candidate.end(true); // Another broker won, or another was picked

                client = candidate;
                client.options.reconnectPeriod = options.reconnectPeriod;
                client.on('message', (topic, message) => handlers.onMessage(topic, message));
                client.on('reconnect', () => {
                    console.log('Reconnecting...');
                    setBrokerState('reconnecting');
                });
                client.on('connect', () => setBrokerState('connected'));  // After a reconnect
                console.log(`Connected to ${host}!`);
                setBrokerState('connected', new URL(host).host, performance.now() - start);
                pingBroker();  // A round trip, like the later ones, rather than the time to connect
            });
        });

        candidate.on('error', (err) => {
            console.log(`Connection error (${host}): `, err.message);
            if (candidate === client) {
                candidate.end(true);
                client = null;
                if (mine === attempt) connectFastest();
            } else {
                fail();
            }
        });

        candidate.on('close', fail);
    });
}

// Switches broker: '' races them all again, a host connects to that one only. The
// messages between are missed (the brokers carry the same ones)
registerService('broker', {
    options: () => hosts.map((h) => {
        var host = new URL(h).host;
        return { value: host, label: host, ms: host === brokerState.host ? brokerState.ms : null };
    }),
    use() {
        var old = client;
        client = null;
        attempt++;  // The old one's candidates, and its close, give up
        if (old) old.end(true);
        connectFastest();
    },
});
