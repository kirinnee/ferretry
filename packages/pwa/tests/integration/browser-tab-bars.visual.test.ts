/**
 * THE BROWSER SIDE TAB SPENDS ONE BAR (TWO AT MOST) ON META-INFORMATION, in a real browser.
 *
 * The scene (`tests/integration/fixtures/browser-tab-scene.tsx`) is the real page strip, surface header and
 * remote pane over a fake transport and display, in every state a person meets: idle, an agent driving, the
 * owner holding the page, a hand-over ask, a human-check page, a failed page, a lost display and a stopped
 * browser. At a phone and a desktop width, light and dark, nothing scrolls sideways and the page view starts
 * within the bar budget.
 *
 * Set `FY_BROWSER_BARS_SHOTS_DIR` to keep `<FY_BROWSER_BARS_PREFIX>-<state>-<viewport>-<theme>.png`.
 */
import { afterAll, beforeAll, describe, expect } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser } from 'playwright-core';
import { sharedChromium } from './support/chromium.ts';
import { laneTests } from './support/lanes.ts';

const packageRoot = resolve(import.meta.dir, '../..');
const shotsDir = process.env.FY_BROWSER_BARS_SHOTS_DIR ?? '';
const prefix = process.env.FY_BROWSER_BARS_PREFIX ?? 'after';

const viewports = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'desktop', width: 1_440, height: 900 },
] as const;
const themes = ['light', 'dark'] as const;
const states = ['idle', 'driving', 'owner', 'ask', 'challenge', 'error', 'disconnected', 'stopped'] as const;

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-browser-bars-'));
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(packageRoot, 'scripts/build-composer-integration-fixture.ts'),
      '--out',
      directory,
      '--entry',
      'tests/integration/fixtures/browser-tab-scene.tsx',
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the browser-tab scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  return { css: await readFile(manifest.css, 'utf8'), js: await readFile(manifest.js, 'utf8') };
};

beforeAll(async () => {
  browser = await sharedChromium();
  const { css, js } = await build();
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>html,body,#root{height:100%;margin:0}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      const path = new URL(request.url).pathname;
      if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
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

const pause = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms));

interface Measure {
  readonly overflow: number;
  /** Where the page view (the streamed display) begins, below the top of the tab's frame. */
  readonly pageTop: number;
  readonly frameTop: number;
  readonly bars: number;
  readonly chips: readonly string[];
  /** Pieces of the old stacked chrome that must be gone. */
  readonly leftovers: readonly string[];
  /** Bar children that spill past the bar's own box (clipped or overlapping). */
  readonly spilled: readonly string[];
  readonly barHeight: number;
}

/** The chip each scene must show: the state a person has to be able to read at a glance. */
const expectedChip: Record<(typeof states)[number], readonly string[]> = {
  idle: ['live', 'connecting'],
  driving: ['agent'],
  owner: ['owner'],
  ask: ['ask'],
  challenge: ['challenge'],
  error: ['error'],
  disconnected: ['disconnected'],
  stopped: ['stopped'],
};

const lane = laneTests();

