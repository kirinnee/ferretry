/**
 * Screenshots and checks for "after a reply the Inbox moves on at once, with Undo": the first card open with the owner's
 * words typed, the same page right after Send (the NEXT card in the deck and the "Replied" toast, the replied card gone
 * from the list), and after Undo (the card back, its words back in its composer). Phone 390 and desktop 1440, Studio
 * light and dark.
 *
 *   bun harness/inbox-reply-screenshot.ts [outDir] [series]   # writes <outDir>/<series>-<step>-<phone|desktop>-<theme>.png
 *                                                             # (series defaults to inbox-reply)
 *
 * It bundles `inbox-page.tsx` (the real `AgendaInboxPage` and `Composer`, invented data; its fake send is accepted and
 * stays queued, so Undo can take it back), drives it with a real pointer and keyboard, and FAILS (after writing every
 * picture) when: Send leaves the same card on top; the toast is not a polite status naming the move; the replied card
 * is still in the list; focus is on a node that is gone; Undo does not bring the card back; or its words do not come
 * back into that card's composer. Nothing leaves the page.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out', 'inbox-reply-build');
const outDir = resolve(process.argv[2] ?? '/tmp/claude-1000');
const series = process.argv[3] ?? 'inbox-reply';

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
    // The app's own self-hosted fonts: `theme-fonts.css` names them `../assets/fonts/…`, which lands on `/assets/fonts/…`
    // here and lives in src. Without this route every face 404s and the page is drawn in the fallback font.
    const built = Bun.file(join(buildDir, url.pathname));
    if (await built.exists()) return new Response(built);
    const font = Bun.file(join(packageDir, 'src', url.pathname));
    return new Response((await font.exists()) ? font : Bun.file(join(packageDir, 'public', url.pathname)));
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
const NOW = new Date('2026-10-29T09:00:00.000Z');
const LOCALE = { timezoneId: 'UTC', locale: 'en-US' } as const;
const THEMES = ['studio-light', 'studio-dark'] as const;
const WORDS = 'Go with SQLite for now, and keep the migration reversible.';
type Form = 'phone' | 'desktop';

const violations: string[] = [];
let checks = 0;
const check = (ok: boolean, message: string): void => {
  checks += 1;
  if (ok) return;
  violations.push(message);
  process.stderr.write(`❌ ${message}\n`);
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

const shot = async (page: Page, step: string, form: Form, theme: string): Promise<void> => {
  await page.evaluate(async () => document.fonts.ready.then(() => undefined));
  await page.waitForTimeout(150);
  const loaded = await page.evaluate(() =>
    [...document.fonts].filter(face => face.status === 'loaded').map(face => face.family.replaceAll(/["']/gu, '')),
  );
  const stack = (await page.evaluate(() => getComputedStyle(document.body).fontFamily))
    .split(',')
    .map(name => name.replaceAll(/["']/gu, '').trim());
  check(
    loaded.some(family => stack.includes(family)),
    `${step} ${form} ${theme}: none of the app's fonts (${stack.join(', ')}) loaded (loaded: ${loaded.join(', ') || 'none'})`,
  );
  const light = await backgroundLightness(page);
  check(
    theme.endsWith('-dark') ? light < 0.35 : light > 0.65,
    `${step} ${form} ${theme}: the page is not ${theme.endsWith('-dark') ? 'dark' : 'light'} (lightness ${light.toFixed(2)})`,
  );
  const path = join(outDir, `${series}-${step}-${form}-${theme}.png`);
  await page.screenshot({ path });
  process.stdout.write(`📸 ${path}\n`);
};

const COMPOSER = '[data-inbox-composer] textarea, [data-inbox-composer] [contenteditable]';
const topCard = (page: Page): Promise<string> =>
  page.locator('.fy-attn-deck__top [data-inbox-who]').first().innerText();
const composerWords = (page: Page): Promise<string> => page.locator(COMPOSER).first().innerText();

for (const form of ['phone', 'desktop'] as const) {
  for (const theme of THEMES) {
    const context = await browser.newContext({
      ...(form === 'phone' ? PHONE : DESKTOP),
      ...LOCALE,
      colorScheme: theme.endsWith('-dark') ? 'dark' : 'light',
    });
    const page = await context.newPage();
    await page.route('**/*', route =>
      route.request().url().startsWith(server.url.origin) ? route.continue() : route.abort(),
    );
    await page.clock.setFixedTime(NOW);
    await page.goto(`${server.url}?theme=${theme}&view=open`);
    await page.locator('[data-fixture]').waitFor({ state: 'visible' });
    await page.waitForTimeout(250);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(wide <= 0, `${form} ${theme}: scrolls sideways by ${wide}px`);

    const first = await topCard(page);
    const composer = page.locator(COMPOSER).first();
    await composer.waitFor({ state: 'visible' });
    await composer.click();
    await page.keyboard.type(WORDS);
    check((await composerWords(page)).includes('SQLite'), `${form} ${theme}: the typed words are not in the composer`);
    await shot(page, '1-open-with-words', form, theme);

    await page.locator('[data-inbox-composer] [data-composer-send]').first().click();
    await page.locator('[data-agenda-replied-toast]').waitFor({ state: 'visible' });
    await page.waitForTimeout(350);
    const second = await topCard(page);
    check(second !== first, `${form} ${theme}: Send left the same card on top ("${first}")`);
    const toast = page.locator('[data-agenda-replied-toast] [role=status]').first();
    check(
      ((await toast.textContent()) ?? '').includes('Moved to Replied'),
      `${form} ${theme}: the toast does not name the move`,
    );
    check(
      (await page.evaluate(() => document.activeElement !== null && document.body.contains(document.activeElement))) &&
        (await page.evaluate(() => document.activeElement !== document.body)),
      `${form} ${theme}: focus fell to the page after the card went`,
    );
    const overlap = await page.evaluate(() => {
      const rect = (selector: string) => document.querySelector(selector)?.getBoundingClientRect();
      const toast = rect('[data-agenda-replied-toast]');
      if (toast === undefined) return ['the toast is not drawn'];
      const covered = (name: string, other: DOMRect | undefined): string[] =>
        other !== undefined &&
        toast.left < other.right &&
        toast.right > other.left &&
        toast.top < other.bottom &&
        toast.bottom > other.top
          ? [name]
          : [];
      return [
        ...covered('the composer box', rect('[data-inbox-composer] [data-live-editor]')),
        ...covered('the send button', rect('[data-inbox-composer] [data-composer-send]')),
      ];
    });
    check(overlap.length === 0, `${form} ${theme}: the toast covers ${overlap.join(' and ')}`);
    await shot(page, '2-after-send', form, theme);

    await page.locator('[data-agenda-undo-button]').first().click();
    await page.waitForTimeout(350);
    check((await topCard(page)) === first, `${form} ${theme}: Undo did not bring the first card back on top`);
    await page.locator(COMPOSER).first().waitFor({ state: 'visible' });
    check(
      (await composerWords(page)).includes('SQLite'),
      `${form} ${theme}: Undo did not put the words back in the composer`,
    );
    await shot(page, '3-after-undo', form, theme);

    await context.close();
  }
}

await browser.close();
server.stop();
if (violations.length > 0) fail(`${violations.length} of ${checks} checks failed`);
process.stdout.write(`✅ ${checks} checks passed\n`);
