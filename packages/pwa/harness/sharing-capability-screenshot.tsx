/**
 * Screenshots of the eighth capability row, `sharing`, in Settings › "What this browser may do here"
 * (docs/grants.md, capability eight): the list with the Sharing row, at a 390px phone and a 1440px
 * desktop, light and dark. Review evidence; nothing compares the PNGs.
 *
 *   bun harness/sharing-capability-screenshot.tsx [out-dir]   # writes sharing-capability-<viewport>-<scheme>.png (default harness/out)
 *
 * It renders the REAL `CapabilityList` over every capability the protocol declares, all granted. Like
 * `device-permissions-screenshot.tsx` it drives the system Chrome through playwright-core, aborts every
 * request off the loopback origin, and asserts every width fits without sideways scroll.
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
import { DAEMON_CAPABILITIES } from '@ferretry/protocol';
import { CapabilityList } from '../../src/features/settings/capability-list.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';

const connection = daemonConnection({ daemonId: 'harness', baseUrl: 'https://harness.example.test', deviceId: 'token' });
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
    <div className="flex w-full max-w-xl flex-col gap-panel" data-shot="list">
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
  <body><div id="root"></div><script type="module" src="/sharing-capability-entry.js"></script></body>
</html>`;

mkdirSync(buildDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
await Bun.write(join(buildDir, 'sharing-capability-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(buildDir, 'sharing-capability-entry.tsx'), '--outdir', buildDir, '--target', 'browser']);
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
      });
      try {
        await context.route('**/*', async route => {
          if (new URL(route.request().url()).origin !== server.url.origin) return await route.abort();
          return await route.continue();
        });
        const page = await context.newPage();
        await page.goto(`${server.url}?theme=studio-${scheme}`);
        const where = `${viewport.name}/${scheme}`;
        await page.locator('[data-capability-row="sharing"]').waitFor({ state: 'visible' });
        const rows = await page.locator('[data-capability-row]').count();
        if (rows !== 8) fail(`${where}: expected 8 capability rows, saw ${rows}`);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (overflow > 0) fail(`${where} scrolls sideways by ${overflow}px`);
        const target = join(outDir, `sharing-capability-${viewport.name}-${scheme}.png`);
        await page.locator('[data-shot="list"]').screenshot({ path: target });
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
