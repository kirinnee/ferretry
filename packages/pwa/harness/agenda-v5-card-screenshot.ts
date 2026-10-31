/**
 * Screenshots and checks for the v5 agenda card: the premise + context block first in the body, a type badge and a
 * layout per type, History as the conversation (bubbles; no tool call, thinking or extras) and the Revisions view.
 *
 *   bun harness/agenda-v5-card-screenshot.ts [outDir]   # writes <outDir>/card-<name>-<phone|desktop>-<theme>.png
 *
 * It bundles `agenda-page.tsx` (`v5=1`: a LONG decision A80 with a 4-column options table, premise, context, two
 * revisions and a conversation with tool calls in it, plus one item of each type: A81 approval, A82 to-do, A83
 * review, A84 note, A85 reply), drives it with real clicks, and FAILS (after writing every picture) when: a page
 * scrolls sideways; the premise block is not the first section of the body; the type badge is missing or wrong;
 * the History holds tool-call text or no bubble; the Revisions list is not newest first ending with v1; or an item
 * view shows "What's going on" / "Why it matters" a second time.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out', 'agenda-v5-card-build');
const outDir = resolve(process.argv[2] ?? '/tmp/claude-1000/v5-shots');

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

const shot = async (page: Page, name: string, form: Form, theme: string): Promise<void> => {
  await page.mouse.move(1, 1);
  await page.waitForTimeout(120);
  const path = join(outDir, `card-${name}-${form}-${theme}.png`);
  const shown = await page.evaluate(() => document.documentElement.dataset.theme ?? '');
  check(shown === theme, `card-${name} ${form}: drawn in ${shown}, named ${theme}`);
  await page.screenshot({ path });
  process.stdout.write(`📸 ${path}\n`);
};

const openItem = async (page: Page, id: string): Promise<void> => {
  await page.locator('[data-agenda-line-toggle]').click();
  await page.locator('[data-agenda-drawer]').waitFor({ state: 'visible' });
  await page.waitForTimeout(150);
  await page.locator(`[data-agenda-drawer] [data-agenda-row="${id}"]`).click();
  await page.locator('[data-agenda-view]').waitFor({ state: 'visible' });
  await page.waitForTimeout(200);
};

const scrollTo = async (page: Page, where: 'top' | 'middle' | 'bottom'): Promise<void> => {
  await page.locator('.fy-item-view__body').evaluate((node, at) => {
    const room = node.scrollHeight - node.clientHeight;
    node.scrollTop = at === 'top' ? 0 : at === 'middle' ? room / 2 : room;
  }, where);
  await page.waitForTimeout(150);
};

/** The item types, as the badge names them. */
const ITEMS = [
  { id: 'A80', name: 'decision', type: 'choice' },
  { id: 'A81', name: 'approval', type: 'permission' },
  { id: 'A82', name: 'todo', type: 'task' },
  { id: 'A83', name: 'review', type: 'review' },
  { id: 'A84', name: 'note', type: 'info' },
  { id: 'A85', name: 'reply', type: 'reply' },
] as const;

const TOOL_WORDS = ['Bash(', 'Read(', 'rg ledger', 'fy daemon status', '→ 14 matches', '→ 212 lines'] as const;

