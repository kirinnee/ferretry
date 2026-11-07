/**
 * DRAGGING A MACHINE HEADING IN THE SESSIONS BAR, in a real browser: the real bar, the real saved-order
 * hook and the controls record kept in localStorage, over three fake machines.
 *
 * What is proved, with real layout and real pointer events:
 *   - a mouse drag past the slop moves a machine, the drop line shows first, and nothing moves on a click;
 *   - a held finger lifts it, a swipe from the grip does not;
 *   - the keyboard picks up, moves, drops and cancels;
 *   - the order outlives a reload, because it is the device's;
 *   - a phone and a desktop, light and dark, never scroll sideways.
 *
 * Set `FY_MACHINE_REORDER_SHOTS_DIR` to keep the captures; every name in them is fake.
 */
import { afterAll, beforeAll, describe, expect } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { sharedChromium } from '../support/chromium.ts';
import { boundedContext, overlapped } from '../support/overlap.ts';

const packageRoot = resolve(import.meta.dir, '../../..');
const shotsDir = process.env.FY_MACHINE_REORDER_SHOTS_DIR ?? '';

const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

let browser: Browser;
const overlap = overlapped();
const bounded = boundedContext(() => browser, 3);
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-machine-reorder-'));
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(packageRoot, 'scripts/build-composer-integration-fixture.ts'),
      '--out',
      directory,
      '--entry',
      'tests/integration/fixtures/machine-reorder-scene.tsx',
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the machine-reorder scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  return { css: await readFile(manifest.css, 'utf8'), js: await readFile(manifest.js, 'utf8') };
};

const open = async (
  context: BrowserContext,
  scene: 'bar' | 'drawer',
  theme: string,
  mode: 'light' | 'dark',
): Promise<Page> => {
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  await tab.goto(`${origin}/?scene=${scene}&theme=${theme}-${mode}`);
  await tab.waitForSelector('[data-machine-grip]');
  return tab;
};

const newContext = async (phone: boolean, mode: 'light' | 'dark'): Promise<BrowserContext> =>
  await bounded({
    viewport: phone ? { width: 390, height: 844 } : { width: 1_440, height: 900 },
    colorScheme: mode,
    reducedMotion: 'reduce',
    deviceScaleFactor: 2,
    ...(phone ? { isMobile: true, hasTouch: true, userAgent: ANDROID_UA } : {}),
  });

const heads = async (tab: Page): Promise<readonly string[]> =>
  await tab.$$eval('.fy-sbar__machine-label', nodes => nodes.map(node => (node.textContent ?? '').trim()));

