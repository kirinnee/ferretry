/**
 * Screenshots of the "update failed verification" notice and the replaced-checker alarm, at a 390px
 * phone and a desktop width, in the light and dark studio themes. Review evidence for
 * `docs/pwa-release-signing.md`; nothing compares the PNGs.
 *
 *   bun harness/release-notice-screenshot.tsx            # writes harness/out/release-notice-*.png
 *
 * It renders the REAL `ReleaseNoticeBanner` in the same fixed slot `App.tsx` puts it in, above a
 * plain shell, so the capture shows the notice where a reader meets it. Like `screenshot.ts` it
 * drives the system Chrome through playwright-core and aborts every request off the loopback origin.
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

/** The page itself: the shell's fixed notice slot over an empty app surface. */
const PAGE_ENTRY = `
import { createRoot } from 'react-dom/client';
import type { ReleaseNotice } from '../../src/hooks/use-release-integrity.ts';
import { ReleaseNoticeBanner } from '../../src/shell/release-notice.tsx';
const kind = new URLSearchParams(location.search).get('kind');
const notice: ReleaseNotice = kind === 'unsigned-worker'
  ? { kind: 'unsigned-worker' }
  : { kind: 'refused', refusal: 'bad-signature', hadRelease: true };
const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <>
    <div className="fixed inset-x-0 top-[var(--app-top,0px)] z-50">
      <ReleaseNoticeBanner notice={notice} onDismiss={() => undefined} />
    </div>
    <div className="kt-shell flex flex-col bg-bg" />
  </>,
);
`;

const html = (theme: string) => `<!doctype html>
<html lang="en" data-theme="${theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="/app.css" />
  </head>
  <body><div id="root"></div><script type="module" src="/release-notice-entry.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
await Bun.write(join(outDir, 'release-notice-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(outDir, 'release-notice-entry.tsx'), '--outdir', outDir, '--target', 'browser']);
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
        for (const kind of ['refused', 'unsigned-worker'] as const) {
          await page.goto(`${server.url}?theme=studio-${scheme}&kind=${kind}`);
          await page.locator(`[data-release-notice="${kind}"]`).waitFor({ state: 'visible' });
          // A notice wider than a phone would hide its own last words off-screen.
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (overflow > 0) fail(`${kind} at ${viewport.name}/${scheme} scrolls sideways by ${overflow}px`);
          const target = join(outDir, `release-notice-${kind}-${viewport.name}-${scheme}.png`);
          await page.screenshot({ path: target, clip: { x: 0, y: 0, width: viewport.width, height: 240 } });
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
