/**
 * F-120/F-121 in a real browser: the project page lists the branches and worktrees of its repositories and offers to
 * adopt a stray checkout. The REAL detail page over a scripted daemon (fake names, no network), at 390 and 1440, light and
 * dark, in the default look (Studio) and in the two roundest looks (Gen Z, Neumorphism), asserting the round-safe rule and
 * no sideways scroll in each state.
 *
 *   list      two repositories held: both repositories' branches, one offer for the stray checkout
 *   adopted   the offer pressed: the checkout reads as adopted and the offer is gone
 *   failed    one repository could not be read: said beside its name, the other still listed
 *   none      no repository held: said, with nothing to list
 *
 * Set `FY_PROJECT_WORKTREES_SHOTS_DIR` to keep `<look>-<viewport>-<scheme>-<state>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { describeRoundMisses, roundSafeMisses, sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(120_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_PROJECT_WORKTREES_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-project-worktrees-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/project-worktrees-scene.tsx'],
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
    port: Number(process.env.FY_PROJECT_WORKTREES_TEST_PORT ?? '7497'),
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

const LOOKS = [
  { style: 'studio', palette: 'studio' },
  { style: 'genz', palette: 'vaporwave' },
  { style: 'neumorphism', palette: 'afterglow' },
] as const;
const VIEWPORTS = [
  { name: '390', width: 390, height: 844, phone: true },
  { name: '1440', width: 1_440, height: 900, phone: false },
] as const;
const STRAY = '/home/fake/old-docs-checkout';

const STATES: readonly {
  name: string;
  query: string;
  act?: (page: Page) => Promise<void>;
  waitFor: string;
  check: (page: Page) => Promise<void>;
}[] = [
  {
    name: 'list',
    query: 'repos=2',
    waitFor: '[data-project-worktree-state="ready"] >> nth=1',
    check: async page => {
      expect(await page.locator('[data-project-worktree]').count(), 'both repositories’ worktrees').toBe(4);
      expect(await page.locator('[data-project-worktree-offer]').count(), 'one offer, for the stray checkout').toBe(1);
      expect(await page.locator(`[data-project-worktree-offer="${STRAY}"]`).count()).toBe(1);
    },
  },
  {
    name: 'adopted',
    query: 'repos=2',
    act: async page => {
      await page.waitForSelector('[data-project-worktree-adopt]');
      await page.click('[data-project-worktree-adopt]');
    },
    waitFor: `[data-project-worktree="${STRAY}"][data-project-worktree-tracked="adopted"]`,
    check: async page => {
      expect(await page.locator('[data-project-worktree-offer]').count(), 'the offer is gone').toBe(0);
    },
  },
  {
    name: 'failed',
    query: 'repos=2&worktrees=failed',
    waitFor: '[data-project-worktree-state="failed"]',
    check: async page => {
      expect(await page.locator('[data-project-worktree-state="failed"]').innerText()).toContain(
        'not a git common directory',
      );
      expect(await page.locator('[data-project-worktree="/work/trees/site-nav"]').count()).toBe(1);
    },
  },
  { name: 'none', query: 'repos=0', waitFor: '[data-project-worktrees="none"]', check: async () => undefined },
];

for (const look of LOOKS)
  for (const viewport of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const)
      describe(`project worktrees: ${look.style} ${viewport.name} ${scheme}`, () => {
        for (const state of STATES)
          it(state.name, async () => {
            const context = await browser.newContext({
              viewport: { width: viewport.width, height: viewport.height },
              deviceScaleFactor: viewport.phone ? 2 : 1,
              hasTouch: viewport.phone,
              isMobile: viewport.phone,
              colorScheme: scheme,
              reducedMotion: 'reduce',
            });
            try {
              const origin = server?.url.origin ?? '';
              await context.route('**/*', async route =>
                new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
              );
              const page = await context.newPage();
              await page.goto(`${origin}/?theme=${look.palette}-${scheme}&${state.query}`);
              await page.evaluate(style => document.documentElement.setAttribute('data-style', style), look.style);
              await page.waitForSelector('[data-project-worktrees]');
              await page.evaluate(async () => await document.fonts.ready);
              await state.act?.(page);
              await page.waitForSelector(state.waitFor);
              await page.waitForTimeout(400);
              await page.locator('[data-project-worktrees]').scrollIntoViewIfNeeded();
              if (shotsDir !== '') {
                await page.screenshot({
                  path: join(shotsDir, `${look.style}-${viewport.name}-${scheme}-${state.name}.png`),
                  fullPage: true,
                });
                await page.locator('[data-project-worktrees]').screenshot({
                  path: join(shotsDir, `${look.style}-${viewport.name}-${scheme}-${state.name}-panel.png`),
                });
              }
              await state.check(page);
              const misses = await roundSafeMisses(page);
              expect(misses, `\n${describeRoundMisses(misses)}`).toEqual([]);
              const overflow = await page.evaluate(
                () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
              );
              expect(overflow, 'the page never scrolls sideways').toBeLessThanOrEqual(0);
            } finally {
              await context.close();
            }
          });
      });
