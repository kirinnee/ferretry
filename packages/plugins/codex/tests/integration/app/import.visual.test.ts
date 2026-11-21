/**
 * THE CODEX IMPORT PAGES, in a real browser, over fixed fake data (no real name, path or login). The scene
 * (`fixtures/import-scene.tsx`) draws the real pages inside the app's `StepPageFrame`. Each page must stay on screen, keep every
 * button a 44px target and never take the full width of a desktop, in light and dark.
 *
 * r11 O5 (the kind pages, owner line 3): the five "choose what to import" pages keep their found-list and are laid out like
 * every other page: the demo in `[data-step-demo]` to the RIGHT of the page's words and list at 1280 (above them, at most 140 px
 * tall, at 390), the page's own words (the list left out) at most 160 characters, and the list's checkboxes still there. On
 * every Codex import page, both widths, light and dark: the whole screen never says "Claude".
 *
 * Set `FY_O10B_SHOTS_DIR` to keep a screenshot of each case.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';
import { expectKitFrame, factsOf, SAME_AS_CLAUDE } from './fixtures/parity.ts';

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_O10B_SHOTS_DIR ?? '';

const SCENE_CSS = 'html, body, #root { min-height: 100%; margin: 0; }';

const VIEWPORTS = [
  { name: 'phone-390', width: 390, height: 844, phone: true },
  { name: 'desktop-1280', width: 1_280, height: 800, phone: false },
  { name: 'tablet-768', width: 768, height: 1_024, phone: false },
] as const;
const PAGES = [
  'settings',
  'model-set',
  'instructions',
  'skills',
  'mcp',
  'conversations',
  'run',
  'run-done',
  'run-everything',
  'run-unreviewed',
] as const;

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-o10b-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/import-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the import scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  return { css: await readFile(manifest.css, 'utf8'), js: await readFile(manifest.js, 'utf8') };
};

beforeAll(async () => {
  const { css, js } = await build();
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>${SCENE_CSS}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      const path = new URL(request.url).pathname;
      if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
      if (path === '/') return new Response(html, { headers: { 'content-type': 'text/html' } });
      return new Response('not here', { status: 404 });
    },
  });
  browser = await sharedChromium();
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const newContext = async (viewport: (typeof VIEWPORTS)[number], mode: 'light' | 'dark'): Promise<BrowserContext> => {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme: mode,
    deviceScaleFactor: viewport.phone ? 2 : 1,
    ...(viewport.phone ? { isMobile: true, hasTouch: true } : {}),
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  return context;
};

const open = async (context: BrowserContext, page: string, mode: 'light' | 'dark'): Promise<Page> => {
  const tab = await context.newPage();
  await tab.goto(`${server?.url.origin ?? ''}/?page=${page}&theme=studio-${mode}`);
  await tab.waitForSelector('[data-codex-step]');
  // The done shot is the run page after the one import.
  if (page === 'run-done') {
    await tab.waitForSelector('[data-import-run]');
    await tab.locator('[data-import-run]').click();
    await tab.waitForSelector('[data-import-done]');
  }
  // Let the card animation and the scan read finish: a shot shows the last frame.
  await tab.waitForTimeout(800);
  return tab;
};

describe('the Codex import pages', () => {
  for (const viewport of VIEWPORTS)
    for (const mode of ['light', 'dark'] as const)
      for (const page of PAGES)
        it(`${page}: inside the screen, buttons 44px, never full width, at ${viewport.name}, ${mode}`, async () => {
          const context = await newContext(viewport, mode);
          const tab = await open(context, page, mode);
          expect(await tab.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
          for (const button of await tab.locator('[data-step-footer] button, [data-codex-step] button').all()) {
            const box = await button.boundingBox();
            expect(box?.height).toBeGreaterThanOrEqual(44);
            expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(viewport.width);
            if (!viewport.phone) expect(box?.width).toBeLessThan(viewport.width / 2);
          }
          // Nothing inside the page body runs past the screen edge (a long name or sentence wraps).
          for (const node of await tab.locator('[data-codex-step] *').all()) {
            const box = await node.boundingBox();
            if (box !== null) expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
          }
          if (shotsDir !== '')
            await tab.screenshot({ fullPage: true, path: join(shotsDir, `${page}-${viewport.name}-${mode}.png`) });
          await context.close();
        }, 60_000);

  // ── The run and kind pages keep the import kit's frame, measured in the browser (the conversations page is proved in onboarding.visual.test.ts) ──
  for (const mode of ['light', 'dark'] as const)
    for (const viewport of VIEWPORTS) {
      const at = `at ${viewport.name}, ${mode}`;
      it(`run: the count, what Next does, the kit's name field, and Import + Skip the import like Claude Code, ${at}`, async () => {
        const context = await newContext(viewport, mode);
        const tab = await open(context, 'run', mode);
        const facts = await factsOf(tab);
        expectKitFrame(facts, 'run');
        expect(facts.buttons).toEqual([...SAME_AS_CLAUDE.importRun.buttons]);
        expect(facts.field, 'the runtime name is the kit field').toBe(true);
        expect(await tab.locator('[data-import-count]').innerText()).toMatch(
          /^Bringing \d+ items?(, leaving out \d+)?\. Hooks are never imported\.$/u,
        );
        expect(await tab.locator('[data-import-next]').innerText()).toContain('Next leaves the import for later');
        await context.close();
      }, 60_000);

      it(`a kind page: the kit's frame and its checklist, ${at}`, async () => {
        const context = await newContext(viewport, mode);
        const tab = await open(context, 'settings', mode);
        const facts = await factsOf(tab);
        expectKitFrame(facts, 'settings');
        expect(await tab.locator('[data-codex-step] input[type="checkbox"]').count()).toBeGreaterThan(0);
        await context.close();
      }, 60_000);
    }

  // ── r11 O5: the kind pages' layout and the no-Claude rule, on every Codex import page ──
  const KIND_PAGES: readonly string[] = ['settings', 'model-set', 'instructions', 'skills', 'mcp'];
  for (const viewport of VIEWPORTS.filter(candidate => candidate.name !== 'tablet-768'))
    for (const mode of ['light', 'dark'] as const)
      for (const page of PAGES) {
        it(`${page}: no Claude anywhere${KIND_PAGES.includes(page) ? ', the demo beside the found-list' : ''}, at ${viewport.name}, ${mode}`, async () => {
          const context = await newContext(viewport, mode);
          const tab = await open(context, page, mode);
          const m = await tab.evaluate(() => {
            const box = (node: Element | null) => {
              const r = node?.getBoundingClientRect() ?? new DOMRect();
              return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
            };
            const body = document.querySelector('[data-codex-step]') as HTMLElement;
            const list = body.querySelector<HTMLElement>('[data-found-list]');
            const words = body.innerText
              .replace(list?.innerText ?? '', '')
              .replace(/\s+/gu, ' ')
              .trim();
            return {
              screen: document.body.innerText,
              body: box(body),
              list: list === null ? null : box(list),
              demo: box(document.querySelector('[data-step-demo]')),
              demoKind: document.querySelector('[data-step-demo] [data-demo]')?.getAttribute('data-demo') ?? '',
              words,
              checkboxes: body.querySelectorAll('input[type="checkbox"]').length,
              overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
            };
          });
          expect(m.screen.toLowerCase(), 'the page never names Claude').not.toContain('claude');
          expect(m.overflowX).toBe(false);
          if (KIND_PAGES.includes(page)) {
            // The list is kept: rows to tick, drawn inside the page body.
            expect(m.list, 'the found-list is still on the page').not.toBeNull();
            expect(m.checkboxes).toBeGreaterThan(0);
            // The demo is this kind's own, in the frame's demo column.
            expect(m.demoKind).toBe(`kind-${page}`);
            expect(m.words.length, m.words).toBeLessThanOrEqual(160);
            if (viewport.phone) {
              expect(m.demo.bottom, 'the demo is above the page').toBeLessThanOrEqual(m.body.y + 1);
              expect(m.demo.h).toBeLessThanOrEqual(140);
            } else {
              expect(m.demo.x, 'the demo is right of the page').toBeGreaterThan(m.body.right - 1);
              expect(Math.abs(m.demo.y - m.body.y), 'the demo starts level with the page').toBeLessThanOrEqual(8);
              // The list keeps a real width beside the demo (it is not squeezed to a sliver).
              expect(m.list?.w ?? 0).toBeGreaterThan(280);
            }
          }
          await context.close();
        }, 60_000);
      }
});
