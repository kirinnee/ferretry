/**
 * Screenshots and layout checks for the agenda in a ferret's chat: the drawer, an agenda item OPEN over the message
 * list (only the composer stays below it, its placeholder saying "Reply about !A57…"), a multi-question item, a
 * permission item, a config change, a long item scrolled mid-way, the thinking line beside the pill and, on a
 * phone, the quick replies above a faked keyboard — plus the two v4 items: a Jaeda-style item with five lettered
 * options, and a single choice whose options explain themselves in Markdown — and the v4b swipe row: items with
 * two, three and five options, the "…" menu open, a swipe up and a swipe down (skip) caught mid-drag. Desktop 1440
 * and phone 390, in the Studio theme, light and dark.
 *
 *   bun harness/agenda-v4-screenshot.ts [outDir]   # writes <outDir>/agenda-v4-<name>-<phone|desktop>-<theme>.png
 *                                                  # and <outDir>/agenda-v4c-<name>-<phone|desktop>-<theme>.png
 *
 * It bundles `agenda-page.tsx` (the real `useAgenda`, invented data), serves it on an ephemeral loopback
 * port, drives it with real clicks, and FAILS (after writing every picture) when: a page scrolls sideways; the
 * overlay's box is not the message list's box, or it covers any of the composer; the composer moves when an item
 * opens or closes; the top or the quick replies move when the body scrolls; the transcript loses its scroll
 * position; anything but the one body scrolls; the agenda pill or an "about" chip is on screen while an item is
 * open, or the composer does not say "Reply about …", or it is not directly under the card; the quick-reply row
 * holds more than three answer buttons, or a button is not in the slot of its swipe direction (← left, ↑ middle,
 * → right), or its buttons are not equal; the item view holds a <details>, a summary or a toggle; a send does not carry the item's reference, or × does not
 * return plain chat, or a send leaves the view open; a question's text is drawn twice; an option's Markdown is
 * drawn as plain text; a drawer row holds more than the row button; or a phone touch target is under 44px.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Locator, type Page } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out', 'agenda-v4-build');
const outDir = resolve(process.argv[2] ?? '/tmp/claude-1000');

const fail = (message: string): never => {
  process.stderr.write(`❌ ${message}\n`);
  process.exit(1);
};

const run = (command: string, args: readonly string[]): void => {
  const result = spawnSync(command, args, { cwd: packageDir, stdio: 'inherit' });
  if (result.status !== 0) fail(`${command} exited ${result.status}`);
};

const html = (theme: string, entry = 'agenda-page') => `<!doctype html>
<html lang="en" data-theme="${theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <link rel="stylesheet" href="/app.css" />
  </head>
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/${entry}.js"></script></body>
</html>`;

mkdirSync(buildDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
run('bun', ['build', join(harnessDir, 'agenda-page.tsx'), '--outdir', buildDir, '--target', 'browser']);
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
      return new Response(
        html(
          url.searchParams.get('theme') ?? 'studio-dark',
          url.searchParams.get('entry') === 'inbox' ? 'inbox-page' : 'agenda-page',
        ),
        {
          headers: { 'content-type': 'text/html' },
        },
      );
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

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const boxOf = async (locator: Locator, label: string): Promise<Box> => {
  const found = await locator.first().boundingBox();
  if (found === null) return fail(`${label}: not on screen`);
  return found;
};

const sameBox = (a: Box, b: Box, label: string): void =>
  check(
    (['x', 'y', 'width', 'height'] as const).every(key => Math.abs(a[key] - b[key]) < 1),
    `${label}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`,
  );

const open = async (browserContext: { newPage: () => Promise<Page> }, theme: string, query: string): Promise<Page> => {
  const page = await browserContext.newPage();
  await page.route('**/*', route =>
    route.request().url().startsWith(server.url.origin) ? route.continue() : route.abort(),
  );
  await page.clock.setFixedTime(NOW);
  await page.goto(`${server.url}?theme=${theme}&${query}`);
  await page.locator('[data-fixture]').waitFor({ state: 'visible' });
  await page.waitForTimeout(200);
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(wide <= 0, `${query}: scrolls sideways by ${wide}px`);
  return page;
};

const shot = async (page: Page, name: string, form: Form, theme: string, series = 'agenda-v4'): Promise<void> => {
  await page.mouse.move(1, 1);
  await page.waitForTimeout(120);
  const path = join(outDir, `${series}-${name}-${form}-${theme}.png`);
  // A page that mounts the theme picker publishes the theme it resolves itself (`useTheme`): a "-dark" shot that
  // is really light is a lie, so every picture is checked against the theme it is named for.
  const shown = await page.evaluate(() => document.documentElement.dataset.theme ?? '');
  check(shown === theme, `${series}-${name} ${form}: drawn in ${shown}, named ${theme}`);
  await page.screenshot({ path });
  process.stdout.write(`📸 ${path}\n`);
};

const composerBox = (page: Page): Promise<Box> => boxOf(page.locator('[data-agenda-harness-composer]'), 'composer');

const openDrawer = async (page: Page): Promise<void> => {
  await page.locator('[data-agenda-line-toggle]').click();
  await page.locator('[data-agenda-drawer]').waitFor({ state: 'visible' });
  await page.waitForTimeout(150);
};

/** The sizes the overlay's own checks read. */
const overlay = (page: Page) => page.locator('[data-agenda-view]');

