/**
 * WRITING ON A PR in a real browser over fake data (`fixtures/compose-scene.tsx`): the Quote button over a real selection,
 * the box with the quote and its preview, a comment on diff lines, the posted state, the secret warning and the "not sure"
 * state, at 1280 and 390 wide, light and dark. Real selections, real pointer presses, no network (the scene's client is
 * scripted and the browser may reach nothing but the scene).
 *
 * Set `FY_COMPOSE_SHOTS_DIR` to keep `<viewport>-<theme>-<step>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';
import type { Browser, BrowserContext, Page } from 'playwright-core';

setDefaultTimeout(90_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_COMPOSE_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-compose-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/compose-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the compose scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request =>
      new URL(request.url).pathname === '/app.js'
        ? new Response(js, { headers: { 'content-type': 'text/javascript' } })
        : new Response(html, { headers: { 'content-type': 'text/html' } }),
  });
  browser = await sharedChromium();
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const VARIANTS = [
  { name: '1280-light', width: 1_280, phone: false, scheme: 'light' },
  { name: '1280-dark', width: 1_280, phone: false, scheme: 'dark' },
  { name: '390-light', width: 390, phone: true, scheme: 'light' },
  { name: '390-dark', width: 390, phone: true, scheme: 'dark' },
] as const;

async function open(
  variant: (typeof VARIANTS)[number],
  post: string,
): Promise<{ context: BrowserContext; tab: Page; problems: string[] }> {
  const context = await browser.newContext({
    // Tall, so the page's own scroll box shows the whole of it in a shot.
    viewport: { width: variant.width, height: 1_800 },
    deviceScaleFactor: variant.phone ? 2 : 1,
    hasTouch: variant.phone,
    isMobile: variant.phone,
    colorScheme: variant.scheme,
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  const problems: string[] = [];
  tab.on('pageerror', error => problems.push(error.message));
  await tab.goto(`${origin}/?theme=studio-${variant.scheme}&post=${post}`);
  await tab.waitForSelector('[data-pull-conversation]');
  return { context, tab, problems };
}

/** Selects the text of one element's first text node, from `from` to `to`, as a drag would. */
async function selectIn(tab: Page, selector: string, from: number, to: number): Promise<void> {
  await tab.evaluate(
    ([sel, a, b]) => {
      const node = document.querySelector(sel as string)?.firstChild as Text;
      const range = document.createRange();
      range.setStart(node, a as number);
      range.setEnd(node, b as number);
      const selection = window.getSelection() as Selection;
      selection.removeAllRanges();
      selection.addRange(range);
    },
    [selector, from, to],
  );
}

