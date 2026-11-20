// The welcome shown on a first visit (issue #9): what the site is, and its views.
// Shown once per browser (localStorage, wis-welcomed); About on the map reopens it
import { PAGES, PAGE } from '../../page.js';

const SEEN_KEY = 'wis-welcomed';

let dialog = null;

function build() {
    dialog = document.createElement('dialog');
    dialog.className = 'welcome';
    dialog.setAttribute('aria-labelledby', 'welcome-title');
    dialog.innerHTML = `
        <h1 id="welcome-title" class="welcome-title">WIS 2.0 Live</h1>
        <p class="welcome-lead">Weather observations from around the world, drawn on the map as
        they are published through the WMO Information System (WIS2).</p>
        <p class="welcome-text">National weather services publish each observation to WIS2, and
        the Global Brokers announce it within seconds. This site listens to those announcements,
        downloads and decodes the data in your browser, and plots it. Click anything on the map
        for its details.</p>
        <h2 class="welcome-heading">Views</h2>
        <ul class="welcome-pages">${PAGES.map((p) => `
            <li><a href="${p.href}"${p.key === PAGE ? ' aria-current="page"' : ''}>
                <span class="welcome-page-label">${p.label}${p.key === PAGE ? ' <span class="welcome-here">You are here</span>' : ''}</span>
                <span class="welcome-page-about">${p.about}</span>
            </a></li>`).join('')}
        </ul>
        <p class="welcome-note">Not affiliated with WMO.</p>
        <form method="dialog" class="welcome-actions">
            <button class="btn btn-primary" value="close" autofocus>Explore the map</button>
        </form>`;
    // A click on the backdrop (outside the dialog's box) closes it too
    dialog.addEventListener('click', (e) => {
        if (e.target === dialog) dialog.close();
    });
    // The current page's link only closes the welcome, rather than reloading the page
    dialog.querySelector('[aria-current="page"]').addEventListener('click', (e) => {
        e.preventDefault();
        dialog.close();
    });
    document.body.appendChild(dialog);
}

export function showWelcome() {
    if (!dialog) build();
    if (!dialog.open) dialog.showModal();
    try {
        localStorage.setItem(SEEN_KEY, '1');
    } catch (err) {
        // Storage blocked: it shows again next visit
    }
}

// On a first visit only (any page counts)
export function welcomeFirstVisit() {
    var seen = false;
    try {
        seen = localStorage.getItem(SEEN_KEY) === '1';
    } catch (err) {
        seen = false;
    }
    if (!seen) showWelcome();
}
