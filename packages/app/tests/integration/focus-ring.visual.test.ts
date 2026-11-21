/**
 * FOCUS RINGS ARE NEVER CLIPPED (r11 S13, owner/britnee F: "focus rings clipped app-wide", shot 22 on Usage analytics).
 *
 * A real browser over the REAL app (`fixtures/mobile-scene.tsx`: every shipped plugin's own app half over one fake machine) and
 * over the onboarding step frame (`fixtures/step-frame-scene.tsx`). On each page the probe (`support/browser/focus-ring.ts`)
 * presses Tab through every focusable (cap 80), scrolls it into view (`block: 'nearest'`) and measures its ring box against
 * every clipping ancestor's padding box: 0 violations. A primary button's ring also keeps >= 3:1 against what sits just
 * inside it and just outside it.
 *
 * Pages: Usage analytics Overview (`/d/ws/insights`) and Query (`/d/ws/insights/query`, where the owner's screenshot 22 shows the
 * Metric select), New ferret, Projects, three Settings tabs, and the step frame; at 1280, 768 and
 * 390, light and dark. `FY_FOCUS_RING_ONLY=<name,name>` narrows the pages; `FY_FOCUS_RING_REPORT=<file>` writes the
 * measured numbers as JSON (the PR body quotes them).
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';
import { sceneBuilder, sceneServer, sharedChromium } from '../support/browser/index.ts';
import { ringOf, walkFocusRings } from '../support/browser/focus-ring.ts';
import { STYLE_IDS } from '../../src/theme/catalog.ts';

setDefaultTimeout(90_000);

const reportPath = process.env.FY_FOCUS_RING_REPORT ?? '';
/** `FY_FOCUS_RING_SHOTS=<dir>`: also write a screenshot of the focused Metric select in every style (local evidence, never committed). */
const shotsDir = process.env.FY_FOCUS_RING_SHOTS ?? '';
const only = (process.env.FY_FOCUS_RING_ONLY ?? '').split(',').filter(Boolean);
const appScene = new URL('./fixtures/mobile-scene.tsx', import.meta.url).pathname;
const frameScene = new URL('./fixtures/step-frame-scene.tsx', import.meta.url).pathname;

let browser: Browser;
const servers: ReturnType<typeof Bun.spawn>[] = [];
const origins: Record<'app' | 'frame', string> = { app: '', frame: '' };

const start = async (entry: string): Promise<string> => {
  const server = Bun.spawn([process.execPath, sceneServer, '--entry', entry], { stderr: 'inherit', stdout: 'pipe' });
  servers.push(server);
  const reader = (server.stdout as ReadableStream<Uint8Array>).getReader();
  const first = await Promise.race([
    reader.read(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the scene server did not start')), 120_000)),
  ]);
  return (JSON.parse(new TextDecoder().decode(first.value).trim().split('\n')[0] as string) as { origin: string })
    .origin;
};

/** The step frame scene is a plain entry: built to one bundle (css inlined) and served, like the step page frame test does. */
let directory = '';
let frameServer: ReturnType<typeof Bun.serve> | undefined;
const serveFrame = async (): Promise<string> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-focus-ring-'));
  const child = Bun.spawn([process.execPath, sceneBuilder, '--out', directory, '--entry', frameScene], {
    cwd: import.meta.dir,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the step frame scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  frameServer = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request =>
      new URL(request.url).pathname === '/app.js'
        ? new Response(js, { headers: { 'content-type': 'text/javascript' } })
        : new Response(page, { headers: { 'content-type': 'text/html' } }),
  });
  return frameServer.url.origin;
};

const report: Record<string, unknown> = {};

beforeAll(async () => {
  browser = await sharedChromium();
  [origins.app, origins.frame] = await Promise.all([start(appScene), serveFrame()]);
}, 240_000);

afterAll(async () => {
  for (const server of servers) server.kill();
  frameServer?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
  if (reportPath !== '') await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
});

