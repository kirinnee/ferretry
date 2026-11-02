/**
 * Screenshots and checks for the Warden's "A card has nobody working on it" notice: the item open with one card and
 * with three, in the Inbox list (`?from=warden`), and the Close confirm. Phone 390 and desktop 1440, light and dark.
 *
 *   bun harness/orphan-notice-screenshot.ts [outDir]   # writes <outDir>/<state>-<390|1440>-<light|dark>.png
 *
 * It bundles `inbox-page.tsx` (the real `AgendaInboxPage` and `AgendaCardsHost`, invented data and a fake board),
 * serves it, with the app's own fonts, on an ephemeral loopback port and drives it with a real browser. It FAILS (after writing every picture)
 * when a page scrolls sideways, a card line lacks its three buttons, Got it is missing, Close acts before the owner
 * says yes, or the confirm does not offer a reason and Keep it.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out', 'orphan-notice-build');
const outDir = resolve(process.argv[2] ?? '/tmp/claude-1000/shots/b141/g-orphan-notice');

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
  '1440': { viewport: { width: 1_440, height: 900 }, hasTouch: false },
} as const;
type Width = keyof typeof FORMS;
const NOW = new Date('2026-10-29T09:00:00.000Z');
const LOCALE = { timezoneId: 'UTC', locale: 'en-US' } as const;
const THEMES = ['light', 'dark'] as const;

const violations: string[] = [];
const check = (ok: boolean, message: string): void => {
  if (ok) return;
  violations.push(message);
  process.stderr.write(`❌ ${message}\n`);
};

const count = (page: Page, selector: string): Promise<number> => page.locator(selector).count();

interface State {
  readonly name: string;
  readonly view: string;
  readonly cards: number;
  readonly confirm?: true;
  /** The list row: a notice is only a line there, its buttons are on the open item. */
  readonly list?: true;
}

const STATES: readonly State[] = [
  { name: 'one-card-open', view: 'orphan-one', cards: 1 },
  { name: 'three-cards-open', view: 'orphan-three', cards: 3 },
  { name: 'inbox-list', view: 'orphan-list', cards: 0, list: true },
  { name: 'close-confirm', view: 'orphan-one', cards: 1, confirm: true },
  { name: 'three-cards-close-confirm', view: 'orphan-three', cards: 3, confirm: true },
];

const scene = async (width: Width, theme: (typeof THEMES)[number], state: State): Promise<void> => {
  const label = `${state.name} ${width} ${theme}`;
  const context = await browser.newContext({
    ...FORMS[width],
    ...LOCALE,
    colorScheme: theme,
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  page.on('pageerror', error => check(false, `${label}: the page threw: ${error.message}`));
  await page.route('**/*', route =>
    route.request().url().startsWith(server.url.origin) ? route.continue() : route.abort(),
  );
  await page.clock.setFixedTime(NOW);
  await page.goto(`${server.url}?theme=studio-${theme}&view=${state.view}`);
  await page.locator('[data-fixture]').waitFor({ state: 'visible', timeout: 8_000 });
  await page.evaluate(async () => document.fonts.ready.then(() => undefined));
  await page.waitForTimeout(400);
  const loaded = await page.evaluate(() => [...document.fonts].filter(face => face.status === 'loaded').length);
  check(loaded > 0, `${label}: the app's own font did not load`);

  check((await count(page, '[data-agenda-card-row]')) === state.cards, `${label}: expected ${state.cards} card rows`);
  check(
    (await count(page, '[data-agenda-card-open]')) === state.cards &&
      (await count(page, '[data-agenda-card-start]')) === state.cards &&
      (await count(page, '[data-agenda-card-close]')) === state.cards,
    `${label}: every card line needs Open, Start a ferret and Close`,
  );
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('[data-agenda-card-buttons]')].map(row => {
      const tops = [...row.querySelectorAll('button')].map(button => Math.round(button.getBoundingClientRect().top));
      return new Set(tops).size;
    }),
  );
  check(
    rows.every(lines => lines === 1),
    `${label}: a card's buttons wrap onto more than one row`,
  );
  check(
    (await page.getByText('Tap Got it to dismiss this notice').count()) === 0,
    `${label}: the redundant lead is back`,
  );
  if (state.list !== true)
    check((await page.getByRole('button', { name: /Got it/u }).count()) > 0, `${label}: Got it is missing`);
  check((await page.getByText('Nothing to decide').count()) === 0, `${label}: still says "Nothing to decide"`);

  if (state.confirm === true) {
    await page.locator('[data-agenda-card-close]').first().click();
    await page.locator('[data-agenda-card-confirm]').waitFor({ state: 'visible' });
    check(
      (await count(page, '[data-agenda-card-reason]')) === 1 && (await count(page, '[data-agenda-card-keep]')) === 1,
      `${label}: the confirm needs a reason field and Keep it`,
    );
    check((await count(page, '[data-agenda-card-done]')) === 0, `${label}: Close acted before the owner said yes`);
    await page.locator('[data-agenda-card-confirm]').scrollIntoViewIfNeeded();
  } else if (state.list !== true) {
    await page.locator('[data-agenda-cards]').first().scrollIntoViewIfNeeded();
  }

  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(wide <= 0, `${label}: scrolls sideways by ${wide}px`);
  await page.waitForTimeout(150);
  const path = join(outDir, `${state.name}-${width}-${theme}.png`);
  await page.screenshot({ path });
  process.stdout.write(`📸 ${path}\n`);
  await context.close();
};

for (const state of STATES)
  for (const width of Object.keys(FORMS) as Width[]) for (const theme of THEMES) await scene(width, theme, state);

await browser.close();
server.stop(true);
if (violations.length > 0) fail(`${violations.length} check(s) failed`);
process.stdout.write('✅ orphan notice screenshots written\n');
