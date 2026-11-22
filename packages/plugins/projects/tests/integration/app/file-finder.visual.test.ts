/**
 * F6061 U7 in a real browser: the project page's file finder over FAKE data, light and dark, at 390 and 1280.
 *
 * The owner's ask is "an IDE's Go to file" on a phone as much as a desktop, so what is measured is geometry and
 * legibility, not a snapshot: the finder sits inside the viewport with no sideways scroll even for a very long path, rows
 * are as tall as the page's own controls (a thumb can hit them), the coverage banner at the cap is on screen ABOVE the list
 * and readable (WCAG AA), a partial index never prints "no file matches", typing filters through the daemon, and Rescan
 * says Updating… and comes back. Set `FY_FINDER_SHOTS_DIR` to keep `<viewport>-<scheme>-<shot>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(90_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_FINDER_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-finder-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/finder-scene.tsx'],
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
type Viewport = (typeof VIEWPORTS)[number];

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
    await tab.waitForSelector('[data-finder-state="ready"]', { timeout: 15_000 });
    await tab.waitForTimeout(250);
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

/** What the page measures about the finder at one moment. */
interface Measured {
  viewportWidth: number;
  pageScrollWidth: number;
  finder: { left: number; right: number };
  input: { height: number };
  /** The page's own control height (`min-h-control`), as the browser resolves it for this viewport. */
  controlPx: number;
  rescan: { height: number; text: string; disabled: boolean };
  rows: { count: number; minHeight: number; maxRight: number; overflowing: number };
  banner: { text: string; left: number; right: number; bottom: number; contrast: number; fontPx: number } | null;
  firstRowTop: number | null;
  emptyText: string | null;
}

const measure = (tab: Page): Promise<Measured> =>
  tab.evaluate((): Measured => {
    const finder = document.querySelector('[data-finder-state="ready"]') as HTMLElement;
    const channels = (color: string): [number, number, number, number] => {
      const found = color.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 1];
      return [found[0] ?? 0, found[1] ?? 0, found[2] ?? 0, found[3] ?? 1];
    };
    const luminance = ([red, green, blue]: [number, number, number, number]): number => {
      const lin = (value: number) => {
        const unit = value / 255;
        return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * lin(red) + 0.7152 * lin(green) + 0.0722 * lin(blue);
    };
    const contrastOf = (node: HTMLElement): number => {
      let background: [number, number, number, number] = [255, 255, 255, 1];
      for (let up: HTMLElement | null = node; up !== null; up = up.parentElement) {
        const paint = channels(getComputedStyle(up).backgroundColor);
        if (paint[3] > 0.99) {
          background = paint;
          break;
        }
      }
      const [lighter, darker] = [luminance(channels(getComputedStyle(node).color)), luminance(background)].sort(
        (a, b) => b - a,
      ) as [number, number];
      return (lighter + 0.05) / (darker + 0.05);
    };
    const box = finder.getBoundingClientRect();
    const input = finder.querySelector('[data-finder-input]') as HTMLElement;
    const rescan = finder.querySelector('[data-finder-rescan]') as HTMLButtonElement;
    const rowNodes = [...finder.querySelectorAll<HTMLElement>('[data-finder-row]')];
    const banner = finder.querySelector<HTMLElement>('[data-finder-banner]');
    const bannerBox = banner?.getBoundingClientRect();
    const empty = finder.querySelector<HTMLElement>('[data-finder-empty]');
    // A row overflows when its own content is wider than the row: the long name must truncate, not push.
    const rowBoxes = rowNodes.map(node => node.getBoundingClientRect());
    return {
      viewportWidth: window.innerWidth,
      pageScrollWidth: document.documentElement.scrollWidth,
      finder: { left: box.left, right: box.right },
      input: { height: input.getBoundingClientRect().height },
      controlPx: Number.parseFloat(getComputedStyle(rescan).minHeight),
      rescan: {
        height: rescan.getBoundingClientRect().height,
        text: rescan.innerText.trim(),
        disabled: rescan.disabled,
      },
      rows: {
        count: rowNodes.length,
        minHeight: rowBoxes.length === 0 ? 0 : Math.min(...rowBoxes.map(row => row.height)),
        maxRight: rowBoxes.length === 0 ? 0 : Math.max(...rowBoxes.map(row => row.right)),
        overflowing: rowNodes.filter(node => node.scrollWidth > node.clientWidth + 1).length,
      },
      banner:
        banner === null || bannerBox === undefined
          ? null
          : {
              text: banner.innerText,
              left: bannerBox.left,
              right: bannerBox.right,
              bottom: bannerBox.bottom,
              contrast: contrastOf(banner),
              fontPx: Number.parseFloat(getComputedStyle(banner).fontSize),
            },
      firstRowTop: rowBoxes[0]?.top ?? null,
      emptyText: empty?.innerText ?? null,
    };
  });

