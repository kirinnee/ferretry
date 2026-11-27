/**
 * AN ANSWER GIVEN IN THE REAL INBOX IS SAID IN THE ITEM'S CONVERSATION, in a real browser, at 390 and 1440, light and dark, at
 * the default and the highest rounding: the built Inbox and chat-line ask route reopen the item DURING the undo hold.
 * Undo removes the line; waiting out the actual hold and accepting the send leaves exactly one line. Fake daemon only.
 *
 * Set `FY_PENDING_ANSWER_SHOTS_DIR` to keep `<viewport>-<scheme>-<rounding>-<step>.png`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_PENDING_ANSWER_SHOTS_DIR ?? '';
// A box with no system fonts paints no text at all: a font file named here is served and forced, for the shots only.
const fontFile = process.env.FY_PENDING_ANSWER_FONT ?? '';
const FONT_CSS =
  fontFile === ''
    ? ''
    : `@font-face { font-family: 'Shot Sans'; src: url(/shot-font.ttf); } *, *::before, *::after { font-family: 'Shot Sans', sans-serif !important; }`;

const SCENE_CSS = `
  html, body, #root { height: 100%; margin: 0; }
  .scene-chat { box-sizing: border-box; display: flex; flex-direction: column; inset: 0; position: fixed; }
  .scene-chat .fy-chat-log { flex: 1 1 0; }
`;

/** Every radius token the app draws with, set to the pill: what the highest rounding does to a surface. */
const RADII = [
  'radius-xs',
  'radius-sm',
  'radius-md',
  'radius-lg',
  'radius-control',
  'radius-panel',
  'radius-badge',
  'radius-tab',
  'radius-input',
  'radius-pill',
  'bubble-radius',
  'card-radius',
  'menu-radius',
  'md-code-radius',
  'md-quote-radius',
  'md-link-radius',
  'md-stack-radius',
];

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-pending-answer-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/pending-answer-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the pending-answer scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  return { css: await readFile(manifest.css, 'utf8'), js: await readFile(manifest.js, 'utf8') };
};

beforeAll(async () => {
  browser = await sharedChromium();
  const { css, js } = await build();
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>${SCENE_CSS}${FONT_CSS}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 7488,
    fetch: request => {
      const path = new URL(request.url).pathname;
      if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
      if (path === '/shot-font.ttf' && fontFile !== '')
        return new Response(Bun.file(fontFile), { headers: { 'content-type': 'font/ttf' } });
      if (path === '/' || path.startsWith('/d/'))
        return new Response(page, { headers: { 'content-type': 'text/html' } });
      return new Response('not here', { status: 404 });
    },
  });
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const owned = (tab: Page): Promise<string[]> =>
  tab.evaluate(() =>
    [...document.querySelectorAll('[data-agenda-history] [data-history="owner"]')].map(
      row =>
        `${row.querySelector('.fy-hist__said')?.textContent ?? ''}|${row.querySelector('[data-send-receipt]')?.getAttribute('data-send-receipt') ?? ''}`,
    ),
  );

const VIEWPORTS = [
  { name: '390', width: 390, height: 844, phone: true },
  { name: '1440', width: 1_440, height: 900, phone: false },
] as const;

