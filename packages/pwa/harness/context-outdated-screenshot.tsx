/**
 * Screenshots of the two things this change says in words: the Context rail on a machine whose daemon
 * predates the MCP route ("needs an update", not an error), and a composer whose attached file did not
 * upload ("not sent yet", not a message that leaves without it). Desktop 1440 and phone 390, light and dark.
 * Review evidence; nothing compares the PNGs.
 *
 *   bun harness/context-outdated-screenshot.tsx   # writes harness/out/context-outdated-*.png
 *
 * Renders the REAL `ContextFailure` and the REAL `Composer` (with an uploader that always fails).
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
import { ContextFailure } from '../../src/features/context-rail/context-rail-parts.tsx';
import { Composer } from '../../src/components/composer.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { DaemonDraftStore } from '../../src/lib/drafts.ts';
import { writeMdComposePref } from '../../src/lib/md-compose.ts';

writeMdComposePref('off');

const daemon = daemonConnection({ daemonId: 'shot', baseUrl: 'https://shot.example.test', deviceId: 'device' });
const storage = { getItem: () => null, setItem: () => {} };
const noop = () => {};

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <main style={{ margin: '0 auto', maxWidth: 560, padding: '12px 16px', display: 'grid', gap: 24 }}>
    <section data-shot="outdated">
      <ContextFailure
        machineName="Liftoff MBP"
        what="read this ferret’s MCP servers"
        reason="unknown route"
        outdated={{ daemonVersion: '4.81.0' }}
        showing="MCP"
        onRetry={noop}
      />
    </section>
    <section data-shot="failed">
      <ContextFailure
        machineName="Liftoff MBP"
        what="read this ferret’s MCP servers"
        reason="the daemon failed to handle this request"
        onRetry={noop}
      />
    </section>
    <section data-shot="composer">
      <Composer
        api={{ send: async () => ({}) as never }}
        daemon={daemon}
        draftStore={new DaemonDraftStore(storage)}
        sessionId="shot"
        uploadAttachment={async () => { throw new Error('relay closed'); }}
      />
    </section>
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
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/context-outdated-entry.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
await Bun.write(join(outDir, 'context-outdated-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(outDir, 'context-outdated-entry.tsx'), '--outdir', outDir, '--target', 'browser']);
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
  { name: 'desktop', width: 1440, height: 900, mobile: false },
  { name: 'phone', width: 390, height: 844, mobile: true },
] as const;

try {
  for (const viewport of VIEWPORTS) {
    for (const scheme of ['light', 'dark'] as const) {
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
        await page.locator('[data-context-outdated]').waitFor({ state: 'visible' });
        await page.locator('input[type="file"]:not([accept])').setInputFiles({
          name: 'screenshot.png',
          mimeType: 'image/png',
          buffer: Buffer.from('not really a png'),
        });
        await page.locator('textarea').first().fill('see the attached');
        await page.locator('[data-composer-attachments-hold]').waitFor({ state: 'visible' });
        const text = await page.locator('[data-composer-attachments-hold]').textContent();
        if (!text?.includes('did not upload')) fail(`composer hold reads ${JSON.stringify(text)}`);
        if (!(await page.locator('[data-composer-send]').isDisabled())) fail('Send is not held');
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (overflow > 0) fail(`${viewport.name} ${scheme} scrolls sideways by ${overflow}px`);
        const target = join(outDir, `context-outdated-${viewport.name}-${scheme}.png`);
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
