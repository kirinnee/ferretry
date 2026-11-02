/**
 * Round 2 of the roomier Inbox: the phone Inbox list as ONE compact filter row (and its menu), the kind chip (TASK or
 * AGENDA) on every card, a swipe started from the MIDDLE of a card — Inbox card, Answer quickly and the side panel —
 * with a wobble that leans off the horizontal, and the side panel's Cards with a long body scrolled while its head and
 * answer row stay in view. Phone 390 and desktop 1440, light and dark of each family.
 *
 *   bun harness/roomier-inbox-2-screenshot.ts [outDir]   # writes <outDir>/<name>-<phone|desktop>-<theme>.png
 *
 * Real touch input (CDP). FAILS, after writing every picture, when a page scrolls sideways; the phone's filter chrome is
 * more than one row; a menu does not list its counts or change the list; a card lacks the right kind chip; a drag that
 * starts at the card's middle (straight, or leaning ~30°) does not read as a swipe; or the side panel's head or answer
 * row leave the screen while the body scrolls.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type CDPSession, chromium, type Page } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out', 'roomier-inbox-2-build');
const outDir = resolve(process.argv[2] ?? '/tmp/claude-1000/shots/roomier-inbox-2');
const problems: string[] = [];
const fail = (message: string): never => {
  process.stderr.write(`❌ ${message}\n`);
  process.exit(1);
};
const check = (ok: boolean, message: string): void => {
  if (!ok) problems.push(message);
};
const run = (command: string, args: readonly string[]): void => {
  if (spawnSync(command, args, { cwd: packageDir, stdio: 'inherit' }).status !== 0) fail(`${command} failed`);
};

mkdirSync(buildDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
for (const page of ['inbox-page', 'board-chat-page'])
  run('bun', ['build', join(harnessDir, `${page}.tsx`), '--outdir', buildDir, '--target', 'browser']);
run('./node_modules/.bin/tailwindcss', [
  '--config',
  'tailwind.config.ts',
  '--input',
  'src/styles/index.css',
  '--output',
  join(buildDir, 'app.css'),
]);

const html = (
  theme: string,
  script: string,
) => `<!doctype html><html lang="en" data-theme="${theme}"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" /><link rel="stylesheet" href="/app.css" /></head>
<body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/${script}.js"></script></body></html>`;
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/')
      return new Response(
        html(url.searchParams.get('theme') ?? 'studio-dark', url.searchParams.get('page') ?? 'inbox-page'),
        {
          headers: { 'content-type': 'text/html' },
        },
      );
    const built = Bun.file(join(buildDir, url.pathname));
    return new Response((await built.exists()) ? built : Bun.file(join(packageDir, 'public', url.pathname)));
  },
});

const executablePath =
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? Bun.which('chromium-browser') ?? fail('no Chrome');
const browser = await chromium.launch({ executablePath, headless: true });
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } as const;
const DESKTOP = { viewport: { width: 1_440, height: 900 }, hasTouch: true } as const;
const THEMES = (process.env.FY_SHOT_THEMES ?? 'studio-light,studio-dark,neo-light,neo-dark').split(',');
const NOW = new Date('2026-10-29T09:00:00.000Z');
const PANEL = 'page=board-chat-page&state=card&tab=tasks&view=cards&cards=few&agents=1&totest=1&long=1';

const touch = (client: CDPSession, type: 'touchStart' | 'touchMove' | 'touchEnd', x?: number, y?: number) =>
  client.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: x === undefined || y === undefined ? [] : [{ x, y }],
  });

/** A finger down at (x, y), dragged `dx` across while drifting down `slope` px per px (0.5 is ~27°). */
const drag = async (client: CDPSession, page: Page, x: number, y: number, dx: number, slope: number): Promise<void> => {
  await touch(client, 'touchStart', x, y);
  for (let step = 1; step <= 10; step += 1)
    await touch(client, 'touchMove', x + (dx * step) / 10, y + (dx * slope * step) / 10);
  await page.waitForTimeout(120);
};