/** The row is the swipe row: at most three answer buttons, each at the start of the slot of its direction. */
const SLOT = { left: 0, up: 1, right: 2 } as const;
const checkSlots = async (page: Page, label: string): Promise<void> => {
  const found = await page.evaluate(() => {
    const row = document.querySelector<HTMLElement>('[data-agenda-quick-replies] .fy-qr__row');
    if (row === null) return null;
    const style = getComputedStyle(row);
    const gap = Number.parseFloat(style.columnGap) || 0;
    const at = row.getBoundingClientRect();
    const column = document.querySelector('.fy-item-view__column')?.getBoundingClientRect() ?? null;
    const kids = [...row.children].map(child => child.getBoundingClientRect());
    const holes = kids.slice(1).map((box, index) => box.left - (kids[index]?.right ?? box.left) - gap);
    return {
      slotted: row.hasAttribute('data-slots'),
      holes,
      edges: column === null ? null : { left: at.left - column.left, right: column.right - at.right },
      dismissLast:
        row.querySelector('[data-agenda-dismiss]') === null ||
        row.lastElementChild?.hasAttribute('data-agenda-dismiss') === true,
      buttons: [...row.querySelectorAll<HTMLElement>('[data-agenda-answer]')].map(button => ({
        direction: button.dataset.agendaAnswer ?? '',
        x: button.getBoundingClientRect().left,
        letter: button.textContent?.trim() ?? '',
      })),
    };
  });
  if (found === null || !found.slotted) return;
  check(found.buttons.length <= 3, `${label}: the row holds ${found.buttons.length} answer buttons`);
  // Positions follow the swipe: read left to right, the buttons' directions run ← ↑ →. (A slot may grow past its
  // equal share to hold its longest word, so an exact x is not the rule — the order is.)
  const order = [...found.buttons].sort((a, b) => a.x - b.x).map(button => SLOT[button.direction as keyof typeof SLOT]);
  check(
    order.every((slot, index) => slot !== undefined && (index === 0 || slot > (order[index - 1] ?? -1))),
    `${label}: the row is not in ← ↑ → order: ${found.buttons.map(button => button.direction).join(', ')}`,
  );
  // No holes: a direction with no answer draws nothing, the buttons share the width.
  check(
    found.holes.every(hole => hole <= 1.5),
    `${label}: the row has a hole: ${found.holes.map(hole => Math.round(hole)).join(', ')}px past the gap`,
  );
  check(found.dismissLast, `${label}: "Not needed" is not the last thing in the row`);
  // Inside the content column, on the card body's edges.
  check(
    found.edges !== null && Math.abs(found.edges.left) <= 1 && Math.abs(found.edges.right) <= 1,
    `${label}: the row is off the body's edges by ${JSON.stringify(found.edges)}`,
  );
};

/** Nothing in an item view folds: no disclosure, no summary, no toggle, nothing expandable in the body. */
const checkNoFolds = async (page: Page, label: string): Promise<void> => {
  const folds = await page.evaluate(() => {
    const view = document.querySelector('[data-agenda-view]');
    if (view === null) return ['no item view'];
    const found = [...view.querySelectorAll('details, summary, [data-agenda-history-toggle]')];
    const body = view.querySelector('.fy-item-view__body');
    // A diagram's own source toggle (fy-render) is a tool on the picture, not a fold of the item.
    const expandable =
      body === null ? [] : [...body.querySelectorAll('[aria-expanded]:not(.fy-render-tool):not(.fy-receipt)')];
    return [...found, ...expandable].map(node => `${node.tagName.toLowerCase()}.${node.className}`);
  });
  check(folds.length === 0, `${label}: the item view folds something: ${folds.join(', ')}`);
};

