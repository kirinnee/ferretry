/**
 * THE PHONE'S BOTTOM NAV OWNS ITS STRIP, MEASURED IN A REAL BROWSER.
 *
 * The Inbox sits in the real shell tree (`kt-shell` › `data-shell-main` › pull region › page › tab bar)
 * over invented cards. At 390 and 412 wide, in Studio and Neo-Brutalism, light and dark, it is scrolled
 * to the top, the middle and the end, and every claim is a number:
 *
 *   * the Inbox has ONE scroller, and its bottom edge is the tab bar's top edge;
 *   * nothing the page draws is under the tab bar (`elementFromPoint` over the bar's strip lands on the bar);
 *   * scrolled to the end, the last card's bottom sits at least the page's bottom padding above the bar
 *     (the bar's height is NOT added: the scroller already stops at it);
 *   * the bar has its own surface (an opaque background) and nothing scrolls the document.
 *
 * Every check announces itself and is counted: a check that stops being reached reads exactly like one
 * that passed, so the run owes `MOBILE_INBOX_NAV_CHECKS`.
 *
 *   bun harness/mobile-inbox-nav-geometry.ts [--label before|after] [outDir]
 *   # writes <outDir>/mobile-inbox-<label>-<width>-<theme>-<top|end>.png and exits 1 on any violation
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out', 'mobile-inbox-nav-build');
const labelAt = process.argv.indexOf('--label');
const label = labelAt === -1 ? 'after' : (process.argv[labelAt + 1] ?? 'after');
const positional = process.argv.slice(2).filter((arg, at, all) => arg !== '--label' && all[at - 1] !== '--label');
const outDir = resolve(positional[0] ?? '/tmp/claude-1000');

const fail = (message: string): never => {
  process.stderr.write(`❌ ${message}\n`);
  process.exit(1);
};

const run = (command: string, args: readonly string[]): void => {
  const result = spawnSync(command, args, { cwd: packageDir, stdio: 'inherit' });
  if (result.status !== 0) fail(`${command} exited ${result.status}`);
};

const WIDTHS = [
  { width: 390, height: 844 },
  { width: 412, height: 915 },
] as const;
const THEMES = ['studio-light', 'studio-dark', 'neo-light', 'neo-dark'] as const;
/** Four checks at each of the two stops (top, end) of every width and theme. */
export const MOBILE_INBOX_NAV_CHECKS = WIDTHS.length * THEMES.length * 2 * 5;

const html = (theme: string) => `<!doctype html>
<html lang="en" data-theme="${theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <link rel="stylesheet" href="/app.css" />
  </head>
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/inbox-page.js"></script></body>
</html>`;

