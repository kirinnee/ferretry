/**
 * Screenshots and checks for the item view's DIFF, MERGE and SPLIT links (docs/agenda.md § The item view).
 *
 *   bun harness/agenda-diff-screenshot.ts [outDir]   # writes <outDir>/diff-<scene>-<phone|desktop>-<theme>.png
 *
 * It bundles `agenda-diff-page.tsx` (fixtures in `agenda-diff.ts`, a stubbed daemon), opens each item the way a link
 * does (`?agenda=A…`), and FAILS (after writing every picture) when: a page scrolls sideways; the card is drawn in a
 * fallback font; the diff does not default to "since you last looked"; an addition is not underlined or a removal is
 * not struck through (colour alone is never the signal); an unchanged section is not folded; the merge confirm does not
 * say what closes and what is kept; a merged or split item has no reference link for its lineage; a "from chat" entry
 * lacks its tag; a link's meaning is missing from the terms table; or a machine without `agenda.conversation.1` still
 * shows a diff or merge control.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out', 'agenda-diff-build');
const outDir = resolve(process.argv[2] ?? '/tmp/claude-1000/shots/f559-pr8');

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
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/agenda-diff-page.js"></script></body>
</html>`;

mkdirSync(buildDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
run('bun', ['build', join(harnessDir, 'agenda-diff-page.tsx'), '--outdir', buildDir, '--target', 'browser']);
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
  await page.waitForTimeout(150);
  const path = join(outDir, `diff-${name}-${form}-${theme}.png`);
  const shown = await page.evaluate(() => document.documentElement.dataset.theme ?? '');
  check(shown === theme, `diff-${name} ${form}: drawn in ${shown}, named ${theme}`);
  await page.screenshot({ path });
  process.stdout.write(`📸 ${path}\n`);
};

/** Scrolling into view can nudge a clipped header sideways; the pictures show the header as the owner sees it. */
const scrollInto = async (page: Page, selector: string): Promise<void> => {
  await page.evaluate(found => {
    document.querySelector(found)?.scrollIntoView({ block: 'start' });
    for (const node of document.querySelectorAll('*')) if (node.scrollLeft !== 0) node.scrollLeft = 0;
  }, selector);
  await page.waitForTimeout(200);
};

const scrollToPart = (page: Page, part: string): Promise<void> => scrollInto(page, `[data-agenda-part="${part}"]`);

const scrollToSelector = scrollInto;

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
      wide: Math.max(
        document.documentElement.scrollWidth - window.innerWidth,
        body === null ? 0 : body.scrollWidth - body.clientWidth,
      ),
    };
  });
  check(found.wide <= 0, `${label}: scrolls sideways by ${found.wide}px`);
  check(
    found.loaded.some(face => found.family.includes(face.replaceAll('"', ''))),
    `${label}: drawn in a fallback font (${found.family}; loaded: ${found.loaded.join(', ')})`,
  );
};

