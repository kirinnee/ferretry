/**
 * The composer's refused-location chip with the "turn location back on" steps Access provides for an iPhone browser tab
 * (u2-08). It renders the REAL `ComposerLocationChip` over the REAL Access hook (`howToEnableLocationHook`) against an
 * invented iPhone window, in the shell stub the app's tests use. Fake data only: no machine, no secret.
 *
 *   bun packages/plugins/conversation/tests/integration/app/composer-location-chip-screenshot.harness.tsx
 *   # writes out/composer-location-chip-<theme>-<phone|desktop>.png
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const harnessDir = import.meta.dir;
const outDir = join(harnessDir, 'out');
const appPackage = resolve(harnessDir, '../../../../../app');

const fail = (message: string): never => {
  process.stderr.write(`❌ ${message}\n`);
  process.exit(1);
};
const run = (command: string, args: readonly string[], cwd: string): void => {
  if (spawnSync(command, args, { cwd, stdio: 'inherit' }).status !== 0) fail(`${command} failed`);
};

const ENTRY = `
import { createRoot } from 'react-dom/client';
import { LocationError } from '@ferretry/app';
import { ShellContext } from '../../../../../../app/src/shell/context.tsx';
import { ACCESS_HOW_TO_ENABLE_LOCATION_HOOK } from '@ferretry/plugin-access/contract';
import { howToEnableLocationHook } from '../../../../../access/app/lib/location-steps-hook.ts';
import { ComposerLocationChip } from '../../../../app/composer/composer-location-chip.tsx';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1';
const win = {
  navigator: { userAgent: IPHONE, maxTouchPoints: 5 },
  isSecureContext: true,
  matchMedia: () => ({ matches: false }),
};
const hook = howToEnableLocationHook(win)();
// A shell that gives app hooks and nothing else, as the app's own test shell does.
const shell = { runtime: { appHook: (_daemon, name) => (name === ACCESS_HOW_TO_ENABLE_LOCATION_HOOK ? hook : undefined), subscribe: () => () => undefined, version: () => 0 } };
const draft = { kind: 'failed', error: new LocationError('denied', 'Location is off for this site.') };

createRoot(document.getElementById('root')).render(
  <ShellContext.Provider value={shell}>
    <main style={{ margin: '0 auto', maxWidth: 560, padding: 16 }}>
      <div data-frame="" className="rounded border border-border-soft bg-surface p-sm">
        <ComposerLocationChip daemon="studio" disabled={false} draft={draft} onPlace={() => {}} onRemove={() => {}} onRetry={() => {}} />
      </div>
    </main>
  </ShellContext.Provider>,
);
window.__ready = true;
`;

const html = (theme: string) => `<!doctype html>
<html lang="en" data-theme="${theme}"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="stylesheet" href="/chip.css" />
<style>html, body { height: auto !important; overflow: visible !important; }</style></head>
<body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/chip-entry.js"></script></body></html>`;

mkdirSync(outDir, { recursive: true });
await Bun.write(join(outDir, 'chip-entry.jsx'), ENTRY);
run('bun', ['build', join(outDir, 'chip-entry.jsx'), '--outdir', outDir, '--target', 'browser'], harnessDir);
run(
  './node_modules/.bin/tailwindcss',
  ['--config', 'tailwind.config.ts', '--input', 'src/styles/index.css', '--output', join(outDir, 'chip.css')],
  appPackage,
);

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/favicon.ico') return new Response(null, { status: 204 });
    if (url.pathname === '/')
      return new Response(html(url.searchParams.get('theme') ?? 'studio-dark'), {
        headers: { 'content-type': 'text/html' },
      });
    if (url.pathname.startsWith('/assets/fonts/')) return new Response(Bun.file(join(appPackage, 'src', url.pathname)));
    return new Response(Bun.file(join(outDir, url.pathname)));
  },
});

const executablePath =
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? fail('no system Chrome or Chromium found');
const browser = await chromium.launch({ executablePath, headless: true });
const SIZES = { phone: { width: 390, height: 500 }, desktop: { width: 900, height: 500 } } as const;
for (const theme of ['studio-light', 'studio-dark']) {
  for (const [name, viewport] of Object.entries(SIZES)) {
    const page = await browser.newPage({ viewport });
    await page.goto(`${server.url}?theme=${theme}`);
    await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true);
    await page.locator('[data-location-draft="failed"]').waitFor({ state: 'visible' });
    await page.evaluate(async () => document.fonts.ready);
    await page.waitForTimeout(300);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 0) fail(`${theme} ${name} scrolls sideways by ${overflow}px`);
    const box = await page.locator('[data-frame]').boundingBox();
    if (box === null) fail('no frame');
    const file = join(outDir, `composer-location-chip-${theme}-${name}.png`);
    await page.screenshot({
      path: file,
      clip: {
        x: Math.max(0, box!.x - 8),
        y: Math.max(0, box!.y - 8),
        width: box!.width + 16,
        height: box!.height + 16,
      },
    });
    process.stdout.write(`📸 ${file}\n`);
    await page.close();
  }
}
await browser.close();
server.stop();
