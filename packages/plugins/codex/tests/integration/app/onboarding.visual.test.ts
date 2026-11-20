/**
 * THE CODEX SEGMENT'S FIRST-RUN PAGES, in a real browser, over fixed fake data (no real name, path or login). The scene
 * (`fixtures/onboarding-scene.tsx`) draws the real pages inside the app's `StepPageFrame`. Each page must stay on screen,
 * keep every button a 44px target and never take the full width of a desktop, in light and dark.
 *
 * Set `FY_O10_SHOTS_DIR` to keep a screenshot of each case.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';
import { expectDemo, expectKitFrame, factsOf, SAME_AS_CLAUDE } from './fixtures/parity.ts';

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_O10_SHOTS_DIR ?? '';

const SCENE_CSS = 'html, body, #root { min-height: 100%; margin: 0; }';

const VIEWPORTS = [
  { name: 'phone-390', width: 390, height: 844, phone: true },
  { name: 'desktop-1280', width: 1_280, height: 800, phone: false },
  { name: 'tablet-768', width: 768, height: 1_024, phone: false },
] as const;
const PAGES = [
  'installed',
  'sign-in',
  'sign-in-checking',
  'import-choice',
  'permission',
  'permission-confirm',
  'permission-unknown',
] as const;

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-o10-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/onboarding-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the onboarding scene did not build (${code}):\n${stderr}\n${stdout}`);
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
  // The confirm shot is the Auto file after the person pressed the Skip card: the warning and its confirm, nothing written.
  if (page === 'permission-confirm') await tab.locator('input[value="skip"]').check({ force: true });
  // Let the card animation and the demo (about 1.5 s) finish: a shot shows the last frame.
  await tab.waitForTimeout((await tab.locator('[data-demo]').count()) > 0 ? 1_700 : 800);
  return tab;
};

describe('the Codex segment pages', () => {
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
          // Nothing inside the page body runs past the screen edge (a long flag or command wraps).
          for (const node of await tab.locator('[data-codex-step] *').all()) {
            const box = await node.boundingBox();
            if (box !== null) expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
          }
          if (shotsDir !== '')
            await tab.screenshot({ fullPage: true, path: join(shotsDir, `${page}-${viewport.name}-${mode}.png`) });
          await context.close();
        }, 60_000);

  it('permission: the current value is the selected card, and the real flag is named', async () => {
    const context = await newContext(VIEWPORTS[1], 'light');
    const tab = await open(context, 'permission', 'light');
    expect(await tab.locator('input[value="skip"]').isChecked()).toBe(true);
    expect(await tab.locator('[data-codex-step]').innerText()).toContain('--dangerously-bypass-approvals-and-sandbox');
    await tab.locator('input[value="auto"]').click({ force: true });
    await tab.waitForTimeout(400);
    if (shotsDir !== '')
      await tab.screenshot({ fullPage: true, path: join(shotsDir, 'permission-auto-desktop-1280-light.png') });
    await context.close();
  }, 60_000);

  // ── The same page as Claude Code's, measured in the browser (the gate found Codex without the demo box and with other buttons) ──
  for (const mode of ['light', 'dark'] as const)
    for (const viewport of VIEWPORTS) {
      it(`installed: the kit's frame, the demo box and Claude Code's button set, at ${viewport.name}, ${mode}`, async () => {
        const context = await newContext(viewport, mode);
        const tab = await open(context, 'installed', mode);
        const facts = await factsOf(tab);
        expectKitFrame(facts, 'installed');
        expectDemo(facts, SAME_AS_CLAUDE.installed.demo, 'installed');
        expect(facts.buttons).toEqual([...SAME_AS_CLAUDE.installed.buttons]);
        await context.close();
      }, 60_000);

      it(`import-choice: the kit's frame, an intro line and three cards, at ${viewport.name}, ${mode}`, async () => {
        const context = await newContext(viewport, mode);
        const tab = await open(context, 'import-choice', mode);
        const facts = await factsOf(tab);
        expectKitFrame(facts, 'import-choice');
        expect(facts.lines).toBeGreaterThanOrEqual(SAME_AS_CLAUDE.importChoice.minLines);
        expect(facts.cards).toBe(SAME_AS_CLAUDE.importChoice.cards);
        expect(await tab.locator('[data-codex-step] .ob-step__line').first().innerText()).toContain(
          'Hooks are never imported.',
        );
        expect(facts.demo, 'import-choice has no demo, as on Claude Code').toBeNull();
        await context.close();
      }, 60_000);

      it(`permission: the demo follows the pick, and a pick shows "Use …" and "Keep …" like Claude Code, at ${viewport.name}, ${mode}`, async () => {
        const context = await newContext(viewport, mode);
        const tab = await open(context, 'permission', mode);
        let facts = await factsOf(tab);
        expectKitFrame(facts, 'permission');
        expect(facts.cards).toBe(SAME_AS_CLAUDE.permission.cards);
        expectDemo(facts, SAME_AS_CLAUDE.permission.demo, 'permission');
        expect(facts.buttons, 'no button before a pick').toEqual([]);
        await tab.locator('input[value="auto"]').check({ force: true });
        await tab.waitForSelector('[data-permission-confirm]');
        facts = await factsOf(tab);
        expectDemo(facts, SAME_AS_CLAUDE.permissionPick.demo, 'permission (picked)');
        expect(facts.buttons).toEqual([...SAME_AS_CLAUDE.permissionPick.buttons]);
        expectKitFrame(facts, 'permission (picked)');
        await tab.waitForTimeout(1_700);
        if (shotsDir !== '')
          await tab.screenshot({
            fullPage: true,
            path: join(shotsDir, `permission-picked-${viewport.name}-${mode}.png`),
          });
        await context.close();
      }, 60_000);
    }
});
