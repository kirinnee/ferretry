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
import { HOSTED_RELAY_DIRECTORY_ORIGIN } from '@ferretry/relay';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from 'tailwindcss';
import { defineConfig } from 'vite';
import tailwindConfig from './tailwind.config.ts';

/**
 * `@sherpaw/asr`'s own files the sherpa worker needs and its exports map does not name: the Emscripten
 * loader, which takes the WebAssembly binary as bytes, and the binary itself, emitted under `/assets/`
 * and fetched only by an Install (`lib/stt/sherpa-models.ts`). Both are files of the exact version
 * `package.json` pins; a version bump that renames the loader fails this build.
 */
const SHERPA_DIST = dirname(createRequire(import.meta.url).resolve('@sherpaw/asr'));
const SHERPA_ALIASES = [
  { find: /^sherpa-glue$/u, replacement: join(SHERPA_DIST, 'asr-B3QtWJoU.js') },
  { find: /^sherpa-runtime-wasm/u, replacement: join(SHERPA_DIST, 'prebuilt', 'asr.wasm') },
];

/**
 * The default relay’s discovery ORIGIN, baked in at build time.
 *
 * The relay is a separate Worker on its own hostname and Pages stays static — no
 * Functions, no proxy — so a relative path could never reach it. One shared,
 * non-user-identifying origin is therefore a build constant. It is imported from
 * `@ferretry/relay`, the same source the daemon imports, so Nix, GoReleaser, Pages,
 * local Bun builds and forks cannot disagree about which directory to ask.
 *
 * The directory remains distinct from the carrier. Its no-store advertisement can
 * withdraw the carrier without rebuilding either end.
 *
 * `FY_RELAY_DIRECTORY_ORIGIN` OVERRIDES IT, and until now it did not. Two callers
 * already passed the variable and got nothing for it — `tests/e2e/support/relay-harness.ts`,
 * whose comment claimed the bundle carried NO directory while it in fact carried the
 * production one and dialled it on load, and `harness/app-screenshot.ts`, which needs
 * an origin its interceptor can answer. The daemon has honoured the same variable all
 * along (`packages/daemon/src/adapters/system/runtime-environment.ts`: "the environment
 * wins over the build"), so the two ends disagreed about whether the escape hatch
 * existed. An empty or blank value is NOT an override — it is how a caller says "use
 * the default" — and `scripts/validate/relay-config.sh` still holds this file to
 * importing the shared default, which is the fact it pins.
 */
const overriddenDirectory = process.env.FY_RELAY_DIRECTORY_ORIGIN?.trim() ?? '';

/**
 * THE APP'S OWN RELEASE VERSION, stamped from the repository's `VERSION` — the release semantic-release
 * last cut, and the number the signed release list carries (`scripts/build-release.ts`). Settings ›
 * Machine › About shows it beside the machine's, and the "Ferretry updated" line compares it with the
 * last one this browser saw (`src/lib/app-version.ts`).
 * The file is part of every checkout, so a build without one fails rather than ships an unknown version.
 */
const appVersion = readFileSync(fileURLToPath(new URL('../../VERSION', import.meta.url)), 'utf8').trim();

/**
 * LEAFLET'S ONE LOAD-TIME MARKUP WRITE, removed from the bundle.
 *
 * At module evaluation Leaflet feature-tests inline SVG with `div.innerHTML = '<svg/>'`. The page's
 * policy is `require-trusted-types-for 'script'` with no `default` policy, so that assignment THROWS in
 * Chromium and the whole `type: map` chunk would fail to evaluate. Every browser this app supports has
 * inline SVG, so the test is replaced by its answer rather than a new Trusted Types policy being named in
 * the CSP for a string that is a constant. The transform FAILS THE BUILD if it no longer matches, so a
 * Leaflet bump is a conscious re-audit (`tests/unit/build-contract.test.ts` also proves the built chunk
 * has no `innerHTML = '<svg` left and no policy named).
 */
export const LEAFLET_INLINE_SVG_TEST =
  /var inlineSvg = !!svg\$1 && \(function \(\) \{\s*var div = document\.createElement\('div'\);\s*div\.innerHTML = '<svg\/>';\s*return \(div\.firstChild && div\.firstChild\.namespaceURI\) === 'http:\/\/www\.w3\.org\/2000\/svg';\s*\}\)\(\);/u;

export const leafletTrustedTypes = {
  name: 'fy-leaflet-trusted-types',
  enforce: 'pre' as const,
  transform(code: string, id: string): string | undefined {
    if (!/[\\/]leaflet[\\/]dist[\\/]leaflet-src(?:\.esm)?\.js(?:\?|$)/u.test(id)) return undefined;
    if (!LEAFLET_INLINE_SVG_TEST.test(code)) {
      throw new Error(
        'fy-leaflet-trusted-types: Leaflet no longer has the inline-SVG test this plugin removes; re-audit its markup writes',
      );
    }
    return code.replace(LEAFLET_INLINE_SVG_TEST, () => 'var inlineSvg = !!svg$1;');
  },
};

export default defineConfig({
  plugins: [
    leafletTrustedTypes,
    {
      name: 'fy-release-version',
      transformIndexHtml: {
        order: 'pre',
        handler: html => html.replaceAll('%FY_RELEASE_VERSION%', appVersion),
      },
    },
  ],
  define: {
    __FY_APP_VERSION__: JSON.stringify(appVersion),
    __FY_RELAY_DIRECTORY__: JSON.stringify(
      overriddenDirectory === '' ? HOSTED_RELAY_DIRECTORY_ORIGIN : overriddenDirectory,
    ),
  },
  // The static landing owns `/` and the PWA document is `/app/`, but their
  // public assets are emitted once at the site root. Keep every generated chunk
  // root-absolute: that lets the app load on daemon-qualified deep links without
  // rewriting shared icons or the manifest to a nonexistent `/app/...` copy.
  base: '/',
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
        'get-started': fileURLToPath(new URL('./get-started/index.html', import.meta.url)),
      },
    },
  },
  /**
   * ON-DEVICE DICTATION's worker (`src/worker/parakeet-worker.ts`).
   *
   * A MODULE worker, because its bundle has a lazy chunk (parakeet.js reaches ONNX Runtime through a
   * dynamic import) and Vite's default classic-worker format cannot split one.
   *
   * `onnxruntime-web` resolves to its WASM-ONLY build. parakeet.js imports the bare package, whose
   * default entry is the WebGPU/JSEP build — a second, 25 MB runtime binary this app never runs,
   * because the pinned int8 encoder cannot run on WebGPU. The alias makes the library and the worker
   * share the one 12 MB build the worker configures.
   */
  worker: { format: 'es' },
  resolve: {
    alias: [{ find: /^onnxruntime-web$/u, replacement: 'onnxruntime-web/wasm' }, ...SHERPA_ALIASES],
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
