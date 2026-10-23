/**
 * Screenshots of Settings › Open links in, with a daemon on this computer connected directly, so the third
 * choice "Your computer's default browser" is offered. Two scenes (this computer, and a remote-only device
 * where the choice is not offered), at phone (390) and desktop (1440) in the light and dark studio themes.
 *
 *   bun harness/open-links-in-screenshot.tsx   # writes harness/out/open-links-<scene>-<viewport>-<scheme>.png
 *
 * It renders the REAL `OpenLinksInSetting` — no network, no daemon. Review evidence; nothing compares the PNGs.
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
import { OpenLinksInSetting } from '../../src/features/settings/conversation-settings.tsx';

function Scene({ computerAvailable, initial }) {
  const [value, setValue] = useState(initial);
  return (
    <section className="kt-panel p-panel">
      <h3 className="m-0 mb-3 text-row font-semibold text-fg">Open links in</h3>
      <OpenLinksInSetting openLinksIn={value} onChange={setValue} computerAvailable={computerAvailable} />
    </section>
  );
}

createRoot(document.getElementById('root')).render(
  <main style={{ margin: '0 auto', maxWidth: 760, padding: 16, display: 'flex', flexDirection: 'column', gap: 24 }}>
    <div data-scene="local"><Scene computerAvailable initial="computer" /></div>
    <div data-scene="remote"><Scene computerAvailable={false} initial="browser" /></div>
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
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/open-links-entry.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
await Bun.write(join(outDir, 'open-links-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(outDir, 'open-links-entry.tsx'), '--outdir', outDir, '--target', 'browser']);
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
        await page
          .locator('[data-scene="local"] fieldset, [data-scene="local"] [role="radiogroup"]')
          .first()
          .waitFor({ state: 'visible' });
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (overflow > 0) fail(`${scheme} ${viewport.name} scrolls sideways by ${overflow}px`);
        for (const name of ['local', 'remote'] as const) {
          const target = join(outDir, `open-links-${name}-${viewport.name}-${scheme}.png`);
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