const scenes = async (form: Form, theme: string): Promise<void> => {
  const browserContext = await browser.newContext({
    ...(form === 'phone' ? PHONE : DESKTOP),
    ...LOCALE,
    colorScheme: theme.endsWith('-dark') ? 'dark' : 'light',
    // The header title is a marquee that scrolls; reduced motion draws it cut at a word with "…", the same frame each time.
    reducedMotion: 'reduce',
  });
  const open = async (id: string, extra = ''): Promise<Page> => {
    const page = await browserContext.newPage();
    await page.route('**/*', route =>
      route.request().url().startsWith(server.url.origin) ? route.continue() : route.abort(),
    );
    await page.clock.setFixedTime(NOW);
    await page.goto(`${server.url}?theme=${theme}&agenda=${id}${extra}`);
    await page.locator('[data-agenda-view]').waitFor({ state: 'visible' });
    await page.waitForTimeout(450);
    return page;
  };
  const press = (page: Page, selector: string) =>
    form === 'phone' ? page.locator(selector).tap() : page.locator(selector).click();
  const label = (scene: string): string => `${scene} ${form} ${theme}`;

  // THE DIFF: "since you last looked", an added term, the ask replaced, unchanged sections folded.
  {
    const page = await open('A140');
    await checkCommon(page, label('item'));
    await press(page, '[data-agenda-diff-toggle]');
    await page.locator('[data-agenda-diff-summary]').waitFor({ state: 'visible' });
    const basis = (await page.locator('[data-agenda-diff-basis]').textContent()) ?? '';
    check(
      /since you last looked/i.test(basis),
      `${label('diff')}: the basis says "${basis}", not "since you last looked"`,
    );
    const marks = await page.evaluate(() => ({
      ins: [...document.querySelectorAll('[data-agenda-diff] ins')].map(
        node => getComputedStyle(node).textDecorationLine,
      ),
      del: [...document.querySelectorAll('[data-agenda-diff] del')].map(
        node => getComputedStyle(node).textDecorationLine,
      ),
      sections: [...document.querySelectorAll('[data-agenda-diff-section]')].map(node => ({
        key: node.getAttribute('data-agenda-diff-section') ?? '',
        status: node.getAttribute('data-status') ?? '',
      })),
      folded: document.querySelector('[data-agenda-diff-unchanged]')?.hasAttribute('open') ?? null,
    }));
    check(
      marks.ins.length > 0 && marks.ins.every(line => line.includes('underline')),
      `${label('diff')}: additions are not all underlined`,
    );
    check(
      marks.del.length > 0 && marks.del.every(line => line.includes('line-through')),
      `${label('diff')}: removals are not all struck through`,
    );
    const keys = marks.sections.map(section => section.key);
    for (const key of ['whereWeAre', 'terms', 'ask'])
      check(keys.includes(key), `${label('diff')}: "${key}" is not shown as changed (${keys.join(', ')})`);
    check(marks.folded === false, `${label('diff')}: the unchanged sections are not folded`);
    // A rewrite is one block out and one block in; a one-word edit stays a word diff inside its line.
    const rewrite = await page.evaluate(() => ({
      del: document.querySelectorAll('[data-agenda-diff-section="whereWeAre"] del').length,
      ins: document.querySelectorAll('[data-agenda-diff-section="whereWeAre"] ins').length,
    }));
    check(
      rewrite.del === 1 && rewrite.ins === 1,
      `${label('diff')}: "Where we are now" is ${rewrite.del} removed and ${rewrite.ins} added runs, not one block out and one in`,
    );
    const small = await page.evaluate(() =>
      [...document.querySelectorAll('[data-agenda-diff-section="terms"] ins')].map(node => node.textContent?.trim()),
    );
    check(
      small.includes('open'),
      `${label('diff')}: the one-word edit to a term is not a word diff (${small.join(' | ')})`,
    );
    await scrollToSelector(page, '[data-agenda-diff]');
    await shot(page, 'changes', form, theme);

    // THE VERSION PICKER: any two versions, here v2 to v3.
    await page.locator('[data-agenda-diff-from]').selectOption('2');
    await page.waitForTimeout(350);
    const heading = (await page.locator('[data-agenda-diff-basis]').textContent()) ?? '';
    check(/v2 to v3/.test(heading), `${label('picker')}: the heading says "${heading}", not v2 to v3`);
    await scrollToSelector(page, '[data-agenda-diff]');
    await shot(page, 'picker', form, theme);

    // THE CONVERSATION and THE TERMS TABLE, from the same item.
    await scrollToPart(page, 'conversation');
    const tags = await page.locator('.fy-hist__tag').allTextContents();
    check(
      tags.some(tag => /from chat/i.test(tag)),
      `${label('conversation')}: no "from chat" tag (${tags.join(', ')})`,
    );
    await shot(page, 'conversation', form, theme);
    await scrollToPart(page, 'references');
    const rows = await page.locator('[data-agenda-part="references"] tr').allTextContents();
    check(
      rows.some(row => row.includes('The change that gives the badge, the Inbox and push one queue.')),
      `${label('terms')}: the link's meaning is not in the table`,
    );
    check(
      rows.some(row => row.includes('The card this work is tracked on')),
      `${label('terms')}: a link with no meaning does not fall back to its label`,
    );
    await shot(page, 'terms', form, theme);
    await page.close();
  }

  // THE MERGE BUTTON: the picker, then the confirm.
  {
    const page = await open('A141');
    await checkCommon(page, label('merge'));
    check(
      (await page.locator('[data-agenda-lineage-line="merged-from"]').count()) === 1,
      `${label('merge')}: A141 does not say it absorbed A143`,
    );
    await press(page, '[data-agenda-merge-open]');
    await page.locator('[data-agenda-merge-picker]').waitFor({ state: 'visible' });
    check(
      (await page.locator('[data-agenda-merge-candidate="A142"]').count()) === 1,
      `${label('merge')}: A142 is not offered`,
    );
    check(
      (await page.locator('[data-agenda-merge-candidate="A143"]').count()) === 0,
      `${label('merge')}: a closed item is offered`,
    );
    await scrollToSelector(page, '[data-agenda-lineage]');
    await shot(page, 'merge-picker', form, theme);
    await press(page, '[data-agenda-merge-candidate="A142"]');
    await page.locator('[data-agenda-merge-confirm]').waitFor({ state: 'visible' });
    const words = (await page.locator('[data-agenda-merge-confirm]').textContent()) ?? '';
    check(
      /closes as merged into/.test(words) &&
        /Both conversations and all cards are kept/.test(words) &&
        words.includes('"Does push repeat for a woken item?"') &&
        words.includes('"Where do snoozed items go?" (this one)'),
      `${label('merge')}: the confirm does not say what closes and what is kept ("${words}")`,
    );
    await scrollToSelector(page, '[data-agenda-lineage]');
    await shot(page, 'merge-confirm', form, theme);
    await page.close();
  }

  // A MERGED ITEM, and a SPLIT PAIR.
  {
    const page = await open('A143');
    await checkCommon(page, label('merged'));
    check(
      (await page
        .locator('[data-agenda-lineage-line="merged-into"] a, [data-agenda-lineage-line="merged-into"] button')
        .count()) >= 1,
      `${label('merged')}: "merged into !A141" is not a link`,
    );
    check(
      (await page.locator('[data-agenda-merge-open]').count()) === 0,
      `${label('merged')}: a closed item offers a merge`,
    );
    await shot(page, 'merged', form, theme);
    await page.close();
    const from = await open('A144');
    check(
      (await from.locator('[data-agenda-lineage-line="split-from"]').count()) === 1,
      `${label('split')}: A144 does not say where it was split from`,
    );
    await shot(from, 'split-from', form, theme);
    await from.close();
    const into = await open('A146');
    const text = (await into.locator('[data-agenda-lineage-line="split-into"]').textContent()) ?? '';
    check(
      /A144 \(Split off: the snooze copy\)/.test(text) && /A145 \(Split off: the badge count\)/.test(text),
      `${label('split')}: A146 does not list both children with their titles ("${text}")`,
    );
    await shot(into, 'split-into', form, theme);
    await into.close();
  }

  // AN OLDER MACHINE: no diff control, no merge button.
  {
    const page = await open('A140', '&old=1');
    check(
      (await page.locator('[data-agenda-diff-toggle]').count()) === 0,
      `${label('old machine')}: a diff control is drawn`,
    );
    check(
      (await page.locator('[data-agenda-merge-open]').count()) === 0,
      `${label('old machine')}: a merge button is drawn`,
    );
    await page.close();
  }
  await browserContext.close();
};

for (const theme of THEMES) {
  await scenes('phone', theme);
  await scenes('desktop', theme);
}
await browser.close();
server.stop(true);

process.stdout.write(`${checks} checks, ${violations.length} violation(s)\n`);
if (violations.length > 0) process.exit(1);