const checkCommon = async (page: Page, label: string, type: string): Promise<void> => {
  const found = await page.evaluate(() => {
    const view = document.querySelector('[data-agenda-view]');
    const body = view?.querySelector('.fy-item-view__body') ?? null;
    const firstSection = body?.querySelector('section:not([data-agenda-detail])') ?? null;
    const copy = view?.cloneNode(true) as HTMLElement | undefined;
    copy?.querySelector('[data-agenda-revisions]')?.remove();
    const text = copy?.textContent ?? '';
    return {
      first: firstSection === null ? null : Object.keys((firstSection as HTMLElement).dataset),
      premise: body?.querySelectorAll('[data-agenda-section="premise"]').length ?? 0,
      context: body?.querySelectorAll('[data-agenda-section="context"]').length ?? 0,
      badge: view?.querySelector('[data-agenda-type]')?.getAttribute('data-agenda-type') ?? null,
      dead: /What's going on|Why it matters/u.test(text),
      wide: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
  check(
    found.first?.includes('agendaSituation') === true,
    `${label}: the premise block is not the first section (${found.first?.join(',') ?? 'none'})`,
  );
  check(
    found.premise === 1 && found.context === 1,
    `${label}: premise ${found.premise}, context ${found.context}; wanted one each`,
  );
  check(found.badge === type, `${label}: the badge says ${found.badge}, wanted ${type}`);
  check(!found.dead, `${label}: the dead "What's going on / Why it matters" is still drawn`);
  check(found.wide <= 0, `${label}: scrolls sideways by ${found.wide}px`);
};

const checkLong = async (page: Page, label: string): Promise<void> => {
  await scrollTo(page, 'bottom');
  const history = page.locator('[data-agenda-history]');
  check((await history.count()) === 1, `${label}: no History`);
  const text = (await history.textContent()) ?? '';
  for (const word of TOOL_WORDS) check(!text.includes(word), `${label}: the History shows tool-call text "${word}"`);
  const bubbles = await history.locator('li:not(.fy-item-history__divider)').count();
  check(bubbles >= 6, `${label}: the History holds ${bubbles} bubbles, wanted at least 6`);
  const dividers = await history.locator('li.fy-item-history__divider').allTextContents();
  check(
    dividers.some(line => /Raised by/u.test(line)),
    `${label}: no "Raised by" divider`,
  );
  check(
    dividers.filter(line => /edited/u.test(line)).length === 2,
    `${label}: the revisions are not two dividers: ${dividers.join(' | ')}`,
  );
  const hidden = await history
    .locator('li')
    .evaluateAll(nodes => nodes.filter(node => node.getBoundingClientRect().height === 0).length);
  check(hidden === 0, `${label}: the History hides ${hidden} rows`);

  const versions = await page
    .locator('[data-agenda-revisions] [data-agenda-version]')
    .evaluateAll(nodes => nodes.map(node => Number(node.getAttribute('data-agenda-version'))));
  check(
    versions.join(',') === '3,2,1',
    `${label}: the Revisions list is ${versions.join(',')}, wanted 3,2,1 (newest first)`,
  );
  const changed = await page
    .locator('[data-agenda-revisions] [data-agenda-version="3"] [data-field]')
    .evaluateAll(nodes => nodes.map(node => node.getAttribute('data-field')));
  check(changed.join(',') === 'ask,context', `${label}: v3 changed ${changed.join(',')}, wanted ask,context`);
  const older = await page
    .locator('[data-agenda-revisions] [data-agenda-version="2"] [data-field]')
    .evaluateAll(nodes => nodes.map(node => node.getAttribute('data-field')));
  check(older.join(',') === 'subject,premise', `${label}: v2 changed ${older.join(',')}, wanted subject,premise`);
  const sides = await page
    .locator('[data-agenda-revisions] [data-agenda-version="2"] [data-side]')
    .evaluateAll(nodes => nodes.map(node => node.getAttribute('data-side')));
  check(sides.includes('before') && sides.includes('after'), `${label}: v2 does not show before → after`);

  const table = await page.locator('.fy-item-view__body table:not([data-agenda-terms])').count();
  check(table >= 1, `${label}: the 4-column options table is not drawn`);
  const columns = await page
    .locator('.fy-item-view__body table:not([data-agenda-terms])')
    .first()
    .locator('thead th')
    .count();
  check(columns === 4, `${label}: the table has ${columns} columns, wanted 4`);
};

const scenes = async (form: Form, theme: string): Promise<void> => {
  const browserContext = await browser.newContext({
    ...(form === 'phone' ? PHONE : DESKTOP),
    ...LOCALE,
    colorScheme: theme.endsWith('-dark') ? 'dark' : 'light',
  });
  for (const { id, name, type } of ITEMS) {
    const page = await browserContext.newPage();
    await page.route('**/*', route =>
      route.request().url().startsWith(server.url.origin) ? route.continue() : route.abort(),
    );
    await page.clock.setFixedTime(NOW);
    await page.goto(`${server.url}?theme=${theme}&view=board&v5=1`);
    await page.locator('[data-fixture]').waitFor({ state: 'visible' });
    await page.waitForTimeout(200);
    await openItem(page, id);
    const label = `${name} ${form} ${theme}`;
    await checkCommon(page, label, type);
    if (id === 'A80') {
      await shot(page, `${name}-top`, form, theme);
      await scrollTo(page, 'middle');
      await shot(page, `${name}-middle`, form, theme);
      await checkLong(page, label);
      await shot(page, `${name}-bottom`, form, theme);
    } else {
      await shot(page, name, form, theme);
    }
    await page.close();
  }
  await browserContext.close();
};

for (const theme of THEMES) for (const form of ['desktop', 'phone'] as const) await scenes(form, theme);

await browser.close();
server.stop(true);
process.stdout.write(`${checks} checks, ${violations.length} violations\n`);
if (violations.length > 0) process.exit(1);
