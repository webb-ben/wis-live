// Google Analytics (GA4): the tag is in each page's <head>. Its cookie lasts only until the
// browser closes, so a visit is counted and its events go together, but nobody is followed
// from one visit to the next; Google signals and ad storage are off. (Analytics storage
// denied would set no cookie at all, but GA's reports then leave the visits out.)
//
// What's sent: page events (track) carrying the app's own values (layer names, centre ids,
// models, the filters in the URL), never a message's contents or anything about the visitor.
// Every click on a control is sent too (ui_click: its label and the panel it's in), and
// every pick from a dropdown (ui_change), but nothing typed into a text box
import { PAGE } from '../page.js';

const EVENTS_MAX = 2000;  // Per page load, so a tab left open all week can't flood GA
let sent = 0;

function gtag() {
    if (typeof window.gtag === 'function') window.gtag(...arguments);
}

// An event, with the page it's from. Strings are cut to GA's 100 characters
export function track(name, params = {}) {
    if (sent++ >= EVENTS_MAX) return;
    var clean = { page_kind: PAGE };
    for (var [k, v] of Object.entries(params)) {
        if (v == null || v === '') continue;
        clean[k] = typeof v === 'string' ? v.slice(0, 100) : v;
    }
    gtag('event', name, clean);
}

// The same event at most once per `ms` for each key (a slider dragged, the map moved)
const lastSent = new Map();
export function trackOnce(key, ms, name, params) {
    var now = Date.now();
    if (now - (lastSent.get(key) || 0) < ms) return;
    lastSent.set(key, now);
    track(name, params);
}

// The centre of a WIS2 topic: …/a/wis2/<centre>/…
export function centreOf(topic) {
    return ((topic || '').split('/a/wis2/')[1] || '').split('/', 1)[0] || null;
}

// ---------- What's tracked without being called

// A control's name: what it says it does, else its text, else its class
function describe(el) {
    var label = el.dataset.track || el.getAttribute('aria-label') || el.title
        || (el.tagName === 'INPUT' && el.closest('label') ? el.closest('label').textContent : el.textContent) || '';
    label = label.replace(/\s+/g, ' ').trim();
    return label.slice(0, 60) || (typeof el.className === 'string' ? el.className.split(' ')[0] : el.tagName.toLowerCase());
}

const AREAS = [['.welcome', 'welcome'], ['.infobar', 'popup'], ['.maplibregl-popup', 'popup'],
    ['.forecast-field', 'forecast_legend'], ['.map-style', 'legend'], ['.map-world', 'world_map'], ['.queue', 'sidebar'],
    ['.maplibregl-ctrl', 'map_controls']];
function areaOf(el) {
    var hit = AREAS.find(([selector]) => el.closest(selector));
    return hit ? hit[1] : 'page';
}

const CLICKABLE = 'button, a, summary, [role="button"], [data-key-toggle], .queue-chip, .filter-banner-chip, .queue-row, input[type="checkbox"], input[type="radio"]';

function trackControls() {
    document.addEventListener('click', (e) => {
        var el = e.target.closest && e.target.closest(CLICKABLE);
        if (!el) return;
        var params = { control: describe(el), area: areaOf(el) };
        if (el.type === 'checkbox' || el.type === 'radio') params.checked = el.checked;
        // Rows of the message list: which kind, not which message
        if (el.classList.contains('queue-row')) params.control = 'message row';
        track('ui_click', params);
    }, true);
    document.addEventListener('change', (e) => {
        var el = e.target;
        if (el.tagName !== 'SELECT' && el.type !== 'range') return;
        trackOnce(`change:${describe(el)}`, 2000, 'ui_change', { control: describe(el), value: String(el.value), area: areaOf(el) });
    }, true);
}

// Script errors, for what breaks for real visitors (at most 20 a page load)
let errors = 0;
function trackErrors() {
    var report = (message) => {
        if (errors++ < 20) track('exception', { description: String(message || 'unknown'), fatal: false });
    };
    window.addEventListener('error', (e) => report(e.message));
    window.addEventListener('unhandledrejection', (e) => report(e.reason && (e.reason.message || e.reason)));
}

// How long the page is looked at and how many messages arrived, sent as the tab is hidden
// or closed (GA sends these with sendBeacon)
let messages = 0;
let visibleSince = document.hidden ? null : Date.now();
let visibleMs = 0;
export function countMessage() {
    messages++;
}
function trackSession() {
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
            visibleSince = Date.now();
            return;
        }
        if (visibleSince) visibleMs += Date.now() - visibleSince;
        visibleSince = null;
        track('session_summary', { minutes_visible: Math.round(visibleMs / 6e3) / 10, messages });
    });
}

export function initAnalytics() {
    trackControls();
    trackErrors();
    trackSession();
}
