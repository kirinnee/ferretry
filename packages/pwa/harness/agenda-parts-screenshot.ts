/**
 * Screenshots and checks for the NINE-PART ITEM VIEW (docs/agenda.md § The item view): head, premise and context, the
 * folded detailed context, the terms and references table, where we are now, the conversation, what it needs from the
 * owner (with card asks), the body and the folded activity log.
 *
 *   bun harness/agenda-parts-screenshot.ts [outDir]   # writes <outDir>/parts-<scene>-<phone|desktop>-<theme>.png
 *
 * It bundles `agenda-page.tsx` (`parts=1`, fixtures in `agenda-parts.ts`), opens each item the way a link or a push
 * does (`?agenda=A…`), and FAILS (after writing every picture) when: a page scrolls sideways; the card is drawn in a
 * fallback font; the parts are out of the spec's order; a stage chip is wrong; a folded part starts open or does not
 * open; the terms table is not one table with a meaning per row; the long report is cut (its last line missing, or
 * its box clipping it); the conversation drops a reply; the card ask's buttons are not inside "What I need from you",
 * lack their own heading or the card's test steps, are cut off, or sit under the dock; the item's own answer is docked
 * beside a card ask; the activity log does not list each stage; a push does not open the item at its ask; the head's
 * title scrolls, is cut at a side or takes more than two lines, or is longer than them and not drawn whole in the
 * body; or a Yes / No row is not No ← · Yes →.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out', 'agenda-parts-build');
const outDir = resolve(process.argv[2] ?? '/tmp/claude-1000/shots/agenda-parts');

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
    // The stylesheet names its fonts relative to src/styles: serve them, so the pictures use the app's own typefaces.
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
const ORDER = ['head', 'premise', 'detail', 'references', 'where', 'conversation', 'needs', 'body', 'activity'];
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
  const path = join(outDir, `parts-${name}-${form}-${theme}.png`);
  const shown = await page.evaluate(() => document.documentElement.dataset.theme ?? '');
  check(shown === theme, `parts-${name} ${form}: drawn in ${shown}, named ${theme}`);
  await page.screenshot({ path });
  process.stdout.write(`📸 ${path}\n`);
};

/** Scrolls the open item's one scroller so `part` sits at its top (its scroll padding keeps it under the sticky head). */
const scrollToPart = async (page: Page, part: string): Promise<void> => {
  await page.evaluate(name => {
    document.querySelector(`[data-agenda-part="${name}"]`)?.scrollIntoView({ block: 'start' });
  }, part);
  await page.waitForTimeout(200);
};

const scrollTop = async (page: Page): Promise<void> => {
  await page.locator('.fy-item-view__body').evaluate(node => {
    node.scrollTop = 0;
  });
  await page.waitForTimeout(150);
};

