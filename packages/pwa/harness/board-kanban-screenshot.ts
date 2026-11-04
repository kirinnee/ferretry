/**
 * Screenshots of the Board's Kanban and its ⋯ menu. A card draws no owner button (no Done, no Not good, no Reopen):
 * the owner answers in the agenda, so the Board only says where the work stands:
 *
 *   bun harness/board-kanban-screenshot.ts [outDir]    # default /tmp/claude-1000
 *
 * It bundles `board-page.tsx` (sixty-odd cards, `?big=1`), serves it on an ephemeral loopback port, aborts
 * anything that leaves it, and fails when a page scrolls sideways, any card draws an owner button, or — at any of
 * several widths, from a wide desktop down to the narrowest phone — a card's ⋯ button leaves its card.
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
 * Every button on a card (the ⋯) must sit inside its card and show its whole label. A menu
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
  process.stdout.write(`✓ ${problems.checked} card buttons fit their cards at ${where}\n`);
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

/** No card draws an owner button: no Done, no Not good, no Reopen. */
const checkNoOwnerButtons = async (page: Page): Promise<void> => {
  const found = await page.evaluate(
    () =>
      document.querySelectorAll('.fy-board-done, .fy-board-verdict, [data-verdict], .fy-board-card__verdict').length,
  );
  if (found > 0) fail(`${found} owner buttons on the cards`);
};

try {
  // THE CARD BUTTONS FIT: every card's buttons, at every width, on the Kanban (and the phone's To test lane).
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
          await checkNoOwnerButtons(page);
          await shot(page, `board-kanban-${scheme}-desktop`);
          await page.locator('.fy-board-card__more').first().click();
          await page.waitForTimeout(150);
          await shot(page, `board-kanban-menu-${scheme}-desktop`);
          await page.keyboard.press('Escape');
        } else {
          await page.locator('[role="tab"]', { hasText: 'To test' }).click();
          await page.waitForTimeout(200);
          await checkNoOwnerButtons(page);
          await shot(page, `board-kanban-${scheme}-phone`);
        }
        await page.close();
      } finally {
        await context.close();
      }
    }
  }
  process.stdout.write(
    '✅ the Kanban captured; no owner button on any card; every card button fits its card at every width\n',
  );
} finally {
  await browser.close();
  server.stop();
}
