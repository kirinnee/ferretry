/**
 * The app's production bundle and dev server. Copied from today's PWA `vite.config.ts`, narrowed to the shell: the
 * speech workers belong to the plugin that uses them (Voice) and come with its app half. Leaflet's and the markdown
 * decoder's Trusted Types transforms (`scripts/trusted-types-plugins.ts`) and the fy-render sandbox shell and library
 * bundles (`scripts/build-fy-render-libs.ts`, run before every dev server and build) serve Conversation's blocks.
 *
 * `outDir`, `assetsDir` and `base` are the Pages deployment's contract: `public/_headers` gives `/assets/*` an
 * immutable year, the landing page owns `/` and the app document is `/app/`, and every chunk stays root-absolute so
 * the app loads on daemon-qualified deep links (`/d/<daemon>/...`).
 *
 * NO DEV PROXY: the app has no default daemon. Pairing supplies each daemon at run time and every byte to it rides a
 * sealed session (§9.6); a proxy would reintroduce the single-origin coupling pairing removed.
 */
import autoprefixer from 'autoprefixer';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import tailwindcss from 'tailwindcss';
import { defineConfig } from 'vite';
import tailwindConfig from './tailwind.config.ts';
import { textScalePostcss } from './scripts/text-scale-postcss.ts';
import { entityDecoderTrustedTypes, leafletTrustedTypes } from './scripts/trusted-types-plugins.ts';
import { HOSTED_RELAY_DIRECTORY_ORIGIN } from '../plugins/connections/contract/hosted-directory.ts';

/** The release version this app is built from (`release.json`, §10.6), stamped into the HTML. */
const release = JSON.parse(readFileSync(fileURLToPath(new URL('../../release.json', import.meta.url)), 'utf8')) as {
  readonly version: string;
};

/**
 * THE GET-STARTED PAGE (`/get-started/`) is Onboarding's own static document. Vite names an HTML input by its path
 * under this package, so a page outside it cannot be an input that lands at `get-started/index.html`: the build emits
 * it there instead, with the release version stamped in exactly as `fy-release-version` stamps the app's pages.
 */
const getStartedPage = fileURLToPath(new URL('../plugins/onboarding/app/get-started/index.html', import.meta.url));

/**
 * THE RELAY DIRECTORY ORIGIN this bundle discovers the hosted rendezvous from (R580), copied from today's PWA build:
 * Connections' shared `HOSTED_RELAY_DIRECTORY_ORIGIN`, overridden by `FY_RELAY_DIRECTORY_ORIGIN` exactly as the daemon
 * honours it, so both ends of a session read the same advertisement. A blank value is not an override; `off` (CI)
 * is an origin that parses as nothing, so discovery fails closed to direct-only.
 */
const overriddenDirectory = process.env.FY_RELAY_DIRECTORY_ORIGIN?.trim() ?? '';

/**
 * THE HOSTED APP'S ORIGIN this bundle links to, from the one script every build route asks
 * (`scripts/ci/hosted-app-origin.sh`, switched by `FY_HOSTED_APP_ORIGIN`): the production address unless a build
 * names another (the 5.0 preview). The daemon compile sets the same define from the same script, so a pairing link,
 * a catalog and a share link point at one app on both ends. Plugin code reads it through the kernel's
 * `hosted-app` module, the only place the address is spelled.
 */
const hostedAppOrigin = (() => {
  const script = fileURLToPath(new URL('../../scripts/ci/hosted-app-origin.sh', import.meta.url));
  const result = spawnSync(script, [], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`scripts/ci/hosted-app-origin.sh failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
})();

export default defineConfig({
  define: {
    __FY_HOSTED_APP_ORIGIN__: JSON.stringify(hostedAppOrigin),
    __FY_RELAY_DIRECTORY__: JSON.stringify(
      overriddenDirectory === '' ? HOSTED_RELAY_DIRECTORY_ORIGIN : overriddenDirectory,
    ),
  },
  plugins: [
    leafletTrustedTypes,
    entityDecoderTrustedTypes,
    {
      name: 'fy-release-version',
      transformIndexHtml: {
        order: 'pre',
        handler: html => html.replaceAll('%FY_RELEASE_VERSION%', release.version),
      },
    },
    {
      name: 'fy-get-started-page',
      apply: 'build',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'get-started/index.html',
          source: readFileSync(getStartedPage, 'utf8').replaceAll('%FY_RELEASE_VERSION%', release.version),
        });
      },
    },
  ],
  // POSTCSS IS CONFIGURED HERE, not in a sibling `postcss.config.js` (as today): the Tailwind config is a TypeScript
  // module, so the plugin and `tailwind.config.ts` cannot drift. The text scale runs AFTER Tailwind so its utilities
  // are covered by the one rule (`scripts/text-scale-postcss.ts`).
  css: {
    postcss: {
      plugins: [tailwindcss(tailwindConfig), textScalePostcss(), autoprefixer()],
    },
  },
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