const checkOverlay = async (page: Page, form: Form, label: string, composerRest: Box): Promise<void> => {
  await overlay(page).waitFor({ state: 'visible' });
  const log = await boxOf(page.locator('.fy-chat-log'), 'message list');
  sameBox(await boxOf(overlay(page), 'overlay'), log, `${label}: the overlay is not the message list`);
  sameBox(await composerBox(page), composerRest, `${label}: opening the item moved the composer`);
  const composerFree = await page.evaluate(() => {
    const composer = document.querySelector('[data-agenda-harness-composer]');
    const view = document.querySelector('[data-agenda-view]');
    if (composer === null || view === null) return false;
    const at = composer.getBoundingClientRect();
    const hit = document.elementFromPoint(at.x + at.width / 2, at.y + at.height / 2);
    return hit !== null && composer.contains(hit) && !view.contains(hit);
  });
  check(composerFree, `${label}: the composer is covered by the view`);
  const only = await page.evaluate(() => {
    const view = document.querySelector('[data-agenda-view]');
    if (view === null) return [];
    return [view, ...view.querySelectorAll('*')]
      .filter(node => {
        const style = getComputedStyle(node);
        const scrolls = ['auto', 'scroll'].includes(style.overflowY) || ['auto', 'scroll'].includes(style.overflowX);
        return scrolls && node.scrollHeight > node.clientHeight + 1;
      })
      .filter(node => !node.closest('[data-fy-render], .fy-render'))
      .map(node => (node.getAttribute('data-agenda-body') !== null ? 'body' : node.className.toString()));
  });
  check(
    only.every(name => name === 'body'),
    `${label}: scrolls somewhere other than the body: ${only.join(', ')}`,
  );
  const body = page.locator('.fy-item-view__body');
  const sideways = await body.evaluate(node => node.scrollWidth - node.clientWidth);
  check(sideways <= 1, `${label}: the body scrolls sideways by ${sideways}px`);
  const topBox = await boxOf(page.locator('[data-agenda-top]'), 'top');
  check(topBox.y >= log.y - 1, `${label}: the top starts above the message list`);
  check((await page.locator('[data-agenda-chip]').count()) === 0, `${label}: an "about" chip is on screen`);
  check((await page.locator('[data-agenda-line-toggle]').count()) === 0, `${label}: the agenda pill is on screen`);
  const placeholder = await page.locator('[data-agenda-harness-input]').getAttribute('placeholder');
  check(/^Reply about !A\d+…$/u.test(placeholder ?? ''), `${label}: the placeholder is "${placeholder}"`);
  const card = await boxOf(overlay(page), 'overlay');
  const composerNow = await composerBox(page);
  const gap = composerNow.y - (card.y + card.height);
  check(gap >= -1 && gap <= 24, `${label}: the composer is ${Math.round(gap)}px from the card`);
  const row = page.locator('[data-agenda-quick-replies] .fy-qr__row:not(.fy-qr__more)');
  if ((await row.count()) > 0) {
    const buttons = await row.locator('button').all();
    const boxes = (await Promise.all(buttons.map(button => button.boundingBox()))).filter(
      (found): found is Box => found !== null,
    );
    await checkSlots(page, label);
    // Every label is whole: never clipped, never broken inside a word ("Postgre / s").
    const clipped = await row.evaluate(element =>
      [...element.querySelectorAll<HTMLElement>('.fy-qr__label')]
        .filter(text => text.scrollWidth > text.clientWidth + 1)
        .map(text => text.textContent ?? ''),
    );
    check(clipped.length === 0, `${label}: a quick-reply label does not fit its button: ${clipped.join(', ')}`);
    check(new Set(boxes.map(box => Math.round(box.y))).size === 1, `${label}: the quick replies are not one row`);
  }
  await checkNoFolds(page, label);
  check(
    !((await overlay(page).textContent()) ?? '').includes('message box below'),
    `${label}: the "message box below" boilerplate is back`,
  );
  if (form === 'phone') {
    for (const button of await page.locator('[data-agenda-top] button').all()) {
      const rect = await button.boundingBox();
      if (rect !== null)
        check(
          rect.height >= 43.5 || rect.width >= 43.5,
          `${label}: a touch target is ${Math.round(rect.width)}x${Math.round(rect.height)}`,
        );
    }
    for (const button of await page.locator('[data-agenda-quick-replies] button').all()) {
      const rect = await button.boundingBox();
      if (rect !== null)
        check(rect.height >= 35.5, `${label}: a quick reply is ${Math.round(rect.width)}x${Math.round(rect.height)}`);
    }
  }
};

const openItem = async (page: Page, id: string): Promise<void> => {
  await openDrawer(page);
  await page.locator(`[data-agenda-drawer] [data-agenda-row="${id}"]`).click();
  await overlay(page).waitFor({ state: 'visible' });
  await page.waitForTimeout(200);
};