interface Page {
  readonly name: string;
  readonly scene: 'app' | 'frame';
  readonly path: string;
  readonly ready: string;
}
const PAGES: readonly Page[] = [
  { name: 'usage-analytics', scene: 'app', path: '/d/ws/insights', ready: '.fy-main' },
  { name: 'usage-query', scene: 'app', path: '/d/ws/insights/query', ready: 'select.kt-input:not(:disabled)' },
  { name: 'new-ferret', scene: 'app', path: '/d/ws/new', ready: '.fy-main' },
  { name: 'projects', scene: 'app', path: '/d/ws/projects', ready: '.fy-main' },
  { name: 'settings-budgets', scene: 'app', path: '/d/ws/settings/usage/budgets', ready: '.fy-page' },
  { name: 'settings-logins', scene: 'app', path: '/d/ws/settings/logins/logins', ready: '.fy-page' },
  { name: 'settings-speedups', scene: 'app', path: '/d/ws/settings/voice/speedups', ready: '.fy-page' },
  { name: 'onboarding-step', scene: 'frame', path: '/?scene=stack', ready: '[data-step-page]' },
].filter(page => only.length === 0 || only.includes(page.name)) as Page[];

const VIEWPORTS = [
  { name: '1280', width: 1_280, height: 900, phone: false },
  { name: '768', width: 768, height: 900, phone: false },
  { name: '390', width: 390, height: 844, phone: true },
] as const;

describe('a keyboard focus ring is never cut by a clipping ancestor', () => {
  for (const page of PAGES)
    for (const viewport of VIEWPORTS)
      for (const scheme of ['light', 'dark'] as const)
        it(`${page.name} at ${viewport.name} ${scheme}`, async () => {
          const context = await browser.newContext({
            viewport: { width: viewport.width, height: viewport.height },
            hasTouch: viewport.phone,
            isMobile: viewport.phone,
            colorScheme: scheme,
          });
          try {
            const tab = await context.newPage();
            tab.setDefaultTimeout(30_000);
            const problems: string[] = [];
            tab.on('pageerror', error => problems.push(error.message));
            const joiner = page.path.includes('?') ? '&' : '?';
            await tab.goto(`${origins[page.scene]}${page.path}${joiner}theme=studio-${scheme}`);
            await tab.waitForSelector(page.ready, { timeout: 30_000 });
            await tab.waitForTimeout(1_200);
            const walk = await walkFocusRings(tab);
            const primary = walk.stops.flatMap(stop => (stop.primary === undefined ? [] : [stop.primary]));
            report[`${page.name}@${viewport.name}-${scheme}`] = {
              stops: walk.stops.length,
              widestReach: Math.max(0, ...walk.stops.map(stop => stop.reach)),
              violations: walk.violations,
              primaryRingContrast: primary.map(p => ({
                inside: Number(p.inside.toFixed(2)),
                outside: Number(p.outside.toFixed(2)),
                separator: p.separator,
              })),
            };
            expect(problems).toEqual([]);
            expect(walk.stops.length).toBeGreaterThan(2);
            // Every stop paints a ring (a missing one is a violation, not "nothing to clip") and the walk came all the way round.
            expect(walk.stops.filter(stop => !stop.painted).map(stop => stop.label)).toEqual([]);
            expect(['wrapped', 'left-page']).toContain(walk.ended);
            expect(walk.violations).toEqual([]);
            for (const ring of primary) {
              expect(ring.inside).toBeGreaterThanOrEqual(3);
              expect(ring.outside).toBeGreaterThanOrEqual(3);
            }
          } finally {
            await context.close();
          }
        });
});

/**
 * THE OWNER'S OWN CONTROL (review r11 S13, shot 22): Insights > Query > "Metric" select. A real Tab reaches it, and in EVERY style
 * its ring is painted, reaches 0px outside its border box, and is cut by no clipping ancestor. (Studio drew -2px; Pixel drew a 3px
 * outline at offset 0 and Gen Z a 3px outline at offset 5px plus a 5px shadow band: both outside.)
 */
