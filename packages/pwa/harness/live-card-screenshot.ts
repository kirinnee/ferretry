/**
 * Screenshots and checks for the inline `card` and `board` blocks, at phone 390x844 and desktop 1440x900, light and dark,
 * in the app's own fonts.
 *
 *   bun harness/live-card-screenshot.ts [outDir]   # writes <outDir>/live-<scene>-<phone|desktop>-<theme>.png
 *
 * Scenes: `chat` (a card and a lane-grouped mini board in a message), `agenda` (a parent's children in an agenda body),
 * `error` (a missing and an unreadable card). `chat` and `agenda` are also drawn after a simulated lane move. It FAILS
 * (after writing every picture) when a page scrolls sideways, a block is not drawn, the move does not show, a missing or
 * unreadable card is drawn as a link, or a block is drawn in a fallback font.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out', 'live-card-build');
const outDir = resolve(process.argv[2] ?? '/tmp/claude-1000/shots/f559-pr9');

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
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/live-card-page.js"></script></body>
</html>`;

mkdirSync(buildDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
run('bun', ['build', join(harnessDir, 'live-card-page.tsx'), '--outdir', buildDir, '--target', 'browser']);
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

const PHONE = {
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
  userAgent:
    'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
} as const;
const DESKTOP = { viewport: { width: 1_440, height: 900 } } as const;
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
  await page.waitForTimeout(150);
  const path = join(outDir, `live-${name}-${form}-${theme}.png`);
  await page.screenshot({ path, fullPage: true });
  process.stdout.write(`📸 ${path}\n`);
};

const layout = async (page: Page, label: string): Promise<void> => {
  const found = await page.evaluate(async () => {
    await document.fonts.ready;
    const probe = document.querySelector('.fy-card-embed, [data-fy-card-embed-note]') ?? document.body;
    const family = getComputedStyle(probe).fontFamily;
    const loaded = [...document.fonts].filter(face => face.status === 'loaded').map(face => face.family);
    return {
      wide: document.documentElement.scrollWidth - window.innerWidth,
      family,
      loaded,
      fallbackRows: document.querySelectorAll('pre code').length,
    };
  });
  check(found.wide <= 0, `${label}: scrolls sideways by ${found.wide}px`);
  check(
    found.loaded.some(face => found.family.includes(face.replaceAll('"', ''))),
    `${label}: drawn in a fallback font (${found.family}; loaded: ${found.loaded.join(', ')})`,
  );
  check(found.fallbackRows === 0, `${label}: a block is drawn as a code fence`);
};

/** The mini board and the lone card sit as the Board's own: no list indent, no paragraph margins, the Board's card padding and list gap, the Board's lane head. */
const unindented = async (page: Page, label: string): Promise<void> => {
  const found = await page.evaluate(() => {
    const px = (value: string) => Number.parseFloat(value);
    const lists = [...document.querySelectorAll<HTMLElement>('.fy-board-lane__cards, .fy-card-embed-list')].map(
      list => {
        const style = getComputedStyle(list);
        const parent = list.parentElement as HTMLElement;
        return {
          indent: Math.round(
            list.getBoundingClientRect().left -
              parent.getBoundingClientRect().left -
              px(getComputedStyle(parent).paddingLeft) -
              px(getComputedStyle(parent).borderLeftWidth),
          ),
          padding: px(style.paddingLeft),
          marker: style.listStyleType,
        };
      },
    );
    const sides = (style: CSSStyleDeclaration) =>
      [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft].join(' ');
    const cards = [...document.querySelectorAll<HTMLElement>('.fy-card-embed .fy-board-card')].map(item => ({
      top: px(getComputedStyle(item).marginTop),
      bottom: px(getComputedStyle(item).marginBottom),
      padding: sides(getComputedStyle(item)),
    }));
    // The Board's own card and list, drawn outside any prose, are the reference an inline one is measured against.
    const reference = document.createElement('div');
    reference.innerHTML =
      '<ul class="fy-board-lane__cards"><li class="fy-board-card"></li><li class="fy-board-card"></li></ul>';
    document.body.append(reference);
    const referenceList = reference.querySelector<HTMLElement>('ul') as HTMLElement;
    const referenceCard = reference.querySelector<HTMLElement>('li') as HTMLElement;
    const board = {
      padding: sides(getComputedStyle(referenceCard)),
      gap: getComputedStyle(referenceList).rowGap,
    };
    reference.remove();
    const gaps = [...document.querySelectorAll<HTMLElement>('.fy-board-lane__cards, .fy-card-embed-list')].map(
      list => getComputedStyle(list).rowGap,
    );
    const head = document.querySelector<HTMLElement>('.fy-card-embed .fy-board-lane__head');
    const title = document.querySelector<HTMLElement>('.fy-card-embed .fy-board-card__title');
    return {
      lists,
      cards,
      board,
      gaps,
      headFamily: head === null ? null : getComputedStyle(head).fontFamily,
      titleFamily: title === null ? null : getComputedStyle(title).fontFamily,
      headTracking: head === null ? null : getComputedStyle(head).letterSpacing,
    };
  });
  check(found.lists.length > 0, `${label}: no card list found`);
  check(
    found.lists.every(list => list.indent === 0 && list.padding === 0 && list.marker === 'none'),
    `${label}: a card list is indented or bulleted (${JSON.stringify(found.lists)})`,
  );
  check(
    found.cards.every(card => card.top === 0 && card.bottom === 0),
    `${label}: a card carries list-item margins (${JSON.stringify(found.cards)})`,
  );
  check(
    found.cards.every(card => card.padding === found.board.padding),
    `${label}: a card is padded ${JSON.stringify(found.cards.map(card => card.padding))}, the Board's is ${found.board.padding}`,
  );
  check(
    found.gaps.every(gap => gap === found.board.gap),
    `${label}: cards sit ${JSON.stringify(found.gaps)} apart, the Board's list gap is ${found.board.gap}`,
  );
  if (found.headFamily !== null)
    check(
      found.headFamily === found.titleFamily,
      `${label}: the lane head is in ${found.headFamily}, not the body font`,
    );
  check(
    found.headTracking === null || found.headTracking === 'normal',
    `${label}: lane head tracking is ${found.headTracking}`,
  );
};

