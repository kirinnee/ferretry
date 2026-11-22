/**
 * A TRY AGAIN IS A PRESS, in a real browser, over fake data (`fixtures/retry-press-scene.tsx`): the app's real `useContextRead` and
 * `ContextFailure`, a fake machine that refuses a read and asks for the passkey only for a read the person pressed for, and a stand-in
 * for Access's prompt. The page's own opening read opens no prompt; Try again opens it; Cancel closes it; Try again opens it AGAIN
 * (a Cancel must not leave the button dead). The ceremony is a fake that does nothing; this test never creates, asks for or asserts a
 * passkey.
 *
 * Set `FY_RETRY_PRESS_SHOTS_DIR` to keep `<viewport>-<theme>-retry-opens-dialog.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '../support/browser/index.ts';

setDefaultTimeout(30_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_RETRY_PRESS_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-retry-press-'));
  const child = Bun.spawn(
    [
      process.execPath,
      sceneBuilder,
      '--out',
      directory,
      '--entry',
      resolve(packageRoot, 'fixtures/retry-press-scene.tsx'),
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the retry-press scene did not build (${code}):\n${stderr}\n${stdout}`);
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
      return new Response(page, { headers: { 'content-type': 'text/html' } });
    },
  });
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const VIEWPORTS = [
  { name: '1280', width: 1_280, height: 800, phone: false },
  { name: '390', width: 390, height: 844, phone: true },
] as const;

describe('Try again opens the passkey dialog, and keeps opening it after a Cancel', () => {
  for (const viewport of VIEWPORTS) {
    for (const theme of ['studio-light', 'studio-dark'] as const) {
      it(`${viewport.name} ${theme}`, async () => {
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
          await tab.locator('[data-context-retry]').waitFor({ state: 'visible' });
          // The page's own opening read was refused quietly: no dialog.
          expect(await tab.locator('[data-step-up-dialog]').count()).toBe(0);
          expect(await tab.locator('[data-prompts]').getAttribute('data-prompts')).toBe('0');
          await tab.locator('[data-context-retry]').click();
          await tab.locator('[data-step-up-confirm]').waitFor({ state: 'visible' });
          await tab.locator('[data-step-up-cancel]').click();
          expect(await tab.locator('[data-step-up-dialog]').count()).toBe(0);
          // After the Cancel the same button opens it again.
          await tab.locator('[data-context-retry]').click();
          await tab.locator('[data-step-up-confirm]').waitFor({ state: 'visible' });
          await tab.waitForTimeout(250);
          if (shotsDir !== '')
            await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${theme}-retry-opens-dialog.png`) });
          await tab.locator('[data-step-up-cancel]').click();
          expect(await tab.locator('[data-prompts]').getAttribute('data-prompts')).toBe('2');
        } finally {
          await context.close();
        }
      });
    }
  }
});

// end B5: the Try again is a 44px target at a phone's width even where the pointer is not reported coarse (a narrow desktop window,
// the gate's run), where it was 23-30px.
describe('Try again is a 44px target at 390', () => {
  for (const coarse of [false, true])
    it(`${coarse ? 'a touch phone' : 'a narrow window with a mouse'}`, async () => {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        hasTouch: coarse,
        isMobile: coarse,
      });
      const origin = server?.url.origin ?? '';
      await context.route('**/*', async route =>
        new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
      );
      const tab = await context.newPage();
      try {
        await tab.goto(`${origin}/?theme=studio-light`);
        const button = tab.locator('[data-context-retry]');
        await button.waitFor({ state: 'visible' });
        const box = await button.boundingBox();
        expect(box?.height ?? 0, 'the Try again is at least 44px tall').toBeGreaterThanOrEqual(44);
        if (shotsDir !== '' && !coarse) await tab.screenshot({ path: join(shotsDir, '390-mouse-retry-44px.png') });
      } finally {
        await context.close();
      }
    });
});
