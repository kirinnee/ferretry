/**
 * Screenshots and checks for the open item's COMPACT HEAD (&F920; docs/agenda.md § The item view, "One menu for the
 * quiet controls"): ONE row — the one-line title, ‹ n/N ›, ⋯ and ✕ — two small chips under it, and every quiet control
 * (version, Changes, Snooze, Merge with…, Skip, Not needed) behind ⋯: a bottom sheet on a phone, a popover wider.
 *
 *   bun harness/agenda-compact-head-screenshot.ts [outDir]   # writes <outDir>/<scene>-<phone|desktop>-<theme>.png
 *
 * It drives the real Inbox (`inbox-page.tsx`, `?view=open` and `?view=open-longtitle`, with the app bar) and FAILS
 * (after writing every picture) when: a page scrolls sideways; the head is more than one row; the title wraps or is
 * drawn twice; the premise starts below the top ~quarter of a 390px phone's screen (it prints where it starts); the
 * terms, the conversation or the activity start open; or the ⋯ menu is not a sheet on a phone and a popover wider, or
 * leaves the screen.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out', 'agenda-compact-head-build');
const outDir = resolve(process.argv[2] ?? '/tmp/claude-1000/shots/F920');
const fail = (message: string): never => {
  process.stderr.write(`❌ ${message}\n`);
  process.exit(1);
};
const run = (command: string, args: readonly string[]): void => {
  if (spawnSync(command, args, { cwd: packageDir, stdio: 'inherit' }).status !== 0) fail(`${command} failed`);
};

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

const html = (theme: string) => `<!doctype html><html lang="en" data-theme="${theme}"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" /><link rel="stylesheet" href="/app.css" /></head>
<body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/inbox-page.js"></script></body></html>`;
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
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? Bun.which('chromium-browser') ?? fail('no Chrome');
const browser = await chromium.launch({ executablePath, headless: true });
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } as const;
const DESKTOP = { viewport: { width: 1_440, height: 900 } } as const;
const THEMES = (process.env.FY_SHOT_THEMES ?? 'studio-light,studio-dark').split(',');
const NOW = new Date('2026-10-29T09:00:00.000Z');
const problems: string[] = [];
const check = (ok: boolean, message: string): void => {
  if (!ok) problems.push(message);
};

for (const form of ['phone', 'desktop'] as const) {
  for (const theme of THEMES) {
    const context = await browser.newContext({
      ...(form === 'phone' ? PHONE : DESKTOP),
      timezoneId: 'UTC',
      locale: 'en-US',
      colorScheme: theme.endsWith('-dark') ? 'dark' : 'light',
    });
    const [family, mode] = [theme.slice(0, theme.lastIndexOf('-')), theme.slice(theme.lastIndexOf('-') + 1)];
    await context.addInitScript(
      ([f, m]) => localStorage.setItem('fy-theme-v1', JSON.stringify({ family: f, mode: m, textScale: 'default' })),
      [family, mode] as const,
    );
    const open = async (view: string): Promise<Page> => {
      const page = await context.newPage();
      await page.route('**/*', route =>
        route.request().url().startsWith(server.url.origin) ? route.continue() : route.abort(),
      );
      await page.clock.setFixedTime(NOW);
      await page.goto(`${server.url}?theme=${theme}&view=${view}&bar=1`);
      await page.locator('[data-agenda-view]:visible [data-card-head]').first().waitFor({ state: 'visible' });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(400);
      return page;
    };
    const snap = async (page: Page, name: string): Promise<void> => {
      const path = join(outDir, `${name}-${form}-${theme}.png`);
      await page.waitForTimeout(150);
      await page.screenshot({ path });
      process.stdout.write(`📸 ${path}\n`);
    };
    const label = (scene: string) => `${scene} ${form} ${theme}`;

    for (const view of ['open', 'open-longtitle'] as const) {
      const page = await open(view);
      const laid = await page.evaluate(() => {
        // The deck keeps the cards under the top one mounted, hidden: read the one on screen.
        const view = [...document.querySelectorAll<HTMLElement>('[data-agenda-view]')].find(
          node => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden',
        );
        const box = (query: string) => view?.querySelector(query)?.getBoundingClientRect() ?? null;
        const title = view?.querySelector<HTMLElement>('[data-agenda-title]') ?? null;
        const head = box('.fy-item-view__head');
        const premise = box('[data-agenda-part="premise"]');
        const folds = Object.fromEntries(
          [...(view?.querySelectorAll('[data-agenda-fold]') ?? [])].map(node => [
            node.getAttribute('data-agenda-fold'),
            node.getAttribute('aria-expanded'),
          ]),
        );
        return {
          wide: document.documentElement.scrollWidth - window.innerWidth,
          height: window.innerHeight,
          headHeight: head?.height ?? 0,
          premiseTop: premise?.top ?? null,
          titleLines:
            title === null ? 0 : Math.round(title.clientHeight / Number.parseFloat(getComputedStyle(title).lineHeight)),
          wraps: title?.hasAttribute('data-wrap') ?? true,
          twice: view?.querySelectorAll('[data-agenda-full-title]').length ?? 0,
          folds,
        };
      });
      check(laid.wide <= 0, `${label(view)}: scrolls sideways by ${laid.wide}px`);
      check(laid.headHeight <= 72, `${label(view)}: the head is ${laid.headHeight}px tall, wanted one row`);
      check(laid.titleLines === 1 && !laid.wraps, `${label(view)}: the title takes ${laid.titleLines} lines`);
      check(laid.twice === 0, `${label(view)}: the title is drawn a second time`);
      for (const part of ['references', 'conversation', 'activity'])
        check(laid.folds[part] !== 'true', `${label(view)}: ${part} starts open`);
      if (laid.premiseTop !== null) {
        const share = laid.premiseTop / laid.height;
        process.stdout.write(
          `📏 ${label(view)}: the premise starts at ${Math.round(laid.premiseTop)}px of ${laid.height}px (${Math.round(share * 100)}%)\n`,
        );
        if (form === 'phone') check(share <= 0.3, `${label(view)}: the premise starts at ${Math.round(share * 100)}%`);
      }
      await snap(page, view === 'open' ? 'item-top' : 'item-long-title');

      if (view === 'open') {
        await page.locator('[data-agenda-view]:visible [data-agenda-menu-toggle]').first().click();
        const want = form === 'phone' ? 'sheet' : 'popover';
        await page.locator(`[data-agenda-menu="${want}"]`).waitFor({ state: 'visible' });
        await page.waitForTimeout(350);
        const menu = await page.evaluate((kind: string) => {
          const node = document.querySelector(`[data-agenda-menu="${kind}"]`);
          const rect = node?.getBoundingClientRect();
          return {
            inside:
              rect !== undefined &&
              rect.left >= -1 &&
              rect.top >= -1 &&
              rect.right <= document.documentElement.clientWidth + 1 &&
              rect.bottom <= window.innerHeight + 1,
            groups: [...(node?.querySelectorAll('[data-agenda-menu-group]') ?? [])].map(group =>
              group.getAttribute('data-agenda-menu-group'),
            ),
          };
        }, want);
        check(menu.inside, `${label('menu')}: the ${want} leaves the screen`);
        check(menu.groups.includes('aside'), `${label('menu')}: no Skip / Not needed in the menu (${menu.groups})`);
        await snap(page, 'item-menu');
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
        check(
          (await page.locator('[data-agenda-view]:visible').count()) > 0,
          `${label('menu')}: Esc closed the item, not the menu`,
        );
        // The folded parts, opened, to see them drawn.
        for (const part of ['references', 'conversation']) {
          const toggle = page.locator(`[data-agenda-view]:visible [data-agenda-fold="${part}"]`).first();
          if ((await toggle.count()) > 0) await toggle.click();
        }
        await page
          .locator('[data-agenda-view]:visible [data-agenda-part="references"]')
          .first()
          .scrollIntoViewIfNeeded()
          .catch(() => undefined);
        await snap(page, 'item-folds-open');
      }
      await page.close();
    }
    await context.close();
  }
}
await browser.close();
server.stop();
if (problems.length > 0) fail(problems.join('\n'));
process.stdout.write('✅ done\n');
