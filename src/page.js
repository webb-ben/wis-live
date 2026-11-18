// What the page does that modules ask for: opening the info panel, applying the
// layer switches and filters to the map, rebuilding the map key, and so on. main.js
// fills this in as it starts (Object.assign(page, ...)), and a module calls, say,
// page.updateMapKey() rather than importing main.js, which imports the modules.
// Only called once the page is running, never while modules load.
export const page = {};
