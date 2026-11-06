/**
 * Screenshots of Settings › Appearance › Map style and a `map` block drawn in both styles, at phone (390) and
 * desktop (1280), light and dark. FAKE key, STUBBED Google frame, stubbed OSM tiles: every request that leaves the
 * loopback origin is answered locally, so nothing here reaches Google or OpenStreetMap.
 *
 *   bun harness/map-style-screenshot.tsx   # writes harness/out/map-style-<scene>-<viewport>-<scheme>.png
 *
 * Review evidence; nothing compares the PNGs. The page is served WITHOUT the production CSP (the CSP is pinned by
 * `tests/unit/map-style.test.ts` and `scripts/validate/pages-config.sh`).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const outDir = process.env.MAP_SHOTS_OUT ?? join(harnessDir, 'out');

const fail = (message: string): never => {
  process.stderr.write(`❌ ${message}\n`);
  process.exit(1);
};

const run = (command: string, args: readonly string[]): void => {
  const result = spawnSync(command, args, { cwd: packageDir, stdio: 'inherit' });
  if (result.status !== 0) fail(`${command} exited ${result.status}`);
};

const html = (theme: string) => `<!doctype html>
<html lang="en" data-theme="${theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="/app.css" />
    <link rel="stylesheet" href="/map-style-page.css" />
    <style>html, body { height: auto !important; overflow: visible !important; }</style>
  </head>
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/map-style-page.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
const entry = join(harnessDir, 'map-style-page.tsx');
run('bun', ['build', entry, '--outdir', outDir, '--target', 'browser']);
run('./node_modules/.bin/tailwindcss', [
  '--config',
  'tailwind.config.ts',
  '--input',
  'src/styles/index.css',
  '--output',
  join(outDir, 'app.css'),
]);

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/') {
      return new Response(html(url.searchParams.get('theme') ?? 'studio-dark'), {
        headers: { 'content-type': 'text/html' },
      });
    }
    return new Response(Bun.file(join(outDir, url.pathname)));
  },
});

const TILE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#ede9dc"/><path d="M0 128H256M128 0V256" stroke="#fff" stroke-width="10"/><path d="M0 40L256 90M60 0L110 256" stroke="#f6d98a" stroke-width="6"/><rect x="150" y="150" width="70" height="60" fill="#cfe3c4"/></svg>`;

const frameStub = (address: string): string => {
  const url = new URL(address);
  const shown = [...url.searchParams.entries()]
    .filter(([name]) => name !== 'key')
    .map(([name, value]) => `${name}=${value}`);
  return `<!doctype html><html><body style="margin:0;font:14px system-ui;background:linear-gradient(135deg,#dfe8f2,#c9d9c3);height:100vh;display:grid;place-items:center">
<div style="background:#fff;border-radius:8px;padding:12px 16px;box-shadow:0 1px 4px #0004;max-width:80%;color:#222">
<b>STUB — Google Maps Embed</b><br>${url.pathname.replace('/maps/embed/v1/', '')} · key=FAKE<br>${shown.join('<br>')}</div></body></html>`;
};

const executablePath =
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? fail('no system Chrome or Chromium found');
const browser = await chromium.launch({ executablePath, headless: true });
const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844, mobile: true },
  { name: 'desktop', width: 1280, height: 900, mobile: false },
] as const;
const framed: string[] = [];

try {
  for (const scheme of ['light', 'dark'] as const) {
    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 2,
        isMobile: viewport.mobile,
        hasTouch: viewport.mobile,
        colorScheme: scheme,
        reducedMotion: 'reduce',
      });
      try {
        await context.route('**/*', async route => {
          const address = route.request().url();
          const url = new URL(address);
          if (url.origin === server.url.origin) return await route.continue();
          if (url.origin === 'https://www.google.com' && url.pathname.startsWith('/maps/embed/v1/')) {
            framed.push(address);
            return await route.fulfill({ body: frameStub(address), contentType: 'text/html; charset=utf-8' });
          }
          if (url.origin === 'https://tile.openstreetmap.org') {
            return await route.fulfill({
              body: TILE_SVG,
              contentType: 'image/svg+xml',
              headers: { 'access-control-allow-origin': '*' },
            });
          }
          return await route.abort();
        });
        const page = await context.newPage();
        page.on('pageerror', error => process.stderr.write(`pageerror: ${error.message}\n`));
        await page.goto(`${server.url}?theme=studio-${scheme}`);
        await page
          .locator('[data-scene="settings"] [role="radiogroup"][aria-label="Map style"]')
          .waitFor({ state: 'visible' });
        // A map block draws only when it is near the viewport, so bring each scene to the screen in turn.
        for (const scene of ['osm', 'google', 'fallback'] as const) {
          await page.locator(`[data-scene="${scene}"]`).scrollIntoViewIfNeeded();
          await page
            .locator(`[data-scene="${scene}"] ${scene === 'google' ? 'iframe' : '.leaflet-container'}`)
            .waitFor({ state: 'attached', timeout: 15_000 });
        }
        await page.locator('[data-scene="fallback"] .fy-render-map-note').waitFor({ state: 'visible' });
        await page.waitForTimeout(800);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (overflow > 0) fail(`${scheme} ${viewport.name} scrolls sideways by ${overflow}px`);
        for (const name of ['settings', 'osm', 'google', 'fallback'] as const) {
          const target = join(outDir, `map-style-${name}-${viewport.name}-${scheme}.png`);
          await page.locator(`[data-scene="${name}"]`).screenshot({ path: target });
          process.stdout.write(`📸 ${target}\n`);
        }
      } finally {
        await context.close();
      }
    }
  }
  process.stdout.write(
    `frames requested (key redacted): ${framed.length}\n${framed[0]?.replace(/key=[^&]+/, 'key=FAKE')}\n`,
  );
} finally {
  await browser.close();
  server.stop();
}