const log = (label: string, m: Measured): void => {
  console.info(
    `[u7] ${label}: finder x ${m.finder.left.toFixed(1)}..${m.finder.right.toFixed(1)} of ${m.viewportWidth}, page scrollWidth ${m.pageScrollWidth}, input ${m.input.height.toFixed(1)}px, control ${m.controlPx}px, rescan ${m.rescan.height.toFixed(1)}px, rows ${m.rows.count} (min height ${m.rows.minHeight.toFixed(1)}px, max right ${m.rows.maxRight.toFixed(1)}, truncating ${m.rows.overflowing})${m.banner === null ? '' : `, banner contrast ${m.banner.contrast.toFixed(2)}:1 ${m.banner.fontPx}px`}`,
  );
};

/** Geometry every state must meet: on screen, nothing sideways, rows as tall as the page's own controls. */
const expectFits = (label: string, m: Measured, viewport: Viewport): void => {
  expect(m.finder.left, `${label}: starts inside the viewport`).toBeGreaterThanOrEqual(0);
  expect(m.finder.right, `${label}: ends inside the viewport`).toBeLessThanOrEqual(m.viewportWidth + 0.5);
  expect(m.pageScrollWidth, `${label}: nothing scrolls sideways`).toBeLessThanOrEqual(viewport.width);
  expect(m.rows.maxRight, `${label}: no row reaches past the viewport`).toBeLessThanOrEqual(m.viewportWidth + 0.5);
  // The page's own control height is the floor for a button or a row: 28px at a desktop, and larger where a thumb is the
  // pointer. The rule is "at least the page's control", measured as the browser resolved it for this viewport.
  expect(m.controlPx, `${label}: the page's control height resolved`).toBeGreaterThanOrEqual(viewport.phone ? 40 : 28);
  expect(m.rescan.height, `${label}: Rescan is at least a control tall`).toBeGreaterThanOrEqual(m.controlPx - 0.5);
  if (m.rows.count > 0)
    expect(m.rows.minHeight, `${label}: a row is at least a control tall`).toBeGreaterThanOrEqual(m.controlPx - 0.5);
};

