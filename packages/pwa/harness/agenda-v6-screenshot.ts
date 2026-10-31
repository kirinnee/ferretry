/**
 * Screenshots and checks for the v6 agenda card (the owner-approved mockup): title and its one line, ONE card —
 * type, "↓ Not needed" and the version picker in its top bar, premise + context, the question, the options, open
 * sections, ONE answer row — then the History, all at the composer's width.
 *
 *   bun harness/agenda-v6-screenshot.ts [outDir]   # writes <outDir>/v6-<scene>-<phone|desktop>-<theme>.png
 *
 * It bundles `agenda-page.tsx` (`v6=1`: A90 the spend-limit decision with terms, two versions and a conversation
 * with tool calls and an unrelated exchange in it; A91 a to-do with steps; A92 a lettered choice of four; A93 an
 * input request), drives it with real clicks, and FAILS (after writing every picture) when: a page scrolls
 * sideways; the card, the History or the title column is not the composer's width; "Why now" is drawn; anything in
 * the card has a left accent bar; the answer row holds more than three buttons or wraps; Not needed is not in the
 * card's top bar; a term's meaning does not open; or the History holds tool text, unrelated chat, a ferret bubble,
 * or no "Card updated to v2".
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out', 'agenda-v6-card-build');
const outDir = resolve(process.argv[2] ?? '/tmp/claude-1000/shots/agenda-v6');

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
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/agenda-page.js"></script></body>
</html>`;

mkdirSync(buildDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
run('bun', ['build', join(harnessDir, 'agenda-page.tsx'), '--outdir', buildDir, '--target', 'browser']);
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
    // The stylesheet names its fonts relative to src/styles (`../assets/fonts/…`): serve them from there, so the
    // pictures are drawn in the app's own typefaces rather than a fallback.
    if (url.pathname.startsWith('/assets/fonts/')) return new Response(Bun.file(join(packageDir, 'src', url.pathname)));
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
const NOW = new Date('2026-10-29T09:00:00.000Z');
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

const shot = async (page: Page, name: string, form: Form, theme: string): Promise<void> => {
  await page.mouse.move(1, 1);
  await page.waitForTimeout(120);
  const path = join(outDir, `v6-${name}-${form}-${theme}.png`);
  const shown = await page.evaluate(() => document.documentElement.dataset.theme ?? '');
  check(shown === theme, `v6-${name} ${form}: drawn in ${shown}, named ${theme}`);
  await page.screenshot({ path });
  process.stdout.write(`📸 ${path}\n`);
};

const openItem = async (page: Page, id: string): Promise<void> => {
  await page.locator('[data-agenda-line-toggle]').click();
  await page.locator('[data-agenda-drawer]').waitFor({ state: 'visible' });
  await page.waitForTimeout(150);
  await page.locator(`[data-agenda-drawer] [data-agenda-row="${id}"]`).click();
  await page.locator('[data-agenda-view]').waitFor({ state: 'visible' });
  await page.waitForTimeout(250);
};

const scrollTo = async (page: Page, where: 'top' | 'bottom'): Promise<void> => {
  await page.locator('.fy-item-view__body').evaluate((node, at) => {
    node.scrollTop = at === 'top' ? 0 : node.scrollHeight;
  }, where);
  await page.waitForTimeout(150);
};

const checkLayout = async (page: Page, label: string): Promise<void> => {
  const found = await page.evaluate(() => {
    const box = (selector: string) => {
      const node = document.querySelector(selector);
      if (node === null) return null;
      const rect = node.getBoundingClientRect();
      return { left: Math.round(rect.left), right: Math.round(rect.right) };
    };
    const card = document.querySelector('.fy-card');
    const bars = [...(card?.querySelectorAll('*') ?? [])].filter(node => {
      const style = getComputedStyle(node);
      return Number.parseFloat(style.borderLeftWidth) >= 2 && style.borderLeftStyle !== 'none';
    }).length;
    const chips = [...document.querySelectorAll('.fy-card .fy-qr__row > button')].map(node =>
      Math.round(node.getBoundingClientRect().top),
    );
    const view = document.querySelector('[data-agenda-view]');
    const pictures = [
      ...(card?.querySelectorAll('.fy-render-image:not([data-fy-render-sized="true"]), .fy-render-chart') ?? []),
    ].map(node => Math.round(node.getBoundingClientRect().width));
    const folds = card?.querySelectorAll('details, summary').length ?? 0;
    const hiddenSections = [...(card?.querySelectorAll('.fy-card__section-body') ?? [])].filter(
      node => node.getBoundingClientRect().height === 0,
    ).length;
    const block = (name: string) => {
      const node = document.querySelector(`.fy-card [data-agenda-situation] [data-agenda-section="${name}"]`);
      const label = node?.querySelector('h4');
      const text = node?.querySelector('ul, ol, p');
      if (!node || !label || !text) return null;
      const outer = node.getBoundingClientRect();
      const above = label.getBoundingClientRect();
      const below = text.getBoundingClientRect();
      return {
        stacked: above.bottom <= below.top + 1,
        textWidth: Math.round(below.width),
        blockWidth: Math.round(outer.width),
        background: getComputedStyle(node).backgroundColor,
        labelColour: getComputedStyle(label).color,
      };
    };
    return {
      premise: block('premise'),
      context: block('context'),
      composer: box('[data-agenda-harness-composer]'),
      card: box('.fy-card'),
      head: box('.fy-item-view__head'),
      history: box('[data-agenda-history]'),
      wide: Math.max(
        document.documentElement.scrollWidth - window.innerWidth,
        (() => {
          const body = document.querySelector('.fy-item-view__body');
          return body === null ? 0 : body.scrollWidth - body.clientWidth;
        })(),
      ),
      whyNow: /why now/iu.test(view?.textContent ?? ''),
      bars,
      folds,
      pictures,
      hiddenSections,
      chips,
    };
  });
  check(found.wide <= 0, `${label}: scrolls sideways by ${found.wide}px`);
  check(!found.whyNow, `${label}: "Why now" is drawn`);
  check(found.bars === 0, `${label}: ${found.bars} element(s) in the card draw a left accent bar`);
  for (const [name, part] of [
    ['premise', found.premise],
    ['context', found.context],
  ] as const) {
    if (part === null) continue;
    check(part.stacked, `${label}: the ${name} label is not above its text`);
    check(
      part.blockWidth - part.textWidth <= 56,
      `${label}: the ${name} text is not full width (${part.textWidth} of ${part.blockWidth})`,
    );
    check(part.background !== 'rgba(0, 0, 0, 0)', `${label}: the ${name} block has no tint`);
    check(part.labelColour !== part.background, `${label}: the ${name} label matches its tint`);
  }
  if (found.premise !== null && found.context !== null)
    check(found.premise.background !== found.context.background, `${label}: premise and context share one tint`);
  check(
    found.pictures.every(width => width <= 481),
    `${label}: a picture or chart is drawn wider than 480px (${found.pictures.join(',')})`,
  );
  check(found.folds === 0, `${label}: ${found.folds} folding element(s) in the card`);
  check(found.hiddenSections === 0, `${label}: ${found.hiddenSections} section(s) drawn with no body`);
  check(found.chips.length <= 3, `${label}: the answer row holds ${found.chips.length} buttons`);
  check(new Set(found.chips).size <= 1, `${label}: the answer row wraps (${found.chips.join(',')})`);
  const composer = found.composer;
  check(composer !== null, `${label}: no composer`);
  for (const [name, part] of [
    ['card', found.card],
    ['title column', found.head],
    ['history', found.history],
  ] as const) {
    if (part === null || composer === null) continue;
    check(
      Math.abs(part.left - composer.left) <= 1 && Math.abs(part.right - composer.right) <= 1,
      `${label}: the ${name} spans ${part.left}–${part.right}, the composer ${composer.left}–${composer.right}`,
    );
  }
};

const HISTORY_OUT = ['Bash(', 'Read(', 'Let me check the runner', 'lockfile', 'Building the spend-limit'] as const;

const checkHistory = async (page: Page, label: string): Promise<void> => {
  const history = page.locator('[data-agenda-history]');
  check((await history.count()) === 1, `${label}: no History`);
  const text = (await history.textContent()) ?? '';
  for (const word of HISTORY_OUT) check(!text.includes(word), `${label}: the History shows "${word}"`);
  check(text.includes('does pause kill a running turn?'), `${label}: the owner's question is missing`);
  check(text.includes('A running turn finishes'), `${label}: the ferret's answer (no !A90 in it) is missing`);
  check(text.includes('Card updated to v2'), `${label}: no "Card updated to v2"`);
  const backgrounds = await history
    .locator('[data-history="ferret"]')
    .evaluateAll(nodes => nodes.map(node => getComputedStyle(node).backgroundColor));
  check(
    backgrounds.every(colour => colour === 'rgba(0, 0, 0, 0)' || colour === 'transparent'),
    `${label}: a ferret row is drawn as a bubble (${backgrounds.join(',')})`,
  );
  const owners = await history.locator('[data-history="owner"]').count();
  check(owners === 1, `${label}: ${owners} owner bubbles, wanted 1`);
  const order = await history
    .locator('li')
    .evaluateAll(nodes => nodes.map(node => Math.round(node.getBoundingClientRect().top)));
  check(
    order.every((top, at) => at === 0 || top > (order[at - 1] ?? 0)),
    `${label}: the History does not read top-down`,
  );
};

const scenes = async (form: Form, theme: string): Promise<void> => {
  const browserContext = await browser.newContext({
    ...(form === 'phone' ? PHONE : DESKTOP),
    ...LOCALE,
    colorScheme: theme.endsWith('-dark') ? 'dark' : 'light',
  });
  const open = async (id: string): Promise<Page> => {
    const page = await browserContext.newPage();
    await page.route('**/*', route =>
      route.request().url().startsWith(server.url.origin) ? route.continue() : route.abort(),
    );
    await page.clock.setFixedTime(NOW);
    await page.goto(`${server.url}?theme=${theme}&view=board&v6=1`);
    await page.locator('[data-fixture]').waitFor({ state: 'visible' });
    await page.waitForTimeout(200);
    await openItem(page, id);
    return page;
  };

  // The decision, as the mockup draws it.
  const choice = await open('A90');
  const faces = await choice.evaluate(async () => {
    await document.fonts.ready;
    const family = getComputedStyle(document.querySelector('.fy-card') ?? document.body).fontFamily;
    const loaded = [...document.fonts].filter(face => face.status === 'loaded').map(face => face.family);
    return { family, loaded };
  });
  check(
    faces.loaded.some(face => faces.family.includes(face.replaceAll('"', ''))),
    `choice ${form} ${theme}: the card is drawn in a fallback font (${faces.family}; loaded: ${faces.loaded.join(', ')})`,
  );
  await checkLayout(choice, `choice ${form} ${theme}`);
  check(
    (await choice.locator('.fy-card__top [data-agenda-dismiss]').count()) === 1,
    `choice ${form} ${theme}: Not needed is not in the card's top bar`,
  );
  check(
    ((await choice.locator('[data-agenda-version-picker]').textContent()) ?? '').includes('v2 of 2'),
    `choice ${form} ${theme}: the version picker does not say v2 of 2`,
  );
  const heights = await choice.evaluate(() =>
    ['.fy-card__top [data-agenda-dismiss]', '.fy-card__top [data-agenda-version-picker]'].map(selector =>
      Math.round(document.querySelector(selector)?.getBoundingClientRect().height ?? -1),
    ),
  );
  check(
    heights[0] === heights[1],
    `choice ${form} ${theme}: Not needed is ${heights[0]}px tall, the version picker ${heights[1]}px`,
  );
  await shot(choice, 'choice', form, theme);
  // A term opened: its meaning shows under it, inside the card (the Terms list is already open: nothing folds).
  await choice.locator('.fy-card a[href^="#fy-term-"]').nth(1).click();
  await choice.waitForTimeout(150);
  const tip = choice.locator('[data-agenda-term-tip]');
  check((await tip.count()) === 1, `terms ${form} ${theme}: a tapped term shows no meaning`);
  // A tap anywhere else closes it; then it is opened again for the picture.
  const press = (target: ReturnType<Page['locator']>) => (form === 'phone' ? target.tap() : target.click());
  // The opened meaning floats over the lines under its term, so the tap lands beside the column, where it covers nothing.
  await (form === 'phone' ? choice.touchscreen.tap(2, 60) : choice.mouse.click(2, 60));
  await choice.waitForTimeout(100);
  check((await tip.count()) === 0, `terms ${form} ${theme}: a tap elsewhere leaves the meaning open`);
  await press(choice.locator('.fy-card a[href^="#fy-term-"]').nth(1));
  await choice.waitForTimeout(150);
  check((await tip.count()) === 1, `terms ${form} ${theme}: a tapped term shows no meaning the second time`);
  await tip.scrollIntoViewIfNeeded();
  await shot(choice, 'terms', form, theme);
  // The conversation about it, at the bottom.
  await choice.mouse.click(2, 60);
  await scrollTo(choice, 'bottom');
  await checkHistory(choice, `history ${form} ${theme}`);
  await shot(choice, 'history', form, theme);
  await choice.close();

  const todo = await open('A91');
  await checkLayout(todo, `todo ${form} ${theme}`);
  check((await todo.locator('[data-agenda-section="steps"]:visible').count()) === 1, `todo ${form}: steps not drawn`);
  await shot(todo, 'todo', form, theme);
  await todo.close();

  const lettered = await open('A92');
  await checkLayout(lettered, `lettered ${form} ${theme}`);
  const names = await lettered.locator('.fy-card__option-name').allTextContents();
  check(names.join('') === 'ABCD', `lettered ${form} ${theme}: the options are named ${names.join(',')}`);
  await shot(lettered, 'lettered', form, theme);
  await lettered.close();

  const input = await open('A93');
  await checkLayout(input, `input ${form} ${theme}`);
  await shot(input, 'input', form, theme);
  await input.close();

  await browserContext.close();
};

for (const theme of THEMES) for (const form of ['desktop', 'phone'] as const) await scenes(form, theme);

await browser.close();
server.stop(true);
process.stdout.write(`${checks} checks, ${violations.length} violations\n`);
if (violations.length > 0) process.exit(1);
