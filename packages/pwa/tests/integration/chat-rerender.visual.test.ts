/**
 * WHAT A READER IS DOING IN A MESSAGE SURVIVES THE NEXT MESSAGE ARRIVING, in a real browser.
 *
 * The scene (`tests/integration/fixtures/chat-rerender-scene.tsx`) is the real `Transcript` over a
 * sliding log window, holding an interactive `html` block (a tab strip whose choice lives inside the
 * iframe) and a tool group. The reader picks "Day 2" and opens the group; five messages then arrive.
 * The SAME iframe must remain, still on "Day 2", and the group must still be open.
 *
 * Set `FY_RERENDER_SHOTS_DIR` to keep `<tag>-1-interacted.png` and `<tag>-2-after-5-messages.png`
 * (`FY_RERENDER_SHOTS_TAG`, default `after`). Without it no file is written.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sharedChromium } from './support/chromium.ts';
import { fyRenderIntegrationFixture } from './support/fy-render-integration-fixture.ts';

const packageRoot = resolve(import.meta.dir, '../..');
const shotsDir = process.env.FY_RERENDER_SHOTS_DIR ?? '';
const tag = process.env.FY_RERENDER_SHOTS_TAG ?? 'after';

const SCENE_CSS = `
  html, body, #root { height: 100%; margin: 0; }
  .scene-chat { box-sizing: border-box; display: flex; flex-direction: column; inset: 0; position: fixed; }
  .scene-chat .fy-transcript-shell { flex: 1 1 auto; margin: 0 auto; max-width: 760px; padding: 0 16px; width: 100%; box-sizing: border-box; }
`;

const FRAME = 'iframe[data-fy-render-frame="html"]';
const GROUP_TOGGLE = '[data-transcript-kind="tool"] .kt-chrome > button';
const GROUP_BODY = '[data-transcript-kind="tool"] .kt-chrome > div';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-chat-rerender-'));
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(packageRoot, 'scripts/build-composer-integration-fixture.ts'),
      '--out',
      directory,
      '--entry',
      'tests/integration/fixtures/chat-rerender-scene.tsx',
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the chat-rerender scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  return { css: await readFile(manifest.css, 'utf8'), js: await readFile(manifest.js, 'utf8') };
};

beforeAll(async () => {
  browser = await sharedChromium();
  const { css, js } = await build();
  const htmlShell = (await fyRenderIntegrationFixture()).html;
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>${SCENE_CSS}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      const path = new URL(request.url).pathname;
      if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
      if (path === '/fy-render-html.html')
        return new Response(htmlShell, {
          headers: {
            'content-security-policy': "frame-ancestors 'self'; sandbox allow-scripts",
            'content-type': 'text/html; charset=utf-8',
          },
        });
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
  if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${tag}-${name}.png`) });
};

describe('what the reader is doing survives new messages', () => {
  it('keeps the interactive frame, its picked tab and an open tool group through five new messages', async () => {
    const context = await browser.newContext({
      viewport: { width: 1_440, height: 900 },
      colorScheme: 'light',
      deviceScaleFactor: 1,
    });
    try {
      const origin = server?.url.origin ?? '';
      await context.route('**/*', async route =>
        new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
      );
      const tab = await context.newPage();
      await tab.goto(`${origin}/?theme=studio-light`);
      await tab.waitForSelector('.fy-transcript-content');

      // The reader picks Day 2 inside the frame and opens the tool group.
      const day2 = tab.frameLocator(FRAME).getByRole('button', { name: 'Day 2' });
      await day2.waitFor({ timeout: 20_000 });
      await day2.click();
      await tab.locator(FRAME).evaluate(frame => {
        (window as unknown as { __frame: Element }).__frame = frame;
      });
      await tab.locator(GROUP_TOGGLE).first().scrollIntoViewIfNeeded();
      await tab.locator(GROUP_TOGGLE).first().click();
      expect(await tab.locator(GROUP_BODY).count()).toBe(1);
      expect(await day2.getAttribute('aria-pressed')).toBe('true');
      await tab.locator(FRAME).scrollIntoViewIfNeeded();
      await tab.waitForTimeout(150);
      await shoot(tab, '1-interacted');

      // Five messages arrive, one by one; each slides the window.
      for (let message = 0; message < 5; message++) {
        await tab.evaluate(() => window.__appendMessages(1));
        await tab.waitForTimeout(150);
      }
      await tab.waitForTimeout(300);
      await shoot(tab, '2-after-5-messages');

      // The same iframe, still on Day 2, and the group still open.
      const sameFrame = await tab.evaluate(
        selector => document.querySelector(selector) === (window as unknown as { __frame: Element }).__frame,
        FRAME,
      );
      const picked = await tab
        .frameLocator(FRAME)
        .getByRole('button', { name: 'Day 2' })
        .getAttribute('aria-pressed', { timeout: 5_000 })
        .catch(() => null);
      const groupBodies = await tab.locator(GROUP_BODY).count();
      expect({ sameFrame, picked, groupBodies }).toEqual({ sameFrame: true, picked: 'true', groupBodies: 1 });
    } finally {
      await context.close();
    }
  }, 120_000);
});

declare global {
  interface Window {
    __appendMessages: (count: number) => void;
  }
}
