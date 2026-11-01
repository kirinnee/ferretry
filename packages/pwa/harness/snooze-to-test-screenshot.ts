/**
 * Screenshots and checks for snoozing a card waiting for the owner's try: the clock on each row, its menu open (and the
 * Custom… form), and the Snoozed list that holds a parked card with when it wakes and an Unsnooze button. Phone 390 and
 * desktop 1440, Studio and Neo light and dark (set `FY_SHOT_THEMES`).
 *
 *   bun harness/snooze-to-test-screenshot.ts [outDir] [series]   # writes <outDir>/<series>-<name>-<phone|desktop>-<theme>.png
 *
 * It bundles `inbox-page.tsx` (the real `AgendaInboxPage`, invented data, `?view=to-test&snoozed=1`) and FAILS (after
 * writing every picture) when: a page scrolls sideways; the menu is cut off by the row or the screen; the choices are not
 * the agenda's; 1 hour does not send a snooze one hour on; the parked card is still in To test, or missing from Snoozed,
 * or not counted there; or Unsnooze does not send a wake.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out', 'snooze-to-test-build');
const outDir = resolve(process.argv[2] ?? '/tmp/claude-1000/shots/snooze-to-test');
const series = process.argv[3] ?? 'snooze-to-test';

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
    const built = Bun.file(join(buildDir, url.pathname));
    return new Response((await built.exists()) ? built : Bun.file(join(packageDir, 'public', url.pathname)));
  },
});

const executablePath =
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? Bun.which('chromium-browser') ?? fail('no Chrome or Chromium');
const browser = await chromium.launch({ executablePath, headless: true });

const PHONE = {
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
  userAgent:
    'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
} as const;
// A touch laptop: the swipe is touch only, so the desktop picture of it needs a touch screen to be held.
const DESKTOP = { viewport: { width: 1_440, height: 900 }, hasTouch: true } as const;
const NOW = new Date('2026-10-29T09:00:00.000Z');
const LOCALE = { timezoneId: 'UTC', locale: 'en-US' } as const;
const THEMES = (process.env.FY_SHOT_THEMES ?? 'studio-light,studio-dark').split(',');
type Form = 'phone' | 'desktop';

const violations: string[] = [];
let checks = 0;
const check = (ok: boolean, message: string): void => {
  checks += 1;
  if (ok) return;
  violations.push(message);
  process.stderr.write(`❌ ${message}\n`);
};

const open = async (context: { newPage: () => Promise<Page> }, theme: string): Promise<Page> => {
  const page = await context.newPage();
  await page.route('**/*', route =>
    route.request().url().startsWith(server.url.origin) ? route.continue() : route.abort(),
  );
  await page.clock.setFixedTime(NOW);
  await page.goto(`${server.url}?theme=${theme}&view=to-test&snoozed=1`);
  await page.locator('[data-fixture]').waitFor({ state: 'visible' });
  await page.locator('[data-to-test]').first().waitFor({ state: 'visible' });
  await page.waitForTimeout(250);
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(wide <= 0, `to-test: scrolls sideways by ${wide}px`);
  return page;
};

const backgroundLightness = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const paint = (element: Element): string => getComputedStyle(element).backgroundColor;
    const colour = [document.body, document.documentElement]
      .map(paint)
      .find(value => !/rgba\(0, 0, 0, 0\)|transparent/u.test(value));
    const [r = 255, g = 255, b = 255] = (colour ?? 'rgb(255,255,255)').match(/\d+(\.\d+)?/gu)?.map(Number) ?? [];
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  });

const shot = async (page: Page, name: string, form: Form, theme: string): Promise<void> => {
  await page.waitForTimeout(120);
  const light = await backgroundLightness(page);
  check(
    theme.endsWith('-dark') ? light < 0.35 : light > 0.65,
    `${name} ${form} ${theme}: the page is not ${theme.endsWith('-dark') ? 'dark' : 'light'} (lightness ${light.toFixed(2)})`,
  );
  const path = join(outDir, `${series}-${name}-${form}-${theme}.png`);
  await page.screenshot({ path });
  process.stdout.write(`📸 ${path}\n`);
};

const wakes = (page: Page) =>
  page.evaluate(() => (window as unknown as { __snoozes?: { id: string; until: string | null }[] }).__snoozes ?? []);

