/**
 * THE OPEN AGENDA ITEM, in a real browser (A-29): the item's own ask and EVERY task ask come before the why, the steps
 * and the impact; answering one (on the page, or by a live update) leaves the others actionable and puts the answer on
 * the History fold, counted from the asks' own state. Set `FY_G5_SHOTS_DIR` to keep `agenda-<width>-<mode>-<rounding>.png`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_G5_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-open-asks-first-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/open-asks-first-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the agenda scene did not build (${code}):\n${stderr}\n${stdout}`);
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

// Studio is the default rounding; Neumorphism has the highest radii of the shipped styles.
const ROUNDING = { default: 'studio', highest: 'neumorphism' } as const;
const SIZES = [
  { name: '390', width: 390, height: 844, scale: 2 },
  { name: '1440', width: 1_440, height: 900, scale: 1 },
] as const;

/** The open task asks on the page, by task, and the History fold's own words. */
const asksOn = (tab: Page): Promise<string[]> =>
  tab.evaluate(() =>
    [...document.querySelectorAll('[data-agenda-card-ask]')].map(
      node => node.getAttribute('data-agenda-attached-gate') ?? '',
    ),
  );
const historyOn = async (tab: Page): Promise<string> =>
  (await tab.locator('[data-agenda-fold="conversation"]').textContent()) ?? '';
/** Every control that still waits for an answer is above the why, the steps and the impact. */
const askedFirst = (tab: Page): Promise<boolean> =>
  tab.evaluate(() => {
    const top = (selector: string) => document.querySelector(selector)?.getBoundingClientRect().top ?? Number.NaN;
    const details = Math.min(top('[data-agenda-section="recommendation"]'), top('[data-agenda-section="impact"]'));
    return [...document.querySelectorAll('[data-agenda-option]')].every(
      option => option.getBoundingClientRect().top < details,
    );
  });

describe('the open agenda item', () => {
  for (const { name, width, height, scale } of SIZES)
    for (const mode of ['light', 'dark'] as const)
      for (const [rounding, style] of Object.entries(ROUNDING))
        it(`keeps every open ask first while the owner and a live update answer them (${name}, ${mode}, ${rounding} rounding)`, async () => {
          const context = await browser.newContext({
            viewport: { width, height },
            colorScheme: mode,
            deviceScaleFactor: scale,
          });
          try {
            const origin = server?.url.origin ?? '';
            await context.route('**/*', async route =>
              new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
            );
            const tab = await context.newPage();
            await tab.goto(`${origin}/?style=${style}&mode=${mode}`);
            await tab.waitForSelector('[data-agenda-card-asks]');

            // 1. The item's own ask and BOTH task asks, each with its buttons, before the why and the impact; nothing answered yet.
            expect(await asksOn(tab)).toEqual(['F12', 'F13']);
            expect(await tab.locator('[data-agenda-item-answer] [data-agenda-option]').count()).toBe(2);
            expect(await askedFirst(tab)).toBe(true);
            expect(await tab.locator('[data-agenda-fold="conversation"]').count()).toBe(0);
            if (width === 390)
              for (const button of await tab.locator('[data-agenda-card-ask] [data-agenda-option]').all())
                expect((await button.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(32);
            if (shotsDir !== '')
              await tab.screenshot({
                path: join(shotsDir, `agenda-${name}-${mode}-${rounding}-open.png`),
                fullPage: true,
              });

            // 2. Answer the item's OWN choice while both task asks are open: its row is gone, both task asks stay.
            await tab.locator('[data-agenda-item-answer] [data-agenda-option="Blue"]').click();
            await tab.waitForFunction(() => document.querySelector('[data-agenda-item-answer]') === null);
            expect(await asksOn(tab)).toEqual(['F12', 'F13']);
            expect(await tab.locator('[data-agenda-option="Blue"]').count()).toBe(0);
            expect(await historyOn(tab)).toBe('History1 answered');
            expect(await askedFirst(tab)).toBe(true);

            // 3. Answer the first task ask on the page: only the second is left, and History counts two.
            await tab.locator('[data-agenda-attached-gate="F12"] [data-agenda-option="Done"]').click();
            await tab.waitForFunction(() => document.querySelectorAll('[data-agenda-card-ask]').length === 1);
            expect(await asksOn(tab)).toEqual(['F13']);
            expect(await historyOn(tab)).toBe('History2 answered');

            // 4. A LIVE update answers the last one from another device: no ask is left, History counts three, and
            //    its rows say each answer as the item records it.
            await tab.evaluate("window.__agenda.answerTask('F13', 'Not good')");
            await tab.waitForFunction(() => document.querySelector('[data-agenda-card-asks]') === null);
            expect(await historyOn(tab)).toBe('History3 answered');
            await tab.locator('[data-agenda-fold="conversation"]').click();
            const rows = await tab.locator('[data-agenda-answered-ask]').allTextContents();
            expect(rows).toHaveLength(3);
            expect(rows.join('|')).toContain('Chose “Blue”');
            expect(rows.join('|')).toContain('task &F12 · Chose “Done”');
            expect(rows.join('|')).toContain('task &F13 · Chose “Not good”');
            // Nothing runs off the page sideways.
            expect(await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
            if (shotsDir !== '')
              await tab.screenshot({ path: join(shotsDir, `agenda-${name}-${mode}-${rounding}.png`), fullPage: true });
          } finally {
            await context.close();
          }
        }, 60_000);
});
