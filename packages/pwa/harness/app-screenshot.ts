/**
 * Build the REAL bundle, serve `dist/` on an ephemeral loopback port, and
 * screenshot the running app at both viewports in both colour schemes — plus the
 * favicon at its true 16px, fetched by the page itself.
 *
 * This is the other half of `harness/screenshot.ts`, not a replacement for it.
 * That one bundles `harness/main.tsx`: a stacked gallery of every ported surface,
 * which is the right shape for comparing a component against the original but is
 * not the app. Some claims can only be made against the shipped artifact:
 *
 *   - An ICON REFERENCE only resolves if `public/` really was copied into `dist/`
 *     and the href really is root-absolute. The component harness serves neither
 *     `index.html` nor `public/`, so it cannot tell you whether the tab has an
 *     icon at all. This pass records every request the page makes and fails if
 *     one 404s.
 *   - THE FAVICON AT 16px cannot be screenshotted out of the browser's tab strip
 *     by any automation, so the honest substitute is to make the page itself load
 *     `/icons/favicon.svg` at exactly 16x16 — same origin, same policy, same
 *     rasteriser — and capture that, beside a nearest-neighbour magnification of
 *     the same 16px box so a human can actually see the pixels.
 *   - COLOUR SCHEME. `pre-paint.js` resolves the theme from `prefers-color-scheme`
 *     before first paint, so light mode is a different first frame rather than a
 *     class toggle. It has to be emulated at the context, not the DOM.
 *
 * Dev-only, never runs in CI, and nothing it writes is committed —
 * `harness/out/` is gitignored. Every request that leaves the loopback origin is
 * aborted, and the server binds an ephemeral port on 127.0.0.1: a developer's
 * machine has real daemons and real agent sessions on it, and a screenshot pass
 * has no business reaching any of them.
 *
 *   bun harness/app-screenshot.ts
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const harnessDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(harnessDir, '..');
const distDir = join(packageDir, 'dist');
const outDir = join(harnessDir, 'out');

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'desktop', width: 1_440, height: 900 },
] as const;

const SCHEMES = ['light', 'dark'] as const;

/** The favicon magnification factor, matching the `-at-12x` proofs in `docs/brand`. */
const MAGNIFY = 12;

