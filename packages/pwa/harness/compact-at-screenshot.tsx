/**
 * Screenshots of the per-ferret "Compact memory at…" control as the app draws it: the Actions menu with the new
 * row (`menu`), the form on the ferret's own value (`form`), the custom box refusing a size below the floor
 * (`custom`), at a 390px phone and a 1440px desktop, in the light and dark studio themes. Review evidence for
 * docs/compact-at.md; nothing compares the PNGs.
 *
 *   bun harness/compact-at-screenshot.tsx          # writes harness/out/compact-at-*.png
 *   COMPACT_AT_SHOTS=/some/dir bun harness/compact-at-screenshot.tsx
 *
 * It renders the REAL `SessionTopBar` and `ActionsMenu` over the real `useCompactAtSessionActions` hook and the real
 * stylesheet and app fonts; the daemon behind it is answered inside the page and changes nothing. Like
 * `agenda-switch-screenshot.tsx` it drives the system Chrome through playwright-core and aborts every request off
 * the loopback origin.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
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
import { SessionTopBar } from '../../src/components/session-top-bar.tsx';
import { useCompactAtSessionActions } from '../../src/features/session-actions/compact-at-session-actions.tsx';
import { ActionsMenu } from '../../src/features/session-actions/actions-menu.tsx';
import { sessionActionSections } from '../../src/features/session-actions/registry.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { sessionView } from '../../tests/support/sessions.ts';

const connection = daemonConnection({ daemonId: 'harness', baseUrl: 'https://harness.invalid', deviceId: 'd' });
const reading = {
  own: 250000,
  effective: 250000,
  window: 1000000,
  restartRequired: false,
  note: 'Memory is compacted at 250k tokens.',
};
const fetcher = async () => new Response(JSON.stringify(reading), { status: 200, headers: { 'content-type': 'application/json' } });
const NOW = '2026-01-01T00:00:00.000Z';
const view = sessionView('hadi', {
  config: { teammate: 'hadi', label: 'Fix the stuck sign-in', mode: 'interactive', compactAt: 250000, cwd: '/work/ferretry' },
  state: { lastActivityAt: NOW },
});
const compact = window.innerWidth < 640;

function Menu() {
  const [form, setForm] = useState<string | null>(null);
  const compactAt = useCompactAtSessionActions({ connection, fetcher });
  const sections = sessionActionSections(compactAt.contributions, { view, canControl: true });
  return <ActionsMenu sections={sections} compact={compact} name="Hadi" form={form} onFormChange={setForm} />;
}

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <div className="flex flex-col bg-bg text-fg" style={{ minHeight: 520 }} data-shot="">
    <SessionTopBar actions={null} compact={false} menu={<Menu />} project="ferretry" session={view} switches={{}} />
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
  <body class="bg-bg"><div id="root"></div><script type="module" src="/compact-at-entry.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
await Bun.write(join(outDir, 'compact-at-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(outDir, 'compact-at-entry.tsx'), '--outdir', outDir, '--target', 'browser']);
rmSync(join(outDir, 'compact-at-entry.tsx'));
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
    // The stylesheet names its fonts relative to src/styles (`../assets/fonts/…`): serve them from there.
    if (url.pathname.startsWith('/assets/fonts/')) return new Response(Bun.file(join(packageDir, 'src', url.pathname)));
    return new Response(Bun.file(join(outDir, url.pathname)));
  },
});

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'desktop', width: 1_440, height: 900 },
] as const;

const SCENES = ['menu', 'form', 'custom'] as const;

const shotsDir = process.env.COMPACT_AT_SHOTS ?? outDir;
mkdirSync(shotsDir, { recursive: true });
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
      });
      try {
        await context.route('**/*', async route => {
          if (new URL(route.request().url()).origin !== server.url.origin) return await route.abort();
          return await route.continue();
        });
        const page = await context.newPage();
        for (const scene of SCENES) {
          await page.goto(`${server.url}?theme=studio-${scheme}`);
          await page.locator('[data-shot]').waitFor({ state: 'visible' });
          await page.locator('[data-session-actions-trigger]').click();
          await page.locator('[data-session-action-item="compact-at"]').waitFor({ state: 'visible' });
          if (scene !== 'menu') {
            await page.locator('[data-session-action-item="compact-at"]').click();
            await page.locator('[data-session-action-form="compact-at"] form').waitFor({ state: 'visible' });
          }
          if (scene === 'custom') {
            await page.locator('input[type="radio"][value="custom"]').check();
            await page.locator('input.kt-input').fill('50k');
            await page.locator('[data-action-submit]').click();
            await page.getByText('50k is too small: the lowest is 100k.').waitFor({ state: 'visible' });
          }
          await page.evaluate(async () => await document.fonts.ready);
          const family = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (overflow > 0) fail(`${scene} at ${viewport.name}/${scheme} scrolls sideways by ${overflow}px`);
          const target = join(shotsDir, `compact-at-${scene}-${viewport.name}-${scheme}.png`);
          await page.screenshot({ path: target });
          process.stdout.write(`📸 ${target} (${family})\n`);
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
