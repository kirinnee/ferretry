/**
 * Screenshots of Settings › Machine › Performance › Connection drops: a handful of made-up drops,
 * at a 390px phone and a 1440px desktop, in the light and dark studio themes. Review evidence;
 * nothing compares the PNGs.
 *
 *   bun harness/connection-drops-screenshot.tsx [outDir]   # writes <outDir>/connection-drops-<viewport>-<scheme>.png
 *
 * It renders the REAL `ConnectionDrops` panel over a real `CarrierDropLog` filled with invented drops
 * for an invented machine. No credential exists in this harness and every request off the loopback
 * origin is aborted.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const bundleDir = join(harnessDir, 'out');
const outDir = resolve(process.argv[2] ?? bundleDir);

const fail = (message: string): never => {
  process.stderr.write(`❌ ${message}\n`);
  process.exit(1);
};

const run = (command: string, args: readonly string[]): void => {
  const result = spawnSync(command, args, { cwd: packageDir, stdio: 'inherit' });
  if (result.status !== 0) fail(`${command} exited ${result.status}`);
};

const PAGE_ENTRY = `
import { createRoot } from 'react-dom/client';
import { ConnectionDrops } from '../../src/features/settings/connection-drops.tsx';
import { CarrierDropLog } from '../../src/lib/carrier-drops.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';

const machine = daemonConnection({
  daemonId: 'fy_daemon_exampleMachine',
  baseUrl: 'http://127.0.0.1:7431',
  deviceId: 'fy_device_id_example0000000000000000',
});
const page = { now: Date.UTC(2026, 9, 22, 6, 10, 0), hiddenFor: undefined as number | undefined, network: 'cellular/4g' };
const drops = new CarrierDropLog(
  { now: () => page.now, hiddenFor: () => page.hiddenFor, online: () => true, network: () => page.network },
  { getItem: () => null, setItem: () => undefined },
);
const drop = (minutes: number, carrier: 'tunnel' | 'relay', purpose: 'requests' | 'stream', code: number, reason: string, livedMs: number, lastHeardMs: number, hiddenMs: number | undefined, backMs: number) => {
  page.now += minutes * 60_000;
  page.hiddenFor = hiddenMs;
  drops.dropped(machine.daemonId, carrier, purpose, { code, reason, livedMs, lastHeardMs });
  page.now += backMs;
  drops.reconnected(machine.daemonId);
};
drop(0, 'tunnel', 'stream', 1006, '', 1_260_000, 400, undefined, 320);
drop(7, 'tunnel', 'requests', 4408, 'the carrier showed no sign of life for 4 s after a heartbeat', 380_000, 214_000, 212_000, 640);
drop(9, 'tunnel', 'stream', 1006, '', 540_000, 1_100, undefined, 290);
page.network = 'wifi';
drop(14, 'relay', 'requests', 1006, '', 2_400_000, 900, undefined, 410);
const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4">
    <ConnectionDrops connection={machine} drops={drops} write={async () => undefined} />
  </div>,
);
`;

const html = (theme: string) => `<!doctype html>
<html lang="en" data-theme="${theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="/app.css" />
  </head>
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/drops-entry.js"></script></body>
</html>`;

mkdirSync(bundleDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
await Bun.write(join(bundleDir, 'drops-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(bundleDir, 'drops-entry.tsx'), '--outdir', bundleDir, '--target', 'browser']);
run('./node_modules/.bin/tailwindcss', [
  '--config',
  'tailwind.config.ts',
  '--input',
  'src/styles/index.css',
  '--output',
  join(bundleDir, 'app.css'),
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
    return new Response(Bun.file(join(bundleDir, url.pathname)));
  },
});

const executablePath =
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? fail('no system Chrome or Chromium found');
const browser = await chromium.launch({ executablePath, headless: true });
const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844, mobile: true },
  { name: 'desktop', width: 1440, height: 900, mobile: false },
] as const;

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
          if (new URL(route.request().url()).origin !== server.url.origin) return await route.abort();
          return await route.continue();
        });
        const page = await context.newPage();
        await page.goto(`${server.url}?theme=studio-${scheme}`);
        await page.locator('[data-connection-drops="4"]').waitFor({ state: 'visible' });
        const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (sideways > 0) fail(`${scheme} ${viewport.name} scrolls sideways by ${sideways}px`);
        const target = join(outDir, `connection-drops-${viewport.name}-${scheme}.png`);
        await page.screenshot({ path: target, fullPage: true });
        process.stdout.write(`📸 ${target}\n`);
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
  server.stop();
}
