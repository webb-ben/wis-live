// The live feed: races the public WIS2 Global Brokers and keeps the first that
// connects and subscribes. A page passes what to do with each message and with
// the broker's state.
import mqtt from 'mqtt';

// Public WIS2 Global Brokers reachable from a browser (WSS only)
const hosts = [
    'wss://globalbroker.meteo.fr:443/mqtt',
    'wss://globalbroker.inmet.gov.br:443/mqtt',
    'wss://wis2broker.globaldata.nws.noaa.gov:443/mqtt',
];
const topics = ['origin/a/wis2/#', 'cache/a/wis2/#'];

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
let handlers = { onMessage() {}, onState() {} };

// Which Global Broker the page is on: connecting (racing them all), connected,
// reconnecting (to the same one), or retrying (none could be reached)
export let brokerState = { state: 'connecting', host: null };

function setBrokerState(state, host) {
    brokerState = { state, host: host === undefined ? brokerState.host : host };
    handlers.onState(brokerState);
}

// Race all brokers and keep the first one that connects and subscribes.
// onMessage(topic, message) gets every message; onState(brokerState) every change
export function connectFastest({ onMessage, onState } = handlers) {
    handlers = { onMessage: onMessage || handlers.onMessage, onState: onState || handlers.onState };
    console.log('Connecting mqtt client');
    setBrokerState('connecting', null);
    let failures = 0;

    hosts.forEach((host) => {
        const candidate = mqtt.connect(host, { ...options, reconnectPeriod: 0 });
        candidate.setMaxListeners(10);
        let failed = false;

        const fail = () => {
            if (failed || candidate === client) return;
            failed = true;
            candidate.end(true);
            if (!client && ++failures === hosts.length) {
                console.log('All brokers failed, retrying...');
                setBrokerState('retrying', null);
                setTimeout(() => connectFastest(), 5000);
            }
        };

        candidate.once('connect', () => {
            candidate.subscribe(topics, (err, granted) => {
                if (err || granted.some((g) => g.qos >= 128)) {
                    console.log(`Subscribe failed on ${host}`);
                    return fail();
                }
                if (client) return candidate.end(true); // Another broker won

                client = candidate;
                client.options.reconnectPeriod = options.reconnectPeriod;
                client.on('message', (topic, message) => handlers.onMessage(topic, message));
                client.on('reconnect', () => {
                    console.log('Reconnecting...');
                    setBrokerState('reconnecting');
                });
                client.on('connect', () => setBrokerState('connected'));  // After a reconnect
                console.log(`Connected to ${host}!`);
                setBrokerState('connected', new URL(host).host);
            });
        });

        candidate.on('error', (err) => {
            console.log(`Connection error (${host}): `, err.message);
            if (candidate === client) {
                candidate.end(true);
                client = null;
                connectFastest();
            } else {
                fail();
            }
        });

        candidate.on('close', fail);
    });
}
