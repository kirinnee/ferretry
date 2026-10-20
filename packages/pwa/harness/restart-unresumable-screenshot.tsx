/**
 * Screenshots of a Restart the daemon paused because the conversation could not go with it — "Start
 * fresh" is the only way past — at a 390px phone and a desktop width, in the light and dark studio
 * themes. Review evidence; nothing compares the PNGs.
 *
 *   bun harness/restart-unresumable-screenshot.tsx      # writes harness/out/restart-unresumable-*.png
 *
 * It renders the REAL `RestartUnresumablePanel` with the daemon's own sentence. Like `screenshot.ts`
 * it drives the system Chrome through playwright-core and aborts every request off the loopback origin.
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

/** The page: the paused Restart, as Actions › Restart CLI shows it. */
const PAGE_ENTRY = `
import { createRoot } from 'react-dom/client';
import { RestartUnresumablePanel } from '../../src/features/session-actions/restart-refusal.tsx';
const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <div className="kt-shell flex flex-col bg-bg p-4" style={{ maxWidth: 560, margin: '0 auto' }}>
    <RestartUnresumablePanel
      busy={false}
      failure={null}
      onCancel={() => undefined}
      onRestartAnyway={() => undefined}
      reason={"Ferretry hasn't matched this session to its conversation yet, so it can't tell which one to resume. Nothing was restarted. Choose \\"Start fresh\\" to restart with a new conversation instead."}
    />
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
  <body class="bg-bg"><div id="root"></div><script type="module" src="/restart-unresumable-entry.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
await Bun.write(join(outDir, 'restart-unresumable-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(outDir, 'restart-unresumable-entry.tsx'), '--outdir', outDir, '--target', 'browser']);
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

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'desktop', width: 1_440, height: 900 },
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
      });
      try {
        await context.route('**/*', async route => {
          if (new URL(route.request().url()).origin !== server.url.origin) return await route.abort();
          return await route.continue();
        });
        const page = await context.newPage();
        await page.goto(`${server.url}?theme=studio-${scheme}`);
        await page.locator('[data-restart-unresumable]').waitFor({ state: 'visible' });
        // The panel is fixed to the bottom of the viewport, so the whole viewport is captured.
        // A panel wider than a phone would hide its own buttons off-screen.
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (overflow > 0) fail(`${viewport.name}/${scheme} scrolls sideways by ${overflow}px`);
        const target = join(outDir, `restart-unresumable-${viewport.name}-${scheme}.png`);
        await page.screenshot({ path: target });
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
