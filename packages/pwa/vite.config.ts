/**
 * The PWA's production bundle and dev server.
 *
 * Ported from kteam `ui/vite.config.ts`, with its release machinery deliberately
 * left behind — see the four departures below. `outDir`, `assetsDir` and
 * `publicDir` are not free choices even though the Cloudflare Pages deployment
 * is not in this repo yet (a separate unit owns it): the PENDING contract is a
 * `wrangler.jsonc` naming `./packages/pwa/dist` as the published directory and
 * a `packages/pwa/public/_headers` giving `/assets/*` an immutable year.
 * Neither file exists here today — changing `outDir` or `assetsDir` now would
 * still break that deploy the moment it lands, so these are fixed against the
 * contract this package will have to honour, not against files present today.
 *
 * 1. NO RELEASE FINGERPRINT. kteam's config was a child of
 *    `scripts/build-pwa.ts`, which minted one release id and threaded it through
 *    a `define`, an index.html placeholder and the generated manifests. None of that
 *    orchestration is ported yet (service worker, precache closure, 14 themed
 *    manifests, icons), so a release id here would name a generation nothing
 *    else in the bundle belongs to. `vite build` is the whole build until the
 *    worker/manifest slice lands.
 * 2. NO DEV PROXY. kteam's dev server forwarded `/v1` and `/stt-models` to one
 *    hardcoded loopback daemon, because its UI read its daemon from the page
 *    origin. Ferretry's PWA has no default daemon at all: pairing supplies each
 *    connection at runtime and transport URLs come from that connection
 *    (`src/lib/daemon-connection.ts`, `README.md`). A proxy would reintroduce
 *    exactly the single-origin coupling the pairing seam removed.
 * 3. NO `@vitejs/plugin-react`. The only thing it adds over the built-in
 *    TS/JSX transform is Fast Refresh in dev; `tsconfig.json` already sets
 *    `jsx: react-jsx`, which the transform honours for both dev and build. A dev
 *    edit therefore reloads the page instead of preserving component state —
 *    the cost of one fewer toolchain in the tree, and reversible in one line.
 * 4. POSTCSS IS CONFIGURED HERE, not in a sibling `postcss.config.js`. The
 *    Tailwind config is a TypeScript module in this package, so importing it
 *    means the plugin and `tailwind.config.ts` cannot drift and the whole
 *    pipeline stays inside the typechecked surface.
 */

import autoprefixer from 'autoprefixer';
import { fileURLToPath } from 'node:url';
import tailwindcss from 'tailwindcss';
import { defineConfig } from 'vite';
import tailwindConfig from './tailwind.config.ts';

export default defineConfig({
  // The static landing document owns `/`; the PWA is a separate entry below
  // `/app/`, so its chunks remain rooted there even on a daemon-qualified route.
  base: '/app/',
  build: {
    outDir: 'dist',
    // Named, not defaulted: the pending `public/_headers` (not yet in this repo)
    // is meant to give `/assets/*` an immutable year, so the directory this
    // writes into is the cache-policy boundary that contract will name.
    assetsDir: 'assets',
    // The bundle is a deployment artifact, not an accumulation of them: a stale
    // chunk left behind by an earlier build would be served as immutable.
    emptyOutDir: true,
    // The floor is set by what the app already requires of a browser, not by
    // taste: private class fields (`#storage` in `lib/theme-preferences.ts`) and
    // logical assignment (`#snapshot ??=` in the same file) are both ES2022, and
    // the same target is what kteam shipped this UI on.
    target: 'es2022',
    // Nothing consumes them: the Pages deployment publishes exactly what is in
    // `dist/`, so shipping maps would publish the readable source of a bundle
    // whose only purpose is to be minified, and shipping them without
    // publishing them makes the build slower for nobody's benefit.
    sourcemap: false,
    rollupOptions: {
      input: {
        landing: fileURLToPath(new URL('./index.html', import.meta.url)),
        app: fileURLToPath(new URL('./app/index.html', import.meta.url)),
      },
    },
  },
  css: {
    postcss: {
      plugins: [tailwindcss(tailwindConfig), autoprefixer()],
    },
  },
  server: {
    // kteam's dev port, kept so the URL a developer already has in a bookmark
    // still opens this app.
    port: 5173,
    // Fail instead of silently sliding to 5174. A dev server on an unexpected
    // port is a pairing problem, not an inconvenience: a daemon's paired origin
    // includes the port, so the "wrong" server looks like an unpaired one.
    strictPort: true,
  },
});
