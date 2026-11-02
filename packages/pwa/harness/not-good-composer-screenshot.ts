/**
 * Screenshots and checks for the "Not good" box, which is the chat's own composer detached from any chat: open under
 * a card waiting for the owner's try (the quick-answer run and the list: a modal sheet over the card), and under the
 * Inbox deck's gate card (inline, exactly as wide as the card), empty and with words. Phone 390 and desktop 1440, Studio light and dark.
 *
 *   bun harness/not-good-composer-screenshot.ts [outDir]   # writes <outDir>/<state>-<390|1440>-<light|dark>.png
 *
 * It bundles `inbox-page.tsx` (the real `AgendaInboxPage`, invented data), serves it on an ephemeral loopback port, and
 * FAILS (after writing every picture) when: a page scrolls sideways; the box is not the composer (no attach, no mic
 * slot, no send); the box is not exactly as wide as the card it answers; words typed do not reach the field; or Cancel
 * does not close it.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out', 'not-good-composer-build');
const outDir = resolve(process.argv[2] ?? '/tmp/claude-1000/shots/b141/c-composer');

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

const FORMS = {
  390: {
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
    userAgent:
      'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  },
  1440: { viewport: { width: 1_440, height: 900 } },
} as const;
const NOW = new Date('2026-10-29T09:00:00.000Z');
const LOCALE = { timezoneId: 'UTC', locale: 'en-US' } as const;
const THEMES = (process.env.FY_SHOT_THEMES ?? 'studio-light,studio-dark').split(',');
const WORDS = 'The code never appears on the second phone, and the QR is cut off.';

const violations: string[] = [];
let checks = 0;
const check = (ok: boolean, message: string): void => {
  checks += 1;
  if (ok) return;
  violations.push(message);
  process.stderr.write(`❌ ${message}\n`);
};

/** What each place draws: its view, the button that asks for words, the card the box answers, and whether it sits under it (a modal sheet does not). */
const PLACES = [
  {
    state: 'to-test-quick',
    view: 'quick-to-test',
    ask: '[data-to-test-not-good]',
    card: '[data-to-test]',
    inline: false,
  },
  { state: 'to-test-list', view: 'to-test', ask: '[data-to-test-not-good]', card: '[data-to-test]', inline: false },
  {
    state: 'gate-deck',
    view: 'gate',
    ask: '[data-agenda-option="Not good"]',
    card: '.fy-attn-deck__top',
    inline: true,
  },
] as const;

const widthOf = (page: Page, selector: string): Promise<number> =>
  page.evaluate(selector => document.querySelector(selector)?.getBoundingClientRect().width ?? Number.NaN, selector);

for (const width of [390, 1440] as const) {
  for (const theme of THEMES) {
    const mode = theme.endsWith('-dark') ? 'dark' : 'light';
    for (const place of PLACES) {
      const context = await browser.newContext({ ...FORMS[width], ...LOCALE, colorScheme: mode });
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
      await page.goto(`${server.url}?theme=${theme}&view=${place.view}`);
      await page.locator('[data-fixture]').waitFor({ state: 'visible' });
      await page.locator(place.ask).first().waitFor({ state: 'visible' });
      await page.waitForTimeout(250);
      await page.locator(place.ask).first().click();
      const box = page.locator('[data-board-send-back]');
      await box.waitFor({ state: 'visible' });
      await page.waitForTimeout(300);
      const name = `${place.state}-${width}-${mode}`;
      const label = `${place.state} ${width} ${theme}`;
      check((await box.count()) === 1, `${label}: not exactly one send-back box`);
      check((await box.locator('form').count()) === 1, `${label}: the box is not the chat composer`);
      check((await box.locator('button[data-composer-send]').count()) === 1, `${label}: no composer send button`);
      check((await box.getByRole('button', { name: 'Cancel' }).count()) === 1, `${label}: the box has no Cancel`);
      const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check(wide <= 0, `${label}: scrolls sideways by ${wide}px`);
      const boxWidth = await widthOf(page, '[data-board-send-back]');
      const cardWidth = await widthOf(page, place.card);
      process.stdout.write(`ℹ️  ${label}: box ${boxWidth}px, card ${cardWidth}px\n`);
      if (place.inline) {
        check(
          Math.abs(boxWidth - cardWidth) <= 1,
          `${label}: box ${boxWidth}px is not as wide as its card ${cardWidth}px`,
        );
      }
      await box.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: join(outDir, `${name.replace(place.state, `${place.state}-not-good-empty`)}.png`),
      });

      const field = box.locator('textarea, [contenteditable="true"]').first();
      await field.click();
      await page.keyboard.type(WORDS);
      await page.waitForTimeout(200);
      const typed = (await field.evaluate(el => ('value' in el ? String(el.value) : (el.textContent ?? '')))) ?? '';
      check(typed.includes('second phone'), `${label}: typed words did not reach the field`);
      await page.screenshot({ path: join(outDir, `${name.replace(place.state, `${place.state}-not-good-text`)}.png`) });

      await box.getByRole('button', { name: 'Cancel' }).click();
      await page.waitForTimeout(200);
      check((await box.count()) === 0, `${label}: Cancel did not close the box`);
      await context.close();
    }
  }
}

await browser.close();
server.stop();
if (violations.length > 0) fail(`${violations.length} of ${checks} checks failed`);
process.stdout.write(`✅ ${checks} checks passed\n`);
