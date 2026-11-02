/**
 * Screenshots for the Inbox over a machine that rolls up every conversation's items (`inbox-rollup-page.tsx`):
 * Snoozed and the filter menu with 44 conversations' worth of items. Phone 390 and desktop 1440, light and dark. The run
 * fails if the Snoozed badge, the header and the rows listed are not one number, if the "most recent conversations"
 * caveat shows, if a row names a sub-ferret instead of the owner's thread, or if a page scrolls sideways.
 *
 *   bun harness/inbox-rollup-screenshot.ts [outDir]   # writes <outDir>/inbox-counts-<snoozed|menu>-<phone|desktop>-<theme>.png
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out', 'inbox-rollup-build');
const outDir = resolve(process.argv[2] ?? '/tmp/claude-1000/shots/f439-inbox-counts');
const fail = (message: string): never => {
  process.stderr.write(`❌ ${message}\n`);
  process.exit(1);
};
const run = (command: string, args: readonly string[]): void => {
  if (spawnSync(command, args, { cwd: packageDir, stdio: 'inherit' }).status !== 0) fail(`${command} failed`);
};

mkdirSync(buildDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
run('bun', ['build', join(harnessDir, 'inbox-rollup-page.tsx'), '--outdir', buildDir, '--target', 'browser']);
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
<body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/inbox-rollup-page.js"></script></body></html>`;
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/')
      return new Response(html(url.searchParams.get('theme') ?? 'studio-dark'), {
        headers: { 'content-type': 'text/html' },
      });
    // The app's own self-hosted fonts: `theme-fonts.css` names them `../assets/fonts/…`, which lands on `/assets/fonts/…` here.
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
const OWNER_FERRETS = ['Ada', 'Khristina', 'Hadi', 'Kai', 'Zoe', 'Judson'];
const SUB_FERRET = /\b(Vena|Moe|Tarn|Pike|Oro|Lux|Bram|Sefa)\d/u;
const EXPECTED = 44;
const problems: string[] = [];

for (const form of ['phone', 'desktop'] as const) {
  for (const theme of THEMES) {
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
    await page.goto(`${server.url}?theme=${theme}`);
    await page.locator('[data-fixture]').waitFor({ state: 'visible' });
    const where = `${form} ${theme}`;
    // The shot is in the app's font or it is not a shot: wait for the faces to load and fail if the body's did not.
    await page.evaluate(async () => document.fonts.ready.then(() => undefined));
    const loadedFaces = await page.evaluate(() =>
      [...document.fonts].filter(face => face.status === 'loaded').map(face => face.family),
    );
    const bodyFamily = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
    const stack = bodyFamily.split(',').map(name => name.replaceAll(/["']/gu, '').trim());
    if (!loadedFaces.some(family => stack.includes(family.replaceAll(/["']/gu, ''))))
      problems.push(
        `${where}: none of the app's fonts (${stack.join(', ')}) loaded (loaded: ${loadedFaces.join(', ') || 'none'})`,
      );
    const trigger = page.locator('[data-agenda-filter] [aria-haspopup="menu"]');
    // The menu first: every badge is a length.
    await trigger.click();
    const snoozedOption = page.locator('[data-agenda-filter-option="snoozed"]');
    await snoozedOption.waitFor({ state: 'visible' });
    await page
      .waitForFunction(
        expected =>
          document.querySelector('[data-agenda-filter-option="snoozed"]')?.textContent === `Snoozed (${expected})`,
        EXPECTED - 4,
        { timeout: 10_000 },
      )
      .catch(() => undefined);
    const menuText = (await snoozedOption.textContent()) ?? '';
    const repliedText = (await page.locator('[data-agenda-filter-option="replied"]').textContent()) ?? '';
    await page.screenshot({ path: join(outDir, `inbox-counts-menu-${form}-${theme}.png`) });
    await snoozedOption.click();
    await page.locator('[data-agenda-parked-pane="snoozed"]').waitFor({ state: 'visible' });
    await page.waitForTimeout(500);
    const rows = await page.locator('[data-agenda-parked]').count();
    const snoozedCount = Number(/\((\d+)\)/u.exec(menuText)?.[1] ?? -1);
    const repliedCount = Number(/\((\d+)\)/u.exec(repliedText)?.[1] ?? -1);
    const header = (await trigger.textContent()) ?? '';
    if (snoozedCount + repliedCount !== EXPECTED)
      problems.push(`${where}: ${snoozedCount} snoozed + ${repliedCount} replied is not ${EXPECTED}`);
    if (rows !== snoozedCount) problems.push(`${where}: badge ${snoozedCount} but ${rows} rows listed`);
    if (header !== `Snoozed (${snoozedCount})`)
      problems.push(`${where}: header says "${header}" not Snoozed (${snoozedCount})`);
    const body = (await page.locator('[data-agenda-parked-pane="snoozed"]').textContent()) ?? '';
    if (body.includes('most recent conversations')) problems.push(`${where}: still shows the 30 most recent caveat`);
    if (!OWNER_FERRETS.some(name => body.includes(name))) problems.push(`${where}: no row names an owner thread`);
    if (SUB_FERRET.test(body)) problems.push(`${where}: a row names a sub-ferret, not its owner's thread`);
    if (errors.length > 0) problems.push(`${where}: ${errors.join('; ')}`);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (wide > 0) problems.push(`${where}: scrolls sideways by ${wide}px`);
    const path = join(outDir, `inbox-counts-snoozed-${form}-${theme}.png`);
    await page.screenshot({ path });
    process.stdout.write(`📸 ${path}  (badge ${snoozedCount}, rows ${rows}, header "${header}")\n`);
    await context.close();
  }
}
await browser.close();
server.stop();
if (problems.length > 0) fail(problems.join('\n'));
process.stdout.write('✅ done\n');
