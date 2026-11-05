/**
 * Screenshots and checks for the open item's CONVERSATION drawn with the chat's own rows (&F921; docs/agenda.md § The
 * item view, "The conversation looks like the chat"): the owner's words are the chat's bubble with its time and its
 * receipt ticks at the foot, the ferret's are the chat's agent text, its name above and its time below.
 *
 *   bun harness/agenda-convo-chat-screenshot.ts [outDir]   # writes <outDir>/conversation-<phone|desktop>-<theme>.png
 *
 * It drives the real Inbox (`inbox-page.tsx`, `?view=open`, with the app bar), opens the folded Conversation and FAILS
 * (after writing every picture) when: the page scrolls sideways; the owner's row is not the chat's bubble with a time
 * and a four-tick receipt; a ferret row is not the chat's agent row with its name above and its time at the foot; or a
 * bubble leaves the screen.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out', 'agenda-convo-chat-build');
const outDir = resolve(process.argv[2] ?? '/tmp/claude-1000/shots/F921');
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

    const page = await open('open');
    const fold = page.locator('[data-agenda-view]:visible [data-agenda-fold="conversation"]').first();
    check((await fold.getAttribute('aria-expanded')) === 'false', `${label('conversation')}: starts open`);
    await (form === 'phone' ? fold.tap() : fold.click());
    const list = page.locator('[data-agenda-view]:visible [data-agenda-history]').first();
    await list.waitFor({ state: 'visible' });
    await list.evaluate(node => node.scrollIntoView({ block: 'end' }));
    await page.waitForTimeout(300);
    const drawn = await list.evaluate(node => {
      const rows = [...node.querySelectorAll(':scope > li')];
      const box = (element: Element | null) => element?.getBoundingClientRect();
      return {
        wide: document.documentElement.scrollWidth - window.innerWidth,
        width: window.innerWidth,
        rows: rows.map(row => {
          const article = row.querySelector('article.fy-message');
          const rect = box(article);
          return {
            who: row.getAttribute('data-history'),
            chat: article?.className ?? '',
            name: article?.querySelector('header')?.textContent ?? '',
            time: article?.querySelector('[data-message-footer] time')?.textContent ?? '',
            receipt: article?.querySelector('[data-send-receipt]')?.getAttribute('data-send-receipt') ?? null,
            ticks: article?.querySelectorAll('[data-send-receipt] svg path').length ?? 0,
            left: rect?.left ?? 0,
            right: rect?.right ?? 0,
          };
        }),
      };
    });
    check(drawn.wide <= 0, `${label('conversation')}: scrolls sideways by ${drawn.wide}px`);
    check(drawn.rows.length >= 3, `${label('conversation')}: ${drawn.rows.length} rows, expected 3`);
    for (const row of drawn.rows) {
      check(/^\d\d:\d\d$/u.test(row.time), `${label('conversation')}: a ${row.who} row shows no chat clock`);
      check(row.left >= 0 && row.right <= drawn.width, `${label('conversation')}: a ${row.who} row leaves the screen`);
      if (row.who === 'owner') {
        check(row.chat.includes('fy-message-user'), `${label('conversation')}: the owner's row is not the chat bubble`);
        check(row.receipt === 'read' && row.ticks === 4, `${label('conversation')}: the owner's row has no four ticks`);
      } else {
        check(row.chat.includes('fy-message-assistant'), `${label('conversation')}: a ferret row is not the chat's`);
        check(row.name.trim() !== '', `${label('conversation')}: a ferret row has no name above it`);
      }
    }
    await snap(page, 'conversation');
    await context.close();
  }
}

await browser.close();
server.stop();
if (problems.length > 0) fail(problems.join('\n'));
process.stdout.write(`✅ every check passed — ${outDir}\n`);
