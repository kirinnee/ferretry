/**
 * Screenshots of the OPT-IN TUNNEL on the Connection panel (docs/relay-protocol.md §15 "The choice").
 * Three scenes, each at phone (390) and desktop (1440) in the light and dark studio themes:
 *
 *   * tunnel-off — "Tunnel only" for a machine whose tunnel is switched off: the stated failure, the
 *     machine's own "Tunnel: off (opt-in)" line, and the offer to turn it on.
 *   * auto-offer — Auto, carried by the relay, for the same machine: the offer, and nothing broken.
 *   * tunnel-up — "Tunnel only" once the tunnel is on and carrying.
 *
 *   bun harness/tunnel-optin-screenshot.tsx   # writes harness/out/tunnel-<scene>-<viewport>-<scheme>.png
 *
 * It renders the REAL `DaemonSettingsFrame` Connection panel over real `chooseConnection` answers — no
 * network, no daemon. Review evidence; nothing compares the PNGs.
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
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { chooseConnection } from '@ferretry/relay';
import { DaemonSettingsFrame } from '../../src/features/settings/daemon-settings-frame.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';

const connection = daemonConnection({ daemonId: 'studio', baseUrl: 'https://studio.local:7431', deviceId: 'harness' });
const DIRECT = { kind: 'direct', daemonUrl: 'https://studio.local:7431' };
const TUNNEL = { kind: 'tunnel', tunnelUrl: 'https://ssxg3hqu5pkfmzjq.ferretry.stream' };
const HOSTED = { kind: 'relay', relayUrl: 'wss://relay.ferretry.workers.dev', operator: 'hosted' };
const unavailable = async () => Promise.reject(new Error('not in this harness'));
const awayFromHome = { method: DIRECT, reachable: false, detail: 'the address did not answer within 4 s' };
const OFF = 'Tunnel: off (opt-in) — turn on with fy daemon tunnel on or Settings › Connection';
const UP = 'Tunnel: on — https://ssxg3hqu5pkfmzjq.ferretry.stream';
const offered = { sentence: OFF, off: true, turnOn: async () => new Promise(() => undefined) };
const scenes = {
  'tunnel-off': {
    carrier: { ok: false, reason: 'Tunnel only: this machine’s tunnel is off (opt-in) — turn it on in Settings › Connection.', passedOver: [] },
    preference: 'tunnel',
    tunnel: offered,
  },
  'auto-offer': {
    carrier: chooseConnection([awayFromHome, { method: HOSTED, reachable: true }]),
    preference: 'auto',
    tunnel: offered,
  },
  'tunnel-up': {
    carrier: chooseConnection([{ method: TUNNEL, reachable: true }]),
    preference: 'tunnel',
    tunnel: { sentence: UP, off: false, turnOn: async () => undefined },
  },
};

function Scene({ scene }) {
  const [preference, setPreference] = useState(scene.preference);
  return (
    <DaemonSettingsFrame
      connection={connection}
      name="Liftoff EC2"
      readWardenStatus={unavailable}
      createWardenClient={unavailable}
      panel="carrier"
      onOpenPanel={() => undefined}
      relayAdvertised
      carrier={scene.carrier}
      carrierPreference={{
        value: preference,
        onChange: setPreference,
        availability: { webrtc: true, tunnelNote: 'This machine has no tunnel yet.', tunnel: scene.tunnel },
      }}
    />
  );
}

createRoot(document.getElementById('root')).render(
  <main style={{ margin: '0 auto', maxWidth: 760, padding: 16, display: 'flex', flexDirection: 'column', gap: 24 }}>
    {Object.entries(scenes).map(([name, scene]) => (
      <div key={name} data-scene={name}><Scene scene={scene} /></div>
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
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/tunnel-optin-entry.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
await Bun.write(join(outDir, 'tunnel-optin-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(outDir, 'tunnel-optin-entry.tsx'), '--outdir', outDir, '--target', 'browser']);
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
const SCENES = ['tunnel-off', 'auto-offer', 'tunnel-up'] as const;

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
        await page.locator('[data-scene="tunnel-off"] [data-tunnel-offer]').waitFor({ state: 'visible' });
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (overflow > 0) fail(`${scheme} ${viewport.name} scrolls sideways by ${overflow}px`);
        for (const name of SCENES) {
          const target = join(outDir, `tunnel-${name}-${viewport.name}-${scheme}.png`);
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