const shot = async (tab: Page, variant: (typeof VARIANTS)[number], step: string) => {
  // A shot is of a state at rest: the pointer is off the controls and the 120 ms fills have finished.
  await tab.mouse.move(0, 0);
  await tab.waitForTimeout(300);
  if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${variant.name}-${step}.png`), fullPage: true });
};
const noSideways = async (tab: Page) =>
  expect(
    await tab.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
    'no sideways scroll',
  ).toBeLessThanOrEqual(0);
const sent = async (tab: Page) => await tab.evaluate(() => (window as unknown as { __posts: unknown[] }).__posts);

describe('quote and comment', () => {
  for (const variant of VARIANTS) {
    it(`${variant.name}: Quote over a real selection, the box with a quote and its preview, and the posted state`, async () => {
      const { context, tab, problems } = await open(variant, 'ok');
      try {
        await selectIn(tab, '[data-gh-text] p:last-child', 0, 36);
        await tab.waitForSelector('[data-selection-actions="prose"]');
        await shot(tab, variant, '1-quote-button');
        await tab.locator('[data-selection-actions="prose"] button').click();
        const box = tab.locator('[data-compose-box]');
        expect((await box.inputValue()).startsWith('> Please keep the old route for one')).toBe(true);
        // The button names the account, and nothing is posted until it is pressed.
        await tab.waitForFunction(() =>
          document.querySelector('[data-compose] button[data-variant="primary"]')?.textContent?.includes('@octo-fake'),
        );
        expect(await tab.locator('[data-compose] button[data-variant="primary"]').innerText()).toBe(
          'Post as @octo-fake',
        );
        await box.fill(`${await box.inputValue()}Agreed, keeping it.`);
        await shot(tab, variant, '2-composer-with-quote');
        await tab.getByRole('button', { name: 'Preview' }).click();
        await tab.waitForSelector('[data-compose-preview] blockquote');
        // The tab that is showing looks different from the one that is not (read from the page, not from a picture).
        const tabs = await tab.evaluate(() =>
          [...document.querySelectorAll<HTMLElement>('[data-compose] header button[aria-pressed]')].map(button => ({
            word: button.textContent,
            pressed: button.getAttribute('aria-pressed'),
            fill: getComputedStyle(button).backgroundColor,
          })),
        );
        expect(tabs.map(each => each.pressed)).toEqual(['false', 'true']);
        expect(tabs[0]?.fill, 'the showing tab has its own fill').not.toBe(tabs[1]?.fill);
        await shot(tab, variant, '3-preview');
        await tab.locator('[data-compose] button[data-variant="primary"]').click();
        await tab.waitForSelector('[data-compose-posted]');
        await shot(tab, variant, '4-posted');
        const posts = (await sent(tab)) as Array<{ route: string; body: { body: string; requestId: string } }>;
        expect(posts).toHaveLength(1);
        expect(posts[0]?.route).toBe('POST /v1/pulls/:project/:repo/:number/comment');
        expect(posts[0]?.body.body).toContain('Agreed, keeping it.');
        await noSideways(tab);
        expect(problems).toEqual([]);
      } finally {
        await context.close();
      }
    });

    it(`${variant.name}: a comment on diff lines, a reply under a thread, the secret warning and the not-sure state`, async () => {
      const { context, tab, problems } = await open(variant, 'secret');
      try {
        await tab.locator('[data-pull-tab]', { hasText: 'Files' }).click();
        await tab.waitForSelector('[data-diff-line] , [data-diff-number]');
        await tab.waitForSelector('[data-thread="PRRT_demo1"]');
        // Two real lines, selected across rows.
        const added = tab.locator('[data-diff-line="add"]').first();
        await added.waitFor();
        await tab.evaluate(() => {
          const lines = [...document.querySelectorAll<HTMLElement>('[data-diff-line="add"]')];
          const first = lines[0]?.querySelector('span:not([aria-hidden])') ?? lines[0];
          const last = lines.at(-1)?.querySelector('span:not([aria-hidden])') ?? lines.at(-1);
          const range = document.createRange();
          range.setStartBefore(first as Node);
          range.setEndAfter(last as Node);
          const selection = window.getSelection() as Selection;
          selection.removeAllRanges();
          selection.addRange(range);
        });
        await tab.waitForSelector('[data-selection-actions="diff"]');
        // The bar is whole (inside the window, not covered by or cut off by anything).
        const bar = await tab.evaluate(() => {
          const element = document.querySelector('[data-selection-actions="diff"]') as HTMLElement;
          const rect = element.getBoundingClientRect();
          const probe = (x: number, y: number) => element.contains(document.elementFromPoint(x, y));
          return {
            left: rect.left,
            right: rect.right,
            top: rect.top,
            width: window.innerWidth,
            corners: [probe(rect.left + 2, rect.top + 2), probe(rect.right - 2, rect.bottom - 2)],
          };
        });
        expect(bar.left).toBeGreaterThanOrEqual(0);
        expect(bar.right).toBeLessThanOrEqual(bar.width);
        expect(bar.top).toBeGreaterThanOrEqual(0);
        expect(bar.corners).toEqual([true, true]);
        await shot(tab, variant, '5-diff-selection');
        await tab.getByRole('button', { name: 'Comment on these lines' }).click();
        expect(await tab.locator('[data-compose-dock="line"] h3').innerText()).toMatch(
          /^Comment on src\/handoff\.ts:\d+(-\d+)?$/u,
        );
        await tab.locator('[data-compose-box]').fill('key: ghp_0123456789abcdefghijklmnopqrstuvwxyzAB');
        await tab.waitForFunction(() =>
          document.querySelector('[data-compose] button[data-variant="primary"]')?.textContent?.includes('@octo-fake'),
        );
        await tab.locator('[data-compose] button[data-variant="primary"]').click();
        await tab.waitForSelector('[data-compose-secret]');
        await shot(tab, variant, '6-secret-warning');
        await tab.getByRole('button', { name: 'Post anyway' }).click();
        await tab.waitForSelector('[data-compose-posted]');
        const posts = (await sent(tab)) as Array<{ route: string; body: Record<string, unknown> }>;
        expect(posts.map(post => post.route)).toEqual([
          'POST /v1/pulls/:project/:repo/:number/line-comment',
          'POST /v1/pulls/:project/:repo/:number/line-comment',
        ]);
        expect(posts[1]?.body.postAnyway).toBe(true);
        expect(posts[1]?.body.requestId).toBe(posts[0]?.body.requestId);
        expect(posts[1]?.body).toMatchObject({ commitId: 'b'.repeat(40), path: 'src/handoff.ts', side: 'right' });
        // A reply under the thread has its own box.
        await tab.locator('[data-reply-open="PRRT_demo1"]').click();
        await tab.waitForSelector('[data-reply-box="PRRT_demo1"] textarea');
        // Nothing a reply box draws may widen the diff or leave the screen.
        const fits = await tab.evaluate(() => {
          const box = document.querySelector('[data-reply-box] [data-compose]')?.getBoundingClientRect();
          const body = document.querySelector<HTMLElement>('[data-diff-body]');
          return {
            right: box?.right ?? 0,
            left: box?.left ?? 0,
            width: window.innerWidth,
            diffOverflow: body === null ? 0 : body.scrollWidth - body.clientWidth,
            scrolled: body?.scrollLeft ?? 0,
          };
        });
        expect(fits.left).toBeGreaterThanOrEqual(0);
        expect(fits.right).toBeLessThanOrEqual(fits.width);
        expect(fits.diffOverflow).toBeLessThanOrEqual(0);
        expect(fits.scrolled).toBe(0);
        await shot(tab, variant, '7-reply');
        await noSideways(tab);
        expect(problems).toEqual([]);
      } finally {
        await context.close();
      }
    });

    it(`${variant.name}: when GitHub did not answer the box says it is not sure and posts nothing more`, async () => {
      const { context, tab, problems } = await open(variant, 'unknown');
      try {
        await tab.locator('[data-compose-open]').click();
        await tab.waitForFunction(() =>
          document.querySelector('[data-compose] button[data-variant="primary"]')?.textContent?.includes('@octo-fake'),
        );
        await tab.locator('[data-compose-box]').fill('Is this still the plan?');
        await tab.locator('[data-compose] button[data-variant="primary"]').click();
        await tab.waitForSelector('[data-compose-unknown]');
        await shot(tab, variant, '8-not-sure');
        expect(((await sent(tab)) as unknown[]).length).toBe(1);
        await noSideways(tab);
        expect(problems).toEqual([]);
      } finally {
        await context.close();
      }
    });
  }
});
