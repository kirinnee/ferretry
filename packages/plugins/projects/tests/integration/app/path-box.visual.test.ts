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

/**
 * What draws a bar, or hides content, under `[role=dialog]` (and the dialog itself):
 * - `forced`: a box whose overflow is FORCED to `scroll` (a bar is drawn even when nothing overflows);
 * - `vertical` / `horizontal`: a box that scrolls (`auto`/`scroll`) AND whose content overflows that way;
 * - `clipped`: content wider than a box that hides it (`hidden`/`clip`), i.e. horizontal content cut off.
 * A single-line ellipsis (`text-overflow: ellipsis`) and a visually-hidden 1px label are deliberate, not clipped layout.
 * The one box that scrolls is named `body` when it is the create sheet's body.
 */
const scrollers = (tab: Page) =>
  tab.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    if (dialog === null) return { error: 'no dialog' };
    const out: { forced: string[]; vertical: string[]; horizontal: string[]; clipped: string[] } = {
      forced: [],
      vertical: [],
      horizontal: [],
      clipped: [],
    };
    for (const node of [dialog, ...dialog.querySelectorAll('*')]) {
      const element = node as HTMLElement;
      const style = getComputedStyle(element);
      const name = element.hasAttribute('data-create-body')
        ? 'body'
        : `${element.tagName.toLowerCase()}.${String(element.className).slice(0, 48)}`;
      const scrollsY = style.overflowY === 'auto' || style.overflowY === 'scroll';
      const scrollsX = style.overflowX === 'auto' || style.overflowX === 'scroll';
      if (style.overflowY === 'scroll' || style.overflowX === 'scroll') out.forced.push(name);
      if (scrollsY && element.scrollHeight > element.clientHeight + 1) out.vertical.push(name);
      if (scrollsX && element.scrollWidth > element.clientWidth + 1) out.horizontal.push(name);
      const cuts = style.overflowX === 'hidden' || style.overflowX === 'clip';
      // A 1px box is the visually-hidden pattern (a screen-reader label), not a layout that cuts content off.
      const drawn = element.clientWidth > 2 && element.clientHeight > 2;
      if (cuts && drawn && style.textOverflow !== 'ellipsis' && element.scrollWidth > element.clientWidth + 1)
        out.clipped.push(name);
    }
    return out;
  });

