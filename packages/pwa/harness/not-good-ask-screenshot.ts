/**
 * Screenshots and checks for the "Not good" box under a QUESTION item that carries a card ask: the box names the CARD
 * being tried ("Pairing a second phone (&F61)"), once, never the agenda's own question. Phone 390 and desktop 1440,
 * Studio light and dark.
 *
 *   bun harness/not-good-ask-screenshot.ts [outDir]   # writes <outDir>/inbox-ask-not-good-box-<phone|desktop>-<theme>.png
 *
 * It bundles `inbox-page.tsx` (the real `AgendaInboxPage`, invented data, `?view=ask-gate`), serves it on an ephemeral
 * loopback port, and FAILS (after writing every picture) when the box's heading is not exactly
 * "Not good: what went wrong with Pairing a second phone (&F61)?" or a page scrolls sideways.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out', 'not-good-ask-build');
const outDir = resolve(process.argv[2] ?? '/tmp/claude-1000/shots/not-good-ask');
const HEADING = 'Not good: what went wrong with Pairing a second phone (&F61)?';

const fail = (message: string): never => {
  process.stderr.write(`❌ ${message}\n`);
  process.exit(1);
};

const run = (command: string, args: readonly string[]): void => {
  const result = spawnSync(command, args, { cwd: packageDir, stdio: 'inherit' });
  if (result.status !== 0) fail(`${command} exited ${result.status}`);
};

const html = (theme: string) => `<!doctype html>
<html lang="en" data-theme="${theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <link rel="stylesheet" href="/app.css" />
  </head>
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/inbox-page.js"></script></body>
</html>`;

mkdirSync(buildDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
run('bun', ['build', join(harnessDir, 'inbox-page.tsx'), '--outdir', buildDir, '--target', 'browser']);
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
    if (url.pathname === '/')
      return new Response(html(url.searchParams.get('theme') ?? 'studio-dark'), {
        headers: { 'content-type': 'text/html' },
      });
    // The stylesheet names its fonts relative to src/styles: serve them so the pictures use the app's own typefaces.
    if (url.pathname.startsWith('/assets/fonts/')) return new Response(Bun.file(join(packageDir, 'src', url.pathname)));
    const built = Bun.file(join(buildDir, url.pathname));
    return new Response((await built.exists()) ? built : Bun.file(join(packageDir, 'public', url.pathname)));
  },
});

const executablePath =
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? Bun.which('chromium-browser') ?? fail('no Chrome or Chromium');
const browser = await chromium.launch({ executablePath, headless: true });

const FORMS = {
  phone: {
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
    userAgent:
      'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  },
  desktop: { viewport: { width: 1_440, height: 900 } },
} as const;
const NOW = new Date('2026-10-29T09:00:00.000Z');
const LOCALE = { timezoneId: 'UTC', locale: 'en-US' } as const;

const violations: string[] = [];
let checks = 0;
const check = (ok: boolean, message: string): void => {
  checks += 1;
  if (ok) return;
  violations.push(message);
  process.stderr.write(`❌ ${message}\n`);
};

for (const form of ['phone', 'desktop'] as const) {
  for (const theme of ['studio-light', 'studio-dark']) {
    const mode = theme.endsWith('-dark') ? 'dark' : 'light';
    const context = await browser.newContext({ ...FORMS[form], ...LOCALE, colorScheme: mode });
    await context.addInitScript(
      ([family, tone]) =>
        localStorage.setItem('fy-theme-v1', JSON.stringify({ family, mode: tone, textScale: 'default' })),
      [theme.slice(0, theme.lastIndexOf('-')), mode] as const,
    );
    const page = await context.newPage();
    await page.route('**/*', route =>
      route.request().url().startsWith(server.url.origin) ? route.continue() : route.abort(),
    );
    await page.clock.setFixedTime(NOW);
    await page.goto(`${server.url}?theme=${theme}&view=ask-gate&voice=1`);
    await page.locator('[data-fixture]').waitFor({ state: 'visible' });
    const attached = page.locator('[data-agenda-attached-gate="F61"]');
    await attached.waitFor({ state: 'visible' });
    await page.evaluate(async () => document.fonts.ready);
    await page.waitForTimeout(250);
    await attached.locator('[data-agenda-option="Not good"]').click();
    const why = page.locator('[data-inbox-gate-why]');
    await why.waitFor({ state: 'visible' });
    await page.evaluate(async () => document.fonts.ready);
    await page.waitForTimeout(300);
    const label = `${form} ${theme}`;
    const heading = (await why.locator('[data-board-send-back]').innerText()).split('\n')[0]?.trim() ?? '';
    check(heading === HEADING, `${label}: the box reads "${heading}", not "${HEADING}"`);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(wide <= 0, `${label}: scrolls sideways by ${wide}px`);
    await why.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(outDir, `inbox-ask-not-good-box-${form}-${theme}.png`) });
    process.stdout.write(`ℹ️  ${label}: "${heading}"\n`);
    await context.close();
  }
}

await browser.close();
server.stop();
if (violations.length > 0) fail(`${violations.length} of ${checks} checks failed`);
process.stdout.write(`✅ ${checks} checks passed\n`);