/** The first label of the "Query helpers" fieldset (`analytics-custom-query.tsx`): Metric, then Aggregation. */
const METRIC = 'fieldset > label:first-of-type > select.kt-input';
describe('the Query tab Metric select keeps its focus ring inside itself in every style', () => {
  for (const viewport of VIEWPORTS.filter(v => v.name !== '768'))
    for (const scheme of ['light', 'dark'] as const)
      it(`at ${viewport.name} ${scheme}`, async () => {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          hasTouch: viewport.phone,
          isMobile: viewport.phone,
          colorScheme: scheme,
        });
        try {
          const tab = await context.newPage();
          tab.setDefaultTimeout(30_000);
          await tab.goto(`${origins.app}/d/ws/insights/query?theme=studio-${scheme}`);
          await tab.waitForSelector(`${METRIC}:not(:disabled)`, { timeout: 30_000 });
          await tab.waitForTimeout(1_200);
          const measured: Record<string, unknown> = {};
          const bad: string[] = [];
          for (const style of STYLE_IDS) {
            await tab.evaluate(id => {
              document.documentElement.dataset.style = id;
            }, style);
            const ring = await ringOf(tab, METRIC);
            if (ring === null) {
              bad.push(`${style}: Tab never reached the Metric select`);
              continue;
            }
            if (shotsDir !== '') {
              const box = await tab.locator(METRIC).boundingBox();
              if (box !== null)
                await tab.screenshot({
                  path: join(shotsDir, `metric-${style}-${viewport.name}-${scheme}.png`),
                  clip: {
                    x: Math.max(0, box.x - 24),
                    y: Math.max(0, box.y - 28),
                    width: Math.min(viewport.width, box.width + 48),
                    height: box.height + 56,
                  },
                });
            }
            measured[style] = { reach: ring.reach, painted: ring.painted, violations: ring.violations };
            if (!ring.painted) bad.push(`${style}: no ring painted`);
            if (ring.reach !== 0) bad.push(`${style}: the ring reaches ${ring.reach}px outside the select`);
            for (const line of ring.violations) bad.push(`${style}: ${line}`);
          }
          report[`metric-select@${viewport.name}-${scheme}`] = measured;
          expect(bad).toEqual([]);
        } finally {
          await context.close();
        }
      });
});

/**
 * THE PROBE CANNOT BE FOOLED (review r11 S13, item 2): a control that paints NO ring is a violation (it used to count as
 * "reach 0", i.e. clipped by nothing), and a walk ends on element IDENTITY, so a second control with the same label is still
 * visited (it used to stop on the label and never reach the clipped one behind it).
 */
describe('the focus probe itself', () => {
  const html = `<!doctype html><meta charset="utf-8"><style>
    button { outline: 2px solid #00f; outline-offset: -2px; }
    .bare { outline: none; box-shadow: none; }
    .clip { overflow: hidden; width: 200px; }
    .clip button.out { outline-offset: 4px; margin: 0; }
  </style>
  <button>Save</button><button>Save</button><button class="bare">Save</button>
  <div class="clip"><button class="out">Save</button></div>`;
  it('flags a control with no ring and visits every same-labelled control to the end of the page', async () => {
    const context = await browser.newContext({ viewport: { width: 600, height: 400 } });
    try {
      const tab = await context.newPage();
      await tab.setContent(html);
      const walk = await walkFocusRings(tab);
      // Four same-labelled buttons: all four are stops (the old label-based end stopped at the second).
      expect(walk.stops.map(stop => stop.label)).toHaveLength(4);
      expect(walk.stops.map(stop => stop.painted)).toEqual([true, true, false, true]);
      expect(walk.violations.some(line => line.includes('paints no visible focus ring'))).toBe(true);
      expect(walk.violations.some(line => line.includes('crosses'))).toBe(true);
      expect(['wrapped', 'left-page']).toContain(walk.ended);
    } finally {
      await context.close();
    }
  });
});
