/**
 * Screenshots of the Board's Kanban with the owner's Done on a To test card and a Released card, and the ⋯ menu
 * with Done first; then Done in flight (its spinner), a refused Done, and the "Not good" composer with a picture:
 *
 *   bun harness/board-kanban-screenshot.ts [outDir]    # default /tmp/claude-1000
 *
 * It bundles `board-page.tsx` (sixty-odd cards, `?big=1`), serves it on an ephemeral loopback port, aborts
 * anything that leaves it, and fails when a page scrolls sideways, a To test / Released card has no Done (a
 * Merged card has none), or — at any of several widths, from a wide desktop down to the narrowest phone — an
 * answer button leaves its card or cuts its own label.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type BrowserContext, chromium, type Page } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out', 'board-kanban');
const shotsDir = resolve(process.argv[2] ?? '/tmp/claude-1000');

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
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/board-page.js"></script></body>
</html>`;

mkdirSync(buildDir, { recursive: true });
mkdirSync(shotsDir, { recursive: true });
run('bun', ['build', join(harnessDir, 'board-page.tsx'), '--outdir', buildDir, '--target', 'browser']);
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
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? fail('no system Chrome or Chromium found');
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

/** The widths every card's answers are checked at: desktop columns from roomy to their narrowest, then phones. */
const DESKTOP_WIDTHS = [1_440, 1_180, 1_024, 820] as const;
const PHONE_WIDTHS = [390, 360, 320] as const;
/**
 * Columns squeezed below the Kanban's own minimum, as the side pane or a crowded window draws them: a card's
 * answers must still fit (they wrap onto two lines rather than spill).
 */
const SQUEEZED_COLUMNS = [150, 128, 112] as const;

const squeeze = async (page: Page, width: number | null): Promise<void> => {
  await page.evaluate(px => {
    document.getElementById('squeeze')?.remove();
    if (px === null) return;
    const style = document.createElement('style');
    style.id = 'squeeze';
    style.textContent = `.fy-board-lane { min-width: 0 !important; flex: 0 0 ${px}px !important; max-width: ${px}px !important; }`;
    document.head.append(style);
  }, width);
  await page.waitForTimeout(100);
};

/** Every theme: each sets its own font and text sizes, and a wider face is where a label used to spill. */
const THEMES = [
  'studio-light',
  'studio-dark',
  'light',
  'dark',
  'blueprint-light',
  'blueprint-dark',
  'broadsheet-light',
  'broadsheet-dark',
  'contrast-light',
  'contrast-dark',
  'geist-light',
  'geist-dark',
  'ledger-dark',
  'ma-dark',
  'mission-light',
  'mission-dark',
  'neo-light',
  'neo-dark',
  'phosphor-light',
  'phosphor-dark',
  'wayfinding-dark',
  'x',
] as const;

/**
 * Every answer button (Done, Close, Not good, Reopen, ⋯) must sit inside its card and show its whole label. A menu
 * that drops down from ⋯ is meant to reach past the card, so its items are not counted.
 */
const checkAnswersFit = async (page: Page, where: string): Promise<number> => {
  const problems = await page.evaluate(() => {
    const found: string[] = [];
    let checked = 0;
    for (const card of document.querySelectorAll<HTMLElement>('.fy-board-card, .fy-board-table__row')) {
      const box = card.getBoundingClientRect();
      for (const button of card.querySelectorAll<HTMLButtonElement>('button')) {
        if (button.closest('[role="menu"]') !== null) continue;
        const own = button.getBoundingClientRect();
        if (own.width === 0) continue;
        checked += 1;
        const name = `&${card.dataset['task'] ?? '?'} "${button.textContent?.trim() || button.getAttribute('aria-label')}"`;
        if (own.left < box.left - 0.5 || own.right > box.right + 0.5)
          found.push(
            `${name} leaves its card (${Math.round(own.left)}–${Math.round(own.right)} in ${Math.round(box.left)}–${Math.round(box.right)})`,
          );
        // Only a worded button has a label to cut; the phone's ⋯ reaches past itself on purpose (its hit area).
        const worded = (button.textContent?.trim() ?? '') !== '';
        if (worded && button.scrollWidth > button.clientWidth + 1) found.push(`${name} cuts its label`);
      }
    }
    return { found, checked };
  });
  if (problems.found.length > 0) fail(`at ${where}: ${problems.found.slice(0, 6).join('; ')}`);
  process.stdout.write(`✓ ${problems.checked} answer buttons fit their cards at ${where}\n`);
  return problems.checked;
};

const open = async (context: BrowserContext, theme: string, extra = ''): Promise<Page> => {
  const page = await context.newPage();
  await page.route('**/*', route =>
    route.request().url().startsWith(server.url.origin) ? route.continue() : route.abort(),
  );
  page.on('pageerror', error => process.stderr.write(`page error: ${error.message}\n`));
  await page.goto(`${server.url}?theme=${theme}&big=1${extra}`);
  await page.locator('[data-fixture]').waitFor({ state: 'visible' });
  await page.locator('.fy-board-card').first().waitFor({ state: 'visible' });
  await page.waitForTimeout(300);
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (wide > 0) fail(`the Kanban scrolls sideways by ${wide}px`);
  return page;
};

const shot = async (page: Page, name: string): Promise<void> => {
  const path = join(shotsDir, `${name}.png`);
  await page.screenshot({ path });
  process.stdout.write(`📸 ${path}\n`);
};

