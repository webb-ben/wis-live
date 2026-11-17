import { defineConfig } from 'vite';

// Served from GitHub Pages at https://benwebb.com/wis-live/. Each page is an HTML
// file at the root; add more (e.g. satellites.html) to build.rollupOptions.input
export default defineConfig({
    base: '/wis-live/',
    build: {
        rollupOptions: {
            input: {
                main: 'index.html',
            },
        },
    },
});
