// wis2box names itself and its version in generated_by ("wis2box 1.3.0"), and
// serves data under <base>/data/<date>/wis/..., so the base of an origin link is
// the wis2box itself. Cache copies find it through the origin's link for the same data.
import { wis2boxVersion } from './messages.js';
import { linksSeen } from '../data/download.js';
export const WIS2BOX_DATA = /^(https?:\/\/[^?#]+?)\/data\/\d{4}-\d{2}-\d{2}\/wis\//;

// Known wis2box deployments by centre (from the wis2box deployments list, a
// snapshot since that list can't be fetched from a browser), for centres whose
// messages don't link back to their wis2box
export const WIS2BOX_DEPLOYMENTS = 'assets/data/wis2box-deployments.json';
export const wis2boxByCentre = new Map();  // centre-id -> wis2box URL
fetch(WIS2BOX_DEPLOYMENTS).then((r) => (r.ok ? r.json() : null))
    .then((list) => (list && list.deployments || []).forEach((d) => wis2boxByCentre.set(d.centre, d.url)))
    .catch(() => {});

export function wis2boxOf(record) {
    var version = wis2boxVersion(record.notification);
    var hrefs = [...record.links.map((l) => l.href), ...linksSeen(record.props.data_id)];
    var base = hrefs.map((h) => (String(h).match(WIS2BOX_DATA) || [])[1]).find(Boolean) || wis2boxByCentre.get(record.centre);
    if (!version && !base) return null;
    return { version, url: base || null };
}