describe('the project page file finder', () => {
  for (const viewport of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const) {
      const where = `${viewport.name}, ${scheme}`;

      it(`lists files, fits the screen even for a very long path, and says nothing alarming when complete (${where})`, () =>
        withTab(viewport, scheme, async (tab, open, shot) => {
          await open('view=ready');
          const m = await measure(tab);
          log(`ready ${where}`, m);
          expectFits(`ready ${where}`, m, viewport);
          expect(m.rows.count, 'the top of the index is listed').toBeGreaterThan(10);
          expect(m.rows.count, 'at most the default 50').toBeLessThanOrEqual(50);
          // The very long name truncates inside its row instead of widening the page.
          expect(m.rows.overflowing, 'a long name is cut with an ellipsis, not scrolled').toBe(0);
          expect(m.banner, 'a complete index has no banner').toBeNull();
          await shot('ready');
        }));

      it(`at the cap the banner is on screen above the list, readable, and says where and what (${where})`, () =>
        withTab(viewport, scheme, async (tab, open, shot) => {
          await open('view=cap');
          const m = await measure(tab);
          log(`cap ${where}`, m);
          expectFits(`cap ${where}`, m, viewport);
          const banner = m.banner;
          expect(banner, 'the banner is drawn').not.toBeNull();
          if (banner === null) return;
          expect(banner.text).toContain('Showing 50,000 of more than 50,000 files');
          expect(banner.text).toContain('Most files: data/ (31,200)');
          expect(banner.text).toContain('Skipped: 3 nested worktrees, 41 secret-looking names.');
          expect(banner.text).toContain('.gitignore');
          expect(banner.left, 'banner inside the viewport').toBeGreaterThanOrEqual(0);
          expect(banner.right, 'banner inside the viewport').toBeLessThanOrEqual(m.viewportWidth + 0.5);
          expect(banner.contrast, 'readable (WCAG AA for text)').toBeGreaterThanOrEqual(4.5);
          expect(banner.fontPx, 'no smaller than the page’s meta text').toBeGreaterThanOrEqual(11);
          expect(m.firstRowTop ?? Number.POSITIVE_INFINITY, 'the banner sits above the first row').toBeGreaterThan(
            banner.bottom - 1,
          );
          await shot('cap');
        }));

      it(`typing searches through the daemon, and a partial index never says "no file matches" (${where})`, () =>
        withTab(viewport, scheme, async (tab, open, shot) => {
          await open('view=ready');
          await tab.locator('[data-finder-input]').fill('module-3');
          await tab.waitForFunction(
            () => {
              const rows = [...document.querySelectorAll('[data-finder-row]')];
              return (
                rows.length > 0 &&
                rows.length < 20 &&
                rows.every(row => (row.getAttribute('data-finder-row') ?? '').includes('module-3'))
              );
            },
            undefined,
            { timeout: 8_000 },
          );
          expectFits(`search ${where}`, await measure(tab), viewport);

          // A complete index may say there is no match; a partial one never does.
          await tab.locator('[data-finder-input]').fill('zzz-not-here');
          await tab.waitForSelector('[data-finder-empty]', { timeout: 8_000 });
          expect((await measure(tab)).emptyText).toBe('No file in this project matches “zzz-not-here”.');
          await open('view=cap&find=zzz-not-here');
          await tab.waitForSelector('[data-finder-empty]', { timeout: 8_000 });
          const partial = await measure(tab);
          log(`empty over a partial index ${where}`, partial);
          expectFits(`empty cap ${where}`, partial, viewport);
          expect(partial.emptyText).toContain('the file may exist beyond them');
          expect(partial.emptyText).not.toContain('No file in this project');
          await shot('empty-cap');
          // The filtered list as typed, for the shots; last, because a full-page capture resizes the viewport.
          await open('view=ready&find=module-3');
          await tab.waitForSelector('[data-finder-row]', { timeout: 8_000 });
          await shot('search');
        }));

      it(`Rescan says Updating…, stays disabled while it builds and comes back (${where})`, () =>
        withTab(viewport, scheme, async (tab, open, shot) => {
          await open('view=building');
          const during = await measure(tab);
          log(`building ${where}`, during);
          expect(during.rescan.text).toContain('Updating');
          expect(during.rescan.disabled).toBe(true);
          expectFits(`building ${where}`, during, viewport);
          // The shot of the busy state is taken first of all, but a full-page capture resizes the emulated viewport, so it
          // is the LAST thing the test does to the page: every measurement above and below is of the real viewport.
          await tab.waitForFunction(
            () => document.querySelector('[data-finder-rescan]')?.textContent?.includes('Rescan') === true,
            undefined,
            { timeout: 12_000 },
          );
          const after = await measure(tab);
          expect(after.rescan.disabled).toBe(false);
          expectFits(`rebuilt ${where}`, after, viewport);
          // Updating… was on screen only while the fake build ran, so the shot reloads the page to catch it again.
          await open('view=building');
          await shot('building');
        }));

      it(`a ferret working here adds one link into its file browser, never a second finder (${where})`, () =>
        withTab(viewport, scheme, async (tab, open, shot) => {
          await open('view=ferret');
          await tab.waitForSelector('[data-project-files-ferret="f-1"]', { timeout: 8_000 });
          const m = await measure(tab);
          expectFits(`ferret ${where}`, m, viewport);
          expect(await tab.locator('[data-finder-input]').count(), 'one finder').toBe(1);
          await shot('ferret');
        }));
    }
});
