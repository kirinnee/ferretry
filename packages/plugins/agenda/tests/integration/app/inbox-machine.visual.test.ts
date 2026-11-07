/**
 * THE INBOX'S MACHINE GROUP, in a real browser, on a phone and a desktop.
 *
 *  - The Machine group is the FIRST group, above the ferret's, with the machine's own notices ("3 ferrets could not be
 *    moved", "claude-liftoff hit its hard limit") and no callsign.
 *  - Its header carries an icon and is not a link: the machine agenda has no chat.
 *  - Its rows read at the same contrast as the ferret's, and a tap opens the detail: why, the listed ferrets and the fix.
 *  - Nothing scrolls sideways.
 *
 * Set `FY_INBOX_MACHINE_SHOTS_DIR` to keep `<viewport>-<theme>-machine.png` and `…-machine-open.png`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser } from 'playwright-core';
import { sharedChromium } from './support/hromium.ts';

const packageRoot = resolve(import.meta.dir, '../..');
const shotsDir = process.env.FY_INBOX_MACHINE_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-inbox-machine-'));
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(packageRoot, 'scripts/build-composer-integration-fixture.ts'),
      '--out',
      directory,
      '--entry',
      'tests/integration/fixtures/inbox-machine-scene.tsx',
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the inbox machine scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  return { css: await readFile(manifest.css, 'utf8'), js: await readFile(manifest.js, 'utf8') };
};

beforeAll(async () => {
  browser = await sharedChromium();
  const { css, js } = await build();
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>html, body, #root { height: 100%; margin: 0; }</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      const path = new URL(request.url).pathname;
      if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
      if (path === '/') return new Response(page, { headers: { 'content-type': 'text/html' } });
      return new Response('not here', { status: 404 });
    },
  });
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const VIEWPORTS = [
  { name: 'phone-390', width: 390, height: 844, phone: true },
  { name: 'desktop-1440', width: 1_440, height: 900, phone: false },
] as const;

const THEMES = ['studio-light', 'studio-dark'] as const;

describe('the Inbox’s Machine group', () => {
  for (const viewport of VIEWPORTS)
    for (const theme of THEMES)
      it(`comes first with an icon, reads at full contrast and opens its detail (${viewport.name}, ${theme})`, async () => {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          deviceScaleFactor: viewport.phone ? 2 : 1,
          hasTouch: viewport.phone,
          isMobile: viewport.phone,
        });
        const origin = server?.url.origin ?? '';
        await context.route('**/*', async route =>
          new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
        );
        const tab = await context.newPage();
        try {
          await tab.goto(`${origin}/?theme=${theme}`);
          await tab.waitForSelector('[data-agenda-group]', { timeout: 4_000 });
          await tab.evaluate(async () => await document.fonts.ready);
          const groups = await tab.evaluate(() =>
            [...document.querySelectorAll('[data-agenda-group]')].map(group => ({
              text: group.textContent ?? '',
              link: group.querySelector('[data-agenda-group-link]') !== null,
              machine: group.querySelector('[data-agenda-group-machine]') !== null,
              icon: group.querySelector('[data-agenda-group-icon]') !== null,
              titleColors: [...group.querySelectorAll('[data-agenda-row-title]')].map(
                title => getComputedStyle(title).color,
              ),
              notices: group.querySelectorAll('[data-agenda-notice]').length,
            })),
          );
          expect(groups.length).toBe(2);
          expect(groups[0]?.machine).toBe(true);
          expect(groups[0]?.icon).toBe(true);
          expect(groups[0]?.link).toBe(false);
          expect(groups[0]?.notices).toBe(0);
          expect(groups[0]?.text).toContain('4 ferrets could not be moved');
          expect(groups[0]?.text).toContain('claude-liftoff hit its hard limit');
          expect(groups[1]?.link).toBe(true);
          // The same text colour as the ferret's own row, not a muted grey.
          expect(new Set([...(groups[0]?.titleColors ?? []), ...(groups[1]?.titleColors ?? [])]).size).toBe(1);
          const overflow = await tab.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
          expect(overflow).toBeLessThanOrEqual(0);
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${theme}-machine.png`) });

          await tab.goto(`${origin}/?theme=${theme}&open=1`);
          await tab.waitForSelector('[data-inbox-open] [data-inbox-machine-why] >> visible=true', { timeout: 4_000 });
          await tab.evaluate(async () => await document.fonts.ready);
          await tab.waitForTimeout(900);
          if (shotsDir !== '')
            await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${theme}-machine-open.png`) });
          const detail = await tab.evaluate(
            () =>
              [...document.querySelectorAll('[data-inbox-open]')]
                .map(open => open.textContent ?? '')
                .find(text => text.includes('durian')) ?? '',
          );
          expect(detail).toContain('durian');
          expect(detail).toContain('fy migrate 7f3a91c2 -a claude-llm1');
          expect(detail).toContain('fy migrate b04e55d8 -a claude-atomi-long-login-name');
          expect(detail).not.toContain('fy migrate e29c1a60');
          expect(detail).not.toContain('fy migrate c81d02aa');
          expect(detail).not.toContain('<runtime>');
          expect(detail).not.toContain('warden.yaml');
          expect(detail.split('Wait for it to finish its turn').length).toBe(2);
          expect(detail.split('Wait for a login to reset').length).toBe(2);
          const laid = await tab.evaluate(() => {
            const notes = document.querySelector('[data-inbox-machine-notes]');
            const title = document.querySelector('[data-inbox-open] [data-agenda-title]');
            const text = title?.querySelector('.fy-item-view__title-text');
            const commands = [...document.querySelectorAll<HTMLElement>('[data-inbox-machine-command]')];
            return {
              pad: notes === null ? 0 : Number.parseFloat(getComputedStyle(notes).paddingLeft),
              rights: [...document.querySelectorAll('[data-inbox-machine-move] [data-onboarding-copy]')].map(button =>
                Math.round(button.getBoundingClientRect().right),
              ),
              lefts: commands.map(code => Math.round(code.getBoundingClientRect().left)),
              heights: commands.map(code => Math.round(code.getBoundingClientRect().height)),
              nowrap: commands.every(code => getComputedStyle(code).whiteSpace === 'nowrap'),
              copies: document.querySelectorAll('[data-inbox-machine-move] [data-onboarding-copy]').length,
              moves: document.querySelectorAll('[data-inbox-machine-move]').length,
              contextShown: [...document.querySelectorAll('[data-inbox-open]')]
                .filter(open => (open.textContent ?? '').includes('durian'))
                .some(open => open.querySelector('[data-agenda-section="context"]') !== null),
              // ONE line in the head (a long one scrolls as a marquee): never clipped from below.
              titleCut:
                title === null || text === null || text === undefined
                  ? true
                  : title.scrollHeight > title.clientHeight + 1,
            };
          });
          expect(laid.pad).toBeGreaterThanOrEqual(8);
          expect(laid.moves).toBe(4);
          expect(laid.copies).toBe(2);
          expect(laid.contextShown).toBe(false);
          expect(laid.nowrap).toBe(true);
          expect(new Set(laid.rights).size).toBe(1);
          expect(new Set(laid.lefts).size).toBe(1);
          expect(Math.max(...laid.heights) - Math.min(...laid.heights)).toBeLessThanOrEqual(1);
          expect(laid.titleCut).toBe(false);
          const chat = await tab.evaluate(() =>
            [...document.querySelectorAll('[data-inbox-open]')]
              .filter(open => (open.textContent ?? '').includes('durian'))
              .some(open => open.querySelector('[data-inbox-open-chat]') !== null),
          );
          expect(chat).toBe(false);
        } finally {
          await context.close();
        }
      }, 60_000);
});
