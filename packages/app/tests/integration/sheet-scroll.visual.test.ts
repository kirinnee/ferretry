/**
 * SHEETS SHOW A SCROLL BAR ONLY WHEN THEY NEED ONE, in a real browser over fake data (`fixtures/sheet-scroll-scene.tsx`):
 * the owner's line "the modal shouldn't have scroll bars unless they need to".
 *
 * Seven `BottomSheet` shapes (every shipping caller's panel props and layout classes), light and dark, at 390 and 1280:
 *   short content  no element inside the sheet scrolls, either way (a scroller = overflow auto|scroll AND content larger than
 *                  its box), and none is `overflow: scroll` (a bar that is always there)
 *   long content   exactly ONE element scrolls vertically, never sideways, its last line is reachable, and the handle row
 *                  stays pinned to the panel's top edge while it scrolls
 *   wide content   a 900px-wide line is clipped by the sheet: no element grows a horizontal bar
 *
 * Set `FY_SHEET_SCROLL_SHOTS_DIR` to keep `<viewport>-<theme>-<scene>-<size>.png`, plus `-end` (long content scrolled to its end).
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '../support/browser/index.ts';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_SHEET_SCROLL_SHOTS_DIR ?? '';
const SCENES = ['chooser', 'device', 'actions', 'skill', 'details', 'info', 'editor'] as const;

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-sheet-scroll-'));
  const child = Bun.spawn(
    [
      process.execPath,
      sceneBuilder,
      '--out',
      directory,
      '--entry',
      resolve(packageRoot, 'fixtures/sheet-scroll-scene.tsx'),
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the sheet scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request =>
      new URL(request.url).pathname === '/app.js'
        ? new Response(js, { headers: { 'content-type': 'text/javascript' } })
        : new Response(page, { headers: { 'content-type': 'text/html' } }),
  });
  browser = await sharedChromium();
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

interface Measure {
  readonly vertical: string[];
  readonly horizontal: string[];
  readonly always: string[];
  readonly panelWidth: number;
  readonly panelScrollWidth: number;
  /** long content scrolled to its end: the last line is on screen. */
  endReached?: boolean;
  /** long content scrolled to its end: how far the grip row is from the panel's top edge (0 = pinned). */
  gripOffset?: number;
}

const measure = async (
  width: number,
  scheme: 'light' | 'dark',
  scene: string,
  size: 'short' | 'long',
  wide: boolean,
): Promise<Measure> => {
  const phone = width < 600;
  const context = await browser.newContext({
    viewport: { width, height: 800 },
    deviceScaleFactor: phone ? 2 : 1,
    hasTouch: phone,
    isMobile: phone,
    colorScheme: scheme,
  });
  try {
    const tab = await context.newPage();
    await tab.goto(
      `${server?.url.origin ?? ''}/?theme=studio-${scheme}&sheet=${scene}&size=${size}${wide ? '&wide=1' : ''}`,
    );
    await tab.waitForSelector('[role="dialog"]');
    // The sheet slides in: measure it settled.
    await tab.evaluate(async () => {
      await Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => undefined)));
    });
    if (shotsDir !== '')
      await tab.screenshot({ path: join(shotsDir, `${width}-${scheme}-${scene}-${size}${wide ? '-wide' : ''}.png`) });
    const result: Measure = await tab.evaluate(() => {
      const panel = document.querySelector<HTMLElement>('[role="dialog"]') as HTMLElement;
      const name = (element: Element): string =>
        `${element.tagName.toLowerCase()}${element.id !== '' ? `#${element.id}` : ''}.${String(element.className).split(' ').slice(0, 3).join('.')}`;
      const vertical: string[] = [];
      const horizontal: string[] = [];
      const always: string[] = [];
      for (const element of [panel, ...panel.querySelectorAll<HTMLElement>('*')]) {
        const style = getComputedStyle(element);
        if (style.overflowY === 'scroll' || style.overflowX === 'scroll') always.push(name(element));
        const y = style.overflowY === 'auto' || style.overflowY === 'scroll';
        const x = style.overflowX === 'auto' || style.overflowX === 'scroll';
        if (y && element.scrollHeight > element.clientHeight + 1) vertical.push(name(element));
        if (x && element.scrollWidth > element.clientWidth + 1) horizontal.push(name(element));
      }
      return {
        vertical,
        horizontal,
        always,
        panelWidth: panel.clientWidth,
        panelScrollWidth: panel.scrollWidth,
      };
    });
    if (size === 'long' && !wide) {
      // Reachability: scroll the one scroller to its end, then the last line must be on screen and the grip still pinned.
      const end = await tab.evaluate(() => {
        const panel = document.querySelector<HTMLElement>('[role="dialog"]') as HTMLElement;
        for (const element of [panel, ...panel.querySelectorAll<HTMLElement>('*')]) {
          const style = getComputedStyle(element);
          if (
            (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
            element.scrollHeight > element.clientHeight + 1
          )
            element.scrollTop = element.scrollHeight;
        }
        const lines = [...panel.querySelectorAll<HTMLElement>('p')];
        const last = lines.at(-1)?.getBoundingClientRect();
        const grip = panel.querySelector<HTMLElement>('.kt-sheet__grip')?.getBoundingClientRect();
        const box = panel.getBoundingClientRect();
        return {
          lastLineInside: last !== undefined && last.bottom <= box.bottom + 1 && last.top >= box.top,
          gripOffset: grip === undefined ? Number.NaN : Math.abs(grip.top - box.top),
        };
      });
      result.endReached = end.lastLineInside;
      result.gripOffset = end.gripOffset;
      if (shotsDir !== '')
        await tab.screenshot({ path: join(shotsDir, `${width}-${scheme}-${scene}-${size}-end.png`) });
    }
    return result;
  } finally {
    await context.close();
  }
};

const VARIANTS = [
  { width: 1_280, scheme: 'light' as const },
  { width: 1_280, scheme: 'dark' as const },
  { width: 390, scheme: 'light' as const },
  { width: 390, scheme: 'dark' as const },
];

describe('a sheet shows a scroll bar only when it needs one', () => {
  for (const { width, scheme } of VARIANTS) {
    describe(`${width} ${scheme}`, () => {
      for (const scene of SCENES) {
        it(`${scene}: short content, nothing scrolls`, async () => {
          const result = await measure(width, scheme, scene, 'short', false);
          expect(result.vertical).toEqual([]);
          expect(result.horizontal).toEqual([]);
          expect(result.always).toEqual([]);
        });
        it(`${scene}: long content, exactly one element scrolls and never sideways`, async () => {
          const result = await measure(width, scheme, scene, 'long', false);
          expect(result.vertical).toHaveLength(1);
          expect(result.endReached).toBe(true);
          expect(result.gripOffset).toBeLessThanOrEqual(1);
          expect(result.horizontal).toEqual([]);
          expect(result.always).toEqual([]);
        });
      }
      it('a 900px line is clipped, never a sideways bar', async () => {
        for (const scene of SCENES) {
          const result = await measure(width, scheme, scene, 'short', true);
          expect({ scene, horizontal: result.horizontal }).toEqual({ scene, horizontal: [] });
        }
      });
    });
  }
});
