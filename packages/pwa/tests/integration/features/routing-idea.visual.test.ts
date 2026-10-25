/**
 * "YOUR IDEA" AS A TEXT AREA, in a real browser (owner: "make it a text area AND make it so I can type
 * MORE"). The field starts four rows tall, grows with what is typed up to twelve rows and then scrolls,
 * keeps line breaks, counts against 4,000 characters (the counter turns to a warning near the limit), and
 * Ctrl+Enter presses Write it for me. Captured at a phone and a desktop, light and dark. Set
 * `FY_IDEA_SHOTS_DIR` to keep the pictures.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { sharedChromium } from '../support/chromium.ts';

const packageRoot = resolve(import.meta.dir, '../../..');
const shotsDir = process.env.FY_IDEA_SHOTS_DIR ?? '';

const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

const IDEA = '[data-routing-idea]';
const COUNTER = '[data-idea-counter]';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-routing-idea-'));
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(packageRoot, 'scripts/build-composer-integration-fixture.ts'),
      '--out',
      directory,
      '--entry',
      'tests/integration/fixtures/routing-idea-scene.tsx',
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the routing idea scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  return { css: await readFile(manifest.css, 'utf8'), js: await readFile(manifest.js, 'utf8') };
};

beforeAll(async () => {
  const { css, js } = await build();
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-bg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      const path = new URL(request.url).pathname;
      if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
      if (path === '/') return new Response(html, { headers: { 'content-type': 'text/html' } });
      return new Response('not here', { status: 404 });
    },
  });
  browser = await sharedChromium();
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const newContext = async (phone: boolean, mode: 'light' | 'dark'): Promise<BrowserContext> =>
  await browser.newContext({
    viewport: phone ? { width: 390, height: 844 } : { width: 1_440, height: 900 },
    colorScheme: mode,
    reducedMotion: 'reduce',
    deviceScaleFactor: 2,
    ...(phone ? { isMobile: true, hasTouch: true, userAgent: ANDROID_UA } : {}),
  });

const open = async (context: BrowserContext, mode: 'light' | 'dark', view: 'nudge' | 'owner'): Promise<Page> => {
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  await tab.goto(`${origin}/?theme=studio-${mode}&view=${view}`);
  await tab.waitForSelector(IDEA);
  return tab;
};

const heightOf = async (tab: Page): Promise<number> =>
  await tab.locator(IDEA).evaluate(node => (node as HTMLElement).offsetHeight);

const lineHeightOf = async (tab: Page): Promise<number> =>
  await tab.locator(IDEA).evaluate(node => Number.parseFloat(getComputedStyle(node).lineHeight));

const counterColour = async (tab: Page): Promise<string> =>
  await tab.locator(COUNTER).evaluate(node => getComputedStyle(node).color);

const paragraphs = (count: number): string =>
  Array.from({ length: count }, (_, at) => `Line ${String(at + 1)}: cheap models for chores.`).join('\n');

const shot = async (tab: Page, name: string): Promise<void> => {
  if (shotsDir === '') return;
  await tab.locator('[data-routing-card]').screenshot({ path: join(shotsDir, `${name}.png`) });
};

describe('the "Your idea" text area, in a real browser', () => {
  for (const phone of [true, false]) {
    for (const mode of ['light', 'dark'] as const) {
      const where = `${phone ? 'phone-390' : 'desktop-1440'}-${mode}`;
      it(`is a text area that grows to twelve rows and then scrolls, and warns near the limit (${where})`, async () => {
        const context = await newContext(phone, mode);
        try {
          const tab = await open(context, mode, 'nudge');
          const tag = await tab.locator(IDEA).evaluate(node => node.tagName);
          expect(tag).toBe('TEXTAREA');
          const line = await lineHeightOf(tab);
          const empty = await heightOf(tab);
          expect(empty).toBeGreaterThanOrEqual(line * 4);
          expect(await tab.locator(COUNTER).textContent()).toContain('0 / 4,000');
          await shot(tab, `idea-${where}-empty`);

          await tab.locator(IDEA).fill(paragraphs(8));
          const grown = await heightOf(tab);
          expect(grown).toBeGreaterThan(empty);
          expect(await tab.locator(IDEA).inputValue()).toBe(paragraphs(8));

          await tab.locator(IDEA).fill(paragraphs(40));
          const capped = await heightOf(tab);
          expect(capped).toBeLessThanOrEqual(line * 12 + 40);
          expect(capped).toBeGreaterThanOrEqual(line * 11);
          expect(await tab.locator(IDEA).evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
          await shot(tab, `idea-${where}-long-scrolling`);

          const calm = await counterColour(tab);
          await tab.locator(IDEA).fill('x'.repeat(3_700));
          expect(await tab.locator(COUNTER).getAttribute('data-idea-counter')).toBe('near');
          // The colour eases in, so wait for it to settle off the calm one.
          await tab.waitForFunction(
            ([selector, was]) => {
              const node = document.querySelector(selector as string);
              return node !== null && getComputedStyle(node).color !== was;
            },
            [COUNTER, calm],
          );
          await shot(tab, `idea-${where}-near-limit`);

          await tab.locator(IDEA).fill('x'.repeat(4_100));
          expect((await tab.locator(IDEA).inputValue()).length).toBe(4_000);
          expect(await tab.locator(COUNTER).getAttribute('data-idea-counter')).toBe('full');

          expect(await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        } finally {
          await context.close();
        }
      }, 60_000);
    }
  }

  it('keeps Enter as a new line and writes the prompt on Ctrl+Enter, line breaks kept', async () => {
    const context = await newContext(false, 'light');
    try {
      const tab = await open(context, 'light', 'owner');
      const asked = async (): Promise<unknown[]> =>
        await tab.evaluate(() => (window as unknown as { __routingIdea: { asked: unknown[] } }).__routingIdea.asked);
      await tab.locator(IDEA).click();
      await tab.keyboard.type('Chores cheap.');
      await tab.keyboard.press('Enter');
      await tab.keyboard.press('Enter');
      await tab.keyboard.type('Opus plans.');
      expect(await tab.locator(IDEA).inputValue()).toBe('Chores cheap.\n\nOpus plans.');
      expect(await asked()).toEqual([]);
      await tab.keyboard.press('Control+Enter');
      await tab.waitForSelector('[data-clean-up-job]');
      expect(await asked()).toEqual([
        expect.objectContaining({ mode: 'generate', idea: 'Chores cheap.\n\nOpus plans.' }),
      ]);
    } finally {
      await context.close();
    }
  }, 60_000);
});
