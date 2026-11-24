// Pausing the live feed: while paused, messages from the broker are only queued, not
// parsed, drawn or listed; resuming works through the queue, oldest first, a batch at a
// time so the page doesn't stall, and then live messages go on as before. The Pause button
// is on the broker's status line under the world map (legend.js). Not the Messages tab's
// Pause, which only holds the list still while reading it

const QUEUE_MAX = 20000;  // Messages held while paused; the oldest go beyond this
const BATCH = 200;  // Handled each frame while catching up

let handle = null;  // (topic, message) -> parses and draws one message (main.js)
let onChange = () => {};
let paused = false;
let queue = [];
let dropped = 0;
let draining = false;

// handler: what's done with each message; changed(): the status line has something new
// (told at most twice a second: messages can come hundreds a second)
let changeTimer = null;
export function initFeedPause(handler, changed) {
    handle = handler;
    onChange = () => {
        if (!changeTimer) changeTimer = setTimeout(() => { changeTimer = null; changed(); }, 500);
    };
}

// Each message from the broker: handled now, or queued while paused (or while catching up,
// so the order is kept)
export function receive(topic, message) {
    if (paused || draining) {
        queue.push([topic, message]);
        if (queue.length > QUEUE_MAX) {
            queue.shift();
            dropped++;
        }
        if (paused) onChange();
        return;
    }
    handle(topic, message);
}

export function feedState() {
    return { paused, queued: queue.length, dropped, draining };
}

export function setFeedPaused(on) {
    paused = on;
    if (on) dropped = 0;
    else drain();
    onChange();
}

function drain() {
    if (draining) return;
    draining = true;
    var step = () => {
        if (paused) { draining = false; onChange(); return; }
        for (var i = 0; i < BATCH && queue.length; i++) {
            var [topic, message] = queue.shift();
            try {
                handle(topic, message);
            } catch (err) {
                console.debug(`A queued message from ${topic} failed: ${err.message}`);
            }
        }
        onChange();
        if (queue.length) requestAnimationFrame(step);
        else draining = false;
    };
    requestAnimationFrame(step);
}