const shot = async (tab: Page, name: string): Promise<void> => {
  if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${name}.png`) });
};

const center = async (tab: Page, selector: string): Promise<{ x: number; y: number }> => {
  await tab.locator(selector).evaluate(node => node.scrollIntoView({ block: 'center' }));
  const box = await tab.locator(selector).boundingBox();
  if (box === null) throw new Error(`${selector} has no box`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

const gripOf = (name: string): string => `[aria-label="Reorder ${name}"]`;
const groupOf = (name: string): string => `[aria-label="${name}"][data-sbar-machine-group]`;

describe('dragging a machine heading in the sessions bar', () => {
  beforeAll(async () => {
    browser = await sharedChromium();
    const { css, js } = await build();
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: request => {
        const path = new URL(request.url).pathname;
        if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
        if (path === '/app.css') return new Response(css, { headers: { 'content-type': 'text/css' } });
        if (path === '/') return new Response(html, { headers: { 'content-type': 'text/html' } });
        return new Response('not here', { status: 404 });
      },
    });
    if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
  }, 180_000);

  beforeAll(overlap.start);

  afterAll(async () => {
    server?.stop(true);
    if (directory !== '') await rm(directory, { force: true, recursive: true });
  });

  overlap.it(
    'drags with a mouse, shows the drop line, moves on release, and keeps the order across a reload',
    async () => {
      const context = await newContext(false, 'light');
      try {
        const tab = await open(context, 'bar', 'studio', 'light');
        expect(await heads(tab)).toEqual(['studio', 'laptop', 'pibox']);
        // A click on the grip reorders nothing.
        await tab.click(gripOf('laptop'));
        expect(await heads(tab)).toEqual(['studio', 'laptop', 'pibox']);

        const from = await center(tab, gripOf('pibox'));
        const target = await tab.locator(groupOf('studio')).boundingBox();
        if (target === null) throw new Error('the first machine has no box');
        await tab.mouse.move(from.x, from.y);
        await tab.mouse.down();
        await tab.mouse.move(from.x, from.y - 20, { steps: 4 });
        await tab.mouse.move(from.x + 40, target.y + 6, { steps: 8 });
        await tab.waitForSelector('[data-drop-edge="before"]');
        expect(await tab.locator(groupOf('pibox')).getAttribute('data-dragging')).toBe('');
        await shot(tab, 'desktop-dragging-light');
        // Nothing has moved yet.
        expect(await heads(tab)).toEqual(['studio', 'laptop', 'pibox']);
        await tab.mouse.up();
        expect(await heads(tab)).toEqual(['pibox', 'studio', 'laptop']);
        await shot(tab, 'desktop-reordered-light');

        await tab.reload();
        await tab.waitForSelector('[data-machine-grip]');
        expect(await heads(tab)).toEqual(['pibox', 'studio', 'laptop']);
        const overflow = await tab.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow).toBeLessThanOrEqual(0);
      } finally {
        await context.close();
      }
    },
    120_000,
  );

  overlap.it(
    'moves with the keyboard and the heading menu, and says what it did',
    async () => {
      const context = await newContext(false, 'dark');
      try {
        const tab = await open(context, 'bar', 'studio', 'dark');
        await tab.focus(gripOf('studio'));
        await tab.keyboard.press('Space');
        await tab.keyboard.press('ArrowDown');
        await tab.keyboard.press('ArrowDown');
        expect(await heads(tab)).toEqual(['laptop', 'pibox', 'studio']);
        expect(await tab.locator('[role="status"]').first().textContent()).toBe('studio moved to position 3 of 3.');
        expect(await tab.evaluate(() => (document.activeElement as HTMLElement).getAttribute('aria-label'))).toBe(
          'Reorder studio',
        );
        await shot(tab, 'desktop-keyboard-dark');
        await tab.keyboard.press('Escape');
        expect(await heads(tab)).toEqual(['studio', 'laptop', 'pibox']);
        await tab.keyboard.press('Space');
        await tab.keyboard.press('ArrowDown');
        await tab.keyboard.press('Space');
        expect(await heads(tab)).toEqual(['laptop', 'studio', 'pibox']);

        await tab.click('[aria-label="More for pibox"]');
        await tab.getByRole('menuitem', { name: 'Move up' }).click();
        expect(await heads(tab)).toEqual(['laptop', 'pibox', 'studio']);
        await shot(tab, 'desktop-reordered-dark');
      } finally {
        await context.close();
      }
    },
    120_000,
  );

  overlap.it(
    'lifts with a held finger on a phone, and treats a swipe from the grip as a scroll',
    async () => {
      for (const mode of ['light', 'dark'] as const) {
        const context = await newContext(true, mode);
        try {
          const tab = await open(context, 'drawer', 'studio', mode);
          const cdp = await context.newCDPSession(tab);
          const touch = async (type: 'touchStart' | 'touchMove' | 'touchEnd', x: number, y: number) =>
            await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
          const from = await center(tab, gripOf('pibox'));
          // A swipe starts moving at once: nothing lifts.
          await touch('touchStart', from.x, from.y);
          await touch('touchMove', from.x, from.y - 40);
          await tab.waitForTimeout(450);
          expect(await tab.locator(groupOf('pibox')).getAttribute('data-dragging')).toBeNull();
          await touch('touchEnd', from.x, from.y - 40);
          expect(await heads(tab)).toEqual(['studio', 'laptop', 'pibox']);

          // A rest, then a drag to the top.
          const again = await center(tab, gripOf('pibox'));
          const top = await tab.locator(groupOf('studio')).boundingBox();
          if (top === null) throw new Error('the first machine has no box');
          await touch('touchStart', again.x, again.y);
          await tab.waitForTimeout(450);
          await touch('touchMove', again.x, again.y - 40);
          await touch('touchMove', again.x, top.y + 6);
          await tab.waitForSelector('[data-drop-edge="before"]');
          await shot(tab, `phone-dragging-${mode}`);
          await touch('touchEnd', again.x, top.y + 6);
          expect(await heads(tab)).toEqual(['pibox', 'studio', 'laptop']);
          await shot(tab, `phone-reordered-${mode}`);
          expect(
            await tab.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
          ).toBeLessThanOrEqual(0);
        } finally {
          await context.close();
        }
      }
    },
    120_000,
  );
});