for (const form of ['phone', 'desktop'] as const) {
  for (const theme of THEMES) {
    const context = await browser.newContext({
      ...(form === 'phone' ? PHONE : DESKTOP),
      timezoneId: 'UTC',
      locale: 'en-US',
      colorScheme: theme.endsWith('-dark') ? 'dark' : 'light',
    });
    const cut = theme.lastIndexOf('-');
    await context.addInitScript(
      ([family, mode]) => localStorage.setItem('fy-theme-v1', JSON.stringify({ family, mode, textScale: 'default' })),
      [theme.slice(0, cut), theme.slice(cut + 1)] as const,
    );
    const open = async (query: string, ready: string): Promise<Page> => {
      const page = await context.newPage();
      await page.route('**/*', route =>
        route.request().url().startsWith(server.url.origin) ? route.continue() : route.abort(),
      );
      await page.clock.setFixedTime(NOW);
      await page.goto(`${server.url}?theme=${theme}&${query}`);
      await page.locator(ready).first().waitFor({ state: 'visible' });
      await page.waitForTimeout(400);
      const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check(wide <= 0, `${form} ${theme} ${query}: scrolls sideways by ${wide}px`);
      return page;
    };
    const snap = async (page: Page, name: string): Promise<void> => {
      const path = join(outDir, `${name}-${form}-${theme}.png`);
      await page.waitForTimeout(150);
      await page.screenshot({ path });
      process.stdout.write(`📸 ${path}\n`);
    };
    /** Middle swipes on a card: straight and leaning 30°-ish, from the vertical middle of its body. */
    const middleSwipes = async (page: Page, where: string, frameSelector: string): Promise<void> => {
      const client = await context.newCDPSession(page);
      const frame = await page.locator(frameSelector).first().boundingBox();
      if (frame === null) return check(false, `${where}: no card body to grab`);
      const x = frame.x + Math.min(80, frame.width / 3);
      const view = await page.evaluate(() => window.innerHeight);
      const top = Math.max(frame.y, 0);
      const y = top + (Math.min(frame.y + frame.height, view) - top) / 2;
      for (const [name, lean] of [
        ['straight', 0],
        ['leaning', 0.5],
      ] as const) {
        await drag(client, page, x, y, 130, lean);
        const direction = await page
          .locator('[data-swipe-direction]')
          .first()
          .getAttribute('data-swipe-direction')
          .catch(() => null);
        check(
          direction === 'right',
          `${where} ${name}: a drag from the middle read as "${direction}", not a swipe right`,
        );
        if (name === 'leaning') await snap(page, `${where.split(' ')[0]}-swipe-from-middle`);
        await touch(client, 'touchEnd');
        await page.waitForTimeout(250);
      }
    };

    // The phone's Inbox list top: ONE compact filter row, the status menu open with its counts.
    const list = await open('view=sections&bar=1', '[data-agenda-filter]');
    await snap(list, 'inbox-list-top');
    if (form === 'phone') {
      const head = await list.locator('.fy-attn-inbox__head').boundingBox();
      check(
        head !== null && head.height <= 64,
        `${theme}: the phone's filter chrome is ${head?.height}px, more than one row`,
      );
      await list.locator('[data-agenda-filter] button').click();
      const words = (await list.locator('[data-agenda-filter-option]').allTextContents()).join('|');
      check(
        /Snoozed \(\d+\)/u.test(words) && /Replied \(\d+\)/u.test(words),
        `${theme}: the status menu lacks counts ("${words}")`,
      );
      await snap(list, 'inbox-list-status-menu');
      await list.locator('[data-agenda-filter-option="snoozed"]').click();
      check(
        ((await list.locator('[data-agenda-filter] button').first().textContent()) ?? '').startsWith('Snoozed'),
        `${theme}: choosing Snoozed did not show on the button`,
      );
      await list.locator('[data-agenda-find-open]').click();
      await list.locator('[data-agenda-find]').fill('pair');
      await snap(list, 'inbox-list-find');
    }
    await list.close();

    // The agenda card (a question) and the task card (Answer quickly): the chip, the swipe from the middle.
    const agenda = await open('view=open&bar=1', '[data-card-head]:visible');
    check(
      (await agenda.locator('[data-card-kind="agenda"]:visible').count()) > 0,
      `${form} ${theme}: the agenda card has no AGENDA chip`,
    );
    await snap(agenda, 'agenda-card-kind-chip');
    if (form === 'phone') await middleSwipes(agenda, 'agenda-card', '[data-agenda-frame]:visible');
    await agenda.close();

    const task = await open('view=quick-to-test&bar=1', '[data-card-head]:visible');
    check(
      (await task.locator('[data-card-kind="task"]:visible').count()) > 0,
      `${form} ${theme}: the task card has no TASK chip`,
    );
    await snap(task, 'task-card-kind-chip');
    if (form === 'phone') await middleSwipes(task, 'answer-quickly', '[data-to-test]:visible');
    await task.close();

    // The side panel: the same card, head and answer row sticky while a long body scrolls.
    const panel = await open(PANEL, '[data-to-test]');
    check(
      (await panel.locator('[data-card-kind="task"]:visible').count()) > 0,
      `${form} ${theme}: the panel card has no TASK chip`,
    );
    await panel
      .locator('[data-to-test-how]')
      .first()
      .evaluate(element => {
        let node: HTMLElement | null = element as HTMLElement;
        while (
          node !== null &&
          !(node.scrollHeight > node.clientHeight + 2 && /auto|scroll/u.test(getComputedStyle(node).overflowY))
        )
          node = node.parentElement;
        if (node !== null) node.scrollTop = 9_999;
      });
    await panel.waitForTimeout(200);
    const view = await panel.evaluate(() => window.innerHeight);
    const headBox = await panel.locator('[data-card-head]').first().boundingBox();
    const answers = await panel.locator('.fy-totest__actions').first().boundingBox();
    check(
      headBox !== null && headBox.y >= 0 && headBox.y + headBox.height <= view,
      `${form} ${theme}: the panel head left the screen`,
    );
    check(
      answers !== null && answers.y >= 0 && answers.y + answers.height <= view,
      `${form} ${theme}: the panel answer row left the screen`,
    );
    await snap(panel, 'side-panel-cards-long-scrolled');
    if (form === 'phone') await middleSwipes(panel, 'side-panel', '[data-to-test]:visible');
    await panel.close();
    await context.close();
  }
}
await browser.close();
server.stop();
if (problems.length > 0) fail(problems.join('\n'));
process.stdout.write('✅ done\n');