for (const form of ['phone', 'desktop'] as const) {
  for (const theme of THEMES) {
    const context = await browser.newContext({
      ...(form === 'phone' ? PHONE : DESKTOP),
      ...LOCALE,
      colorScheme: theme.endsWith('-dark') ? 'dark' : 'light',
    });
    await context.addInitScript(
      ([family, mode]) => localStorage.setItem('fy-theme-v1', JSON.stringify({ family, mode, textScale: 'default' })),
      [theme.slice(0, theme.lastIndexOf('-')), theme.slice(theme.lastIndexOf('-') + 1)] as const,
    );
    const page = await open(context, theme);
    const tag = `${form} ${theme}`;

    check(
      (await page.locator('[data-to-test]').count()) === 2,
      `${tag}: To test does not hold exactly the two awake cards`,
    );
    check((await page.locator('[data-to-test="F70"]').count()) === 0, `${tag}: the snoozed card is still in To test`);
    const filter = page.locator('[data-agenda-filter-option="snoozed"]');
    const counted = (await filter.textContent()) ?? '';
    check(/\(\d+\)/u.test(counted) && counted.includes('('), `${tag}: the Snoozed filter shows no count (${counted})`);

    // The menu, opened from the first row.
    const row = page.locator('[data-to-test]').first();
    await row.scrollIntoViewIfNeeded();
    const clock = row.locator('[data-agenda-snooze]');
    check((await clock.count()) === 1, `${tag}: the row has no clock`);
    await clock.click();
    const menu = page.locator('.fy-snooze__popover');
    await menu.waitFor({ state: 'visible' });
    const labels = await page.locator('[role="menuitem"]').allTextContents();
    check(
      JSON.stringify(labels) === JSON.stringify(['1 hour', '4 hours', 'Tomorrow 9:00', 'Custom…']),
      `${tag}: the choices are ${JSON.stringify(labels)}`,
    );
    const seen = async (): Promise<boolean> =>
      menu.evaluate(popover => {
        const box = popover.getBoundingClientRect();
        const inside = box.top >= 0 && box.left >= 0 && box.bottom <= innerHeight && box.right <= innerWidth;
        const probes = [popover.firstElementChild, popover.querySelector('[role="menuitem"]:last-of-type')];
        const reachable = probes.every(node => {
          if (node === null || node === undefined) return false;
          const at = node.getBoundingClientRect();
          const top = document.elementFromPoint(at.left + at.width / 2, at.top + at.height / 2);
          return top !== null && popover.contains(top);
        });
        return inside && reachable;
      });
    check(await seen(), `${tag}: the menu is cut off or covered`);
    await shot(page, 'menu', form, theme);
    await page.locator('[role="menuitem"]', { hasText: 'Custom' }).click();
    await page.locator('[data-snooze-custom]').waitFor({ state: 'visible' });
    check(await seen(), `${tag}: the Custom… form is cut off or covered`);
    await shot(page, 'menu-custom', form, theme);
    await page.locator('[role="menuitem"]', { hasText: '1 hour' }).click();
    await page.waitForTimeout(250);
    const sent = await wakes(page);
    check(
      sent.length === 1 && sent[0]?.until === new Date(NOW.getTime() + 3_600_000).toISOString(),
      `${tag}: 1 hour sent ${JSON.stringify(sent)}`,
    );

    // The Snoozed list.
    await filter.click();
    const parked = page.locator('[data-to-test-snoozed]').first();
    await parked.waitFor({ state: 'visible' });
    check(
      ((await parked.locator('[data-to-test-snoozed-title]').textContent()) ?? '').includes('Offline banner wording'),
      `${tag}: Snoozed lacks the parked card`,
    );
    const when = (await parked.locator('[data-to-test-wakes]').textContent()) ?? '';
    check(when === 'Snoozed until 14:00', `${tag}: the parked card says "${when}"`);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(wide <= 0, `${tag}: Snoozed scrolls sideways by ${wide}px`);
    await shot(page, 'snoozed', form, theme);
    await parked.locator('[data-to-test-unsnooze]').click();
    await page.waitForTimeout(250);
    const after = await wakes(page);
    check(after.length === 2 && after[1]?.until === null, `${tag}: Unsnooze sent ${JSON.stringify(after)}`);
    await context.close();
  }
}

await browser.close();
server.stop();
if (violations.length > 0) fail(`${violations.length} of ${checks} checks failed`);
process.stdout.write(`✅ ${checks} checks passed\n`);
