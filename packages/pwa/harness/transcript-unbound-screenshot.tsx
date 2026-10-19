/**
 * Screenshots of a session whose transcript the daemon cannot prove is its own: the workspace
 * notice with its two remedies, and the owner's message that can never be confirmed, which offers
 * no "send again". Desktop 1440 and phone 390, light and dark studio themes. Review evidence only;
 * nothing compares the PNGs.
 *
 *   bun harness/transcript-unbound-screenshot.tsx   # writes harness/out/transcript-unbound-*.png
 *
 * It renders the REAL `TranscriptUnboundNotice` and `LedgerMessage`, with the Restart disclosure
 * open so its consequence is in the capture.
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
import { LedgerMessage } from '../../src/components/ledger-message.tsx';
import { TranscriptUnboundNotice } from '../../src/components/transcript-unbound-notice.tsx';

const hello = {
  sendId: 'send-1',
  acceptedAt: '2026-10-19T07:12:00.000Z',
  message: 'hello',
  attachmentIds: [],
  fate: 'unaccounted',
  unaccountedReason: 'transcript_unbound',
} as const;

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <main data-unbound-scene="" style={{ margin: '0 auto', maxWidth: 720, padding: '12px 0' }}>
    <TranscriptUnboundNotice onCheckAgain={() => undefined} onRestart={async () => undefined} />
    <div className="fy-transcript-shell" style={{ height: 'auto', overflow: 'visible', padding: '12px 16px' }}>
      <div className="fy-transcript-content">
        <LedgerMessage record={hello} onRetry={async () => true} />
      </div>
    </div>
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
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/transcript-unbound-entry.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
await Bun.write(join(outDir, 'transcript-unbound-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(outDir, 'transcript-unbound-entry.tsx'), '--outdir', outDir, '--target', 'browser']);
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
    if (url.pathname === '/')
      return new Response(html(url.searchParams.get('theme') ?? 'studio-dark'), {
        headers: { 'content-type': 'text/html' },
      });
    return new Response(Bun.file(join(outDir, url.pathname)));
  },
});

const executablePath =
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? fail('no system Chrome or Chromium found');
const browser = await chromium.launch({ executablePath, headless: true });
const VIEWPORTS = [
  { name: 'desktop', viewport: { width: 1440, height: 900 }, mobile: false },
  { name: 'phone', viewport: { width: 390, height: 844 }, mobile: true },
] as const;

try {
  for (const scheme of ['light', 'dark'] as const) {
    for (const { name, viewport, mobile } of VIEWPORTS) {
      const context = await browser.newContext({
        viewport,
        deviceScaleFactor: 2,
        isMobile: mobile,
        hasTouch: mobile,
        colorScheme: scheme,
        reducedMotion: 'reduce',
      });
      try {
        await context.route('**/*', async route =>
          new URL(route.request().url()).origin !== server.url.origin ? await route.abort() : await route.continue(),
        );
        const page = await context.newPage();
        await page.goto(`${server.url}?theme=studio-${scheme}`);
        await page.locator('[data-unbound-scene]').waitFor({ state: 'visible' });
        await page.evaluate(() => {
          for (const details of document.querySelectorAll('details')) details.open = true;
        });
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (overflow > 0) fail(`${name} ${scheme} scrolls sideways by ${overflow}px`);
        const target = join(outDir, `transcript-unbound-${name}-${scheme}.png`);
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
