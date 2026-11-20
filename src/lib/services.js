// Which global service the page uses, of each kind (broker, catalogue, cache, replay):
// the fastest by default, or one the viewer picked from the status lines under the
// world map (see legend.js). A pick is kept in this browser (localStorage,
// wis-service-<kind>). Each module that talks to a kind of service registers it
// here: options() lists its choices, and use(value) switches to one ('' for fastest)
const services = new Map();  // kind -> { options, use }
const picks = new Map();  // kind -> value, as read from storage or picked since

export function servicePick(kind) {
    if (!picks.has(kind)) {
        try {
            picks.set(kind, localStorage.getItem(`wis-service-${kind}`) || '');
        } catch (err) {
            picks.set(kind, '');
        }
    }
    return picks.get(kind);
}

export function registerService(kind, { options, use }) {
    services.set(kind, { options, use });
}

// The choices for a kind, [{ value, label, ms }], or [] when it isn't registered
export function serviceOptions(kind) {
    var service = services.get(kind);
    return service ? service.options() : [];
}

export function pickService(kind, value) {
    picks.set(kind, value);
    try {
        if (value) localStorage.setItem(`wis-service-${kind}`, value);
        else localStorage.removeItem(`wis-service-${kind}`);
    } catch (err) {
        // Storage blocked: the pick holds until the page is closed
    }
    var service = services.get(kind);
    if (service) service.use(value);
}
