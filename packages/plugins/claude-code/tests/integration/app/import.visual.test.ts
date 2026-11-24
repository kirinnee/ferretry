/**
 * THE CLAUDE IMPORT PAGES, in a real browser, over fixed fake data (no real name, path or login). The scene
 * (`fixtures/import-scene.tsx`) draws the real pages in a stand-in step frame. Each page must stay on screen, keep
 * every button a 44px target and never take the full width of a desktop, in light and dark.
 *
 * Set `FY_O7B_SHOTS_DIR` to keep a screenshot of each case.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_O7B_SHOTS_DIR ?? '';

const SCENE_CSS = `
  html, body, #root { min-height: 100%; margin: 0; }
  .scene-step { box-sizing: border-box; display: flex; flex-direction: column; gap: 16px; margin: 0 auto; max-width: 880px; min-height: 100vh; padding: 24px 16px; }
  .scene-progress { color: var(--muted); margin: 0; }
  .scene-title { margin: 0; font-size: 1.5rem; }
  .scene-body { flex: 1 1 auto; }
  .scene-footer { display: flex; gap: 12px; justify-content: flex-end; }
  .scene-footer button { min-height: 44px; padding: 12px 16px; }
`;

const VIEWPORTS = [
  { name: 'phone-390', width: 390, height: 844, phone: true },
  { name: 'desktop-1440', width: 1_440, height: 900, phone: false },
] as const;
const PAGES = [
  'settings',
  'model-set',
  'instructions',
  'skills',
  'mcp',
  'conversations',
  'run',
  'run-everything',
  'run-lost',
] as const;

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-o7b-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/import-scene.tsx'],
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

const open = async (
  context: BrowserContext,
  page: string,
  mode: 'light' | 'dark',
  options: { readonly fakeClock?: boolean; readonly extra?: string } | string = {},
): Promise<Page> => {
  const { fakeClock = false, extra = '' } = typeof options === 'string' ? { extra: options } : options;
  const tab = await context.newPage();
  // The 90 s import deadline is fast-forwarded on the page's clock, never waited for.
  if (fakeClock) await tab.clock.install();
  await tab.goto(`${server?.url.origin ?? ''}/?page=${page}&theme=studio-${mode}${extra}`);
  await tab.waitForSelector('[data-onboarding-step]');
  // Let the one-shot demos and the card animation finish: a shot shows the last frame.
  await tab.waitForTimeout(1_600);
  return tab;
};

describe('the Claude import pages', () => {
  for (const viewport of VIEWPORTS)
    for (const mode of ['light', 'dark'] as const)
      for (const page of PAGES)
        it(`${page}: inside the screen, buttons 44px, cards never full width, at ${viewport.name}, ${mode}`, async () => {
          const context = await newContext(viewport, mode);
          const tab = await open(context, page, mode);
          const scroll = await tab.evaluate(() => document.documentElement.scrollWidth);
          expect(scroll).toBeLessThanOrEqual(viewport.width);
          for (const button of await tab.locator('button').all()) {
            const box = await button.boundingBox();
            expect(box?.height).toBeGreaterThanOrEqual(44);
            expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(viewport.width);
            // A button is never the whole row on a desktop.
            if (!viewport.phone) expect(box?.width).toBeLessThan(viewport.width / 2);
          }
          for (const card of await tab.locator('.fy-cc__card').all()) {
            const box = await card.boundingBox();
            // The cards are stacked (r11 O4), so one is as wide as the page body of the stand-in (880 less its padding), never the screen.
            if (!viewport.phone) expect(box?.width).toBeLessThanOrEqual(880);
            // The text is drawn.
            expect((await card.innerText()).trim().length).toBeGreaterThan(0);
            // The radio is visually hidden (the card is the control), so it paints nothing over the text.
            expect((await card.locator('input').boundingBox())?.width ?? 0).toBeLessThanOrEqual(1);
          }
          if (shotsDir !== '')
            await tab.screenshot({ fullPage: true, path: join(shotsDir, `${page}-${viewport.name}-${mode}.png`) });
          await context.close();
        }, 60_000);

  for (const viewport of VIEWPORTS)
    for (const mode of ['light', 'dark'] as const)
      it(`run: the runtime's stored name is an id under "More", never a "Runtime name" to pick (Q8a) at ${viewport.name}, ${mode}`, async () => {
        const context = await newContext(viewport, mode);
        const tab = await open(context, 'run', mode);
        const more = tab.locator('[data-runtime-name-more]');
        expect(await more.count()).toBe(1);
        expect(await more.evaluate(element => (element as HTMLDetailsElement).open)).toBe(false);
        expect(await tab.locator('.cc-step').innerText()).not.toContain('Runtime name');
        expect(await tab.locator('[data-runtime-name]').isVisible()).toBe(false);
        if (shotsDir !== '')
          await tab.screenshot({
            fullPage: true,
            path: join(shotsDir, `run-more-closed-${viewport.name}-${mode}.png`),
          });
        await more.locator('summary').click();
        await tab.waitForTimeout(300);
        expect(await tab.locator('[data-runtime-name]').isVisible()).toBe(true);
        expect(await more.innerText()).toContain('Runtime id');
        expect(await tab.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
        if (shotsDir !== '')
          await tab.screenshot({ fullPage: true, path: join(shotsDir, `run-more-open-${viewport.name}-${mode}.png`) });
        await context.close();
      }, 60_000);

  for (const viewport of VIEWPORTS)
    for (const mode of ['light', 'dark'] as const) {
      it(`conversations: the one-way words are on screen and a pick draws no Use/Keep button at ${viewport.name}, ${mode}`, async () => {
        const context = await newContext(viewport, mode);
        const tab = await open(context, 'conversations', mode);
        expect(await tab.locator('.cc-step').innerText()).toContain(
          'One way: Ferretry reads them and never changes them. A conversation is copied only when you continue it here.',
        );
        await tab.locator('[data-choice="off"]').click();
        await tab.waitForTimeout(400);
        // Next saves the pick (r11 O4): the page itself draws no Use / Keep button, and the pick stays inside the screen.
        expect(await tab.locator('.cc-step button').count()).toBe(0);
        for (const label of ['Use: don’t show them', 'Keep showing them'])
          expect(await tab.getByRole('button', { name: label }).count()).toBe(0);
        const picked = await tab.locator('[data-choice="off"]').boundingBox();
        expect((picked?.x ?? 0) + (picked?.width ?? 0)).toBeLessThanOrEqual(viewport.width);
        if (shotsDir !== '')
          await tab.screenshot({
            fullPage: true,
            path: join(shotsDir, `conversations-pick-${viewport.name}-${mode}.png`),
          });
        await context.close();
      }, 60_000);

      it(`run: an import that never answers ends at 90 s, Try again is enabled, a late reply of the old attempt changes nothing at ${viewport.name}, ${mode}`, async () => {
        const context = await newContext(viewport, mode);
        const tab = await open(context, 'run-slow', mode, { fakeClock: true });
        const sent = async () =>
          await tab.evaluate(() =>
            (
              window as unknown as {
                __import: { sent: { route: string; signal?: AbortSignal }[] };
              }
            ).__import.sent.map(entry => ({ route: entry.route, aborted: entry.signal?.aborted === true })),
          );
        const press = tab.locator('[data-import-press]');
        await press.click();
        // O5: the page no longer says "Importing…" itself (the host footer's hold line does, and this scene's footer is a stand-in): the working bar moving is the page's own sign that it waits.
        await tab.waitForSelector('[data-import-actions]');
        await tab.waitForSelector('.cc-working[data-working="true"]');
        // Waiting: the press is disabled and the first stage POST is in flight with a live signal.
        expect(await press.isDisabled()).toBe(true);
        expect(await sent()).toEqual([{ route: 'POST /v1/runtimes/proposals', aborted: false }]);

        await tab.clock.fastForward(91_000);
        await tab.waitForSelector('[data-import-refusal]');
        const refusal = await tab.locator('[data-import-refusal]').innerText();
        expect(refusal).toContain('Claude Code import did not answer within 90 s');
        expect(await tab.getByText('Importing…').count()).toBe(0);
        expect(await tab.locator('.cc-working[data-working="true"]').count()).toBe(0);
        expect((await press.innerText()).replace(/^↓\s*/, '')).toBe('Try again');
        expect(await press.isEnabled()).toBe(true);
        // The deadline aborted the request that was waiting.
        expect(await sent()).toEqual([{ route: 'POST /v1/runtimes/proposals', aborted: true }]);

        // Try again: a fresh attempt goes out and finishes.
        await press.click();
        await tab.waitForSelector('[data-import-answer]');
        expect(await tab.locator('[data-import-answer]').innerText()).toContain('Claude Code is set up here.');

        // The OLD attempt now answers, late: nothing on the page changes and its apply is never sent.
        await tab.evaluate(() =>
          (window as unknown as { __import: { releaseFirst: () => void } }).__import.releaseFirst(),
        );
        await tab.waitForTimeout(300);
        expect(await tab.locator('[data-import-answer]').innerText()).toContain('Claude Code is set up here.');
        expect(await tab.locator('[data-import-refusal]').count()).toBe(0);
        const routes = (await sent()).map(entry => entry.route);
        expect(routes).toEqual([
          'POST /v1/runtimes/proposals',
          'POST /v1/runtimes/proposals',
          'POST /v1/runtimes/proposals/:proposalId/apply',
        ]);
        await context.close();
      }, 60_000);

      it(`run: a locked machine reads as locked, Try again asks for the unlock again, and unlocking finishes at ${viewport.name}, ${mode}`, async () => {
        const context = await newContext(viewport, mode);
        const tab = await open(context, 'run-locked', mode);
        const press = tab.locator('[data-import-press]');
        const prompts = async () =>
          await tab.evaluate(
            () => (window as unknown as { __import: { unlockPrompts: number } }).__import.unlockPrompts,
          );
        await press.click();
        await tab.waitForSelector('[data-import-refusal]');
        expect(await tab.locator('[data-import-refusal]').innerText()).toContain('This machine is locked');
        expect(await prompts()).toBe(1);
        expect(await tab.locator('[data-unlock-prompt]').count()).toBe(1);
        expect((await press.innerText()).replace(/^↓\s*/, '')).toBe('Try again');
        expect(await press.isEnabled()).toBe(true);
        // Try again is a POST, so the machine asks for the unlock again.
        await press.click();
        await tab.waitForFunction(() => document.querySelectorAll('[data-unlock-prompt]').length === 2);
        expect(await prompts()).toBe(2);
        // The person confirms: the next press goes through.
        await tab.evaluate(() => (window as unknown as { __import: { unlock: () => void } }).__import.unlock());
        await tab.locator('[data-import-press]').click();
        await tab.waitForSelector('[data-import-answer]');
        expect(await tab.locator('[data-import-refusal]').count()).toBe(0);
        await context.close();
      }, 60_000);

      it(`run: pressing Import lists each file written at ${viewport.name}, ${mode}`, async () => {
        const context = await newContext(viewport, mode);
        const tab = await open(context, 'run-everything', mode);
        await tab.getByRole('button', { name: 'Import', exact: true }).click();
        await tab.waitForSelector('[data-import-answer]');
        expect(await tab.locator('[data-import-answer]').innerText()).toContain('mcp/notes.yaml');
        expect(await tab.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
        if (shotsDir !== '')
          await tab.screenshot({ fullPage: true, path: join(shotsDir, `run-result-${viewport.name}-${mode}.png`) });
        await context.close();
      }, 60_000);
    }
});