const scenes = async (form: Form, theme: string): Promise<void> => {
  // The OS colour scheme matches the theme: with no stored choice, the app's theme follows it (`useTheme`).
  const browserContext = await browser.newContext({
    ...(form === 'phone' ? PHONE : DESKTOP),
    ...LOCALE,
    colorScheme: theme.endsWith('-dark') ? 'dark' : 'light',
  });
  const phone = form === 'phone';

  // the pill alone, the drawer, and the composer not moving for either
  const plain = await open(browserContext, theme, 'view=board');
  const composerRest = await composerBox(plain);
  await shot(plain, 'pill-alone', form, theme);
  const line = await boxOf(plain.locator('[data-agenda-line-toggle]'), 'the pill');
  await openDrawer(plain);
  sameBox(await composerBox(plain), composerRest, 'the drawer moved the composer');
  const rows = await plain.locator('[data-agenda-row]').all();
  check(rows.length >= 3, `the drawer has ${rows.length} rows`);
  for (const row of rows) {
    const extra = await row.evaluate(node => node.querySelectorAll('button, a, input, [role=button]').length);
    check(extra === 0, 'a drawer row holds more than the row button');
    if (phone) check(((await row.boundingBox())?.height ?? 0) >= 44, 'a drawer row is under 44px');
  }
  // no coloured rail or stripe on the left of anything in the drawer: a left border wider than 1px that the right one does not share
  const rails = await plain.locator('[data-agenda-drawer], [data-agenda-drawer] *').evaluateAll(nodes =>
    nodes
      .map(node => getComputedStyle(node))
      .filter(
        style =>
          Number.parseFloat(style.borderLeftWidth) > 1 &&
          style.borderLeftStyle !== 'none' &&
          style.borderLeftColor !== 'rgba(0, 0, 0, 0)' &&
          (style.borderLeftWidth !== style.borderRightWidth || style.borderLeftColor !== style.borderRightColor),
      )
      .map(style => `${style.borderLeftWidth} ${style.borderLeftColor}`),
  );
  check(rails.length === 0, `the drawer has a left rail: ${rails.join(', ')}`);
  await shot(plain, 'drawer', form, theme);
  await plain.close();

  // the thinking line and the pill: ONE row, thinking left, pill right, the composer where it was
  const thinking = await open(browserContext, theme, 'view=board&live=1');
  sameBox(await composerBox(thinking), composerRest, 'the thinking line moved the composer');
  const live = await boxOf(thinking.locator('[data-agenda-live]'), 'the thinking line');
  const pill = await boxOf(thinking.locator('[data-agenda-line-toggle]'), 'the pill');
  check(
    Math.abs(live.y + live.height / 2 - (pill.y + pill.height / 2)) < 4,
    'the thinking line and the pill are not on one row',
  );
  check(live.x < pill.x, 'the thinking line is not left of the pill');
  check(Math.abs(pill.height - line.height) < 2, 'the row wrapped when the thinking line joined the pill');
  await shot(thinking, 'row-thinking-and-pill', form, theme);
  await thinking.close();

  // a choice item: the composer stays (its placeholder names the item), a typed message goes out WITH the reference and closes the view
  const choice = await open(browserContext, theme, 'view=board&history=1');
  await openItem(choice, 'A5');
  await checkOverlay(choice, form, 'choice item', composerRest);
  check((await choice.locator('table[data-agenda-terms]').count()) === 1, 'the terms are not a table');
  const toEnd = (): Promise<void> =>
    choice.locator('.fy-item-view__body').evaluate(node => {
      node.scrollTop = node.scrollHeight;
    });
  await toEnd();
  check((await choice.locator('[data-agenda-history] li').count()) >= 4, 'the history shows fewer than 4 rows, open');
  const hidden = await choice
    .locator('[data-agenda-history] li')
    .evaluateAll(nodes => nodes.filter(node => node.getBoundingClientRect().height === 0).length);
  check(hidden === 0, `the history hides ${hidden} rows`);
  await shot(choice, 'item-history', form, theme);
  await choice.locator('[data-agenda-harness-input]').fill('Leaning SQLite, but keep the nightly export.');
  await choice.locator('.fy-item-view__body').evaluate(node => {
    node.scrollTop = 0;
  });
  await shot(choice, 'item-composer-typed', form, theme);
  sameBox(await composerBox(choice), composerRest, 'typing moved the composer');
  await choice.locator('[data-agenda-harness-send]').click();
  await choice.waitForTimeout(150);
  check((await overlay(choice).count()) === 0, 'a send left the item view open');
  const sentBubble = choice.locator('[data-chat-sent]').last();
  const sentText = (await sentBubble.textContent()) ?? '';
  check(sentText.includes('A5'), `the send did not carry the reference: ${sentText}`);
  check((await sentBubble.locator('[data-agenda-message]').count()) === 1, 'the reply did not draw as its agenda card');
  sameBox(await composerBox(choice), composerRest, 'closing the view moved the composer');
  await shot(choice, 'after-send', form, theme);
  await choice.close();

  // × on the card means plain chat (the pill is back, the normal placeholder), Esc does the same; a quick reply answers AND closes
  const plainSend = await open(browserContext, theme, 'view=board&agenda=A3');
  await overlay(plainSend).waitFor({ state: 'visible' });
  await plainSend.locator('[data-agenda-close]').click();
  check((await overlay(plainSend).count()) === 0, 'the × did not close the card');
  check((await plainSend.locator('[data-agenda-line-toggle]').count()) === 1, 'the pill did not come back');
  check(
    !/^Reply about/u.test((await plainSend.locator('[data-agenda-harness-input]').getAttribute('placeholder')) ?? ''),
    'the placeholder still says Reply about',
  );
  await plainSend.locator('[data-agenda-harness-input]').fill('Unrelated: how is the build?');
  await plainSend.locator('[data-agenda-harness-send]').click();
  const plainText = (await plainSend.locator('[data-chat-sent]').last().textContent()) ?? '';
  check(!plainText.includes('!A3'), `a plain send carried a reference: ${plainText}`);
  await plainSend.close();
  const answered = await open(browserContext, theme, 'view=board&agenda=A3');
  await overlay(answered).waitFor({ state: 'visible' });
  await answered.locator('[data-agenda-answer]').first().click();
  await answered.waitForTimeout(250);
  check((await overlay(answered).count()) === 0, 'a quick reply did not close the view');
  await answered.close();

  // the multi-question item, as the ferret wrote it (no options) and with options and a recommendation
  for (const id of ['A47', 'A48'] as const) {
    const multi = await open(browserContext, theme, `view=board&jaeda=1&agenda=${id}`);
    await overlay(multi).waitFor({ state: 'visible' });
    await checkOverlay(multi, form, `multi-question ${id}`, composerRest);
    const text = (await overlay(multi).textContent()) ?? '';
    // A47 is Jaeda's item word for word; A48 the same three questions written with options.
    const questions =
      id === 'A47'
        ? ['.dockerignore has', 'merge tool rebuilds nix/yaml lists', 'each template ships only the files']
        : ['duplicate retry line', 'rename of carrier', 'the other two relay files'];
    for (const question of questions) {
      const count = text.split(question).length - 1;
      check(count === 1, `${id}: "${question}" is drawn ${count} times`);
    }
    check(!/Answer this one in the message box/u.test(text), `${id}: per-question boilerplate is back`);
    if (id === 'A47') check(!/Why it matters/u.test(text), 'A47: the ferret picks read as Why it matters');
    if (id === 'A48') {
      check((await overlay(multi).locator('[data-recommended]').count()) >= 3, 'the recommended picks are not tagged');
      await multi.locator('[data-agenda-use-recommended]').click();
      await multi.waitForTimeout(100);
    }
    await shot(multi, id === 'A47' ? 'item-multi-question' : 'item-multi-structured', form, theme);
    await multi.close();
  }

  // v4: a Jaeda-style item — five lettered options, one recommended — and a single choice explained in Markdown
  for (const [id, name] of [
    ['A60', 'jaeda-options'],
    ['A61', 'choice-markdown'],
  ] as const) {
    const v4 = await open(browserContext, theme, `view=board&v4=1&agenda=${id}`);
    await overlay(v4).waitFor({ state: 'visible' });
    await v4.waitForTimeout(150);
    await checkOverlay(v4, form, `v4 ${id}`, composerRest);
    const options = v4.locator('[data-agenda-option-detail]');
    check((await options.count()) >= 3, `${id}: the options section has ${await options.count()} entries`);
    const heads = await options.locator('strong').first().textContent();
    check(/^A — /u.test(heads ?? ''), `${id}: the first option is headed "${heads}"`);
    check((await v4.locator('[data-agenda-recommended]').count()) >= 1, `${id}: no option is marked Recommended`);
    check((await options.locator('code').count()) >= 1, `${id}: option details drew no code span`);
    check((await options.locator('strong').count()) >= 3, `${id}: option details drew no bold`);
    const text = (await overlay(v4).textContent()) ?? '';
    const leaked = /.{0,12}(?:[`]|\*\*).{0,12}/u.exec(text)?.[0];
    check(leaked === undefined, `${id}: Markdown marks leaked into the card: ${leaked}`);
    if (id === 'A61') check((await options.locator('a[href]').count()) >= 1, 'A61: the option link is not a link');
    const buttons = await v4.locator('[data-agenda-quick-replies] .fy-qr__row button[data-agenda-option]').all();
    const letters = await Promise.all(buttons.map(button => button.textContent()));
    check(
      letters.some(letter => /^\s*[A-E]\s*$/u.test(letter ?? '')),
      `${id}: no quick reply is a bare letter: ${letters.join('|')}`,
    );
    for (const button of buttons)
      check(((await button.getAttribute('title')) ?? '').length > 0, `${id}: a quick reply has no title`);
    await shot(v4, name, form, theme);
    await v4.close();
  }

  // v4b: the swipe row by direction — 2, 3 and 5 options, the menu open on five, and the jaeda options item
  const V4B = [
    { id: 'A8', name: 'todo-2', answers: ['left', 'right'], plain: true },
    { id: 'A62', name: 'options-2', answers: ['left', 'up'] },
    { id: 'A63', name: 'options-3', answers: ['left', 'up', 'right'] },
    { id: 'A64', name: 'options-5', answers: ['left', 'up', 'right'], extras: 2 },
    { id: 'A65', name: 'options-7', answers: ['left', 'up', 'right'], extras: 4 },
    { id: 'A60', name: 'jaeda-options', answers: ['left', 'up', 'right'], extras: 2 },
  ] as const;
  for (const entry of V4B) {
    const page = await open(browserContext, theme, `view=board&v4=1&agenda=${entry.id}`);
    await overlay(page).waitFor({ state: 'visible' });
    await page.waitForTimeout(150);
    const label = `v4b ${entry.id}`;
    await checkOverlay(page, form, label, composerRest);
    const directions = await page
      .locator('[data-agenda-quick-replies] .fy-qr__row [data-agenda-answer]')
      .evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.agendaAnswer));
    check(
      JSON.stringify(directions) === JSON.stringify(entry.answers),
      `${label}: the row answers are ${directions.join(',')}, wanted ${entry.answers.join(',')}`,
    );
    const plainChips = await page
      .locator('.fy-qr__row[data-slots] button[data-agenda-option]:not([data-agenda-answer])')
      .count();
    check(plainChips === 0, `${label}: ${plainChips} option buttons sit outside the three slots`);
    check(
      (await page.locator('[aria-haspopup="menu"]:not([data-agenda-snooze])').count()) === 0,
      `${label}: a "…" menu is still drawn`,
    );
    // Options past the three: the rows under the swipe row, tap only, each row filling the width.
    const more = page.locator('[data-agenda-more-row]');
    const wanted = 'extras' in entry ? entry.extras : 0;
    const extraButtons = (await more.count()) === 0 ? 0 : await more.locator('button').count();
    check(extraButtons === wanted, `${label}: ${extraButtons} buttons under the swipe row, wanted ${wanted}`);
    if (wanted > 0) {
      const fill = await more.evaluate(row => {
        const box = row.getBoundingClientRect();
        const buttons = [...row.querySelectorAll('button')].map(button => button.getBoundingClientRect());
        const rows = new Map<number, { left: number; right: number }>();
        for (const b of buttons) {
          const at = Math.round(b.top);
          const seen = rows.get(at);
          rows.set(at, {
            left: Math.min(seen?.left ?? b.left, b.left),
            right: Math.max(seen?.right ?? b.right, b.right),
          });
        }
        return [...rows.values()].every(r => r.left - box.left < 2 && box.right - r.right < 2);
      });
      check(fill, `${label}: a row of extra options does not fill the width`);
    }
    if (!('plain' in entry))
      check(
        (await page.locator('.fy-qr__row [data-agenda-answer="up"][data-recommended]').count()) === 1,
        `${label}: the recommended answer is not in the middle slot`,
      );
    // THE ROOM IT TAKES (owner: "doesn't waste so much god damn space"): the sticky actions and the composer.
    const qrTop = (await boxOf(page.locator('[data-agenda-quick-replies]'), 'quick replies')).y;
    const composer = await boxOf(page.locator('[data-agenda-harness-composer]'), 'composer');
    const actions = Math.round(composer.y + composer.height - qrTop);
    // One row of actions has a budget; options past three add their own rows on purpose (approved).
    const room = phone ? 140 : 130;
    if (wanted === 0)
      check(actions <= room, `${label}: the actions and the composer take ${actions}px, over ${room}px`);
    if (phone) {
      const head = Math.round((await boxOf(page.locator('[data-agenda-top]'), 'head')).height);
      check(head <= 56, `${label}: the phone head is ${head}px tall, over 56px`);
      console.log(`📏 ${label} ${form} ${theme}: head ${head}px, actions + composer ${actions}px`);
    } else console.log(`📏 ${label} ${form} ${theme}: actions + composer ${actions}px`);
    await shot(page, entry.name, form, theme, 'agenda-v4c');
    // a touch swipe, caught mid-drag: ↑ answers the middle one, ↓ skips to the next item (phone only: a mouse does not swipe)
    if (phone && entry.id === 'A63') {
      const drag = async (dy: number): Promise<void> => {
        await page.evaluate(offset => {
          const lane = document.querySelector<HTMLElement>('.fy-qr');
          if (lane === null) return;
          const at = lane.getBoundingClientRect();
          const x = at.left + at.width / 2;
          const y = at.top + at.height / 2;
          const event = (type: string, to: number) =>
            new PointerEvent(type, { bubbles: true, clientX: x, clientY: to, pointerId: 11, pointerType: 'touch' });
          lane.dispatchEvent(event('pointerdown', y));
          lane.dispatchEvent(event('pointermove', y + offset));
        }, dy);
        await page.waitForTimeout(150);
      };
      await drag(-70);
      check((await page.locator('.fy-qr__stamp').count()) === 0, `${label}: a floating label shows while swiping up`);
      await shot(page, 'swipe-up', form, theme, 'agenda-v4c');
      await page.evaluate(() => {
        document
          .querySelector('.fy-qr')
          ?.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 11, pointerType: 'touch' }));
      });
      await drag(80);
      check((await page.locator('.fy-qr__stamp').count()) === 0, `${label}: a floating label shows while swiping down`);
      await shot(page, 'swipe-down', form, theme, 'agenda-v4c');
      await page.evaluate(() => {
        const lane = document.querySelector('.fy-qr');
        if (lane === null) return;
        const at = lane.getBoundingClientRect();
        const to = (type: string) =>
          new PointerEvent(type, {
            bubbles: true,
            clientX: at.left + at.width / 2,
            clientY: at.top + at.height / 2 + 300,
            pointerId: 11,
            pointerType: 'touch',
          });
        lane.dispatchEvent(to('pointermove'));
        lane.dispatchEvent(to('pointerup'));
      });
      await page.waitForTimeout(250);
      const now = await overlay(page).getAttribute('data-agenda-view');
      check(now !== 'A63', `${label}: the pull down did not skip to the next item (still ${now})`);
    }
    await page.close();
  }

  // a permission item
  const permission = await open(browserContext, theme, 'view=board&history=1');
  await openItem(permission, 'A2');
  await checkOverlay(permission, form, 'permission item', composerRest);
  await shot(permission, 'item-permission', form, theme);
  await permission.close();

  // a permission item that confirms a config change: the change block, no premise
  const change = await open(browserContext, theme, 'view=board&history=1&config=1');
  await openItem(change, 'A2');
  await checkOverlay(change, form, 'config-change item', composerRest);
  check((await change.locator('[data-agenda-confirms="warden.yaml"]').count()) === 1, 'the config change is not drawn');
  check(
    !((await overlay(change).textContent()) ?? '').includes("What's going on"),
    'the premise is drawn beside the change',
  );
  await shot(change, 'item-config-change', form, theme);
  await change.close();

  // a LONG item scrolled mid-way: top and quick replies stay put, the transcript keeps its scroll, only the body scrolls
  const longPage = await open(browserContext, theme, 'view=board&long=1');
  await longPage.evaluate(() => {
    const log = document.querySelector('.fy-chat-log > div');
    if (log !== null) log.scrollTop = 40;
  });
  const chatBefore = await longPage.evaluate(() => document.querySelector('.fy-chat-log > div')?.scrollTop ?? -1);
  await openItem(longPage, 'A5');
  await checkOverlay(longPage, form, 'long item', composerRest);
  const topBefore = await boxOf(longPage.locator('[data-agenda-top]'), 'top');
  const barBefore = await boxOf(longPage.locator('[data-agenda-quick-replies]'), 'quick replies');
  const body = longPage.locator('.fy-item-view__body');
  const room = await body.evaluate(node => node.scrollHeight - node.clientHeight);
  check(room > 200, `the long item barely scrolls (${room}px)`);
  await body.evaluate(node => {
    node.scrollTop = (node.scrollHeight - node.clientHeight) / 2;
  });
  await longPage.waitForTimeout(150);
  check((await body.evaluate(node => node.scrollTop)) > 100, 'the body did not scroll');
  sameBox(await boxOf(longPage.locator('[data-agenda-top]'), 'top'), topBefore, 'the top moved when the body scrolled');
  sameBox(
    await boxOf(longPage.locator('[data-agenda-quick-replies]'), 'quick replies'),
    barBefore,
    'the quick replies moved when the body scrolled',
  );
  sameBox(await composerBox(longPage), composerRest, 'scrolling the body moved the composer');
  const chatAfter = await longPage.evaluate(() => document.querySelector('.fy-chat-log > div')?.scrollTop ?? -1);
  check(chatAfter === chatBefore, `the transcript lost its scroll position: ${chatBefore} -> ${chatAfter}`);
  await shot(longPage, 'item-long-scrolled', form, theme);
  await longPage.close();

  // a phone with a keyboard: the composer and the quick replies ride above it
  if (phone) {
    const keyboard = await open(browserContext, theme, 'view=board&attention=A5&history=1&kb=1');
    await overlay(keyboard).waitFor({ state: 'visible' });
    const composer = await composerBox(keyboard);
    const fixture = await boxOf(keyboard.locator('[data-fixture]'), 'fixture');
    check(composer.y + composer.height <= fixture.y + fixture.height + 1, 'the composer sits below the keyboard line');
    await shot(keyboard, 'item-keyboard', form, theme);
    await keyboard.close();
  }

  // a deep link opens the item with no drawer
  const deep = await open(browserContext, theme, 'view=board&agenda=A3');
  await overlay(deep).waitFor({ state: 'visible' });
  check((await overlay(deep).getAttribute('data-agenda-view')) === 'A3', '?agenda=A3 did not open A3');
  await deep.close();
  const old = await open(browserContext, theme, 'view=board&attention=A3');
  await overlay(old).waitFor({ state: 'visible' });
  check((await overlay(old).getAttribute('data-agenda-view')) === 'A3', '?attention=A3 did not open A3');
  await old.close();

  // SNOOZE: the clock in the item view's pager opens a menu that is whole, on top, and reachable by touch
  const withParked = await open(browserContext, theme, 'view=board&parked=1');
  const withoutParked = await open(browserContext, theme, 'view=board');
  const lineText = (await withParked.locator('[data-agenda-line]').textContent()) ?? '';
  check(
    lineText === ((await withoutParked.locator('[data-agenda-line]').textContent()) ?? ''),
    `parked items changed the agenda line: "${lineText}"`,
  );
  await withoutParked.close();
  await openDrawer(withParked);
  check(
    (await withParked.locator('[data-agenda-row="A70"], [data-agenda-row="A71"]').count()) === 0,
    'a parked item is listed in the drawer',
  );
  await withParked.close();
  const parkedBoard = await open(browserContext, theme, 'view=board&parked=1&agenda=A3');
  await overlay(parkedBoard).waitFor({ state: 'visible' });
  const clock = parkedBoard.locator('[data-agenda-view="A3"] [data-agenda-snooze]');
  check((await clock.count()) === 1, 'the item view has no snooze clock');
  const clockBox = await boxOf(clock, 'the snooze clock');
  if (phone)
    check(
      clockBox.width >= 43.5 || clockBox.height >= 43.5,
      `the clock is ${Math.round(clockBox.width)}x${Math.round(clockBox.height)}`,
    );
  await clock.click();
  const menu = parkedBoard.locator('[role="menu"]');
  await menu.waitFor({ state: 'visible' });
  await parkedBoard.waitForTimeout(150);
  const items = await menu.locator('[role="menuitem"]').allTextContents();
  check(
    JSON.stringify(items.map(text => text.trim())) ===
      JSON.stringify(['1 hour', '4 hours', 'Tomorrow 9:00', 'Custom…']),
    `the snooze menu says: ${items.join(' | ')}`,
  );
  const menuBox = await boxOf(menu, 'the snooze menu');
  const screen = parkedBoard.viewportSize();
  check(
    menuBox.x >= -1 &&
      menuBox.y >= -1 &&
      menuBox.x + menuBox.width <= (screen?.width ?? 0) + 1 &&
      menuBox.y + menuBox.height <= (screen?.height ?? 0) + 1,
    `the snooze menu leaves the screen: ${JSON.stringify(menuBox)}`,
  );
  const onTop = await menu.locator('[role="menuitem"]').evaluateAll(nodes =>
    nodes.every(node => {
      const at = node.getBoundingClientRect();
      const hit = document.elementFromPoint(at.x + at.width / 2, at.y + at.height / 2);
      return hit !== null && node.contains(hit);
    }),
  );
  check(onTop, 'something sits over the snooze menu');
  if (phone)
    for (const entry of await menu.locator('[role="menuitem"]').all())
      check(((await entry.boundingBox())?.height ?? 0) >= 43.5, 'a snooze menu item is under 44px');
  await shot(parkedBoard, 'snooze-menu', form, theme, 'agenda-snooze');
  await menu.locator('[role="menuitem"]').last().click();
  const custom = parkedBoard.locator('input[type="datetime-local"]');
  await custom.waitFor({ state: 'visible' });
  await custom.fill('2026-10-01T09:00');
  await parkedBoard.locator('[data-snooze-custom] button[type="submit"]').click();
  check((await parkedBoard.locator('[role="alert"]').count()) >= 1, 'a past custom time was not refused');
  await shot(parkedBoard, 'snooze-custom-refused', form, theme, 'agenda-snooze');
  await parkedBoard.keyboard.press('Escape');
  await parkedBoard.waitForTimeout(100);
  check((await parkedBoard.locator('[role="menu"]').count()) === 0, 'Esc did not close the snooze menu');
  await parkedBoard.locator('[data-agenda-view="A3"] [data-agenda-snooze]').click();
  await parkedBoard.locator('[role="menuitem"]').first().click();
  await parkedBoard.waitForTimeout(250);
  check((await parkedBoard.locator('[data-agenda-view="A3"]').count()) === 0, 'snoozing did not leave the item');
  await parkedBoard.close();

  // SNOOZED and REPLIED: the Inbox lists each, says where it stands, and the open list never shows them
  const inbox = await open(browserContext, theme, 'entry=inbox&view=sections');
  const openRows = await inbox.locator('[data-agenda-row]').count();
  check(openRows > 0, 'the inbox has no open rows');
  check((await inbox.locator('[data-agenda-parked]').count()) === 0, 'a parked item is on the open list');
  check(
    (await inbox.locator('[data-agenda-filter-option="snoozed"]').textContent()) === 'Snoozed (2)',
    'the Snoozed filter does not say 2',
  );
  check(
    (await inbox.locator('[data-agenda-filter-option="replied"]').textContent()) === 'Replied (1)',
    'the Replied filter does not say 1',
  );
  for (const [which, rowsWanted, words, button] of [
    ['snoozed', 2, /^Snoozed until /u, 'Unsnooze'],
    ['replied', 1, /^Replied .* — waiting on /u, 'Back to my list'],
  ] as const) {
    await inbox.locator(`[data-agenda-filter-option="${which}"]`).click();
    await inbox.waitForTimeout(200);
    const rows = inbox.locator('[data-agenda-parked]');
    check((await rows.count()) === rowsWanted, `${which}: ${await rows.count()} rows, wanted ${rowsWanted}`);
    for (const status of await inbox.locator('[data-agenda-parked-status]').allTextContents())
      check(words.test(status.trim()), `${which}: a row says "${status}"`);
    const act = inbox.locator(`[data-agenda-unsnooze="${which}"]`);
    check((await act.count()) === rowsWanted, `${which}: no "${button}" button on a row`);
    check(((await act.first().textContent()) ?? '').trim() === button, `${which}: the button is not "${button}"`);
    const wide = await inbox.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(wide <= 0, `${which}: the page scrolls sideways by ${wide}px`);
    if (phone) check(((await act.first().boundingBox())?.height ?? 0) >= 35.5, `${which}: the button is under 36px`);
    await shot(inbox, `${which}-filter`, form, theme, 'agenda-snooze');
  }
  await inbox.close();

  // THE OPEN INBOX CARD: a margin from the panel's edges and from the composer, and a swipe that starts mid-card
  const card = await open(browserContext, theme, 'entry=inbox&view=open');
  await card.locator('.fy-attn-deck__top .fy-inbox-open').waitFor({ state: 'visible' });
  const panel = await boxOf(card.locator('main[data-agenda-inbox="card"]'), 'inbox panel');
  const at = await boxOf(card.locator('.fy-attn-deck__top .fy-inbox-open'), 'inbox card');
  const composer = await boxOf(card.locator('[data-inbox-composer]'), 'inbox composer');
  const side = phone ? 12 : 8;
  check(
    at.x - panel.x >= side,
    `inbox ${form}: the card is ${Math.round(at.x - panel.x)}px from the panel's left edge, under ${side}px`,
  );
  check(
    panel.x + panel.width - (at.x + at.width) >= side,
    `inbox ${form}: the card is ${Math.round(panel.x + panel.width - (at.x + at.width))}px from the panel's right edge, under ${side}px`,
  );
  check(
    composer.y - (at.y + at.height) >= 8,
    `inbox ${form}: the card is ${Math.round(composer.y - (at.y + at.height))}px above the composer, under 8px`,
  );
  console.log(
    `📏 inbox ${form} ${theme}: card ${Math.round(at.x - panel.x)}px from the left edge, ${Math.round(panel.x + panel.width - (at.x + at.width))}px from the right`,
  );
  await shot(card, 'card', form, theme, 'inbox');
  if (phone) {
    const touch = (type: string, dx: number, dy: number) =>
      card.evaluate(
        ([kind, x, y]) => {
          const body = document.querySelector<HTMLElement>('.fy-attn-deck__top [data-agenda-body]');
          if (body === null) return;
          const at = body.getBoundingClientRect();
          body.dispatchEvent(
            new PointerEvent(kind as string, {
              bubbles: true,
              cancelable: true,
              clientX: at.left + at.width / 2 + (x as number),
              clientY: at.top + at.height / 2 + (y as number),
              pointerId: 21,
              pointerType: 'touch',
            }),
          );
        },
        [type, dx, dy] as const,
      );
    const dragging = () => card.locator('.fy-attn-deck__top[data-dragging]').count();
    // a vertical start in the body is the reader scrolling: the card stays put
    await touch('pointerdown', 0, 0);
    await touch('pointermove', 2, -40);
    await card.waitForTimeout(100);
    check((await dragging()) === 0, 'inbox phone: a vertical drag from the middle of the card moved the card');
    await touch('pointerup', 2, -40);
    // a sideways start in the middle of the card follows the finger
    await touch('pointerdown', 0, 0);
    await touch('pointermove', 60, 3);
    await touch('pointermove', 110, 4);
    await card.waitForTimeout(150);
    check((await dragging()) === 1, 'inbox phone: a swipe from the middle of the card did not follow the finger');
    check(
      (await card.locator('.fy-attn-deck__top').getAttribute('data-swipe-direction')) === 'right',
      'inbox phone: the mid-card swipe did not read as right',
    );
    await shot(card, 'swipe-mid', form, theme, 'inbox');
    await card.evaluate(() =>
      document
        .querySelector('.fy-attn-deck__top [data-agenda-body]')
        ?.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 21, pointerType: 'touch' })),
    );
    await card.waitForTimeout(150);
    check((await dragging()) === 0, 'inbox phone: the card did not spring back');
  }
  await card.close();
  await browserContext.close();
};

for (const theme of THEMES) for (const form of ['desktop', 'phone'] as const) await scenes(form, theme);

await browser.close();
server.stop(true);
process.stdout.write(`${checks} checks, ${violations.length} violations\n`);
if (violations.length > 0) process.exit(1);
