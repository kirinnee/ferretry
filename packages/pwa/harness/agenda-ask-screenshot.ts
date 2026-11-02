/**
 * Screenshots and checks for THE ASK AS A SHORT BOLD TITLE, and no heading inside a segment: the card with a long ask
 * and a Markdown heading of every depth in each segment, drawn in the chat and in the Inbox, on a phone (390) and a
 * desktop (1440), in light and dark.
 *
 *   bun harness/agenda-ask-screenshot.ts [outDir]   # writes <outDir>/<chat|inbox>-<390|1440>-<light|dark>.png
 *
 * It bundles `agenda-page.tsx` (`headings=1`) and `inbox-page.tsx` (`view=open-headings`) and FAILS (after writing
 * every picture) when: a page scrolls sideways; the ask is missing, is not bold, is drawn larger than the card's own
 * text, or is an h1–h6; any segment holds an h1–h6; a segment's heading is not bold; or a heading is drawn larger than
 * the text around it. It also draws a gate card with no project (its header must not open, end or double on a dot) and
 * a card with a long title (two lines at most, cut at a word, nothing sideways).
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out', 'agenda-ask-build');
const outDir = resolve(process.argv[2] ?? '/tmp/claude-1000/shots/agenda-ask');

const fail = (message: string): never => {
  process.stderr.write(`❌ ${message}\n`);
  process.exit(1);
};

const run = (command: string, args: readonly string[]): void => {
  const result = spawnSync(command, args, { cwd: packageDir, stdio: 'inherit' });
  if (result.status !== 0) fail(`${command} exited ${result.status}`);
};

const html = (theme: string, entry: string) => `<!doctype html>
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
run('bun', [
  'build',
  join(harnessDir, 'agenda-page.tsx'),
  join(harnessDir, 'inbox-page.tsx'),
  '--outdir',
  buildDir,
  '--target',
  'browser',
]);
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
      return new Response(html(url.searchParams.get('theme') ?? 'studio-dark', url.searchParams.get('entry') ?? ''), {
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
const THEMES = ['light', 'dark'] as const;
type Form = 'phone' | 'desktop';
type Where = 'chat' | 'inbox';

const violations: string[] = [];
let checks = 0;
const check = (ok: boolean, message: string): void => {
  checks += 1;
  if (ok) return;
  violations.push(message);
  process.stderr.write(`❌ ${message}\n`);
};

const openInChat = async (page: Page): Promise<void> => {
  await page.locator('[data-agenda-line-toggle]').click();
  await page.locator('[data-agenda-drawer]').waitFor({ state: 'visible' });
  await page.waitForTimeout(150);
  await page.locator('[data-agenda-drawer] [data-agenda-row="A110"]').click();
  await page.locator('[data-agenda-view]').waitFor({ state: 'visible' });
  await page.waitForTimeout(250);
};

const scene = async (where: Where, form: Form, theme: (typeof THEMES)[number]): Promise<void> => {
  const width = form === 'phone' ? 390 : 1440;
  const label = `${where} ${width} ${theme}`;
  const context = await browser.newContext({
    ...(form === 'phone' ? PHONE : DESKTOP),
    ...LOCALE,
    colorScheme: theme,
  });
  const page = await context.newPage();
  await page.route('**/*', route =>
    route.request().url().startsWith(server.url.origin) ? route.continue() : route.abort(),
  );
  await page.clock.setFixedTime(NOW);
  const query = where === 'chat' ? 'entry=agenda-page&view=board&headings=1' : 'entry=inbox-page&view=open-headings';
  await page.goto(`${server.url}?theme=studio-${theme}&${query}`);
  await page.locator('[data-fixture]').waitFor({ state: 'visible' });
  await page.waitForTimeout(250);
  if (where === 'chat') await openInChat(page);
  await page
    .locator('[data-agenda-question-line]', { hasText: 'catalog looks ugly' })
    .first()
    .waitFor({ state: 'visible' });

  const found = await page.evaluate(() => {
    const size = (node: Element | null): number =>
      node === null ? 0 : Number.parseFloat(getComputedStyle(node).fontSize);
    const card =
      [...document.querySelectorAll('.fy-card')].find(each => each.textContent?.includes('Premise one')) ?? null;
    const ask = card?.querySelector('[data-agenda-question-line]') ?? null;
    const askText = ask?.querySelector('p, .md') ?? ask;
    const body = card?.querySelector('[data-agenda-section="premise"] .fy-seg p') ?? null;
    const segments = [...(card?.querySelectorAll('.fy-seg') ?? [])];
    const demoted = [...(card?.querySelectorAll('[data-demoted-heading]') ?? [])];
    const view = document.querySelector('.fy-item-view__body');
    return {
      segments: segments.length,
      askWeight: askText === null ? 0 : Number.parseInt(getComputedStyle(askText).fontWeight, 10),
      askSize: size(askText),
      askHeading:
        ask?.closest('h1, h2, h3, h4, h5, h6') !== null || ask?.querySelector('h1, h2, h3, h4, h5, h6') !== null,
      askHeight: ask?.getBoundingClientRect().height ?? 0,
      bodySize: size(body),
      headingTags:
        card?.querySelectorAll('.fy-seg h1, .fy-seg h2, .fy-seg h3, .fy-seg h4, .fy-seg h5, .fy-seg h6').length ?? 0,
      demoted: demoted.length,
      demotedBold: demoted.every(
        node => Number.parseInt(getComputedStyle(node.querySelector('strong') ?? node).fontWeight, 10) >= 600,
      ),
      demotedSize: Math.max(0, ...demoted.map(size)),
      wide: Math.max(
        document.documentElement.scrollWidth - window.innerWidth,
        view === null ? 0 : view.scrollWidth - view.clientWidth,
      ),
    };
  });
  check(found.wide <= 0, `${label}: scrolls sideways by ${found.wide}px`);
  check(found.segments >= 5, `${label}: only ${found.segments} segments drawn`);
  check(found.askWeight >= 600, `${label}: the ask is weight ${found.askWeight}, not bold`);
  check(!found.askHeading, `${label}: the ask is a heading element`);
  check(
    found.bodySize > 0 && found.askSize <= found.bodySize,
    `${label}: the ask is ${found.askSize}px, body is ${found.bodySize}px`,
  );
  check(found.headingTags === 0, `${label}: ${found.headingTags} h1–h6 inside a segment`);
  check(found.demoted === 30, `${label}: ${found.demoted} demoted headings, wanted 30 (6 in each of 5 segments)`);
  check(found.demotedBold, `${label}: a demoted heading is not bold`);
  check(
    found.demotedSize <= found.bodySize,
    `${label}: a heading is drawn at ${found.demotedSize}px, body is ${found.bodySize}px`,
  );

  const scroller = page.locator('.fy-item-view__body').first();
  const height = await scroller.evaluate(node => node.scrollHeight);
  const viewport = page.viewportSize() ?? { width: width, height: 844 };
  await page.setViewportSize({ width: viewport.width, height: Math.max(viewport.height, height + 240) });
  if (where === 'inbox') {
    await page
      .locator('[data-agenda-question-line]', { hasText: 'catalog looks ugly' })
      .first()
      .evaluate(node => node.scrollIntoView({ block: 'center' }));
  }
  await page.waitForTimeout(150);
  await page.mouse.move(1, 1);
  const path = join(outDir, `${where}-${width}-${theme}.png`);
  await page.screenshot({ path });
  process.stdout.write(`📸 ${path}\n`);
  await context.close();
};

