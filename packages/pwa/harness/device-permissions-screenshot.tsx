/**
 * Screenshots of device permissions and "Share my location": the Settings › This device › Permissions
 * page (an iPhone with the app installed, one row refused and its how-to open), the composer's "+" menu
 * and the pending location chip, and the same location block as it reads in a sent message. Phone 390
 * and desktop 1440, light and dark. Review evidence; nothing compares the PNGs.
 *
 *   bun harness/device-permissions-screenshot.tsx [out-dir]   # writes device-permissions-*.png (default harness/out)
 *
 * The permissions rows are the REAL `DevicePermissionsSetting` over a fake host that only reads. The
 * composer is the REAL `Composer`, driven by pressing "+" and "Share my location"; the sent message is
 * the REAL `Markdown` drawing the exact text the composer sent. Like `screenshot.ts` it drives the
 * system Chrome through playwright-core, aborts every request off the loopback origin, and asserts every
 * width fits without sideways scroll.
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
import { Composer } from '../../src/components/composer.tsx';
import { Markdown } from '../../src/components/markdown.tsx';
import { DevicePermissionsSetting } from '../../src/features/settings/device-permissions-settings.tsx';
import { DevicePermissionsContext } from '../../src/hooks/use-device-permissions.ts';
import { LocationShareContext } from '../../src/hooks/use-location-share.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { DaemonDraftStore } from '../../src/lib/drafts.ts';
import { formatLocationBlock } from '../../src/lib/location-share.ts';

const daemon = daemonConnection({ daemonId: 'harness', baseUrl: 'https://harness.example.test', deviceId: 'token' });

const STATES = {
  camera: 'denied',
  microphone: 'granted',
  notifications: 'prompt',
  location: 'prompt',
  'clipboard-read': 'unsupported',
  'persistent-storage': 'granted',
};
const permissions = {
  facts: { family: 'ios', installed: true, secure: true },
  status: async id => STATES[id] ?? 'prompt',
  request: async id => STATES[id] ?? 'prompt',
};

const fix = {
  latitude: 51.50735,
  longitude: -0.12776,
  accuracyMeters: 20,
  capturedAt: Date.parse('2026-10-21T12:00:00.000Z'),
  place: 'The office',
};
const locationHost = { locate: async () => ({ ...fix, place: undefined }) };

const sentMessage = 'Here is where I am.\\n\\n' + formatLocationBlock(fix);

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, value); }
}

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <div className="kt-shell flex min-h-full flex-col gap-panel bg-bg p-panel">
    <div className="flex w-full max-w-xl flex-col gap-panel" data-shot="permissions">
      <section className="kt-panel flex flex-col gap-2 p-panel">
        <p className="kt-label m-0">This device · Permissions</p>
        <DevicePermissionsContext.Provider value={permissions}>
          <DevicePermissionsSetting />
        </DevicePermissionsContext.Provider>
      </section>
    </div>
    <div className="flex w-full max-w-xl flex-col gap-panel" data-shot="composer">
      <section className="kt-panel flex flex-col gap-2 p-panel">
        <p className="kt-label m-0">Composer · Share my location</p>
        <LocationShareContext.Provider value={locationHost}>
          <Composer
            api={{ send: async () => ({}) }}
            daemon={daemon}
            draftStore={new DaemonDraftStore(new MemoryStorage())}
            sessionId="harness-session"
          />
        </LocationShareContext.Provider>
      </section>
    </div>
    <div className="flex w-full max-w-xl flex-col gap-panel" data-shot="message">
      <section className="kt-panel flex flex-col gap-2 p-panel">
        <p className="kt-label m-0">Sent message</p>
        <Markdown text={sentMessage} />
      </section>
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
  <body><div id="root"></div><script type="module" src="/device-permissions-entry.js"></script></body>
</html>`;

mkdirSync(buildDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
await Bun.write(join(buildDir, 'device-permissions-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(buildDir, 'device-permissions-entry.tsx'), '--outdir', buildDir, '--target', 'browser']);
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
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/') {
      return new Response(html(url.searchParams.get('theme') ?? 'studio-dark'), {
        headers: { 'content-type': 'text/html' },
      });
    }
    return new Response(Bun.file(join(buildDir, url.pathname)));
  },
});

const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844, touch: true },
  { name: 'desktop', width: 1_440, height: 900, touch: false },
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
        isMobile: viewport.touch,
      });
      try {
        await context.route('**/*', async route => {
          if (new URL(route.request().url()).origin !== server.url.origin) return await route.abort();
          return await route.continue();
        });
        const page = await context.newPage();
        await page.goto(`${server.url}?theme=studio-${scheme}`);
        const where = `${viewport.name}/${scheme}`;
        await page.locator('[data-shot="permissions"] [data-permission]').first().waitFor({ state: 'visible' });
        await page.getByRole('button', { name: 'How to enable' }).first().click();
        await page.evaluate(() => document.querySelector<HTMLElement>('[data-composer-attach]')?.click());
        await page.getByRole('menuitem', { name: 'Share my location' }).waitFor({ state: 'attached' });
        await page.evaluate(() => {
          const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node =>
            node.textContent?.includes('Share my location'),
          );
          item?.click();
        });
        await page.locator('[data-location-draft="ready"]').waitFor({ state: 'visible' });
        await page.getByLabel('Place name (optional)').fill('The office', { force: true });
        await page.locator('[data-shot="message"] [data-location-chip]').waitFor({ state: 'visible' });
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (overflow > 0) fail(`${where} scrolls sideways by ${overflow}px`);
        await page.setViewportSize({
          width: viewport.width,
          height: (await page.evaluate(() => document.documentElement.scrollHeight)) + 800,
        });
        await page.evaluate(() => window.scrollTo(0, 0));
        for (const shot of ['permissions', 'composer', 'message'] as const) {
          const target = join(outDir, `device-permissions-${shot}-${viewport.name}-${scheme}.png`);
          const box = await page.evaluate(selector => {
            const rect = document.querySelector(selector)?.getBoundingClientRect();
            return rect === undefined
              ? undefined
              : { x: 0, y: rect.top + window.scrollY - 8, width: window.innerWidth, height: rect.height + 16 };
          }, `[data-shot="${shot}"]`);
          const block = box ?? fail(`${where}: no ${shot} block`);
          await page.screenshot({ path: target, clip: { ...block, y: Math.max(block.y, 0) } });
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
