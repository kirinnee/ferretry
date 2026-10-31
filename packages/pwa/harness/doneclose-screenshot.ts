/**
 * Screenshots and checks for "Done · closes &F12" in the agenda quick replies: the button in the one row (and
 * under three answers, and alone), the several-cards checklist, the refusal, and the close in flight. Desktop 1440
 * and phone 390, Studio light and dark.
 *
 *   bun harness/doneclose-screenshot.ts [outDir]   # writes <outDir>/doneclose-<name>-<phone|desktop>-<theme>.png
 *
 * It bundles `doneclose-page.tsx` (the real `AgendaQuickReplies` + `useDoneCloseFlow`, invented board), serves it
 * on an ephemeral loopback port, drives it with real clicks, and FAILS (after every picture is written) when: a
 * page scrolls sideways; the button is a swipe answer; with a free slot it is not in the row, or with three
 * answers it is not under them; the row holds more than three answers; the checklist is not all ticked; a tap
 * does not resolve the item; a refused close resolves it or says nothing; the in-flight button is not disabled;
 * the theme drawn is not the one named.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out', 'doneclose-build');
const outDir = resolve(process.argv[2] ?? '/tmp/claude-1000/v5-shots');

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
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/doneclose-page.js"></script></body>
</html>`;

mkdirSync(buildDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
run('bun', ['build', join(harnessDir, 'doneclose-page.tsx'), '--outdir', buildDir, '--target', 'browser']);
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
} as const;
const DESKTOP = { viewport: { width: 1_440, height: 900 } } as const;
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

const open = async (
  context: { newPage: () => Promise<Page> },
  theme: string,
  view: string,
  label: string,
): Promise<Page> => {
  const page = await context.newPage();
  await page.route('**/*', route =>
    route.request().url().startsWith(server.url.origin) ? route.continue() : route.abort(),
  );
  await page.goto(`${server.url}?theme=${theme}&view=${view}`);
  await page.locator('[data-fixture]').waitFor({ state: 'visible' });
  await page.waitForTimeout(150);
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(wide <= 0, `${label}: scrolls sideways by ${wide}px`);
  return page;
};

const shot = async (page: Page, name: string, form: Form, theme: string): Promise<void> => {
  await page.mouse.move(1, 1);
  await page.waitForTimeout(120);
  const path = join(outDir, `doneclose-${name}-${form}-${theme}.png`);
  const shown = await page.evaluate(() => document.documentElement.dataset.theme ?? '');
  check(shown === theme, `doneclose-${name} ${form}: drawn in ${shown}, named ${theme}`);
  await page.screenshot({ path });
  process.stdout.write(`📸 ${path}\n`);
};

const BUTTON = '[data-agenda-done-close]';

/** Where the button sits: inside the swipe row, or somewhere else in the quick replies. */
const placement = (page: Page) =>
  page.evaluate(() => {
    const chip = document.querySelector<HTMLElement>('[data-agenda-done-close]');
    if (chip === null) return null;
    const row = document.querySelector<HTMLElement>('[data-agenda-quick-replies] .fy-qr__row');
    return {
      swipeAnswer: chip.hasAttribute('data-agenda-answer'),
      inRow: row?.contains(chip) === true,
      answers: row === null ? 0 : row.querySelectorAll('[data-agenda-answer]').length,
      below: row === null ? true : chip.getBoundingClientRect().top >= row.getBoundingClientRect().bottom - 1,
      label: chip.getAttribute('aria-label') ?? '',
      shown: chip.innerText.trim(),
      // ONE line: every control in the row, "Not needed" too, shares the row's top (the owner's compact rule).
      oneLine:
        row === null ||
        new Set([...row.children].map(kid => Math.round((kid as HTMLElement).getBoundingClientRect().top))).size === 1,
      disabled: (chip as HTMLButtonElement).disabled,
      outside: [...document.querySelectorAll<HTMLElement>('.fy-qr__row > *')]
        .filter(kid => {
          const at = kid.getBoundingClientRect();
          return at.left < -0.5 || at.right > window.innerWidth + 0.5;
        })
        .map(kid => kid.textContent?.trim() ?? ''),
    };
  });