mkdirSync(buildDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
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

const violations: string[] = [];
let checks = 0;
const check = (ok: boolean, message: string): void => {
  checks += 1;
  if (ok) return;
  violations.push(message);
  process.stderr.write(`❌ ${message}\n`);
};

interface Measure {
  readonly scrollers: number;
  readonly scrollerBottom: number | null;
  readonly scrollerTop: number | null;
  readonly navTop: number;
  readonly navHeight: number;
  readonly navOpaque: boolean;
  readonly underNav: number;
  readonly documentScroll: number;
  readonly lastCardBottom: number;
  readonly pageBottomPadding: number;
  readonly atEnd: boolean;
}

const scrollTo = async (page: Page, stop: 'top' | 'end'): Promise<void> => {
  await page.evaluate(stopName => {
    const main = document.querySelector('main[data-agenda-inbox]');
    let node: Element | null = main;
    while (node !== null) {
      const style = getComputedStyle(node);
      if (/(auto|scroll)/u.test(style.overflowY) && node.scrollHeight > node.clientHeight) {
        node.scrollTop = stopName === 'top' ? 0 : node.scrollHeight;
        return;
      }
      node = node.parentElement;
    }
  }, stop);
  await page.waitForTimeout(150);
};

const measure = async (page: Page): Promise<Measure> =>
  await page.evaluate(() => {
    const main = document.querySelector('main[data-agenda-inbox]');
    const nav = document.querySelector('[data-app-tab-bar]');
    if (main === null || nav === null) throw new Error('the Inbox or its tab bar is not on screen');
    const navRect = nav.getBoundingClientRect();
    const scrollers: Element[] = [];
    for (let node: Element | null = main; node !== null; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (/(auto|scroll)/u.test(style.overflowY) && node.scrollHeight > node.clientHeight) scrollers.push(node);
    }
    const scroller = scrollers[0] ?? null;
    const scrollerRect = scroller?.getBoundingClientRect() ?? null;
    let underNav = 0;
    for (let x = navRect.left + 4; x < navRect.right; x += 12) {
      for (const y of [navRect.top + 2, navRect.top + navRect.height / 2, navRect.bottom - 2]) {
        const hit = document.elementFromPoint(x, y);
        if (hit !== null && !nav.contains(hit)) underNav += 1;
      }
    }
    const cards = [...document.querySelectorAll('.fy-attn-card, .fy-attn-row, [data-agenda-lists] a')];
    const lastCard = cards.at(-1)?.getBoundingClientRect() ?? null;
    const ground = getComputedStyle(nav).backgroundColor;
    return {
      scrollers: scrollers.length,
      scrollerBottom: scrollerRect === null ? null : scrollerRect.bottom,
      scrollerTop: scrollerRect === null ? null : scrollerRect.top,
      navTop: navRect.top,
      navHeight: navRect.height,
      navOpaque: !/rgba\(.*,\s*0\)$/u.test(ground) && ground !== 'transparent',
      underNav,
      documentScroll: document.documentElement.scrollTop + document.body.scrollTop,
      lastCardBottom: lastCard === null ? 0 : lastCard.bottom,
      pageBottomPadding: Number.parseFloat(getComputedStyle(main).paddingBottom),
      atEnd: scroller === null ? true : scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1,
    };
  });

for (const size of WIDTHS) {
  for (const theme of THEMES) {
    const context = await browser.newContext({
      viewport: size,
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
      timezoneId: 'UTC',
      locale: 'en-US',
      userAgent:
        'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
    });
    const page = await context.newPage();
    await page.route('**/*', route =>
      route.request().url().startsWith(server.url.origin) ? route.continue() : route.abort(),
    );
    await page.clock.setFixedTime(new Date('2026-10-29T09:00:00.000Z'));
    await page.goto(`${server.url}?theme=${theme}&view=sections-open`);
    await page.locator('[data-fixture]').waitFor({ state: 'visible' });
    await page.waitForTimeout(250);
    for (const stop of ['top', 'end'] as const) {
      await scrollTo(page, stop);
      const m = await measure(page);
      const where = `${size.width}px ${theme} ${stop}`;
      check(m.scrollers === 1, `${where}: ${m.scrollers} scrollers hold the Inbox, expected exactly 1`);
      check(
        m.scrollerBottom !== null && Math.abs(m.scrollerBottom - m.navTop) <= 1,
        `${where}: the scroller ends at ${m.scrollerBottom}, the tab bar starts at ${m.navTop}`,
      );
      check(m.underNav === 0, `${where}: ${m.underNav} points of the tab bar's strip show the page, not the bar`);
      check(m.navOpaque, `${where}: the tab bar has no surface of its own`);
      check(
        m.documentScroll === 0 && (stop === 'top' || m.lastCardBottom <= m.navTop - 4),
        `${where}: the last card ends at ${m.lastCardBottom}, under the tab bar at ${m.navTop} (document scroll ${m.documentScroll})`,
      );
      await page.screenshot({ path: join(outDir, `mobile-inbox-${label}-${size.width}-${theme}-${stop}.png`) });
    }
    await context.close();
  }
}

await browser.close();
server.stop(true);

if (checks !== MOBILE_INBOX_NAV_CHECKS) fail(`ran ${checks} checks, owed ${MOBILE_INBOX_NAV_CHECKS}`);
if (violations.length > 0) fail(`${violations.length} of ${checks} checks failed`);
process.stdout.write(`✅ mobile inbox nav geometry: ${checks} checks\n`);
