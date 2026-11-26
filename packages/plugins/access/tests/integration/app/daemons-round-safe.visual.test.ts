/**
 * "YOUR DAEMONS" IS ROUND-SAFE AND CENTRED (owner asks &B210 and &B211, 2026-11-25). A real browser draws the REAL daemons
 * page (`fixtures/daemons-scene.tsx`, fake data) in every state it has (plain, with Back, with the device-refused notice,
 * both) at a phone (390) and a desktop (1440), light and dark, in the default look (Studio) and in every look that rounds
 * its controls into a pill or its panels past 16px (Gen Z, Neumorphism, Glass, Lucid, Briefing), and asserts:
 *
 *  1. ROUND-SAFE: no content (a line of text, an icon, a button) leaves the inner rounded rectangle of the box it sits in
 *     (`round-safe.ts`: geometry, not a look). The rule itself is the theme's (`styles/tokens/base-style.css`, "ROUND-SAFE
 *     GEOMETRY"); this is what makes it stay true for a surface somebody writes next.
 *  2. CENTRED: the ferret's centre is the page column's centre within 2 px, in every state (&B211).
 *
 * Set `FY_ROUND_SAFE_SHOTS_DIR` to keep `<look>-<viewport>-<scheme>-<state>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { describeRoundMisses, roundSafeMisses, sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(120_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_ROUND_SAFE_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-round-safe-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/daemons-scene.tsx'],
    {
      cwd: packageRoot,
      stderr: 'pipe',
      stdout: 'pipe',
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the daemons scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>html,body,#root{height:100%}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      const path = new URL(request.url).pathname;
      if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
      return new Response(page, { headers: { 'content-type': 'text/html' } });
    },
  });
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

/** `palette` is the look's own default palette, so each look is drawn as its picker would draw it. */
const LOOKS = [
  { style: 'studio', palette: 'studio' },
  { style: 'genz', palette: 'vaporwave' },
  { style: 'neumorphism', palette: 'afterglow' },
  { style: 'glass', palette: 'aurora' },
  { style: 'lucid', palette: 'mesh' },
  { style: 'briefing', palette: 'briefing' },
] as const;
const VIEWPORTS = [
  { name: '390', width: 390, height: 844, phone: true },
  { name: '1440', width: 1_440, height: 900, phone: false },
] as const;
const STATES = [
  { name: 'plain', query: '' },
  { name: 'back', query: '&back=1' },
  { name: 'refused', query: '&refused=1' },
  { name: 'back-refused', query: '&back=1&refused=1' },
] as const;

/** The ferret's centre and the column's centre, in px: the hero's box and the page's reading column (its content box). */
const centres = async (tab: Page): Promise<{ ferret: number; column: number }> =>
  await tab.evaluate(() => {
    const hero = document.querySelector('.fy-pair-hero') as HTMLElement;
    const main = document.querySelector('main') as HTMLElement;
    const h = hero.getBoundingClientRect();
    const m = main.getBoundingClientRect();
    const style = getComputedStyle(main);
    const left = m.left + Number.parseFloat(style.paddingLeft);
    const right = m.right - Number.parseFloat(style.paddingRight);
    return { ferret: (h.left + h.right) / 2, column: (left + right) / 2 };
  });

for (const look of LOOKS) {
  for (const viewport of VIEWPORTS) {
    for (const scheme of ['light', 'dark'] as const) {
      describe(`${look.style} ${viewport.name} ${scheme}`, () => {
        let close = async (): Promise<void> => {};
        const tabs = new Map<string, Page>();
        beforeAll(async () => {
          const context = await browser.newContext({
            viewport: { width: viewport.width, height: viewport.height },
            deviceScaleFactor: viewport.phone ? 2 : 1,
            hasTouch: viewport.phone,
            isMobile: viewport.phone,
            colorScheme: scheme,
            reducedMotion: 'reduce',
          });
          const origin = server?.url.origin ?? '';
          await context.route('**/*', async route =>
            new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
          );
          close = async () => await context.close();
          for (const state of STATES) {
            const tab = await context.newPage();
            await tab.goto(
              `${origin}/?theme=${look.palette}-${scheme}&style=${look.style}&motion=reduced${state.query}`,
            );
            await tab.waitForSelector('[data-scene-ready] [data-pairing-stage]');
            await tab.evaluate(async () => await document.fonts.ready);
            tabs.set(state.name, tab);
            if (shotsDir !== '')
              await tab.screenshot({
                path: join(shotsDir, `${look.style}-${viewport.name}-${scheme}-${state.name}.png`),
                fullPage: true,
              });
          }
        });
        afterAll(async () => await close());

        for (const state of STATES) {
          it(`${state.name}: no content leaves the inner rounded rectangle of its box`, async () => {
            const misses = await roundSafeMisses(tabs.get(state.name) as Page);
            expect(misses, `\n${describeRoundMisses(misses)}`).toEqual([]);
          });
          // The gate itself is judged against the owner's bug: a button that pokes 4px out of the banner near its bottom-left corner
          // (the banner's "Pair again" moved 18px left and 8px down). A gate that skipped partly-protruding content stayed green here.
          if (state.name.endsWith('refused') && look.style === 'genz' && scheme === 'light')
            it(`${state.name}: the gate turns RED when "Pair again" is moved 18px left and 8px down`, async () => {
              const tab = tabs.get(state.name) as Page;
              expect(await roundSafeMisses(tab), 'the unmoved banner is round-safe').toEqual([]);
              await tab.evaluate(() => {
                const button = document.querySelector('[data-device-refused-pair]') as HTMLElement;
                button.style.transform = 'translate(-18px, 8px)';
              });
              try {
                const misses = await roundSafeMisses(tab);
                expect(misses.length, 'a button poking out of its banner is a miss').toBeGreaterThan(0);
                expect(misses.some(m => m.leaf.includes('Pair again'))).toBe(true);
              } finally {
                await tab.evaluate(() => {
                  (document.querySelector('[data-device-refused-pair]') as HTMLElement).style.transform = '';
                });
              }
            });
          // `overflow` clips a box's CONTENTS, never the box's own edge: the same move on a button that clips its own children is
          // the same painted protrusion, and must stay red.
          if (state.name.endsWith('refused') && look.style === 'genz' && scheme === 'light')
            it(`${state.name}: the gate stays RED when the moved "Pair again" also has overflow:hidden`, async () => {
              const tab = tabs.get(state.name) as Page;
              await tab.evaluate(() => {
                const button = document.querySelector('[data-device-refused-pair]') as HTMLElement;
                button.style.overflow = 'hidden';
                button.style.transform = 'translate(-18px, 8px)';
              });
              try {
                const misses = await roundSafeMisses(tab);
                expect(misses.some(m => m.leaf.includes('Pair again'))).toBe(true);
              } finally {
                await tab.evaluate(() => {
                  const button = document.querySelector('[data-device-refused-pair]') as HTMLElement;
                  button.style.overflow = '';
                  button.style.transform = '';
                });
              }
            });
          it(`${state.name}: the ferret is centred over the column, within 2 px`, async () => {
            const { ferret, column } = await centres(tabs.get(state.name) as Page);
            expect(Math.abs(ferret - column), `ferret ${ferret}, column ${column}`).toBeLessThanOrEqual(2);
          });
        }
      });
    }
  }
}