describe('the browser side tab spends one bar on meta-information', () => {
  for (const viewport of viewports)
    for (const theme of themes)
      lane(`${viewport.name} ${theme}: every state fits its bar budget without sideways scroll`, async () => {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          colorScheme: theme,
          reducedMotion: 'reduce',
          deviceScaleFactor: 2,
        });
        try {
          const origin = server?.url.origin ?? '';
          await context.route('**/*', async route =>
            new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
          );
          for (const state of states) {
            const tab = await context.newPage();
            await tab.goto(`${origin}/?theme=studio-${theme}&state=${state}`);
            await tab.waitForSelector('[data-workspace-browser]');
            await tab.waitForSelector('[aria-label="Shared remote browser"]');
            await pause(400);
            const measure = await tab.evaluate<Measure>(`(() => {
              const frame = document.querySelector('[data-workspace-browser]');
              const screen = document.querySelector('.fy-remote-browser') ?? document.querySelector('[aria-label="Shared remote browser"] > div:last-of-type');
              const frameTop = frame.getBoundingClientRect().top;
              const bars = [...frame.querySelectorAll('[data-browser-bar]')];
              const barBox = bars[0]?.getBoundingClientRect();
              const spilled = bars[0] === undefined ? ['no bar'] : [...bars[0].querySelectorAll('[data-browser-bar-part]')]
                .filter(part => { const r = part.getBoundingClientRect(); return r.width > 0 && (r.right > barBox.right + 0.5 || r.left < barBox.left - 0.5); })
                .map(part => part.getAttribute('data-browser-bar-part'));
              const leftovers = ['[data-browser-pages]', '[data-browser-status-row]', '[role="tablist"]', '[data-browser-challenge]:not([data-browser-chip-detail] *)', '.fy-ws-pages', '.fy-ws-bar', '.fy-ws-marker']
                .filter(selector => frame.querySelector(selector) !== null);
              return {
                overflow: document.documentElement.scrollWidth - window.innerWidth,
                pageTop: screen.getBoundingClientRect().top,
                frameTop,
                bars: bars.length,
                barHeight: barBox?.height ?? 0,
                chips: [...frame.querySelectorAll('[data-browser-chip]')].map(chip => chip.getAttribute('data-browser-chip')),
                leftovers,
                spilled,
              };
            })()`);
            console.info(
              `bars ${prefix} ${state} ${viewport.name} ${theme}: page starts ${Math.round(measure.pageTop - measure.frameTop)}px below the tab top`,
            );
            expect(measure.overflow).toBeLessThanOrEqual(0);
            expect(measure.bars).toBe(1);
            expect(measure.leftovers).toEqual([]);
            expect(measure.spilled).toEqual([]);
            expect(measure.chips).toHaveLength(1);
            expect(expectedChip[state]).toContain(measure.chips[0] as string);
            // One bar, plus (phone only) the field that types into the page.
            expect(measure.pageTop - measure.frameTop).toBeLessThanOrEqual(viewport.name === 'phone' ? 132 : 72);
            if (shotsDir !== '')
              await tab.screenshot({ path: join(shotsDir, `${prefix}-${state}-${viewport.name}-${theme}.png`) });
            if (state === 'challenge' || state === 'ask' || state === 'error') {
              await tab.click('[data-browser-chip]');
              await tab.waitForSelector('[data-browser-chip-detail]');
              const detail = await tab.evaluate<{ readonly text: string; readonly inside: boolean }>(`(() => {
                const node = document.querySelector('[data-browser-chip-detail]');
                const box = node.getBoundingClientRect();
                return { text: node.textContent ?? '', inside: box.left >= 0 && box.right <= window.innerWidth };
              })()`);
              expect(detail.inside).toBe(true);
              expect(detail.text.length).toBeGreaterThan(10);
              if (shotsDir !== '')
                await tab.screenshot({
                  path: join(shotsDir, `${prefix}-${state}-detail-${viewport.name}-${theme}.png`),
                });
            }
            if (state === 'driving') {
              await tab.click('[aria-label="Browser controls"]');
              await tab.waitForSelector('[data-browser-menu]');
              const inside = await tab.evaluate<boolean>(
                `(() => { const box = document.querySelector('[data-browser-menu]').getBoundingClientRect(); return box.left >= 0 && box.right <= window.innerWidth && box.bottom <= window.innerHeight; })()`,
              );
              expect(inside).toBe(true);
              if (shotsDir !== '')
                await tab.screenshot({ path: join(shotsDir, `${prefix}-menu-${viewport.name}-${theme}.png`) });
            }
            if (state === 'idle') {
              await tab.click('[data-browser-bar-part="page"]');
              await tab.waitForSelector('[data-browser-pages]');
              if (shotsDir !== '')
                await tab.screenshot({ path: join(shotsDir, `${prefix}-pages-${viewport.name}-${theme}.png`) });
            }
            await tab.close();
          }
        } finally {
          await context.close();
        }
      });
});
