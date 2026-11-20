import { defineConfig } from 'vite';

// Served from GitHub Pages at https://benwebb.com/wis-live/. Each page is an HTML
// file at the root, listed in build.rollupOptions.input
export default defineConfig({
    base: '/wis-live/',
    css: {
        preprocessorOptions: {
            // Bootstrap 5.1's Sass predates some current Sass rules; its warnings aren't ours to fix
            scss: { quietDeps: true, silenceDeprecations: ['import'] },
        },
    },
    build: {
        rollupOptions: {
            input: {
                main: 'index.html',
                gbon: 'gbon.html',
                metocean: 'metocean.html',
                gts: 'gts.html',
                satellites: 'satellites.html',
            },
            output: {
                // Each big library in a file of its own: they change only when bumped, so a
                // deploy of the app leaves them cached in visitors' browsers
                manualChunks: {
                    maplibre: ['maplibre-gl'],
                    mqtt: ['mqtt'],
                    h3: ['h3-js'],
                },
            },
        },
        // MapLibre alone is about 1 MB (270 KB compressed); that's expected
        chunkSizeWarningLimit: 1100,
    },
});