type Extra = 'gate-noproject' | 'longtitle';

const extraScene = async (which: Extra, form: Form, theme: (typeof THEMES)[number]): Promise<void> => {
  const width = form === 'phone' ? 390 : 1440;
  const label = `${which} ${width} ${theme}`;
  const context = await browser.newContext({
    ...(form === 'phone' ? PHONE : DESKTOP),
    ...LOCALE,
    colorScheme: theme,
  });
  const page = await context.newPage();
  await page.route('**/*', route =>
    route.request().url().startsWith(server.url.origin) ? route.continue() : route.abort(),
  );
  await page.clock.setFixedTime(NOW);
  const view = which === 'gate-noproject' ? 'gate-noproject' : 'open-longtitle';
  await page.goto(`${server.url}?theme=studio-${theme}&entry=inbox-page&view=${view}`);
  await page.locator('[data-fixture]').waitFor({ state: 'visible' });
  await page.waitForTimeout(250);

  if (which === 'gate-noproject') {
    const header = page.locator('[data-inbox-gate="F63"]').first();
    await header.waitFor({ state: 'visible' });
    const found = await header.evaluate(node => {
      const facts = node.querySelector('.fy-meta-line__facts');
      return {
        text: (facts?.textContent ?? '').replace(/\s+/g, ' ').trim(),
        project: node.querySelector('[data-inbox-gate-project]') !== null,
        ferret: node.querySelector('[data-inbox-who-ferret]')?.textContent ?? '',
      };
    });
    check(!found.project, `${label}: the project part is drawn though it has no words`);
    check(found.ferret !== '', `${label}: the ferret is missing`);
    check(
      !found.text.startsWith('·') && !found.text.endsWith('·') && !/·\s*·/.test(found.text),
      `${label}: a leading, trailing or doubled dot in "${found.text}"`,
    );
    check(!found.text.includes('·'), `${label}: one part is drawn, so no dot belongs in "${found.text}"`);
    await header.evaluate(node => node.scrollIntoView({ block: 'center' }));
  } else {
    const title = page.locator('.fy-item-view__title[data-agenda-title]', { hasText: 'Three answers' }).first();
    await title.waitFor({ state: 'visible' });
    const found = await title.evaluate(node => {
      const style = getComputedStyle(node);
      const line = Number.parseFloat(style.lineHeight);
      return {
        wrap: node.getAttribute('data-wrap') !== null,
        lines: Math.round(node.getBoundingClientRect().height / line),
        sideways: node.scrollWidth - node.clientWidth,
        text: node.textContent ?? '',
        whiteSpace: style.whiteSpace,
      };
    });
    check(found.wrap, `${label}: the title does not wrap`);
    check(found.lines >= 1 && found.lines <= 2, `${label}: the title takes ${found.lines} lines`);
    check(found.sideways <= 0, `${label}: the title is cut sideways by ${found.sideways}px`);
    check(found.whiteSpace === 'normal', `${label}: white-space is ${found.whiteSpace}`);
  }
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(wide <= 0, `${label}: scrolls sideways by ${wide}px`);
  await page.waitForTimeout(150);
  await page.mouse.move(1, 1);
  const path = join(outDir, `${which}-${width}-${theme}.png`);
  await page.screenshot({ path });
  process.stdout.write(`📸 ${path}\n`);
  await context.close();
};

for (const form of ['phone', 'desktop'] as const) {
  for (const theme of THEMES) {
    for (const where of ['chat', 'inbox'] as const) await scene(where, form, theme);
    for (const which of ['gate-noproject', 'longtitle'] as const) await extraScene(which, form, theme);
  }
}

await browser.close();
server.stop(true);
if (violations.length > 0) fail(`${violations.length} of ${checks} checks failed`);
process.stdout.write(`✅ ${checks} checks passed\n`);