const checkCommon = async (page: Page, label: string): Promise<void> => {
  const found = await page.evaluate(async () => {
    await document.fonts.ready;
    const card = document.querySelector('.fy-card');
    const family = getComputedStyle(card ?? document.body).fontFamily;
    const loaded = [...document.fonts].filter(face => face.status === 'loaded').map(face => face.family);
    const body = document.querySelector('.fy-item-view__body');
    return {
      family,
      loaded,
      parts: [...(card?.querySelectorAll('[data-agenda-part]') ?? [])].map(
        node => node.getAttribute('data-agenda-part') ?? '',
      ),
      wide: Math.max(
        document.documentElement.scrollWidth - window.innerWidth,
        body === null ? 0 : body.scrollWidth - body.clientWidth,
      ),
      // The head's title is the one clamp allowed (two lines), and only because it is drawn whole in the body too.
      clamped: [...(document.querySelector('[data-agenda-view]')?.querySelectorAll('*') ?? [])].filter(node => {
        const style = getComputedStyle(node);
        return style.webkitLineClamp !== 'none' && style.webkitLineClamp !== '' && !node.matches('[data-agenda-title]');
      }).length,
      title: (() => {
        const box = document.querySelector<HTMLElement>('.fy-item-view__head [data-agenda-title]');
        const text = box?.querySelector('.fy-item-view__title-text');
        if (box === null || box === undefined || text === null || text === undefined) return null;
        const first = text.getClientRects()[0];
        return {
          moves: box.hasAttribute('data-marquee') || text.getAnimations().length > 0,
          cut: box.hasAttribute('data-cut'),
          lines: Math.round(box.clientHeight / Number.parseFloat(getComputedStyle(box).lineHeight)),
          leftClip: first === undefined || first.left < box.getBoundingClientRect().left - 1,
          clamped: box.scrollHeight > box.clientHeight + 1,
          full: text.textContent ?? '',
          whole: document.querySelector('[data-agenda-full-title]')?.textContent ?? null,
        };
      })(),
      yesNo: [...document.querySelectorAll('[data-agenda-option]')]
        .map(node => node.getAttribute('data-agenda-option') ?? '')
        .filter(label => label === 'Yes' || label === 'No'),
    };
  });
  check(found.wide <= 0, `${label}: scrolls sideways by ${found.wide}px`);
  check(
    found.loaded.some(face => found.family.includes(face.replaceAll('"', ''))),
    `${label}: drawn in a fallback font (${found.family}; loaded: ${found.loaded.join(', ')})`,
  );
  const places = found.parts.map(part => ORDER.indexOf(part));
  check(
    places.every((place, at) => place >= 0 && (at === 0 || place > (places[at - 1] ?? -1))),
    `${label}: parts out of order (${found.parts.join(', ')})`,
  );
  check(found.parts[0] === 'head', `${label}: the head is not first (${found.parts.join(', ')})`);
  check(found.clamped === 0, `${label}: ${found.clamped} element(s) in the item view are line-clamped`);
  const title = found.title;
  check(title !== null, `${label}: the head has no title`);
  if (title !== null) {
    check(!title.moves, `${label}: the head's title scrolls`);
    check(!title.cut, `${label}: the head's title is cut at a word`);
    check(!title.leftClip, `${label}: the head's title is cut on the left`);
    check(title.lines <= 2, `${label}: the head's title takes ${title.lines} lines, wanted two at most`);
    check(
      !title.clamped || title.whole === title.full,
      `${label}: the title is longer than the head's two lines and not drawn whole in the body`,
    );
  }
  check(
    /^(No,Yes,?)*$/u.test(found.yesNo.join(',')),
    `${label}: Yes and No sit as ${found.yesNo.join(',')}, wanted No,Yes`,
  );
};

