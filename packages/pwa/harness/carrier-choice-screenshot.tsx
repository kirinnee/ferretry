/**
 * Screenshots of the CONNECTION CHOICE (docs/relay-protocol.md §15 "The choice"). Four scenes, each at
 * phone (390) and desktop (1440) in the light and dark studio themes:
 *
 *   * tunnel — Auto, and the session won on the machine's Cloudflare tunnel after direct failed.
 *   * relay — Auto, every carrier before the relay passed over, with a fallback reason.
 *   * not-set-up — "Tunnel only" on a machine with no tunnel while the operator has no service.
 *   * device — Settings › This device › Connection, one selector per paired machine.
 *
 *   bun harness/carrier-choice-screenshot.tsx   # writes harness/out/carrier-<scene>-<viewport>-<scheme>.png
 *
 * It renders the REAL `DaemonSettingsFrame` Connection panel and `ConnectionPreferenceSettings` over
 * real `chooseConnection` answers — no network, no daemon. Review evidence; nothing compares the PNGs.
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
import { ConnectionPreferenceSettings } from '../../src/features/settings/connection-preference-settings.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';

const connection = daemonConnection({ daemonId: 'studio', baseUrl: 'https://studio.local:7431', deviceId: 'harness' });
const DIRECT = { kind: 'direct', daemonUrl: 'https://studio.local:7431' };
const WEBRTC = { kind: 'webrtc' };
const TUNNEL = { kind: 'tunnel', tunnelUrl: 'https://k3x9mq.tunnels.ferretry.dev' };
const HOSTED = { kind: 'relay', relayUrl: 'wss://relay.ferretry.workers.dev', operator: 'hosted' };
const NO_WEBRTC = { method: WEBRTC, reachable: false, detail: 'WebRTC isn’t available in this build yet', untried: true };
const unavailable = async () => Promise.reject(new Error('not in this harness'));
const relayed = chooseConnection([
  { method: DIRECT, reachable: false, detail: 'Failed to fetch' },
  NO_WEBRTC,
  { method: TUNNEL, reachable: false, detail: 'the address did not answer (1006)' },
  { method: HOSTED, reachable: true },
]);
const scenes = {
  tunnel: {
    carrier: chooseConnection([{ method: DIRECT, reachable: false, detail: 'Failed to fetch' }, NO_WEBRTC, { method: TUNNEL, reachable: true }]),
    preference: 'auto',
    availability: { webrtc: false },
  },
  relay: {
    carrier: { ...relayed, fallbackReason: 'this network blocks the tunnel’s hostname' },
    preference: 'auto',
    availability: { webrtc: false },
  },
  'not-set-up': {
    carrier: { ok: false, reason: 'Tunnel only: not set up by the operator.', passedOver: [] },
    preference: 'tunnel',
    availability: { webrtc: false, tunnelNote: 'Not set up by the operator.' },
  },
};

function Scene({ scene }) {
  const [preference, setPreference] = useState(scene.preference);
  return (
    <DaemonSettingsFrame
      connection={connection}
      name="studio"
      readWardenStatus={unavailable}
      createWardenClient={unavailable}
      panel="carrier"
      onOpenPanel={() => undefined}
      relayAdvertised
      carrier={scene.carrier}
      carrierPreference={{ value: preference, onChange: setPreference, availability: scene.availability }}
    />
  );
}

function Device() {
  const [preferences, setPreferences] = useState({ studio: 'auto', laptop: 'relay' });
  return (
    <section className="kt-panel p-panel">
      <h3 className="m-0 mb-3 text-row font-semibold text-fg">Connection</h3>
      <ConnectionPreferenceSettings
        machines={[
          { daemonId: 'studio', label: 'studio', preference: preferences.studio, availability: { webrtc: false } },
          {
            daemonId: 'laptop',
            label: 'laptop',
            preference: preferences.laptop,
            availability: { webrtc: false, tunnelNote: 'This machine has no tunnel yet.' },
          },
        ]}
        onChange={(daemonId, preference) => setPreferences(current => ({ ...current, [daemonId]: preference }))}
      />
    </section>
  );
}

createRoot(document.getElementById('root')).render(
  <main style={{ margin: '0 auto', maxWidth: 760, padding: 16, display: 'flex', flexDirection: 'column', gap: 24 }}>
    {Object.entries(scenes).map(([name, scene]) => (
      <div key={name} data-scene={name}><Scene scene={scene} /></div>
    ))}
    <div data-scene="device"><Device /></div>
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
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/carrier-choice-entry.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
await Bun.write(join(outDir, 'carrier-choice-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(outDir, 'carrier-choice-entry.tsx'), '--outdir', outDir, '--target', 'browser']);
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
const SCENES = ['tunnel', 'relay', 'not-set-up', 'device'] as const;

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
        await page.locator('[data-scene="device"] [data-connection-preferences]').waitFor({ state: 'visible' });
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (overflow > 0) fail(`${scheme} ${viewport.name} scrolls sideways by ${overflow}px`);
        for (const name of SCENES) {
          const target = join(outDir, `carrier-${name}-${viewport.name}-${scheme}.png`);
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
