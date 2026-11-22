/**
 * F6061 U4 (PR 2303 review item 4) in a real browser: the broad-root warning at registration, over fake data.
 *
 * Registering the disk or a home folder is allowed and is said out loud BEFORE the button is pressed, because a device that may
 * use files on this machine then reads names across it. Two places register a folder, and both are measured: the create flow's
 * folder step (the daemon says `broad` on the listing it just drew) and the typed-path form (spelled `/`, `/home`, a home).
 * The warning must be on screen, inside the viewport with no sideways scroll, readable in both schemes, and absent for an
 * ordinary folder. Set `FY_BROAD_ROOT_SHOTS_DIR` to keep `<viewport>-<scheme>-<shot>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_BROAD_ROOT_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-broad-root-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/broad-root-scene.tsx'],
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

/** What the page measures about one warning node. */
interface Measured {
  text: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
  viewportWidth: number;
  viewportHeight: number;
  pageScrollWidth: number;
  contrast: number;
  fontPx: number;
}

/** Measures the first node matching `selector`: its box, the page's sideways overflow and its text-on-background contrast. */
const measure = (tab: Page, selector: string): Promise<Measured | null> =>
  tab.evaluate((css): Measured | null => {
    const node = document.querySelector(css) as HTMLElement | null;
    if (node === null) return null;
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
    // The first opaque background walking up, flattened over white only as a last resort.
    let background: [number, number, number, number] = [255, 255, 255, 1];
    for (let up: HTMLElement | null = node; up !== null; up = up.parentElement) {
      const paint = channels(getComputedStyle(up).backgroundColor);
      if (paint[3] > 0.99) {
        background = paint;
        break;
      }
    }
    const foreground = channels(getComputedStyle(node).color);
    const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a) as [number, number];
    const box = node.getBoundingClientRect();
    return {
      text: node.innerText,
      left: box.left,
      right: box.right,
      top: box.top,
      bottom: box.bottom,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      pageScrollWidth: document.documentElement.scrollWidth,
      contrast: (lighter + 0.05) / (darker + 0.05),
      fontPx: Number.parseFloat(getComputedStyle(node).fontSize),
    };
  }, selector);

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
    await tab.waitForSelector('[data-explorer-state="ready"], [data-add-project-form]', { timeout: 15_000 });
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

/** The assertions every warning must meet, with the numbers it was measured at logged for the PR. */
const expectLegible = (label: string, got: Measured | null, viewport: Viewport): Measured => {
  expect(got, `${label}: the warning is on the page`).not.toBeNull();
  const m = got as Measured;
  console.info(
    `[u4] ${label}: x ${m.left.toFixed(1)}..${m.right.toFixed(1)} of ${m.viewportWidth}, y ${m.top.toFixed(1)}..${m.bottom.toFixed(1)}, page scrollWidth ${m.pageScrollWidth}, contrast ${m.contrast.toFixed(2)}:1, ${m.fontPx}px`,
  );
  expect(m.text, `${label}: it says what it means`).toContain('whole disk or home folder');
  expect(m.left, `${label}: starts inside the viewport`).toBeGreaterThanOrEqual(0);
  expect(m.right, `${label}: ends inside the viewport`).toBeLessThanOrEqual(m.viewportWidth + 0.5);
  expect(m.pageScrollWidth, `${label}: nothing scrolls sideways`).toBeLessThanOrEqual(viewport.width);
  expect(m.contrast, `${label}: readable (WCAG AA for text)`).toBeGreaterThanOrEqual(4.5);
  // The design's `text-meta` is 11px on a desktop and 14px on a phone: the warning is no smaller than the other notes beside it.
  expect(m.fontPx, `${label}: at least the page's meta text size`).toBeGreaterThanOrEqual(11);
  return m;
};

describe('the broad-root warning at registration', () => {
  for (const viewport of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const) {
      it(`the folder step warns when the open folder is the home, and not for an ordinary folder (${viewport.name}, ${scheme})`, () =>
        withTab(viewport, scheme, async (tab, open, shot) => {
          await open('view=flow');
          await tab.waitForSelector('[data-explorer-broad]');
          expectLegible('folder step, home', await measure(tab, '[data-explorer-broad]'), viewport);
          await shot('folder-step-home');
          // an ordinary folder: no warning at all
          await tab.locator('[data-explorer-entry="project1"]').click();
          await tab.waitForSelector('[data-explorer-crumb="/home/sam/project1"]');
          await tab.waitForTimeout(200);
          expect(await tab.locator('[data-explorer-broad]').count(), 'no warning for an ordinary folder').toBe(0);
          await shot('folder-step-ordinary');
        }));

      it(`the typed-path form warns for /, /home and a home, and not for an ordinary path (${viewport.name}, ${scheme})`, () =>
        withTab(viewport, scheme, async (tab, open, shot) => {
          for (const path of ['/', '/home', '/home/sam']) {
            await open(`view=form&path=${encodeURIComponent(path)}`);
            expectLegible(`form ${path}`, await measure(tab, '[data-project-broad-warning]'), viewport);
            if (path === '/home') await shot('form-home');
          }
          await open(`view=form&path=${encodeURIComponent('/srv/work')}`);
          expect(await tab.locator('[data-project-broad-warning]').count(), 'no warning for an ordinary path').toBe(0);
          await shot('form-ordinary');
        }));
    }
});