const STAGES = [
  ['A120', 'explainer', 'Explainer'],
  ['A121', 'question', 'Question'],
  ['A122', 'plan', 'Plan to approve'],
  ['A123', 'tracker', 'Tracker'],
  ['A124', 'test', 'Test'],
] as const;

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
    await page.goto(`${server.url}?theme=${theme}&view=board&parts=1&agenda=${id}`);
    await page.locator('[data-agenda-view]').waitFor({ state: 'visible' });
    await page.waitForTimeout(350);
    return page;
  };
  const press = (page: Page, selector: string) =>
    form === 'phone' ? page.locator(selector).tap() : page.locator(selector).click();

  // ONE ITEM PER STAGE, from its top.
  for (const [id, stage, words] of STAGES) {
    const page = await open(id);
    await scrollTop(page);
    await checkCommon(page, `${stage} ${form} ${theme}`);
    const chip = (await page.locator('[data-agenda-part="head"] [data-agenda-stage]').textContent()) ?? '';
    check(chip === words, `${stage} ${form} ${theme}: the stage chip says "${chip}", wanted "${words}"`);
    await shot(page, `stage-${stage}`, form, theme);

    if (id === 'A121') {
      // The detailed context: folded, then open.
      await scrollToPart(page, 'detail');
      const folded = await page.locator('[data-agenda-fold="detail"]').getAttribute('aria-expanded');
      check(folded === 'false', `detail ${form} ${theme}: the detailed context starts open`);
      await shot(page, 'detail-folded', form, theme);
      await press(page, '[data-agenda-fold="detail"]');
      await page.waitForTimeout(150);
      const opened = await page.locator('[data-agenda-fold="detail"]').getAttribute('aria-expanded');
      check(opened === 'true', `detail ${form} ${theme}: the detailed context does not open`);
      await scrollToPart(page, 'detail');
      await shot(page, 'detail-open', form, theme);

      // The terms and references table.
      await scrollToPart(page, 'references');
      const table = await page.evaluate(() => {
        const node = document.querySelector('[data-agenda-part="references"] table');
        const rows = [...(node?.querySelectorAll('tbody tr') ?? [])];
        return {
          tables: document.querySelectorAll('[data-agenda-part="references"] table').length,
          rows: rows.length,
          meanings: rows.filter(row => (row.querySelector('td')?.textContent ?? '').trim() !== '').length,
        };
      });
      check(table.tables === 1, `terms ${form} ${theme}: ${table.tables} tables, wanted 1`);
      check(table.rows === 6, `terms ${form} ${theme}: ${table.rows} rows, wanted 3 terms and 3 links`);
      check(table.meanings === table.rows, `terms ${form} ${theme}: a row has no meaning`);
      const filler = await page.evaluate(() =>
        [...document.querySelectorAll('[data-agenda-part="references"] tbody td')]
          .map(cell => cell.textContent ?? '')
          .filter(words => /^A (pull request|card on the board|file|web page|terminal|skill)\.$/u.test(words.trim())),
      );
      check(filler.length === 0, `terms ${form} ${theme}: a made-up meaning is drawn (${filler.join(' | ')})`);
      await shot(page, 'terms', form, theme);

      // The long report in "where we are now", with no cut-off.
      await scrollToPart(page, 'where');
      const report = await page.evaluate(() => {
        const node = document.querySelector<HTMLElement>('[data-agenda-where-now]');
        return {
          last: (node?.textContent ?? '').includes('every count now agrees'),
          findings: (node?.textContent ?? '').match(/Finding \d+\./gu)?.length ?? 0,
          clipped: node === null ? true : node.scrollHeight - node.clientHeight > 1,
        };
      });
      check(report.last, `report ${form} ${theme}: the report's last line is missing`);
      check(report.findings === 14, `report ${form} ${theme}: ${report.findings} of 14 findings shown`);
      check(!report.clipped, `report ${form} ${theme}: the report's box clips it`);
      await shot(page, 'report', form, theme);
      // The end of the report, to show it is whole.
      await page.evaluate(() => {
        document.querySelector('[data-agenda-where-now]')?.scrollIntoView({ block: 'end' });
      });
      await page.waitForTimeout(200);
      await shot(page, 'report-end', form, theme);

      // The conversation, several replies, oldest first.
      await scrollToPart(page, 'conversation');
      const said = await page
        .locator('[data-agenda-part="conversation"] [data-history]')
        .evaluateAll(nodes => nodes.map(node => node.getAttribute('data-history')));
      check(said.length === 7, `conversation ${form} ${theme}: ${said.length} replies, wanted 7`);
      check(said[0] === 'ferret' && said[1] === 'owner', `conversation ${form} ${theme}: not oldest first`);
      await shot(page, 'conversation', form, theme);

      // The activity log, unfolded.
      await scrollToPart(page, 'activity');
      await press(page, '[data-agenda-fold="activity"]');
      await page.waitForTimeout(150);
      await scrollToPart(page, 'activity');
      const lines = await page
        .locator('[data-agenda-activity] .fy-activity__text > span')
        .evaluateAll(nodes => nodes.map(node => node.textContent ?? ''));
      check(
        lines.includes('Started as Explainer') && lines.includes('Moved to Question'),
        `activity ${form} ${theme}: the stages are missing (${lines.join(' | ')})`,
      );
      check(lines.includes('Updated to v2'), `activity ${form} ${theme}: the edit is missing`);
      await page.locator('.fy-item-view__body').evaluate(node => {
        node.scrollTop = node.scrollHeight;
      });
      await page.waitForTimeout(150);
      await shot(page, 'activity-open', form, theme);
    }

    if (id === 'A124') {
      // A push opens it AT ITS ASK; the card ask's buttons are inside it.
      const at = await page.evaluate(() => {
        const needs = document.querySelector('[data-agenda-part="needs"]');
        const ask = needs?.querySelector('[data-agenda-card-ask]');
        return {
          inside: ask !== null && ask !== undefined,
          buttons: [...(ask?.querySelectorAll('[data-agenda-option]') ?? [])].map(
            node => node.getAttribute('data-agenda-option') ?? '',
          ),
          docked: document.querySelector('.fy-item-view__dock [data-agenda-card-ask]') !== null,
        };
      });
      check(at.inside, `test ${form} ${theme}: the card ask is not inside What I need from you`);
      check(
        at.buttons.join(',') === 'Not good,Done',
        `test ${form} ${theme}: the card ask's buttons are ${at.buttons.join(',')}`,
      );
      check(!at.docked, `test ${form} ${theme}: the card ask is docked, not in the item`);
      const own = await page.evaluate(() => ({
        heading: document.querySelector('[data-agenda-card-ask-title]')?.textContent ?? '',
        steps: document.querySelector('[data-agenda-card-ask-test]')?.textContent ?? '',
        inline:
          document.querySelector('[data-agenda-part="needs"] [data-agenda-item-answer] [data-agenda-option="Yes"]') !==
          null,
        dockedRow: document.querySelector('.fy-item-view__dock [data-agenda-option]') !== null,
      }));
      check(
        own.heading.includes('Card &F559') && own.heading.includes('your answer for the card'),
        `test ${form} ${theme}: the card ask has no heading of its own (${own.heading})`,
      );
      check(own.steps.includes('Snooze one item'), `test ${form} ${theme}: the card's test steps are missing`);
      check(own.inline, `test ${form} ${theme}: the item's own answer is not inline under its ask`);
      check(!own.dockedRow, `test ${form} ${theme}: the item's answer is docked beside the card ask's`);
      await page.close();
      const pushed = await open('A124');
      const landing = await pushed.evaluate(() => {
        const body = document.querySelector('.fy-item-view__body');
        const head = document.querySelector('.fy-item-view__head');
        const needs = document.querySelector('[data-agenda-part="needs"]');
        if (body === null || head === null || needs === null) return null;
        const room = body.scrollHeight - body.clientHeight;
        return {
          offset: Math.round(needs.getBoundingClientRect().top - head.getBoundingClientRect().bottom),
          focused: document.activeElement === needs,
          // As far as it goes: a short item cannot bring its ask any higher, and then it is in view as it is.
          atEnd: room <= 0 || Math.abs(body.scrollTop - room) <= 1,
          inView: needs.getBoundingClientRect().top < body.getBoundingClientRect().bottom,
        };
      });
      check(landing !== null, `push ${form} ${theme}: no ask to land on`);
      if (landing !== null) {
        check(landing.focused, `push ${form} ${theme}: the ask does not have the focus`);
        check(landing.inView, `push ${form} ${theme}: the ask is not in view`);
        check(
          Math.abs(landing.offset) <= 24 || landing.atEnd,
          `push ${form} ${theme}: the ask is ${landing.offset}px under the head with room left to scroll`,
        );
      }
      await shot(pushed, 'test-card-ask', form, theme);
      // Done / Not good must be fully visible, and never under the dock, at the ask and with the card ask scrolled to.
      const fullyVisible = async (where: string): Promise<void> => {
        const found = await pushed.evaluate(() => {
          const view = document.querySelector<HTMLElement>('.fy-item-view__body');
          const clip = view?.getBoundingClientRect();
          const dock = document.querySelector('.fy-item-view__dock')?.getBoundingClientRect();
          const buttons = [...document.querySelectorAll('[data-agenda-card-ask] [data-agenda-option]')].map(node => {
            const box = node.getBoundingClientRect();
            return {
              label: node.getAttribute('data-agenda-option') ?? '',
              cut: clip === undefined || box.top < clip.top - 1 || box.bottom > clip.bottom + 1,
              underDock:
                dock !== undefined && dock.height > 0 && box.bottom > dock.top + 1 && box.top < dock.bottom - 1,
              offWidth: box.left < -1 || box.right > window.innerWidth + 1,
            };
          });
          return buttons;
        });
        check(found.length === 2, `test ${where} ${form} ${theme}: ${found.length} card-ask buttons, wanted 2`);
        for (const button of found) {
          check(!button.cut, `test ${where} ${form} ${theme}: "${button.label}" is cut off by the scroller`);
          check(!button.underDock, `test ${where} ${form} ${theme}: "${button.label}" is under the dock`);
          check(!button.offWidth, `test ${where} ${form} ${theme}: "${button.label}" is off the screen's width`);
        }
      };
      await pushed.evaluate(() => {
        document.querySelector('[data-agenda-card-ask]')?.scrollIntoView({ block: 'end' });
      });
      await pushed.waitForTimeout(200);
      await fullyVisible('scrolled to the card ask');
      await shot(pushed, 'test-card-ask-buttons', form, theme);
      await scrollTop(pushed);
      await pushed.evaluate(() => {
        document.querySelector('.fy-item-view__body')?.scrollTo({ top: 0 });
      });
      await pushed.waitForTimeout(150);
      await shot(pushed, 'test-top', form, theme);
      await pushed.close();
      continue;
    }
    await page.close();
  }

  // A TITLE LONGER THAN THE HEAD'S TWO LINES on a phone: wrapped there, and whole at the top of the body.
  const long = await open('A125');
  await scrollTop(long);
  await checkCommon(long, `long-title ${form} ${theme}`);
  if (form === 'phone') {
    const whole = await long.locator('[data-agenda-full-title]').count();
    check(whole === 1, `long-title ${form} ${theme}: the long title is not drawn whole in the body`);
  }
  await shot(long, 'long-title', form, theme);
  await long.close();

  await browserContext.close();
};

for (const theme of THEMES) for (const form of ['desktop', 'phone'] as const) await scenes(form, theme);

await browser.close();
server.stop(true);
process.stdout.write(`${checks} checks, ${violations.length} violations\n`);
if (violations.length > 0) process.exit(1);