const scenes = async (form: Form, theme: string): Promise<void> => {
  const context = await browser.newContext({ ...(form === 'phone' ? PHONE : DESKTOP), ...LOCALE });
  const at = `${form} ${theme}`;

  // The button in the one row: the → slot is free, so it sits there.
  const row = await open(context, theme, 'row', `row ${at}`);
  const rowAt = await placement(row);
  check(rowAt !== null && rowAt.label === 'Done · closes &F12', `row ${at}: label is "${rowAt?.label}"`);
  check(rowAt?.swipeAnswer === false, `row ${at}: the button is a swipe answer`);
  check(rowAt?.inRow === true, `row ${at}: the button is not in the one row`);
  check(rowAt?.outside.length === 0, `row ${at}: off the screen: ${rowAt?.outside.join(' | ')}`);
  check((rowAt?.answers ?? 9) <= 3, `row ${at}: the row holds ${rowAt?.answers} answers`);
  check(rowAt?.oneLine === true, `row ${at}: the row wraps — "Not needed" is not on the answers' line`);
  const words = form === 'phone' ? 'Close &F12' : 'Done · closes &F12';
  check(rowAt?.shown === words, `row ${at}: the button shows "${rowAt?.shown}", wanted "${words}"`);
  await shot(row, 'row', form, theme);
  await row.locator(BUTTON).click();
  await row.locator('[data-resolved]').waitFor({ state: 'visible' });
  check(
    ((await row.locator('[data-resolved]').textContent()) ?? '').includes('Done · closes &F12'),
    `row ${at}: a tap did not resolve the item`,
  );
  await row.close();

  // Three answers fill the row: the button goes under them.
  const full = await open(context, theme, 'full', `full ${at}`);
  const fullAt = await placement(full);
  check(fullAt !== null && !fullAt.inRow && fullAt.below, `full ${at}: the button is not under the three answers`);
  check(fullAt?.answers === 3, `full ${at}: the row holds ${fullAt?.answers} answers, not 3`);
  check(fullAt?.outside.length === 0, `full ${at}: off the screen: ${fullAt?.outside.join(' | ')}`);
  await shot(full, 'row-three-answers', form, theme);
  await full.close();

  // A to-do (its one Mark as done): the button takes the free slot in the row, which keeps one line.
  const alone = await open(context, theme, 'alone', `alone ${at}`);
  const aloneAt = await placement(alone);
  check(aloneAt !== null, `alone ${at}: the button is missing`);
  check(aloneAt?.outside.length === 0, `alone ${at}: off the screen: ${aloneAt?.outside.join(' | ')}`);
  check(aloneAt?.oneLine === true, `alone ${at}: the row wraps — "Not needed" is not on the answers' line`);
  check(aloneAt?.inRow === true, `alone ${at}: the button is not in the to-do's row beside Mark as done`);
  await shot(alone, 'row-alone', form, theme);
  await alone.close();

  // Several cards: the checklist, every one ticked, before anything closes.
  const multi = await open(context, theme, 'multi', `multi ${at}`);
  await multi.locator(BUTTON).click();
  await multi.locator('[data-agenda-done-close-confirm]').waitFor({ state: 'visible' });
  const ticks = await multi
    .locator('[data-agenda-done-close-card]')
    .evaluateAll(boxes => boxes.map(box => (box as HTMLInputElement).checked));
  check(ticks.length === 3 && ticks.every(Boolean), `multi ${at}: ${JSON.stringify(ticks)} is not three ticked`);
  check((await multi.locator('[data-resolved]').count()) === 0, `multi ${at}: resolved before the confirm`);
  await shot(multi, 'multi-confirm', form, theme);
  await multi.locator('[data-agenda-done-close-confirm-go]').click();
  await multi.locator('[data-resolved]').waitFor({ state: 'visible' });
  await multi.close();

  // A refusal: the item stays open and says why.
  const error = await open(context, theme, 'error', `error ${at}`);
  await error.locator(BUTTON).click();
  await error.locator('[data-agenda-done-close-error]').waitFor({ state: 'visible' });
  const said = (await error.locator('[data-agenda-done-close-error]').textContent()) ?? '';
  check(said.startsWith('Not closed:'), `error ${at}: says "${said}"`);
  check((await error.locator('[data-resolved]').count()) === 0, `error ${at}: the item resolved after a refusal`);
  check((await error.locator(BUTTON).count()) === 1, `error ${at}: the button is gone after a refusal`);
  await shot(error, 'error', form, theme);
  await error.close();

  // In flight: disabled, so a second tap cannot close twice.
  const busy = await open(context, theme, 'busy', `busy ${at}`);
  await busy.locator(BUTTON).click();
  await busy.waitForTimeout(150);
  check((await placement(busy))?.disabled === true, `busy ${at}: the button is not disabled while closing`);
  await shot(busy, 'in-flight', form, theme);
  await busy.close();

  await context.close();
};

for (const theme of THEMES) for (const form of ['phone', 'desktop'] as const) await scenes(form, theme);

await browser.close();
server.stop(true);

if (violations.length > 0) fail(`${violations.length} of ${checks} checks failed`);
process.stdout.write(`✅ doneclose harness: ${checks} checks passed\n`);