const embeds = (page: Page) => page.locator('[data-fy-card-embed]');
const laneNames = (page: Page, scope = '') => page.locator(`${scope} .fy-board-lane__name`.trim()).allTextContents();
const cardIn = (page: Page, id: string) => page.locator(`[data-task="${id}"]`).first();

const scenes = async (form: Form, theme: string): Promise<void> => {
  const context = await browser.newContext({
    ...(form === 'phone' ? PHONE : DESKTOP),
    timezoneId: 'UTC',
    locale: 'en-US',
    colorScheme: theme.endsWith('-dark') ? 'dark' : 'light',
  });
  const open = async (scene: string): Promise<Page> => {
    const page = await context.newPage();
    await page.route('**/*', route =>
      route.request().url().startsWith(server.url.origin) ? route.continue() : route.abort(),
    );
    page.on('pageerror', error => process.stderr.write(`page error: ${error.message}\n`));
    await page.goto(`${server.url}?theme=${theme}&scene=${scene}`);
    await page.locator('[data-fixture]').waitFor({ state: 'visible' });
    await page.waitForTimeout(400);
    return page;
  };
  const label = (scene: string) => `${scene} ${form} ${theme}`;

  const chat = await open('chat');
  check((await embeds(chat).count()) === 2, `${label('chat')}: wanted a card and a board block`);
  check((await chat.locator('[data-task]').count()) === 4, `${label('chat')}: wanted a card and three board cards`);
  check((await chat.locator('[data-fy-card-embed="card"] a').count()) >= 1, `${label('chat')}: the card is not a link`);
  const board = chat.locator('[data-fy-card-embed="board"]');
  check((await board.locator('[data-fy-card-embed-board]').count()) === 1, `${label('chat')}: the board has no frame`);
  const chatLanes = await laneNames(chat, '[data-fy-card-embed="board"]');
  check(chatLanes.join('|') === 'Todo|Implement|Review/CI', `${label('chat')}: board lanes are ${chatLanes.join('|')}`);
  const names = (await chat.locator('[data-task]').allTextContents()).join(' ');
  check(/Nimbus/.test(names) && !/mvuc7tsf/.test(names), `${label('chat')}: a ferret is not named by its callsign`);
  const linkColors = await chat.evaluate(() => {
    const main = document.querySelector('.fy-card-embed .fy-board-card__main') as HTMLElement | null;
    if (main === null) return null;
    const style = getComputedStyle(main);
    return { decoration: style.textDecorationLine, color: style.color, body: getComputedStyle(document.body).color };
  });
  check(
    linkColors !== null && linkColors.decoration === 'none',
    `${label('chat')}: the card body reads as a link (${linkColors?.decoration})`,
  );
  const before = (await cardIn(chat, 'F412').textContent()) ?? '';
  check(before.includes('Implement'), `${label('chat')}: F412 does not start in Implement`);
  await layout(chat, label('chat'));
  await unindented(chat, label('chat'));
  await shot(chat, 'chat-before', form, theme);
  await chat.evaluate(() => window.__moveCard());
  await chat.waitForTimeout(400);
  const after = (await cardIn(chat, 'F412').textContent()) ?? '';
  check(after.includes('Review/CI') && !after.includes('Implement'), `${label('chat')}: the move did not show`);
  await shot(chat, 'chat-after', form, theme);
  await chat.close();

  const agenda = await open('agenda');
  check(
    (await agenda.locator('[data-fy-card-embed-board]').count()) === 1,
    `${label('agenda')}: the board has no frame`,
  );
  const lanesBefore = await laneNames(agenda);
  check(lanesBefore.length === 3, `${label('agenda')}: wanted three lanes, got ${lanesBefore.join('|')}`);
  await layout(agenda, label('agenda'));
  await unindented(agenda, label('agenda'));
  await shot(agenda, 'agenda-before', form, theme);
  await agenda.evaluate(() => window.__moveCard());
  await agenda.waitForTimeout(400);
  const lanesAfter = await laneNames(agenda);
  check(
    lanesAfter.join('|') !== lanesBefore.join('|'),
    `${label('agenda')}: the lanes did not change (${lanesAfter.join('|')})`,
  );
  await shot(agenda, 'agenda-after', form, theme);
  await agenda.close();

  const error = await open('error');
  check((await error.locator('[data-fy-card-embed-note]').count()) === 2, `${label('error')}: wanted two notes`);
  check((await error.locator('[data-fy-card-embed] a').count()) === 0, `${label('error')}: a missing card is a link`);
  await layout(error, label('error'));
  await shot(error, 'error', form, theme);
  await error.close();

  await context.close();
};

for (const theme of THEMES) for (const form of ['desktop', 'phone'] as const) await scenes(form, theme);

await browser.close();
server.stop(true);
process.stdout.write(`${checks} checks, ${violations.length} violations\n`);
if (violations.length > 0) process.exit(1);
