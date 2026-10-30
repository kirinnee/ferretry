/**
 * Screenshots and layout checks for the agenda in a ferret's chat: the drawer, an agenda item OPEN over the message
 * list (only the composer stays below it, its placeholder saying "Reply about !A57…"), a multi-question item, a
 * permission item, a config change, a long item scrolled mid-way, the thinking line beside the pill and, on a
 * phone, the quick replies above a faked keyboard — plus the two v4 items: a Jaeda-style item with five lettered
 * options, and a single choice whose options explain themselves in Markdown. Desktop 1440 and phone 390, in the
 * Studio theme, light and dark.
 *
 *   bun harness/agenda-v4-screenshot.ts [outDir]   # writes <outDir>/agenda-v4-<name>-<phone|desktop>-<theme>.png
 *
 * It bundles `agenda-page.tsx` (the real `useAgenda`, invented data), serves it on an ephemeral loopback
 * port, drives it with real clicks, and FAILS (after writing every picture) when: a page scrolls sideways; the
 * overlay's box is not the message list's box, or it covers any of the composer; the composer moves when an item
 * opens or closes; the top or the quick replies move when the body scrolls; the transcript loses its scroll
 * position; anything but the one body scrolls; the agenda pill or an "about" chip is on screen while an item is
 * open, or the composer does not say "Reply about …", or it is not directly under the card; the quick-reply row
 * does not span the card or its buttons are not equal; a send does not carry the item's reference, or × does not
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

const shot = async (page: Page, name: string, form: Form, theme: string): Promise<void> => {
  await page.mouse.move(1, 1);
  await page.waitForTimeout(120);
  const path = join(outDir, `agenda-v4-${name}-${form}-${theme}.png`);
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
  const row = page.locator('[data-agenda-quick-replies] .fy-qr__row');
  if ((await row.count()) > 0) {
    const bar = await boxOf(page.locator('[data-agenda-quick-replies]'), 'quick replies');
    const buttons = await row.locator('button:not([data-agenda-more])').all();
    const boxes = (await Promise.all(buttons.map(button => button.boundingBox()))).filter(
      (found): found is Box => found !== null,
    );
    const every = (await Promise.all((await row.locator('button').all()).map(button => button.boundingBox()))).filter(
      (found): found is Box => found !== null,
    );
    const left = Math.min(...every.map(box => box.x));
    const right = Math.max(...every.map(box => box.x + box.width));
    const wanted = Math.min(bar.width - 24, 720);
    check(
      right - left >= wanted - 2,
      `${label}: the quick replies span ${Math.round(right - left)}px, the card wants ${Math.round(wanted)}px`,
    );
    const widths = boxes.filter(box => box.width > 0).map(box => box.width);
    check(
      Math.max(...widths) - Math.min(...widths) < 2,
      `${label}: the quick replies are not equal width: ${widths.map(Math.round).join(', ')}`,
    );
    check(new Set(boxes.map(box => Math.round(box.y))).size === 1, `${label}: the quick replies are not one row`);
  }
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
  await page.locator(`[data-agenda-row="${id}"]`).click();
  await overlay(page).waitFor({ state: 'visible' });
  await page.waitForTimeout(200);
};

const scenes = async (form: Form, theme: string): Promise<void> => {
  const browserContext = await browser.newContext({ ...(form === 'phone' ? PHONE : DESKTOP), ...LOCALE });
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
  check(
    (await choice.locator('[data-agenda-history-latest] li').count()) === 1,
    'the latest owner message is not kept',
  );
  check(
    (await choice.locator('[data-agenda-history] li').count()) === 1,
    'the collapsed history shows more than one row',
  );
  await shot(choice, 'item-choice', form, theme);
  const toEnd = (): Promise<void> =>
    choice.locator('.fy-item-view__body').evaluate(node => {
      node.scrollTop = node.scrollHeight;
    });
  await toEnd();
  await shot(choice, 'item-history-collapsed', form, theme);
  await choice.locator('[data-agenda-history-toggle]').click();
  await toEnd();
  check((await choice.locator('[data-agenda-history] li').count()) >= 4, 'the opened history has fewer than 4 rows');
  await shot(choice, 'item-history-open', form, theme);
  await choice.locator('[data-agenda-history-toggle]').click();
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
  await browserContext.close();
};

for (const theme of THEMES) for (const form of ['desktop', 'phone'] as const) await scenes(form, theme);

await browser.close();
server.stop(true);
process.stdout.write(`${checks} checks, ${violations.length} violations\n`);
if (violations.length > 0) process.exit(1);
