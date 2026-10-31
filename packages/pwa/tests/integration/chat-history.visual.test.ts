/**
 * SCROLLING A LONG CHAT ALL THE WAY BACK TO ITS FIRST MESSAGE, in a real browser, on a phone and a desktop.
 *
 * The scene (`tests/integration/fixtures/chat-history-scene.tsx`) is the real `Transcript` and the real chat
 * refresh over a daemon that pages a 1,500-record conversation the way `log-page` does. The reader wheels up:
 * older pages load by themselves before the reader reaches them, a page arriving never moves the message
 * under the reader, and the walk ends at the conversation's first message with every message on screen once.
 *
 * Set `FY_HISTORY_SHOTS_DIR` to keep `<viewport>-<scheme>-loading.png`, `-loading-top.png` and `-start.png`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import type { TranscriptHistoryStatus } from '../../src/lib/transcript-history.ts';
import { sharedChromium } from './support/chromium.ts';

const packageRoot = resolve(import.meta.dir, '../..');
const shotsDir = process.env.FY_HISTORY_SHOTS_DIR ?? '';

const SCENE_CSS = `
  html, body, #root { height: 100%; margin: 0; }
  .scene-chat { box-sizing: border-box; display: flex; flex-direction: column; inset: 0; position: fixed; }
  .scene-chat .fy-transcript-shell { flex: 1 1 auto; margin: 0 auto; max-width: 760px; padding: 0 16px; width: 100%; box-sizing: border-box; min-height: 0; }
`;

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-chat-history-'));
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(packageRoot, 'scripts/build-composer-integration-fixture.ts'),
      '--out',
      directory,
      '--entry',
      'tests/integration/fixtures/chat-history-scene.tsx',
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the chat-history scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  return { css: await readFile(manifest.css, 'utf8'), js: await readFile(manifest.js, 'utf8') };
};

beforeAll(async () => {
  browser = await sharedChromium();
  const { css, js } = await build();
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>${SCENE_CSS}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
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

const shoot = async (tab: Page, name: string): Promise<void> => {
  if (shotsDir === '') return;
  await tab.waitForTimeout(150);
  await tab.screenshot({ path: join(shotsDir, `${name}.png`) });
};

const framesSettled = async (tab: Page): Promise<void> =>
  await tab.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

const status = async (tab: Page): Promise<string> => await tab.evaluate(() => window.__historyStatus);

/** Wheels up over the transcript, as a reader does, by `pixels`. */
const wheelUp = async (tab: Page, pixels: number): Promise<void> => {
  const box = await tab.locator('.fy-transcript').boundingBox();
  if (box === null) throw new Error('no transcript on screen');
  await tab.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await tab.mouse.wheel(0, -pixels);
};

/** The first MESSAGE row the reader can see (never the history row above them), kept on the window, and where its top is. */
const markTopRow = async (tab: Page): Promise<number> =>
  await tab.evaluate(() => {
    const viewport = document.querySelector('.fy-transcript') as HTMLElement;
    const top = viewport.getBoundingClientRect().top;
    const rows = [
      ...document.querySelectorAll('.fy-transcript-content > :not(.fy-transcript-history)'),
    ] as HTMLElement[];
    const row = rows.find(candidate => candidate.getBoundingClientRect().bottom > top + 40) as HTMLElement;
    (window as unknown as { __row: HTMLElement }).__row = row;
    return row.getBoundingClientRect().top;
  });

const markedRowTop = async (tab: Page): Promise<number> =>
  await tab.evaluate(() => (window as unknown as { __row: HTMLElement }).__row.getBoundingClientRect().top);

const VIEWPORTS = [
  { name: 'phone', viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 },
  { name: 'desktop', viewport: { width: 1_440, height: 900 }, deviceScaleFactor: 1 },
] as const;

describe('scrolling a long chat back to its first message', () => {
  for (const { name, viewport, deviceScaleFactor } of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const)
      it(`reaches the first message without a jump on a ${name} in ${scheme}`, async () => {
        const context = await browser.newContext({ viewport, colorScheme: scheme, deviceScaleFactor });
        try {
          const origin = server?.url.origin ?? '';
          await context.route('**/*', async route =>
            new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
          );
          const tab = await context.newPage();
          await tab.goto(`${origin}/?theme=studio-${scheme}`);
          await tab.waitForFunction(() => document.body.innerText.includes('Answer 1499.'));
          await framesSettled(tab);
          expect(await status(tab)).toBe('more');

          // The reader wheels up until a page is on its way, and holds still while it lands.
          await tab.evaluate(() => window.__holdOlder());
          for (let step = 0; step < 60 && (await status(tab)) !== 'loading'; step += 1) await wheelUp(tab, 600);
          expect(await status(tab)).toBe('loading');
          await framesSettled(tab);
          const before = await markTopRow(tab);
          await shoot(tab, `${name}-${scheme}-loading`);
          await tab.evaluate(() => window.__releaseOlder());
          await tab.waitForFunction(() => window.__historyStatus !== 'loading');
          await framesSettled(tab);
          // The page went in ABOVE the reader: what they were looking at did not move.
          expect(Math.abs((await markedRowTop(tab)) - before)).toBeLessThanOrEqual(2);

          // A reader who outran the pages sits at the very top while one loads, and stays put when it lands.
          await tab.evaluate(() => window.__holdOlder());
          for (let step = 0; step < 60 && (await status(tab)) !== 'loading'; step += 1) await wheelUp(tab, 100_000);
          await wheelUp(tab, 100_000);
          await framesSettled(tab);
          await tab.waitForFunction(() => document.body.innerText.includes('Loading older messages'));
          const atTop = await markTopRow(tab);
          await shoot(tab, `${name}-${scheme}-loading-top`);
          await tab.evaluate(() => window.__releaseOlder());
          await tab.waitForFunction(() => window.__historyStatus !== 'loading');
          await framesSettled(tab);
          expect(Math.abs((await markedRowTop(tab)) - atTop)).toBeLessThanOrEqual(2);

          // On up to the top, page by page.
          for (let step = 0; step < 400 && (await status(tab)) !== 'start'; step += 1) {
            await wheelUp(tab, 4_000);
            await tab.waitForTimeout(20);
          }
          expect(await status(tab)).toBe('start');
          await wheelUp(tab, 10_000);
          await framesSettled(tab);
          await tab.waitForFunction(() => document.body.innerText.includes('Beginning of the conversation'));
          await shoot(tab, `${name}-${scheme}-start`);

          // Every question of the conversation is on screen exactly once, first to last.
          const questions = await tab.evaluate(() =>
            [...document.body.innerText.matchAll(/Question (\d+):/g)].map(match => Number(match[1])),
          );
          expect(questions).toEqual(Array.from({ length: 150 }, (_, index) => index * 10));
        } finally {
          await context.close();
        }
      }, 120_000);
});

declare global {
  interface Window {
    __holdOlder: () => void;
    __releaseOlder: () => void;
    __historyStatus: TranscriptHistoryStatus;
  }
}
