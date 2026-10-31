/**
 * Screenshots and checks for ONE ANSWER SHAPE PER KIND: every open card's "What I need from you" segment, drawn for
 * each kind on a phone (390) and a desktop, in light and dark.
 *
 *   bun harness/agenda-shapes-screenshot.ts [outDir]   # writes <outDir>/<shape>-<phone|desktop>-<theme>.png
 *
 * It bundles `agenda-page.tsx` (`shapes=1`: A101 a choice … A108 an info card), opens each item's view as the chat
 * does, and FAILS (after writing every picture) when: a page scrolls sideways; the segment is missing, is not
 * directly under the premise and context, or reads as the wrong shape; its instruction line is not the shape's own;
 * the answer row offers anything but the shape's buttons (a card answered in words offers none); or a several-question
 * card draws an option button.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AGENDA_SHAPE_LEADS, type AgendaShape } from '@ferretry/protocol';
import { chromium, type Page } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out', 'agenda-shapes-build');
const outDir = resolve(process.argv[2] ?? '/tmp/claude-1000/shots/agenda-shapes');

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

/** Each scene: the item, the shape its segment must read as, and the answer row's buttons, left to right. */
const SCENES: readonly { readonly id: string; readonly shape: AgendaShape; readonly buttons: readonly string[] }[] = [
  { id: 'A101', shape: 'choice', buttons: ['EU', 'US', 'Both'] },
  { id: 'A102', shape: 'yesno', buttons: ['Yes', 'No'] },
  { id: 'A103', shape: 'approval', buttons: ['Deny', 'Approve'] },
  { id: 'A104', shape: 'review', buttons: ['Request changes', 'Approve'] },
  { id: 'A105', shape: 'reply', buttons: [] },
  { id: 'A106', shape: 'answers', buttons: [] },
  { id: 'A107', shape: 'todo', buttons: ['Mark as done'] },
  { id: 'A108', shape: 'info', buttons: ['Got it'] },
];

const violations: string[] = [];
let checks = 0;
const check = (ok: boolean, message: string): void => {
  checks += 1;
  if (ok) return;
  violations.push(message);
  process.stderr.write(`❌ ${message}\n`);
};

const openItem = async (page: Page, id: string): Promise<void> => {
  await page.locator('[data-agenda-line-toggle]').click();
  await page.locator('[data-agenda-drawer]').waitFor({ state: 'visible' });
  await page.waitForTimeout(150);
  await page.locator(`[data-agenda-drawer] [data-agenda-row="${id}"]`).click();
  await page.locator('[data-agenda-view]').waitFor({ state: 'visible' });
  await page.waitForTimeout(250);
};

const scene = async (form: Form, theme: string, wanted: (typeof SCENES)[number]): Promise<void> => {
  const label = `${wanted.shape} ${form} ${theme}`;
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
  await page.goto(`${server.url}?theme=${theme}&view=board&shapes=1`);
  await page.locator('[data-fixture]').waitFor({ state: 'visible' });
  await page.waitForTimeout(200);
  await openItem(page, wanted.id);

  const found = await page.evaluate(() => {
    const card = document.querySelector('.fy-card');
    const need = card?.querySelector('[data-agenda-need]');
    const blocks = [
      ...(card?.querySelectorAll('[data-agenda-situation], [data-agenda-need], [data-agenda-section]') ?? []),
    ]
      .filter(node => !node.closest('[data-agenda-situation]') || node.hasAttribute('data-agenda-situation'))
      .map(node =>
        node.hasAttribute('data-agenda-situation')
          ? 'situation'
          : node.hasAttribute('data-agenda-need')
            ? 'need'
            : 'section',
      );
    const body = document.querySelector('.fy-item-view__body');
    return {
      shape: need?.getAttribute('data-agenda-need') ?? null,
      lead: need?.querySelector('[data-agenda-need-lead]')?.textContent ?? null,
      heading: need?.querySelector('h4')?.textContent ?? null,
      order: blocks,
      buttons: [...document.querySelectorAll('.fy-card [data-agenda-quick-replies] .fy-qr__chip')].map(
        node => node.querySelector('.fy-qr__label')?.textContent ?? node.textContent ?? '',
      ),
      pickers: card?.querySelectorAll('[data-agenda-pick], [data-agenda-send-answers]').length ?? 0,
      wanted: need?.querySelectorAll('[data-agenda-wanted-answer]').length ?? 0,
      wide: Math.max(
        document.documentElement.scrollWidth - window.innerWidth,
        body === null ? 0 : body.scrollWidth - body.clientWidth,
      ),
    };
  });
  check(found.wide <= 0, `${label}: scrolls sideways by ${found.wide}px`);
  check(found.shape === wanted.shape, `${label}: the segment reads as ${found.shape ?? 'nothing'}`);
  check(found.heading === 'What I need from you', `${label}: the segment is headed "${found.heading ?? ''}"`);
  check(found.lead === AGENDA_SHAPE_LEADS[wanted.shape], `${label}: the instruction says "${found.lead ?? ''}"`);
  check(
    found.order[0] === 'situation' && found.order[1] === 'need',
    `${label}: the segment is not directly under the premise and context (${found.order.join(' › ')})`,
  );
  check(
    JSON.stringify(found.buttons) === JSON.stringify(wanted.buttons),
    `${label}: the answer row offers ${JSON.stringify(found.buttons)}, wanted ${JSON.stringify(wanted.buttons)}`,
  );
  check(found.pickers === 0, `${label}: ${found.pickers} per-question picker(s) drawn`);
  if (wanted.shape === 'answers') check(found.wanted === 3, `${label}: ${found.wanted} numbered answers, wanted 3`);

  // The picture holds the whole card: the item view's body is its scroller, so it is drawn full height.
  const height = await page.locator('.fy-item-view__body').evaluate(node => node.scrollHeight);
  const viewport = page.viewportSize() ?? { width: 390, height: 844 };
  await page.setViewportSize({ width: viewport.width, height: Math.max(viewport.height, height + 160) });
  await page.waitForTimeout(150);
  await page.mouse.move(1, 1);
  const path = join(outDir, `${wanted.shape}-${form}-${theme}.png`);
  await page.screenshot({ path });
  process.stdout.write(`📸 ${path}\n`);
  await context.close();
};

for (const form of ['phone', 'desktop'] as const) {
  for (const theme of THEMES) {
    for (const wanted of SCENES) await scene(form, theme, wanted);
  }
}

await browser.close();
server.stop(true);
if (violations.length > 0) fail(`${violations.length} of ${checks} checks failed`);
process.stdout.write(`✅ ${checks} checks passed\n`);