function fail(message: string): never {
  process.stderr.write(`❌ ${message}\n`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

process.stdout.write('📦 building the real bundle…\n');
const build = spawnSync('./node_modules/.bin/vite', ['build'], { cwd: packageDir, stdio: 'inherit' });
if (build.error) fail(`vite could not be started: ${build.error.message}`);
if (build.status !== 0) fail(`vite build exited ${build.status}`);

/**
 * `dist/` served the way Cloudflare Pages serves it. `/` is the static landing;
 * `/app/`, daemon routes and pairing routes are the PWA document. Getting that
 * split wrong would make every screenshot below a screenshot of the wrong page.
 */
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    const appPath =
      path === '/app' || path === '/app/' ? '/app/index.html' : path.startsWith('/app/') ? path.slice(4) : path;
    const file = Bun.file(join(distDir, appPath === '/' ? 'index.html' : appPath));
    if (await file.exists()) {
      // Bun has no type for `.webmanifest`, and a manifest served as
      // `application/octet-stream` is ignored outright by Chrome.
      const type = path.endsWith('.webmanifest') ? 'application/manifest+json' : undefined;
      return new Response(file, type ? { headers: { 'content-type': type } } : undefined);
    }
    const appRoute =
      path.startsWith('/app/') ||
      path.startsWith('/d/') ||
      path === '/setup' ||
      path === '/pair' ||
      path.startsWith('/pair/');
    return new Response(Bun.file(join(distDir, appRoute ? 'app/index.html' : 'index.html')), {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  },
});

try {
  const chrome = Bun.which('google-chrome') ?? Bun.which('chromium');
  if (chrome === null) fail('no system Chrome or Chromium found');

  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  const missing: string[] = [];
  try {
    for (const viewport of VIEWPORTS) {
      for (const scheme of SCHEMES) {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          colorScheme: scheme,
          reducedMotion: 'reduce',
        });
        try {
          await context.route('**/*', async route => {
            if (new URL(route.request().url()).origin !== server.url.origin) {
              await route.abort();
              return;
            }
            await route.continue();
          });
          const page = await context.newPage();
          try {
            // A 404 on an icon or the manifest is the exact failure this pass
            // exists to catch, and it is invisible in a screenshot: the tab just
            // shows the browser's default glyph.
            page.on('response', response => {
              if (response.status() >= 400) missing.push(`${response.status()} ${response.url()}`);
            });
            await page.goto(new URL('/app/', server.url).toString(), { waitUntil: 'load' });
            const target = join(outDir, `app-${viewport.name}-${scheme}.png`);
            await page.screenshot({ path: target });
            process.stdout.write(
              `📸 app ${viewport.name} ${viewport.width}x${viewport.height} ${scheme} -> ${target}\n`,
            );

            // The favicon proof, once per scheme — the SVG's ink is
            // scheme-dependent, so one capture would only ever prove half of it.
            // Captured on the phone pass only: it is a fixed 16px box, and the
            // viewport it happens to sit in tells you nothing.
            if (viewport.name === 'mobile') {
              await page.evaluate(
                async ({ magnify }) => {
                  const image = new Image();
                  image.src = '/icons/favicon.svg';
                  await image.decode();

                  // RASTERISE AT 16 FIRST, then magnify that raster. Setting an
                  // <img> to 192px and asking for `image-rendering: pixelated`
                  // does NOT show you 16px: an SVG is rendered at its layout
                  // size, so the browser draws a clean 192px vector and the
                  // "proof" proves nothing about the size that was in question.
                  // The 16x16 canvas is the only way to get the actual pixels a
                  // tab strip receives.
                  const small = document.createElement('canvas');
                  small.width = 16;
                  small.height = 16;
                  small.getContext('2d')?.drawImage(image, 0, 0, 16, 16);

                  const large = document.createElement('canvas');
                  large.width = 16 * magnify;
                  large.height = 16 * magnify;
                  const context = large.getContext('2d');
                  if (context) {
                    context.imageSmoothingEnabled = false;
                    context.drawImage(small, 0, 0, large.width, large.height);
                  }

                  const strip = document.createElement('div');
                  strip.id = 'favicon-proof';
                  strip.style.cssText =
                    'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;' +
                    'justify-content:center;gap:24px;background:var(--bg,#fff)';
                  // Left: the untouched 16px <img>, exactly what the tab gets.
                  // Right: that same 16px raster blown up with nearest-neighbour.
                  const actual = document.createElement('img');
                  actual.src = '/icons/favicon.svg';
                  actual.alt = '';
                  actual.width = 16;
                  actual.height = 16;
                  strip.append(actual, large);
                  document.body.appendChild(strip);
                },
                { magnify: MAGNIFY },
              );
              const proof = page.locator('#favicon-proof');
              const proofTarget = join(outDir, `favicon-16-${scheme}.png`);
              await proof.screenshot({ path: proofTarget });
              process.stdout.write(`📸 favicon 16px + ${MAGNIFY}x ${scheme} -> ${proofTarget}\n`);
            }
          } finally {
            await page.close();
          }
        } finally {
          await context.close();
        }
      }
    }
    // Exercise the built documents, not just their source contracts. The pairing
    // QR opens `/pair#v1;…`, which must receive the app entry and its fragment;
    // the landing's marker redirect must still take an already-paired reader to
    // `/app/`, while unavailable storage is deliberately a fail-open landing.
    const routeContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    try {
      const pairingPage = await routeContext.newPage();
      try {
        await pairingPage.goto(
          new URL('/pair#v1;url=https%3A%2F%2Fdaemon.example.test;code=single-use;fp=daemon-a', server.url).toString(),
          { waitUntil: 'load' },
        );
        await pairingPage.getByRole('heading', { name: 'Pair this device?' }).waitFor();
        if (new URL(pairingPage.url()).pathname !== '/pair')
          fail('QR pairing deep link did not retain the pairing route');
      } finally {
        await pairingPage.close();
      }

      const pairedLanding = await routeContext.newPage();
      try {
        await pairedLanding.addInitScript(() => localStorage.setItem('fy-has-pairings-v1', '1'));
        await pairedLanding.goto(server.url.toString(), { waitUntil: 'load' });
        await pairedLanding.waitForURL('**/app/');
      } finally {
        await pairedLanding.close();
      }

      const failOpenLanding = await routeContext.newPage();
      try {
        await failOpenLanding.addInitScript(() => {
          Object.defineProperty(window, 'localStorage', {
            configurable: true,
            get: () => {
              throw new Error('storage unavailable');
            },
          });
        });
        await failOpenLanding.goto(server.url.toString(), { waitUntil: 'load' });
        if (new URL(failOpenLanding.url()).pathname !== '/')
          fail('landing did not fail open when browser storage was unavailable');
      } finally {
        await failOpenLanding.close();
      }
      process.stdout.write('✅ QR pairing route and landing redirect/fail-open behaviour verified\n');
    } finally {
      await routeContext.close();
    }
    // THE HEADER LOCKUP, MAGNIFIED. The mark renders at 20px next to the
    // wordmark, and 20px of grid is too small to judge in a 390px page
    // screenshot — which is exactly the size at which a 3x3 grid's cells start
    // merging into a blob. Captured at deviceScaleFactor 4 so the review is of
    // real rendered pixels enlarged, not of a re-render at a size nothing ships.
    for (const scheme of SCHEMES) {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        colorScheme: scheme,
        reducedMotion: 'reduce',
        deviceScaleFactor: 4,
      });
      try {
        await context.route('**/*', async route => {
          if (new URL(route.request().url()).origin !== server.url.origin) {
            await route.abort();
            return;
          }
          await route.continue();
        });
        const page = await context.newPage();
        try {
          await page.goto(new URL('/app/', server.url).toString(), { waitUntil: 'load' });
          const target = join(outDir, `header-lockup-${scheme}.png`);
          // The lockup is the mark plus the word, so the mark's own size and its
          // optical weight beside the type are both in frame.
          await page.getByText('Ferretry', { exact: true }).locator('..').screenshot({ path: target });
          process.stdout.write(`📸 header lockup at 4x ${scheme} -> ${target}\n`);
        } finally {
          await page.close();
        }
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  // Reported after the browser is down so the failure cannot leak a Chromium.
  if (missing.length > 0) fail(`the page asked for files the bundle does not serve:\n  ${missing.join('\n  ')}`);
  process.stdout.write('✅ every reference the app requested resolved\n');
} finally {
  server.stop(true);
}
