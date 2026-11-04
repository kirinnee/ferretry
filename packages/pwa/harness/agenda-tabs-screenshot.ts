/**
 * Screenshots and checks for an agenda item whose live document is TABS (&F923): "Where we are now" first and open
 * (the answer to the owner's question, decided so far, still open, then its own Markdown), "The full picture", then
 * the ferret's own Decisions and Risks. Phone 390 and desktop 1440, light and dark, in three states: main (the main
 * tab), picture (The full picture opened), and on a phone the switcher sheet; on desktop the Risks tab.
 *
 *   bun harness/agenda-tabs-screenshot.ts [outDir]   # writes <outDir>/tabs-<state>-<phone|desktop>-<theme>.png
 *
 * It bundles `inbox-page.tsx` (`?view=tabs`: the real `AgendaInboxPage`, invented data) and FAILS (after writing every
 * picture) when: a page scrolls sideways; the main tab is not open first; the answer to the owner's question is not
 * the main tab's first block; "Answered: see Where we are now" is missing; the two changed tabs are not marked; a
 * phone draws a tab strip or a desktop draws a switcher; a tab name is cut short; or picking a tab does not show it.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out', 'agenda-tabs-build');
const outDir = resolve(process.argv[2] ?? '/tmp/claude-1000/shots/agenda-tabs');

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

const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'desktop', width: 1440, height: 900 },
] as const;
const NOW = new Date('2026-10-29T09:00:00.000Z');

const violations: string[] = [];
let checks = 0;
const check = (ok: boolean, message: string): void => {
  checks += 1;
  if (ok) return;
  violations.push(message);
  process.stderr.write(`❌ ${message}\n`);
};

const shoot = async (page: Page, state: string, form: string, theme: string): Promise<void> => {
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(wide <= 0, `${state} ${form} ${theme}: scrolls sideways by ${wide}px`);
  await page.mouse.move(1, 1);
  await page.waitForTimeout(150);
  const path = join(outDir, `tabs-${state}-${form}-${theme}.png`);
  await page.screenshot({ path });
  process.stdout.write(`📸 ${path}\n`);
};

/** Scrolls the open item so its tabs part sits at the top of the scroller. */
const toTabs = async (page: Page): Promise<void> => {
  await page.evaluate(() =>
    document.querySelector('.fy-attn-deck__top [data-agenda-part="tabs"]')?.scrollIntoView({ block: 'start' }),
  );
  await page.waitForTimeout(250);
};

for (const scheme of ['light', 'dark'] as const) {
  for (const viewport of VIEWPORTS) {
    const label = `${viewport.name} ${scheme}`;
    const phone = viewport.name === 'phone';
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      isMobile: phone,
      hasTouch: phone,
      deviceScaleFactor: 2,
      timezoneId: 'UTC',
      locale: 'en-US',
      colorScheme: scheme,
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    page.on('pageerror', error => fail(`page error in ${label}: ${error.message}`));
    await page.route('**/*', route =>
      route.request().url().startsWith(server.url.origin) ? route.continue() : route.abort(),
    );
    await page.clock.setFixedTime(NOW);
    await page.goto(`${server.url}?theme=studio-${scheme}&view=tabs`);
    await page.locator('[data-fixture]').waitFor({ state: 'visible' });
    const tabs = page.locator('.fy-attn-deck__top [data-agenda-part="tabs"]');
    await tabs.waitFor({ state: 'attached' });
    await page.waitForTimeout(300);

    // main: the main tab is open first, the answer to the owner's question is its first block.
    check((await tabs.getAttribute('data-agenda-tab')) === 'main', `${label}: the main tab is not open first`);
    const first = await tabs.evaluate(
      node => node.querySelector('[data-agenda-tab-panel] > *')?.hasAttribute('data-agenda-question-answer') ?? false,
    );
    check(first, `${label}: the answer to the owner's question is not the main tab's first block`);
    check(
      (await page.locator('.fy-attn-deck__top [data-agenda-answered-line]').innerText()).trim() ===
        'Answered: see Where we are now',
      `${label}: no "Answered: see Where we are now" line`,
    );
    if (phone) {
      check((await tabs.locator('[role="tablist"]').count()) === 0, `${label}: a phone draws a tab strip`);
      const words = (await tabs.locator('[data-agenda-tab-switch]').innerText()).replace(/\s+/gu, ' ').trim();
      check(words === 'Where we are now · 1 of 4 · 2 changed', `${label}: the switcher says "${words}"`);
    } else {
      check((await tabs.locator('[data-agenda-tab-switch]').count()) === 0, `${label}: a desktop draws a switcher`);
      const names = await tabs.locator('[role="tab"]').allInnerTexts();
      check(names.length === 4, `${label}: ${names.length} tabs, not 4`);
      check((await tabs.locator('[role="tab"] [data-agenda-tab-changed]').count()) === 2, `${label}: not 2 changed`);
      const cut = await tabs.evaluate(node =>
        [...node.querySelectorAll<HTMLElement>('[role="tab"]')].some(tab => tab.scrollWidth > tab.clientWidth + 1),
      );
      check(!cut, `${label}: a tab name is cut short`);
    }
    await toTabs(page);
    await shoot(page, 'main', viewport.name, scheme);

    // picture: "The full picture" opened.
    if (phone) {
      await tabs.locator('[data-agenda-tab-switch]').click();
      const sheet = page.locator('[data-agenda-tab-sheet]');
      await sheet.waitFor({ state: 'visible' });
      await page.waitForTimeout(300);
      check(
        (await sheet.locator('[data-agenda-tab-changed]').count()) === 2,
        `${label}: the sheet does not mark 2 changed`,
      );
      await shoot(page, 'sheet', viewport.name, scheme);
      await sheet.locator('[data-agenda-tab-choice="body"]').click({ force: true });
    } else {
      await tabs.locator('[data-agenda-tab-button="body"]').click();
    }
    await page.waitForTimeout(300);
    check(
      (await tabs.getAttribute('data-agenda-tab')) === 'body',
      `${label}: picking The full picture did not open it`,
    );
    check(
      (await tabs.locator('[data-agenda-tab-panel]').innerText()).includes('Why a second relay'),
      `${label}: The full picture's words are not shown`,
    );
    await toTabs(page);
    await shoot(page, 'picture', viewport.name, scheme);

    if (!phone) {
      await tabs.locator('[data-agenda-tab-button="risks"]').click();
      await page.waitForTimeout(200);
      check(
        (await tabs.locator('[data-agenda-tab-panel]').innerText()).includes('drops live sessions'),
        `${label}: the Risks tab's words are not shown`,
      );
      await toTabs(page);
      await shoot(page, 'risks', viewport.name, scheme);
    }
    await context.close();
  }
}

await browser.close();
server.stop(true);
if (violations.length > 0) fail(`${violations.length} of ${checks} checks failed`);
process.stdout.write(`✅ ${checks} checks passed\n`);
