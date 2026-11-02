/**
 * Screenshots and checks for the KIND CHIP on the Inbox's open cards that `agenda-shapes-screenshot.ts` does not
 * reach: a form (Fill in), an input (Type in), a Test gate and a plan gate (Approve). Phone 390 and desktop 1440,
 * Studio light and dark.
 *
 *   bun harness/agenda-chip-screenshot.ts [outDir]   # writes <outDir>/<state>-<390|1440>-<light|dark>.png
 *
 * It bundles `inbox-page.tsx` (the real `AgendaInboxPage`, invented data) and FAILS (after writing every picture) when
 * a page scrolls sideways or the card's chip does not say the word `AGENDA_KIND_LABELS` / `gateVerb` gives it.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AGENDA_KIND_LABELS, TEST_KIND_LABEL } from '@ferretry/protocol';
import { chromium } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out', 'agenda-chip-build');
const outDir = resolve(process.argv[2] ?? '/tmp/claude-1000/shots/agenda-chip');

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
    if (url.pathname.startsWith('/assets/fonts/')) return new Response(Bun.file(join(packageDir, 'src', url.pathname)));
    const built = Bun.file(join(buildDir, url.pathname));
    return new Response((await built.exists()) ? built : Bun.file(join(packageDir, 'public', url.pathname)));
  },
});

const executablePath =
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? Bun.which('chromium-browser') ?? fail('no Chrome or Chromium');
const browser = await chromium.launch({ executablePath, headless: true });

const FORMS = {
  '390': {
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
    userAgent:
      'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  },
  '1440': { viewport: { width: 1_440, height: 900 } },
} as const;
const NOW = new Date('2026-10-29T09:00:00.000Z');
const THEMES = ['light', 'dark'] as const;

/** Each state: the harness view that opens it and the word its card's chip must say. */
const STATES = [
  { name: 'form', view: 'form', chip: AGENDA_KIND_LABELS.form },
  { name: 'input', view: 'input', chip: AGENDA_KIND_LABELS.input },
  { name: 'gate-test', view: 'gate', chip: TEST_KIND_LABEL },
  { name: 'gate-plan', view: 'gate-plan', chip: AGENDA_KIND_LABELS.permission },
] as const;

const violations: string[] = [];
let checks = 0;
const check = (ok: boolean, message: string): void => {
  checks += 1;
  if (ok) return;
  violations.push(message);
  process.stderr.write(`❌ ${message}\n`);
};

for (const [width, form] of Object.entries(FORMS)) {
  for (const theme of THEMES) {
    for (const state of STATES) {
      const label = `${state.name} ${width} ${theme}`;
      const context = await browser.newContext({
        ...form,
        timezoneId: 'UTC',
        locale: 'en-US',
        colorScheme: theme,
      });
      const page = await context.newPage();
      await page.route('**/*', route =>
        route.request().url().startsWith(server.url.origin) ? route.continue() : route.abort(),
      );
      await page.clock.setFixedTime(NOW);
      await page.goto(`${server.url}?theme=studio-${theme}&view=${state.view}`);
      await page.locator('[data-fixture]').waitFor({ state: 'visible' });
      await page.waitForTimeout(300);
      const found = await page.evaluate(() => ({
        chips: [...document.querySelectorAll('.fy-card__type, [data-card-kind]')].map(
          node => node.textContent?.trim() ?? '',
        ),
        wide: document.documentElement.scrollWidth - window.innerWidth,
      }));
      check(found.wide <= 0, `${label}: scrolls sideways by ${found.wide}px`);
      check(
        found.chips.includes(state.chip),
        `${label}: the chip says ${JSON.stringify(found.chips)}, wanted "${state.chip}"`,
      );
      const path = join(outDir, `${state.name}-${width}-${theme}.png`);
      await page.screenshot({ path });
      process.stdout.write(`📸 ${path}\n`);
      await context.close();
    }
  }
}

await browser.close();
server.stop(true);
if (violations.length > 0) fail(`${violations.length} of ${checks} checks failed`);
process.stdout.write(`✅ ${checks} checks passed\n`);