/** Done pressed on a To test card: it spins, its siblings wait, nothing on the card moves. */
const checkInFlight = async (page: Page, scheme: string, label: string): Promise<void> => {
  const card = page.locator('.fy-board-card[data-category="verify"]').first();
  const before = await card.locator('.fy-board-done').boundingBox();
  await card.locator('.fy-board-done').click();
  await card.locator('.fy-board-done[data-pending] [data-spinner]').waitFor({ state: 'visible' });
  const after = await card.locator('.fy-board-done').boundingBox();
  if (before === null || after === null) fail('Done has no box');
  else if (Math.abs(before.width - after.width) > 0.5 || Math.abs(before.x - after.x) > 0.5)
    fail(`Done moved while it spins: ${before.x},${before.width} → ${after.x},${after.width}`);
  if (!(await card.locator('[data-verdict="not-good"]').isDisabled()))
    fail('Not good is still pressable while Done is on its way');
  await shot(page, `board-kanban-in-flight-${scheme}-${label}`);
};

/** "Not good" on another To test card: the composer, with words and a picture. */
const checkNotGood = async (page: Page, scheme: string, label: string): Promise<void> => {
  await page
    .locator('.fy-board-card[data-category="verify"]:not([data-settling]) [data-verdict="not-good"]')
    .first()
    .click();
  const composer = page.locator('[data-board-send-back]');
  await composer.waitFor({ state: 'visible' });
  await composer.locator('.fy-board-sendback__attach:not([disabled])').waitFor({ state: 'visible' });
  await composer
    .locator('[aria-label="Reason"]')
    .fill('The toggle still flickers on a phone in dark mode — see the screenshot.');
  await composer.locator('[data-send-back-picker]').setInputFiles({
    name: 'flicker.png',
    mimeType: 'image/png',
    buffer: PIXEL,
  });
  await composer.locator('[aria-label="Attached files"] li').first().waitFor({ state: 'visible' });
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (wide > 0) fail(`the Not good composer scrolls sideways by ${wide}px`);
  await shot(page, `board-kanban-not-good-${scheme}-${label}`);
  await composer.locator('button', { hasText: 'Cancel' }).click();
};

/** A one-pixel PNG, as a picked file. */
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const doneCount = async (page: Page, lane: string): Promise<readonly [number, number]> => {
  const cards = page.locator(`.fy-board-lane[aria-label^="${lane},"] .fy-board-card`);
  return [await cards.count(), await cards.locator('.fy-board-done').count()];
};

const checkDone = async (page: Page): Promise<void> => {
  for (const lane of ['To test', 'Released']) {
    const [cards, withDone] = await doneCount(page, lane);
    if (cards === 0 || withDone !== cards) fail(`${withDone} of ${cards} ${lane} cards have a Done`);
  }
  const [merged, mergedDone] = await doneCount(page, 'Merged');
  if (merged === 0 || mergedDone !== 0) fail(`${mergedDone} of ${merged} Merged cards show a Done row`);
};

try {
  // THE ANSWERS FIT: every card's buttons, at every width, on the Kanban (and the phone's To test lane).
  {
    for (const theme of THEMES) {
      const context = await browser.newContext({ ...DESKTOP, colorScheme: theme.endsWith('light') ? 'light' : 'dark' });
      const page = await open(context, theme);
      for (const width of DESKTOP_WIDTHS) {
        await page.setViewportSize({ width, height: 900 });
        await page.waitForTimeout(100);
        await checkAnswersFit(page, `${theme} Kanban ${width}px`);
      }
      for (const column of SQUEEZED_COLUMNS) {
        await squeeze(page, column);
        await checkAnswersFit(page, `${theme} Kanban, ${column}px columns`);
      }
      if (theme === 'studio-light') await shot(page, 'board-kanban-squeezed-light-desktop');
      await squeeze(page, null);
      await context.close();
      for (const width of PHONE_WIDTHS) {
        const phone = await browser.newContext({ ...PHONE, viewport: { width, height: 844 } });
        const lane = await open(phone, theme, '&at=tested');
        await checkAnswersFit(lane, `${theme} phone ${width}px, To test`);
        await phone.close();
      }
    }
  }

  for (const scheme of ['light', 'dark'] as const) {
    for (const [label, options] of [
      ['desktop', DESKTOP],
      ['phone', PHONE],
    ] as const) {
      const context = await browser.newContext({ ...options, colorScheme: scheme });
      try {
        const page = await open(context, `studio-${scheme}`);
        if (label === 'desktop') {
          await checkDone(page);
          await shot(page, `board-kanban-done-${scheme}-desktop`);
          await page.locator('.fy-board-card__more').first().click();
          await page.waitForTimeout(150);
          await shot(page, `board-kanban-menu-${scheme}-desktop`);
          await page.keyboard.press('Escape');
        } else {
          await page.locator('[role="tab"]', { hasText: 'To test' }).click();
          await page.waitForTimeout(200);
          await shot(page, `board-kanban-done-${scheme}-phone`);
        }
        await checkInFlight(page, scheme, label);
        await checkNotGood(page, scheme, label);
        await page.close();
        const refusing = await open(
          context,
          `studio-${scheme}`,
          label === 'phone' ? '&refuse=1&at=tested' : '&refuse=1',
        );
        await refusing.locator('.fy-board-card[data-category="verify"] .fy-board-done').first().click();
        await refusing.locator('[data-answer-error]').first().waitFor({ state: 'visible' });
        await checkAnswersFit(refusing, `${label} ${scheme}, refused`);
        await shot(refusing, `board-kanban-refused-${scheme}-${label}`);
        await refusing.close();
      } finally {
        await context.close();
      }
    }
  }
  process.stdout.write(
    '✅ the Kanban captured; Done on every To test and Released card, none on Merged; every answer fits its card at every width; Done spins in place; Not good opens the composer\n',
  );
} finally {
  await browser.close();
  server.stop();
}
