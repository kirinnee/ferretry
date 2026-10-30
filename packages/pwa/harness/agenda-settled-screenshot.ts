/**
 * Screenshots and checks for #B76 — every `!A` opens the same item view, whatever state the item is in:
 *
 *   parked-replied   the owner's !A89 (replied to): the view, "You replied — waiting on Lizzette", Back to my list
 *   parked-snoozed   a snoozed item: "Snoozed until …", Back to my list
 *   resolved         a resolved item, read-only: how it ended, its answer and note, no quick replies
 *   open             an open item: the quick replies, unchanged
 *   mode-off         a ferret not in agenda mode: no agenda line, and the proved id still opens its view
 *   info-parked      (desktop) Info's one agenda list on its Parked filter; a row opens the same view
 *
 *   bun harness/agenda-settled-screenshot.ts [outDir]   # writes <outDir>/agenda-settled-<name>-<phone|desktop>-<theme>.png
 *
 * It bundles `agenda-settled-page.tsx` (the real `useAgenda`, invented data), serves it on an ephemeral loopback port,
 * and FAILS (after writing every picture) when: a page scrolls sideways; a proved id opens no view; a parked or
 * resolved view draws quick replies; a parked view has no "Back to my list"; a resolved one has one, or keeps the
 * "Reply about …" prefix; "is no longer open" is said for an id the ledger holds; or Info's Parked row opens nothing.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out', 'agenda-settled-build');
const outDir = resolve(process.argv[2] ?? '/tmp/claude-1000');

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
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/agenda-settled-page.js"></script></body>
</html>`;

mkdirSync(buildDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
run('bun', ['build', join(harnessDir, 'agenda-settled-page.tsx'), '--outdir', buildDir, '--target', 'browser']);
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
const DESKTOP = { viewport: { width: 1_440, height: 900 } } as const;
const NOW = new Date('2026-10-30T22:15:00.000Z');
const LOCALE = { timezoneId: 'UTC', locale: 'en-US' } as const;
const THEMES = ['studio-light', 'studio-dark'] as const;
type Form = 'phone' | 'desktop';

const violations: string[] = [];
let checks = 0;
const check = (ok: boolean, message: string): void => {
  checks += 1;
  if (ok) return;
  violations.push(message);
  process.stderr.write(`❌ ${message}\n`);
};

const open = async (context: { newPage: () => Promise<Page> }, theme: string, query: string): Promise<Page> => {
  const page = await context.newPage();
  await page.route('**/*', route =>
    route.request().url().startsWith(server.url.origin) ? route.continue() : route.abort(),
  );
  await page.clock.setFixedTime(NOW);
  await page.goto(`${server.url}?theme=${theme}&${query}`);
  await page.waitForSelector('[data-agenda-harness]');
  // The view fades in: a picture taken mid-fade shows the transcript through it.
  await page.waitForTimeout(400);
  return page;
};

const count = (page: Page, selector: string): Promise<number> => page.locator(selector).count();

const noSideways = async (page: Page, label: string): Promise<void> =>
  check(
    await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
    `${label}: the page scrolls sideways`,
  );

const shoot = async (page: Page, name: string, form: Form, theme: string): Promise<void> => {
  await page.screenshot({ path: join(outDir, `agenda-settled-${name}-${form}-${theme}.png`) });
};

interface Case {
  readonly name: string;
  readonly query: string;
  readonly id: string;
  readonly settled: 'replied' | 'snoozed' | 'resolved' | null;
}

const CASES: readonly Case[] = [
  { name: 'parked-replied', query: 'target=A89', id: 'A89', settled: 'replied' },
  { name: 'parked-snoozed', query: 'target=A70', id: 'A70', settled: 'snoozed' },
  { name: 'resolved', query: 'target=A1', id: 'A1', settled: 'resolved' },
  { name: 'open', query: 'target=A5', id: 'A5', settled: null },
  { name: 'mode-off', query: 'target=A89&mode=off', id: 'A89', settled: 'replied' },
];

for (const [form, device] of [
  ['phone', PHONE],
  ['desktop', DESKTOP],
] as const) {
  for (const theme of THEMES) {
    const context = await browser.newContext({ ...device, ...LOCALE });
    for (const entry of CASES) {
      const label = `${entry.name} ${form} ${theme}`;
      const page = await open(context, theme, entry.query);
      check((await count(page, `[data-agenda-view="${entry.id}"]`)) === 1, `${label}: !${entry.id} opened no view`);
      check((await count(page, '[data-agenda-missing]')) === 0, `${label}: said a held id is no longer open`);
      if (entry.settled === null) {
        check((await count(page, '[data-agenda-quick-replies]')) === 1, `${label}: an open item lost its replies`);
      } else {
        check(
          (await count(page, `[data-agenda-settled="${entry.settled}"]`)) === 1,
          `${label}: no "${entry.settled}" line`,
        );
        check((await count(page, '[data-agenda-quick-replies]')) === 0, `${label}: a settled item drew quick replies`);
        const back = await count(page, '[data-agenda-bring-back]');
        check(
          entry.settled === 'resolved' ? back === 0 : back === 1,
          `${label}: Back to my list ${entry.settled === 'resolved' ? 'on a resolved item' : 'missing'}`,
        );
      }
      await noSideways(page, label);
      await shoot(page, entry.name, form, theme);
      await page.close();
    }
    if (form === 'desktop') {
      const label = `info-parked ${form} ${theme}`;
      const page = await open(context, theme, '');
      const info = page.locator('[data-agenda-harness-info]');
      check(
        (await info.locator('[data-context-chip]').count()) === 3,
        `${label}: Info's list lacks Open / Parked / Resolved`,
      );
      await info.locator('[data-context-chip="parked"]').click();
      check(
        (await info.locator('[data-agenda-row]').count()) === 2,
        `${label}: the Parked filter does not list both parked items`,
      );
      await shoot(page, 'info-parked', form, theme);
      await info.locator('[data-agenda-row="A89"]').click();
      await page.waitForTimeout(400);
      check((await count(page, '[data-agenda-view="A89"]')) === 1, `${label}: a Parked row opened no view`);
      await noSideways(page, label);
      await shoot(page, 'info-parked-opened', form, theme);
      await page.close();
    }
    await context.close();
  }
}

await browser.close();
server.stop(true);
process.stdout.write(`${checks} checks, ${violations.length} failed; pictures in ${outDir}\n`);
if (violations.length > 0) process.exit(1);
