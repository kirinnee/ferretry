/**
 * r11 S4 in a real browser: the folder step's editable PATH BOX and the create sheet's scroll bars, over fake data.
 *
 * The owner's lines (turn 4247): "can we type our own path (editable) other than breadcrumbs?" and "the modal shouldn't
 * have scroll bars unless they need to". Set `FY_PATH_BOX_SHOTS_DIR` to keep `<viewport>-<scheme>-<shot>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_PATH_BOX_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-path-box-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/path-box-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      const path = new URL(request.url).pathname;
      if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
      return new Response(page, { headers: { 'content-type': 'text/html' } });
    },
  });
  browser = await sharedChromium();
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const VIEWPORTS = [
  { name: '1280', width: 1_280, height: 900, phone: false },
  { name: '390', width: 390, height: 844, phone: true },
] as const;

const PATH_BOX = '[data-explorer-path-box] input';

/** Elements under `[role=dialog]` (and the dialog) that have a scroll bar: content longer or wider than the box. */
const scrollers = (tab: Page) =>
  tab.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    if (dialog === null) return { error: 'no dialog' };
    const out: { vertical: string[]; horizontal: string[] } = { vertical: [], horizontal: [] };
    for (const node of [dialog, ...dialog.querySelectorAll('*')]) {
      const element = node as HTMLElement;
      const style = getComputedStyle(element);
      const name = `${element.tagName.toLowerCase()}.${String(element.className).slice(0, 48)}`;
      // A bar is drawn when the box scrolls AND its content overflows; `hidden` and `visible` draw none.
      const scrollsY = style.overflowY === 'auto' || style.overflowY === 'scroll';
      const scrollsX = style.overflowX === 'auto' || style.overflowX === 'scroll';
      if (scrollsY && element.scrollHeight > element.clientHeight + 1) out.vertical.push(name);
      if (scrollsX && element.scrollWidth > element.clientWidth + 1) out.horizontal.push(name);
    }
    return out;
  });

type Viewport = (typeof VIEWPORTS)[number];

/** One fresh page per case, offline except for the scene server. */
const withTab = async (
  viewport: Viewport,
  scheme: 'light' | 'dark',
  run: (tab: Page, open: (query: string) => Promise<void>, shot: (name: string) => Promise<void>) => Promise<void>,
): Promise<void> => {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme: scheme,
    deviceScaleFactor: viewport.phone ? 2 : 1,
    hasTouch: viewport.phone,
    isMobile: viewport.phone,
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  const open = async (query: string): Promise<void> => {
    await tab.goto(`${origin}/?theme=studio-${scheme}&${query}`);
    await tab.waitForSelector('[data-explorer-state="ready"]', { timeout: 15_000 });
    await tab.waitForTimeout(300);
  };
  const shot = async (name: string): Promise<void> => {
    if (shotsDir !== '')
      await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${scheme}-${name}.png`), fullPage: true });
  };
  try {
    await run(tab, open, shot);
  } finally {
    await context.close();
  }
};

describe('create sheet scroll bars', () => {
  for (const viewport of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const)
      it(`draws a bar only when the content needs one (${viewport.name}, ${scheme})`, () =>
        withTab(viewport, scheme, async (tab, open, shot) => {
          // TWO folders: the sheet fits, so NO element in it has a bar, vertical or horizontal.
          await open('folders=2');
          await shot('two-folders');
          expect(await scrollers(tab), 'a sheet that fits draws no scroll bar').toEqual({
            vertical: [],
            horizontal: [],
          });

          // The path box and its Go button are one row, one height.
          const sizes = await tab.evaluate(() => {
            const form = document.querySelector('[data-explorer-path-box]');
            const height = (selector: string) => form?.querySelector(selector)?.getBoundingClientRect().height ?? 0;
            return { input: height('input'), go: height('button') };
          });
          expect(Math.abs(sizes.input - sizes.go), 'input and Go are the same height').toBeLessThanOrEqual(1);

          // SIXTY folders: exactly ONE element scrolls (the sheet's body), and nothing scrolls sideways.
          await open('folders=60');
          await shot('sixty-folders');
          const long = (await scrollers(tab)) as { vertical: string[]; horizontal: string[] };
          expect(long.horizontal, 'no sideways bar').toEqual([]);
          // The footer (Next) stays inside the sheet and on screen however long the list is.
          const next = await tab.getByRole('button', { name: 'Next' }).boundingBox();
          expect(next !== null && next.y >= 0 && next.y + next.height <= viewport.height, 'Next is on screen').toBe(
            true,
          );
          expect(long.vertical.length, `exactly one element scrolls, got ${long.vertical.join(' | ')}`).toBe(1);
        }));
});

describe('folder path box', () => {
  for (const viewport of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const)
      it(`opens a typed path and refuses a fenced one (${viewport.name}, ${scheme})`, () =>
        withTab(viewport, scheme, async (tab, open, shot) => {
          await open('folders=2');
          const calls = () =>
            tab.evaluate(() => (window as unknown as { __calls: { query?: { path?: string } }[] }).__calls);

          // Prefilled with the open folder, `~` for the home.
          const box = tab.locator(PATH_BOX);
          await box.waitFor({ timeout: 5_000 });
          expect(await box.inputValue()).toBe('~');

          // `~/project1` + Enter: the route is asked for that path and the breadcrumb shows it.
          await box.fill('~/project1');
          await box.press('Enter');
          await tab.waitForSelector('[data-explorer-crumb="/home/sam/project1"]');
          expect((await calls()).some(call => call.query?.path === '~/project1')).toBe(true);
          expect(await box.inputValue()).toBe('~/project1');
          await shot('typed-path-opened');

          // A fenced path: the daemon's sentence is under the field, the listing is unchanged, nothing widened.
          await box.fill('/etc');
          await box.press('Enter');
          const refusal = tab.locator('[data-explorer-path-error]');
          await refusal.waitFor({ timeout: 5_000 });
          expect(await refusal.innerText()).toContain('that folder is not there, or cannot be listed');
          expect((await calls()).some(call => call.query?.path === '/etc')).toBe(true);
          expect(await tab.locator('[data-explorer-crumb]').allInnerTexts()).toEqual(['~', 'project1']);
          expect(
            await tab
              .locator('[data-explorer-entry]')
              .evaluateAll(nodes => nodes.map(node => node.getAttribute('data-explorer-entry'))),
          ).toEqual(['src', 'docs']);
          await shot('fenced-path');

          // Esc restores the open folder's path and clears the refusal.
          await box.press('Escape');
          expect(await box.inputValue()).toBe('~/project1');
          expect(await tab.locator('[data-explorer-path-error]').count()).toBe(0);
        }));
});
