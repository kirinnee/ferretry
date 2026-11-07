/**
 * The app's production bundle and dev server. Copied from today's PWA `vite.config.ts`, narrowed to the shell: the
 * speech workers, Leaflet's and the markdown decoder's Trusted Types transforms and the fy-render libraries belong to
 * the plugins that use them (Voice, Conversation) and come with their app halves.
 *
 * `outDir`, `assetsDir` and `base` are the Pages deployment's contract: `public/_headers` gives `/assets/*` an
 * immutable year, the landing page owns `/` and the app document is `/app/`, and every chunk stays root-absolute so
 * the app loads on daemon-qualified deep links (`/d/<daemon>/...`).
 *
 * NO DEV PROXY: the app has no default daemon. Pairing supplies each daemon at run time and every byte to it rides a
 * sealed session (§9.6); a proxy would reintroduce the single-origin coupling pairing removed.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/** The release version this app is built from (`release.json`, §10.6), stamped into the HTML. */
const release = JSON.parse(readFileSync(fileURLToPath(new URL('../../release.json', import.meta.url)), 'utf8')) as {
  readonly version: string;
};

export default defineConfig({
  plugins: [
    {
      name: 'fy-release-version',
      transformIndexHtml: {
        order: 'pre',
        handler: html => html.replaceAll('%FY_RELEASE_VERSION%', release.version),
      },
    },
  ],
  base: '/',
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    // A stale chunk left behind by an earlier build would be served as immutable.
    emptyOutDir: true,
    // Private class fields and logical assignment are ES2022; the floor the app already requires.
    target: 'es2022',
    // The deployment publishes exactly `dist/`; maps would publish readable source for nobody's benefit.
    sourcemap: false,
    rollupOptions: {
      input: {
        landing: fileURLToPath(new URL('./index.html', import.meta.url)),
        app: fileURLToPath(new URL('./app/index.html', import.meta.url)),
      },
    },
  },
  server: {
    port: 5173,
    // A daemon's paired origin includes the port, so a server that slid to 5174 looks like an unpaired one.
    strictPort: true,
  },
});
