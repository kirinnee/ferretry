/**
 * FOCUS RINGS ARE NEVER CLIPPED (r11 S13, owner/britnee F: "focus rings clipped app-wide", shot 22 on Usage analytics).
 *
 * A real browser over the REAL app (`fixtures/mobile-scene.tsx`: every shipped plugin's own app half over one fake machine) and
 * over the onboarding step frame (`fixtures/step-frame-scene.tsx`). On each page the probe (`support/browser/focus-ring.ts`)
 * presses Tab through every focusable (cap 80), scrolls it into view (`block: 'nearest'`) and measures its ring box against
 * every clipping ancestor's padding box: 0 violations. A primary button's ring also keeps >= 3:1 against what sits just
 * inside it and just outside it.
 *
 * Pages: Usage analytics (`/d/ws/insights`), New ferret, Projects, three Settings tabs, and the step frame; at 1280, 768 and
 * 390, light and dark. `FY_FOCUS_RING_ONLY=<name,name>` narrows the pages; `FY_FOCUS_RING_REPORT=<file>` writes the
 * measured numbers as JSON (the PR body quotes them).
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';
import { sceneBuilder, sceneServer, sharedChromium } from '../support/browser/index.ts';
import { walkFocusRings } from '../support/browser/focus-ring.ts';

setDefaultTimeout(90_000);

const reportPath = process.env.FY_FOCUS_RING_REPORT ?? '';
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