describe('an answer given in the real Inbox, in the item conversation', () => {
  for (const viewport of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const)
      for (const rounding of ['default', 'highest'] as const)
        it(`is held in both real routes, leaves with Undo and echoes once after send (${viewport.name}, ${scheme}, ${rounding})`, async () => {
          const context = await browser.newContext({
            viewport: { width: viewport.width, height: viewport.height },
            colorScheme: scheme,
            deviceScaleFactor: viewport.phone ? 2 : 1,
            hasTouch: viewport.phone,
            isMobile: viewport.phone,
            reducedMotion: 'reduce',
          });
          const origin = server?.url.origin ?? '';
          await context.route('**/*', async route =>
            new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
          );
          const tab = await context.newPage();
          await tab.clock.install();
          const settle = (): Promise<void> =>
            tab.evaluate(
              () => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
            );
          const shoot = async (step: string, refused = false): Promise<void> => {
            if (!refused) expect(await tab.textContent('body'), 'clean reads').not.toContain('Not sent:');
            await tab.evaluate(() =>
              document.querySelector('[data-agenda-history]')?.scrollIntoView({ block: 'center' }),
            );
            await settle();
            if (shotsDir !== '')
              await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${scheme}-${rounding}-${step}.png`) });
          };
          const go = async (where: string): Promise<void> => {
            await tab.evaluate(path => window.scene.go(path), where);
            await settle();
          };
          const openConversation = async (): Promise<void> => {
            const fold = await tab.waitForSelector('[data-agenda-fold="conversation"]');
            if ((await fold.getAttribute('aria-expanded')) !== 'true') await fold.click();
          };
          try {
            await tab.goto(`${origin}/d/this/agenda?theme=studio-${scheme}`);
            await tab.waitForSelector('[data-agenda-row*="A2"]');
            await tab.click('[data-agenda-row*="A2"]');
            if (rounding === 'highest')
              await tab.evaluate(names => {
                for (const name of names)
                  document.documentElement.style.setProperty(`--${name}`, 'var(--radius-round)');
              }, RADII);
            await tab.evaluate(async () => document.fonts.ready);

            // Answer, then REOPEN through the real Inbox while still held. No flush, substitute view or fake action.
            await tab.click('.fy-attn-deck__top [data-agenda-option="Ship"]');
            await tab.waitForSelector('[data-agenda-undo-button]');
            await go('/d/this/agenda?ask=A2&session=sess-1');
            await tab.waitForTimeout(450);
            expect(await tab.evaluate(() => window.scene.state().pending.length)).toBe(1);
            expect(await tab.evaluate(() => window.scene.commitCount())).toBe(0);
            expect(await tab.getAttribute('.fy-attn-deck__top [data-agenda-view]', 'data-agenda-view')).toBe('A2');
            await openConversation();
            expect(await owned(tab)).toEqual(['Ship|saved']);
            await shoot('inbox-held');

            // The REAL chat line's row goes through its ask screen, then normalizes to Inbox with the SAME item.
            await go('/d/this/session/sess-1');
            await tab.click('[data-agenda-line-toggle]');
            await tab.click('[data-agenda-row="A2"]');
            await tab.waitForURL('**/agenda?ask=A2&session=sess-1');
            await tab.waitForTimeout(450);
            expect(await tab.evaluate(() => window.scene.state().pending.length)).toBe(1);
            expect(await tab.evaluate(() => window.scene.commitCount())).toBe(0);
            await openConversation();
            expect(await owned(tab)).toEqual(['Ship|saved']);
            await shoot('chat-route-held');
            await tab.click('[data-agenda-undo-button]');
            expect(await owned(tab), 'Undo left nothing said').toEqual([]);
            expect(await tab.evaluate(() => window.scene.commitCount())).toBe(0);

            // Answer again and let the REAL timer send; the line remains through send and the matching echo.
            await tab.click('.fy-attn-deck__top [data-agenda-option="Ship"]');
            await openConversation();
            expect(await owned(tab)).toEqual(['Ship|saved']);
            await tab.clock.fastForward(5_001);
            await tab.waitForFunction(() => window.scene.state().sending.length === 1);
            expect(await owned(tab)).toEqual(['Ship|saved']);
            const overflow = await tab.evaluate(
              () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
            );
            expect(overflow, 'nothing scrolls sideways').toBeLessThanOrEqual(0);
            await tab.evaluate(() => window.scene.accept());
            await tab.waitForFunction(() => window.scene.state().sending.length === 0);
            expect(
              (await owned(tab)).map(row => row.split('|')[0]),
              'the echo draws exactly once',
            ).toEqual(['Ship']);
            await shoot('inbox-sent');

            // R2: the recorded Ship belongs to a DIFFERENT send. A refused Ship must still be visible.
            await tab.click('.fy-attn-deck__top [data-agenda-option="Ship"]');
            await tab.clock.fastForward(5_001);
            await tab.waitForFunction(() => window.scene.state().sending.length === 1);
            await tab.evaluate(() => window.scene.refuse('Offline'));
            await tab.waitForFunction(() => window.scene.state().failed.length === 1);
            await go('/d/this/agenda?ask=A2&session=sess-1');
            await openConversation();
            expect((await owned(tab)).filter(row => row === 'Ship|failed')).toHaveLength(1);
            await go('/d/this/session/sess-1');
            await tab.click('[data-agenda-line-toggle]');
            await tab.click('[data-agenda-row="A2"]');
            await tab.waitForURL('**/agenda?ask=A2&session=sess-1');
            await openConversation();
            expect((await owned(tab)).filter(row => row === 'Ship|failed')).toHaveLength(1);
            await shoot('inbox-refused-echo', true);

            // R3: independent promises, newer Hold refuses first, then the older Ship. BOTH receipts survive.
            await tab.click('.fy-attn-deck__top [data-agenda-option="Ship"]');
            await tab.clock.fastForward(5_001);
            await tab.waitForFunction(() => window.scene.state().sending.length === 1);
            await tab.click('.fy-attn-deck__top [data-agenda-option="Hold"]');
            await tab.clock.fastForward(5_001);
            await tab.waitForFunction(() => window.scene.state().sending.length === 2);
            await tab.evaluate(() => window.scene.refuseAt(1, 'Hold refused'));
            await tab.waitForFunction(() => window.scene.state().failed.length === 1);
            await tab.evaluate(() => window.scene.refuseAt(0, 'Ship offline'));
            await tab.waitForFunction(() => window.scene.state().failed.length === 2);
            const refusals = async (): Promise<string[]> =>
              (await owned(tab)).filter(row => row.endsWith('|failed')).sort();
            await go('/d/this/agenda?ask=A2&session=sess-1');
            await openConversation();
            expect(await refusals()).toEqual(['Hold|failed', 'Ship|failed']);
            await go('/d/this/session/sess-1');
            await tab.click('[data-agenda-line-toggle]');
            await tab.click('[data-agenda-row="A2"]');
            await tab.waitForURL('**/agenda?ask=A2&session=sess-1');
            await openConversation();
            expect(await refusals()).toEqual(['Hold|failed', 'Ship|failed']);
            const history = await tab.textContent('[data-agenda-history]');
            expect(history).toContain('Hold refused');
            expect(history).toContain('Ship offline');
            await shoot('inbox-independent-refusals', true);
          } finally {
            await context.close();
          }
        }, 60_000);
});
