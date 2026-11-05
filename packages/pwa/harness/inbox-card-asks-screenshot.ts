/**
 * Screenshots for the Inbox of a machine with cards waiting for a try, as the machine's health says it handles them
 * (`inbox-card-asks-page.tsx`, the real hook): the Open view and the Snoozed view of a machine that advertises card asks
 * and of an older one. Phone 390 and desktop 1440, light and dark. The run FAILS (after writing every picture) when a
 * modern machine still lists To test rows, counts them, runs them in "Answer quickly" or lists a snoozed one, when an
 * older machine does not keep all three, or when a page scrolls sideways.
 *
 *   bun harness/inbox-card-asks-screenshot.ts [outDir]
 *   # writes <outDir>/inbox-<modern|older>-<open|snoozed>-<phone|desktop>-<studio-light|studio-dark>.png
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out', 'inbox-card-asks-build');
const outDir = resolve(process.argv[2] ?? '/tmp/claude-1000/shots/f559-pr6');
const fail = (message: string): never => {
  process.stderr.write(`❌ ${message}\n`);
  process.exit(1);
};
const run = (command: string, args: readonly string[]): void => {
  if (spawnSync(command, args, { cwd: packageDir, stdio: 'inherit' }).status !== 0) fail(`${command} failed`);
};

mkdirSync(buildDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
run('bun', ['build', join(harnessDir, 'inbox-card-asks-page.tsx'), '--outdir', buildDir, '--target', 'browser']);
run('./node_modules/.bin/tailwindcss', [
  '--config',
  'tailwind.config.ts',
  '--input',
  'src/styles/index.css',
  '--output',
  join(buildDir, 'app.css'),
]);

const html = (theme: string) => `<!doctype html><html lang="en" data-theme="${theme}"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" /><link rel="stylesheet" href="/app.css" /></head>
<body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/inbox-card-asks-page.js"></script></body></html>`;
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/')
      return new Response(html(url.searchParams.get('theme') ?? 'studio-dark'), {
        headers: { 'content-type': 'text/html' },
      });
    const built = Bun.file(join(buildDir, url.pathname));
    if (await built.exists()) return new Response(built);
    const font = Bun.file(join(packageDir, 'src', url.pathname));
    return new Response((await font.exists()) ? font : Bun.file(join(packageDir, 'public', url.pathname)));
  },
});

const executablePath =
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? Bun.which('chromium-browser') ?? fail('no Chrome');
const browser = await chromium.launch({ executablePath, headless: true });
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } as const;
const DESKTOP = { viewport: { width: 1_440, height: 900 } } as const;
const THEMES = (process.env.FY_SHOT_THEMES ?? 'studio-light,studio-dark').split(',');
const problems: string[] = [];

for (const form of ['phone', 'desktop'] as const) {
  for (const theme of THEMES) {
    for (const machine of ['modern', 'older'] as const) {
      const context = await browser.newContext({
        ...(form === 'phone' ? PHONE : DESKTOP),
        timezoneId: 'UTC',
        locale: 'en-US',
        colorScheme: theme.endsWith('-dark') ? 'dark' : 'light',
      });
      const [family, mode] = [theme.slice(0, theme.lastIndexOf('-')), theme.slice(theme.lastIndexOf('-') + 1)];
      await context.addInitScript(
        ([f, m]) => localStorage.setItem('fy-theme-v1', JSON.stringify({ family: f, mode: m, textScale: 'default' })),
        [family, mode] as const,
      );
      const page = await context.newPage();
      await page.route('**/*', route =>
        route.request().url().startsWith(server.url.origin) ? route.continue() : route.abort(),
      );
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${server.url}?theme=${theme}&machine=${machine}`);
      await page.locator('[data-fixture]').waitFor({ state: 'visible' });
      await page.locator('[data-agenda-filter]').waitFor({ state: 'visible' });
      await page.evaluate(async () => document.fonts.ready.then(() => undefined));
      await page.waitForTimeout(400);
      const where = `${machine} ${form} ${theme}`;
      const older = machine === 'older';

      const toTestRows = await page.locator('[data-to-test]').count();
      const sectionTitle = await page.locator('[data-agenda-section="to-test"]').count();
      const quick = Number((await page.locator('[data-agenda-quick] .fy-inbox-quick__count').textContent()) ?? -1);
      if (older) {
        if (toTestRows !== 2) problems.push(`${where}: ${toTestRows} To test rows, expected 2`);
        if (sectionTitle === 0) problems.push(`${where}: no To test section`);
        if (quick !== 3) problems.push(`${where}: quick run is ${quick}, expected the question and 2 cards`);
      } else {
        if (toTestRows !== 0) problems.push(`${where}: ${toTestRows} To test rows on a card-asks machine`);
        if (sectionTitle !== 0) problems.push(`${where}: a To test section on a card-asks machine`);
        if (quick !== 1) problems.push(`${where}: quick run is ${quick}, expected only the question`);
      }
      const wideOpen = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (wideOpen > 0) problems.push(`${where}: scrolls sideways by ${wideOpen}px`);
      const open = join(outDir, `inbox-${machine}-open-${form}-${theme}.png`);
      await page.screenshot({ path: open });

      await page.locator('[data-agenda-filter] [aria-haspopup="menu"]').click();
      await page.locator('[data-agenda-filter-option="snoozed"]').click();
      await page.waitForTimeout(400);
      const snoozedRows = await page.locator('[data-to-test-snoozed]').count();
      if (snoozedRows !== (older ? 1 : 0))
        problems.push(`${where}: ${snoozedRows} snoozed to-test rows, expected ${older ? 1 : 0}`);
      if (errors.length > 0) problems.push(`${where}: ${errors.join('; ')}`);
      const snoozed = join(outDir, `inbox-${machine}-snoozed-${form}-${theme}.png`);
      await page.screenshot({ path: snoozed });
      process.stdout.write(`📸 ${open}  (To test rows ${toTestRows}, quick ${quick}, snoozed rows ${snoozedRows})\n`);
      await context.close();
    }
  }
}
await browser.close();
server.stop();
if (problems.length > 0) fail(problems.join('\n'));
process.stdout.write('✅ done\n');
