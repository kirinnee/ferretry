/**
 * Screenshots of the ninth capability, `voice`, on the two screens that list capabilities (docs/grants.md,
 * "Capability nine was added: `voice`"): Settings › Devices with a device's capabilities open (every row has a
 * one-line description, Voice's reads "Speak to this machine, and set up its speech engine."), and the
 * daemon-wide "What this browser may do here" list with its Voice row. A 390px phone and a 1280px desktop,
 * light and dark. FAKE DATA ONLY. Review evidence; nothing compares the PNGs.
 *
 *   bun harness/voice-capability-screenshot.tsx [out-dir]   # writes voice-capability-<screen>-<viewport>-<scheme>.png (default harness/out)
 *
 * It renders the REAL `AddDeviceCard` and `CapabilityList` over every capability the protocol declares. Like
 * `sharing-capability-screenshot.tsx` it drives the system Chrome through playwright-core, aborts every request
 * off the loopback origin, and asserts every width fits without sideways scroll.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out');
const outDir = resolve(process.argv[2] ?? buildDir);

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
import { type CapabilityGrants, DAEMON_CAPABILITIES, type DaemonCapability } from '@ferretry/protocol';
import { AddDeviceCard } from '../../src/features/settings/add-device-settings.tsx';
import { CapabilityList } from '../../src/features/settings/capability-list.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';

const connection = daemonConnection({ daemonId: 'harness', baseUrl: 'https://harness.example.test', deviceId: 'token' });
const PHONE = 'fy_device_id_' + 'a'.repeat(22);
const TABLET = 'fy_device_id_' + 'b'.repeat(22);

const grantsOf = (held: Partial<Record<DaemonCapability, { use?: boolean; configure?: boolean }>>): CapabilityGrants =>
  Object.fromEntries(
    DAEMON_CAPABILITIES.map(capability => [capability, { use: false, configure: false, ...held[capability] }]),
  ) as CapabilityGrants;
const everything = Object.fromEntries(
  DAEMON_CAPABILITIES.map(capability => [capability, { use: true, configure: true }]),
) as CapabilityGrants;

const view = {
  devices: [
    {
      id: PHONE,
      name: 'Owner phone',
      platform: 'browser' as const,
      createdAt: '2026-10-02T09:00:00.000Z',
      lastSeenAt: '2026-11-05T08:30:00.000Z',
      idleExpiresAt: '2027-03-01T00:00:00.000Z',
      grants: everything,
    },
    {
      id: TABLET,
      name: 'Reading tablet',
      platform: 'browser' as const,
      createdAt: '2026-10-05T10:00:00.000Z',
      lastSeenAt: '2026-11-04T18:00:00.000Z',
      idleExpiresAt: '2027-03-01T00:00:00.000Z',
      grants: grantsOf({ fleet: { use: true }, voice: { use: true } }),
    },
  ],
  hostLocal: true,
  thisDeviceId: PHONE,
  mayWiden: everything,
};

const capabilities = DAEMON_CAPABILITIES.map(capability => ({
  capability,
  use: true,
  configure: true,
  granted: { use: true, configure: true },
  useRefusal: 'granted' as const,
  configureRefusal: 'granted' as const,
  origin: 'default' as const,
  mayGrant: false,
}));

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <div className="kt-shell flex min-h-full flex-col gap-panel bg-bg p-panel">
    <div className="flex w-full max-w-xl flex-col gap-panel" data-shot="devices">
      <AddDeviceCard
        connection={connection}
        view={view}
        invite={null}
        nowMs={Date.parse('2026-11-05T12:00:00.000Z')}
        capabilitiesOpenFor={TABLET}
        onMint={() => {}}
        onDiscardInvite={() => {}}
        onRevokeCode={() => {}}
        onRevokeDevice={() => {}}
        onChangeDeviceGrants={() => {}}
      />
    </div>
    <div className="flex w-full max-w-xl flex-col gap-panel" data-shot="grants">
      <CapabilityList connection={connection} capabilities={capabilities} governed />
    </div>
  </div>,
);
`;

const html = (theme: string) => `<!doctype html>
<html lang="en" data-theme="${theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="/app.css" />
    <style>html, body, #root { min-height: 100%; margin: 0; }</style>
  </head>
  <body><div id="root"></div><script type="module" src="/voice-capability-entry.js"></script></body>
</html>`;

mkdirSync(buildDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
await Bun.write(join(buildDir, 'voice-capability-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(buildDir, 'voice-capability-entry.tsx'), '--outdir', buildDir, '--target', 'browser']);
run('./node_modules/.bin/tailwindcss', [
  '--config',
  'tailwind.config.ts',
  '--input',
  'src/styles/index.css',
  '--output',
  join(buildDir, 'app.css'),
]);

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/') {
      return new Response(html(url.searchParams.get('theme') ?? 'studio-dark'), {
        headers: { 'content-type': 'text/html' },
      });
    }
    const file = Bun.file(join(buildDir, url.pathname));
    return new Response((await file.exists()) ? file : null, { status: (await file.exists()) ? 200 : 404 });
  },
});

const VIEWPORTS = [
  { name: 'phone-390', width: 390, height: 844, touch: true },
  { name: 'desktop-1280', width: 1_280, height: 900, touch: false },
] as const;

const executablePath =
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? fail('no system Chrome or Chromium found');
const browser = await chromium.launch({ executablePath, headless: true });
try {
  for (const viewport of VIEWPORTS) {
    for (const scheme of ['light', 'dark'] as const) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        colorScheme: scheme,
        reducedMotion: 'reduce',
        hasTouch: viewport.touch,
      });
      try {
        await context.route('**/*', async route => {
          if (new URL(route.request().url()).origin !== server.url.origin) return await route.abort();
          return await route.continue();
        });
        const page = await context.newPage();
        await page.goto(`${server.url}?theme=studio-${scheme}`);
        const where = `${viewport.name}/${scheme}`;
        // The Devices screen: the tablet's capabilities are open, so its Voice row and description are on screen.
        const open = '[data-shot="devices"] [data-device-capabilities][open]';
        await page.locator(`${open} [data-device-capability="voice"]`).waitFor({ state: 'visible' });
        const deviceRows = await page.locator(`${open} [data-device-capability]`).count();
        if (deviceRows !== 9) fail(`${where}: expected 9 device capability rows, saw ${deviceRows}`);
        const blurb = await page
          .locator(`${open} [data-device-capability="voice"] [data-device-capability-blurb]`)
          .innerText();
        if (blurb !== 'Speak to this machine, and set up its speech engine.')
          fail(`${where}: voice blurb was "${blurb}"`);
        // The daemon-wide list.
        await page.locator('[data-shot="grants"] [data-capability-row="voice"]').waitFor({ state: 'visible' });
        const listRows = await page.locator('[data-shot="grants"] [data-capability-row]').count();
        if (listRows !== 9) fail(`${where}: expected 9 capability rows, saw ${listRows}`);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (overflow > 0) fail(`${where} scrolls sideways by ${overflow}px`);
        for (const [screen, selector] of [
          ['devices', '[data-shot="devices"]'],
          ['grants', '[data-shot="grants"]'],
        ] as const) {
          const target = join(outDir, `voice-capability-${screen}-${viewport.name}-${scheme}.png`);
          await page.locator(selector).screenshot({ path: target });
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