type Scrollers = { forced: string[]; vertical: string[]; horizontal: string[]; clipped: string[] };
const NONE: Scrollers = { forced: [], vertical: [], horizontal: [], clipped: [] };

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
          expect(await scrollers(tab), 'a sheet that fits draws no scroll bar and clips nothing').toEqual(NONE);

          // The detector itself: a forced `overflow: scroll` on a short sheet, and a wide child cut off by
          // `overflow-x: hidden`, are both reported (so the line above cannot pass for the wrong reason).
          await tab.evaluate(() => {
            const body = document.querySelector('[data-create-body]') as HTMLElement;
            body.style.overflowY = 'scroll';
            const clip = document.createElement('div');
            clip.id = 'probe-clip';
            clip.style.cssText = 'overflow-x:hidden;width:50px';
            clip.innerHTML = '<div style="width:400px;height:4px"></div>';
            body.append(clip);
          });
          const probed = (await scrollers(tab)) as Scrollers;
          expect(probed.forced, 'a forced overflow:scroll is reported').toContain('body');
          expect(probed.clipped.length, 'horizontal content cut by overflow-x:hidden is reported').toBeGreaterThan(0);
          await tab.evaluate(() => {
            const body = document.querySelector('[data-create-body]') as HTMLElement;
            body.style.overflowY = '';
            document.getElementById('probe-clip')?.remove();
          });

          // O9-4: Go sits INSIDE the path field (centred on it, never taller than it), not beside it.
          const sizes = await tab.evaluate(() => {
            const form = document.querySelector('[data-explorer-path-box]');
            const box = (selector: string) => form?.querySelector(selector)?.getBoundingClientRect();
            return { input: box('input'), go: box('button[type="submit"]') };
          });
          const { input, go } = sizes;
          expect(input !== undefined && go !== undefined, 'the path box has its field and Go').toBe(true);
          if (input !== undefined && go !== undefined) {
            expect(go.left >= input.left && go.right <= input.right, 'Go sits inside the field').toBe(true);
            expect(go.height, 'Go is no taller than the field').toBeLessThanOrEqual(input.height + 1);
            expect(
              Math.abs(go.top + go.height / 2 - (input.top + input.height / 2)),
              'Go is centred on the field',
            ).toBeLessThanOrEqual(1);
          }

          // SIXTY folders: exactly ONE element scrolls (the sheet's body), and nothing scrolls sideways.
          await open('folders=60');
          await shot('sixty-folders');
          const long = (await scrollers(tab)) as Scrollers;
          expect(long.horizontal, 'no sideways bar').toEqual([]);
          expect(long.clipped, 'no horizontal content cut off').toEqual([]);
          expect(long.forced, 'no forced scroll box').toEqual([]);
          // The footer (Next) stays inside the sheet and on screen however long the list is.
          const next = await tab.getByRole('button', { name: 'Next' }).boundingBox();
          expect(next !== null && next.y >= 0 && next.y + next.height <= viewport.height, 'Next is on screen').toBe(
            true,
          );
          expect(long.vertical, 'exactly one element scrolls, and it is the sheet body').toEqual(['body']);

          // Keyboard: walk the highlight 35 rows down; the row must stay in view ABOVE the sticky footer.
          await tab.locator('[role="listbox"]').focus();
          for (let press = 0; press < 35; press += 1) await tab.keyboard.press('ArrowDown');
          const geometry = await tab.evaluate(() => {
            const row = document.querySelector('[data-explorer-highlighted="true"]')?.getBoundingClientRect();
            const footer = document.querySelector('.fy-spf__footer')?.getBoundingClientRect();
            const body = document.querySelector('[data-create-body]')?.getBoundingClientRect();
            return row && footer && body
              ? { rowTop: row.top, rowBottom: row.bottom, footerTop: footer.top, bodyTop: body.top }
              : null;
          });
          expect(geometry, 'a highlighted row, the footer and the body are measured').not.toBeNull();
          const at = geometry as NonNullable<typeof geometry>;
          console.info(
            `[s4] ${viewport.name} ${scheme}: row ${at.rowTop.toFixed(1)}..${at.rowBottom.toFixed(1)}, footer top ${at.footerTop.toFixed(1)}`,
          );
          expect(at.rowBottom, 'the highlighted row ends above the footer').toBeLessThanOrEqual(at.footerTop + 0.5);
          expect(at.rowTop, 'the highlighted row starts below the top of the body').toBeGreaterThanOrEqual(
            at.bodyTop - 0.5,
          );
          await shot('keyboard-highlight');
        }));
});

describe('folder path box', () => {
  for (const viewport of VIEWPORTS)
    it(`drops a typed path once another folder is open (${viewport.name})`, () =>
      withTab(viewport, 'light', async (tab, open) => {
        await open('folders=2');
        const box = tab.locator(PATH_BOX);
        await box.fill('~/project1');
        await box.press('Enter');
        await tab.waitForSelector('[data-explorer-crumb="/home/sam/project1"]');
        // Up goes back to the folder the text was typed in: the box shows THAT folder, not the old edit.
        await tab.locator('[data-explorer-up]').click();
        await tab.waitForFunction(() => document.querySelectorAll('[data-explorer-crumb]').length === 1);
        expect(await box.inputValue(), 'the box shows the open folder after Up').toBe('~');
        // The round trip the other way: Up, then into the folder again: it shows the folder, not a stale edit.
        await tab.locator('[data-explorer-entry="project1"]').click();
        await tab.waitForSelector('[data-explorer-crumb="/home/sam/project1"]');
        expect(await box.inputValue()).toBe('~/project1');
      }));

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

          // O11 R8 (S-68): the Go label is the same size as the explorer's other buttons (it was extra-small text), and a real touch target.
          const sizes = await tab.evaluate(() => {
            const newFolder = [...document.querySelectorAll('button')].find(
              button => button.textContent?.trim() === 'New folder',
            ) as HTMLElement;
            const go = [...document.querySelectorAll('button')].find(
              button => button.textContent?.trim() === 'Go',
            ) as HTMLElement;
            return {
              input: Number.parseFloat(getComputedStyle(newFolder).fontSize),
              go: Number.parseFloat(getComputedStyle(go).fontSize),
              goHeight: go.getBoundingClientRect().height,
            };
          });
          expect(sizes.go, 'Go is not smaller than New folder').toBeGreaterThanOrEqual(sizes.input - 0.5);
          expect(sizes.goHeight, 'Go fills the field (a touch target on a phone)').toBeGreaterThanOrEqual(
            viewport.phone ? 40 : 34,
          );

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
