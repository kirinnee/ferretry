/**
 * Screenshots of the machine's read-only CONNECTION panel (docs/relay-protocol.md §13, piece 4). Three
 * scenes, each at phone (390) and desktop (1440) in the light and dark studio themes:
 *
 *   * direct — the session won on the daemon's own address.
 *   * relayed — direct failed at transport and the hosted relay carried it.
 *   * reconnecting — the reconnect loop lost the carrier that last won.
 *
 *   bun harness/connection-status-screenshot.tsx   # writes harness/out/connection-<scene>-<viewport>-<scheme>.png
 *
 * It renders the REAL `DaemonSettingsFrame` on its Connection panel over real `chooseConnection`
 * answers — no network, no daemon. Review evidence; nothing compares the PNGs.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const outDir = join(harnessDir, 'out');

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
import { chooseConnection } from '@ferretry/relay';
import { DaemonSettingsFrame } from '../../src/features/settings/daemon-settings-frame.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';

const connection = daemonConnection({ daemonId: 'studio', baseUrl: 'https://studio.local:7431', deviceId: 'harness' });
const DIRECT = { kind: 'direct', daemonUrl: 'https://studio.local:7431' };
const HOSTED = { kind: 'relay', relayUrl: 'wss://relay.ferretry.workers.dev', operator: 'hosted' };
const unavailable = async () => Promise.reject(new Error('not in this harness'));
const scenes = {
  direct: { carrier: chooseConnection([{ method: DIRECT, reachable: true }]) },
  relayed: {
    carrier: chooseConnection([
      { method: DIRECT, reachable: false, detail: 'Failed to fetch' },
      { method: HOSTED, reachable: true },
    ]),
  },
  reconnecting: {
    carrier: chooseConnection([
      { method: DIRECT, reachable: false, detail: 'Failed to fetch' },
      { method: HOSTED, reachable: true },
    ]),
    connectionHealth: {
      kind: 'reconnecting',
      since: 0,
      attempt: 3,
      nextAttemptAt: null,
      failures: [
        { label: 'Direct', detail: 'Failed to fetch' },
        { label: 'Hosted relay', detail: 'No daemon holds this rendezvous (4404).' },
      ],
      cause: 'daemon-unreachable',
      stalled: true,
    },
  },
};

createRoot(document.getElementById('root')).render(
  <main style={{ margin: '0 auto', maxWidth: 760, padding: 16, display: 'flex', flexDirection: 'column', gap: 24 }}>
    {Object.entries(scenes).map(([name, scene]) => (
      <div key={name} data-scene={name}>
        <DaemonSettingsFrame
          connection={connection}
          name="studio"
          readWardenStatus={unavailable}
          createWardenClient={unavailable}
          panel="carrier"
          onOpenPanel={() => undefined}
          relayAdvertised
          {...scene}
        />
      </div>
    ))}
  </main>,
);
`;

const html = (theme: string) => `<!doctype html>
<html lang="en" data-theme="${theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="/app.css" />
    <style>html, body { height: auto !important; overflow: visible !important; }</style>
  </head>
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/connection-status-entry.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
await Bun.write(join(outDir, 'connection-status-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(outDir, 'connection-status-entry.tsx'), '--outdir', outDir, '--target', 'browser']);
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

const executablePath =
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? fail('no system Chrome or Chromium found');
const browser = await chromium.launch({ executablePath, headless: true });
const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844, mobile: true },
  { name: 'desktop', width: 1440, height: 900, mobile: false },
] as const;
const SCENES = ['direct', 'relayed', 'reconnecting'] as const;

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
        await page.locator('[data-scene="reconnecting"] [data-connection-status]').waitFor({ state: 'visible' });
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (overflow > 0) fail(`${scheme} ${viewport.name} scrolls sideways by ${overflow}px`);
        for (const name of SCENES) {
          const target = join(outDir, `connection-${name}-${viewport.name}-${scheme}.png`);
          await page.locator(`[data-scene="${name}"]`).screenshot({ path: target });
          process.stdout.write(`📸 ${target}\n`);
        }
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
  server.stop();
}