/** A shot in a taller window (a full-page capture of a phone left the lower tiles unpainted); the window is put back after. */
const tallShot = async (tab: Page, viewport: (typeof VIEWPORTS)[number], path: string): Promise<void> => {
  await tab.setViewportSize({ width: viewport.width, height: 1_400 });
  await tab.waitForTimeout(200);
  await tab.screenshot({ path });
  await tab.setViewportSize({ width: viewport.width, height: viewport.height });
};

/** C59 O5 items 1, 8, 9 on the import page: a row for each item, nothing moves when the import starts, the Import button keeps its size. */
const measured: Record<string, unknown> = {};
describe('C59 O5: the import page lists every item, and working moves nothing', () => {
  for (const viewport of VIEWPORTS)
    for (const mode of ['light', 'dark'] as const)
      it(`run-everything: rows inside the screen; the page does not shift or resize its Import button while it works (${viewport.name}, ${mode})`, async () => {
        const context = await newContext(viewport, mode);
        const tab = await open(context, 'run-everything', mode, '&hold=1500');
        const facts = () =>
          tab.evaluate(() => {
            const box = (el: Element | null) => {
              const r = (el as HTMLElement).getBoundingClientRect();
              return { top: r.top, left: r.left, right: r.right, w: r.width, h: r.height };
            };
            const buttons = ['[data-import-run]'].map(selector => box(document.querySelector(selector)));
            return {
              rows: [...document.querySelectorAll('[data-import-item]')].map(box),
              bar: box(document.querySelector('[role="progressbar"]')),
              buttons,
              count: box(document.querySelector('[data-import-count]')),
              scrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            };
          });
        const idle = await facts();
        expect(idle.rows.length).toBeGreaterThanOrEqual(7);
        for (const row of idle.rows) {
          expect(row.left).toBeGreaterThanOrEqual(0);
          expect(row.right).toBeLessThanOrEqual(viewport.width);
          expect(row.h).toBeGreaterThanOrEqual(44);
        }
        expect(idle.scrollX).toBeLessThanOrEqual(0);
        // Open one item: its fold shows what it becomes and stays inside the screen.
        await tab.locator('[data-import-item] summary').first().click();
        const opened = await tab.locator('[data-import-item] [data-import-item-more]').first().boundingBox();
        expect((opened?.x ?? 0) + (opened?.width ?? 0)).toBeLessThanOrEqual(viewport.width);
        await tab.locator('[data-import-item] summary').first().click();
        if (shotsDir !== '') await tallShot(tab, viewport, join(shotsDir, `run-items-${viewport.name}-${mode}.png`));
        // A full-page shot moves the scroll: it is taken first, and every top is measured after a scroll back to the top.
        await tab.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
        const before = await facts();
        // Pressed from the page itself, so the browser never scrolls to the button and every top is measured from the same scroll.
        await tab.evaluate(() => {
          (document.querySelector('[data-import-run]') as HTMLButtonElement).click();
        });
        await tab.waitForSelector('[data-import-item-status="bringing"]');
        const during = await facts();
        if (shotsDir !== '') await tallShot(tab, viewport, join(shotsDir, `run-working-${viewport.name}-${mode}.png`));
        const offsets = during.rows.map((row, index) => row.top - (before.rows[index]?.top ?? 0));
        const importBefore = before.buttons[0]!;
        const importDuring = during.buttons[0]!;
        // C59 follow-up: ONE answer on the page (the flow's footer Later / Next leave the import): no second "skip" button.
        expect(await tab.locator('[data-import-skip]').count()).toBe(0);
        const row = await tab.evaluate(() => {
          const rect = (selector: string) => (document.querySelector(selector) as HTMLElement).getBoundingClientRect();
          const bar = rect('[data-import-actions]');
          return { barLeft: bar.left, barRight: bar.right };
        });
        const statusLines = await tab.locator('[data-import-item-status="bringing"]').count();
        measured[`import-${viewport.name}-${mode}`] = {
          rows: before.rows.length,
          maxRowOffset: Math.max(...offsets.map(Math.abs)),
          barOffset: during.bar.top - before.bar.top,
          buttonsOffset: importDuring.top - importBefore.top,
          importSize: { idle: [importBefore.w, importBefore.h], busy: [importDuring.w, importDuring.h] },
          statusLines,
        };
        measured[`import-${viewport.name}-${mode}`] = {
          ...(measured[`import-${viewport.name}-${mode}`] as object),
          row,
          run: [importDuring.left, importDuring.right, importDuring.w],
        };
        if (viewport.phone) {
          expect(Math.abs(importDuring.w - (row.barRight - row.barLeft))).toBeLessThanOrEqual(1);
        } else {
          expect(Math.abs(importDuring.right - row.barRight)).toBeLessThanOrEqual(1);
        }
        for (const offset of offsets) expect(Math.abs(offset)).toBeLessThanOrEqual(0.5);
        expect(Math.abs(during.bar.top - before.bar.top)).toBeLessThanOrEqual(0.5);
        expect(Math.abs(importDuring.top - importBefore.top)).toBeLessThanOrEqual(0.5);
        expect(Math.abs(importDuring.w - importBefore.w)).toBeLessThanOrEqual(0.5);
        expect(Math.abs(importDuring.h - importBefore.h)).toBeLessThanOrEqual(0.5);
        expect(statusLines).toBe(before.rows.length);
        expect(during.scrollX).toBeLessThanOrEqual(0);
        await tab.waitForSelector('[data-import-answer]');
        await context.close();
      }, 60_000);
});

afterAll(async () => {
  if (shotsDir !== '') await Bun.write(join(shotsDir, 'measured.json'), JSON.stringify(measured, null, 2));
});
