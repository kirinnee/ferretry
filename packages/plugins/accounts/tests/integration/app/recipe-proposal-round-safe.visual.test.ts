/**
 * A FERRET'S RECIPE PROPOSAL ON ITS ASK CARD IS ROUND-SAFE IN EVERY STATE (G7, ledger A-31; docs/standards/theme). A real
 * browser draws the REAL card (`fixtures/recipe-proposal-scene.tsx`) through the real agenda path, from an item and an account list a
 * real accounts daemon made when a ferret proposed (no hand-written ref), at a phone (390) and a desktop
 * (1440), light and dark, in the default look (Studio) and in the two roundest looks (Gen Z, Neumorphism), and asserts the
 * geometric rule of `round-safe.ts`: no content leaves the inner rounded rectangle of the box it sits in.
 *
 *   ready        the change, the ferret's reason, Approve and Decline
 *   stale        the recipe moved on since: Decline only, and why
 *   gone         already answered or replaced
 *   unreadable   the daemon could not show it
 *   approved     Approve pressed and taken
 *   refused      Approve pressed and the daemon refused, in its own words
 *
 * Set `FY_ROUND_SAFE_SHOTS_DIR` to keep `<look>-<viewport>-<scheme>-<state>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { describeRoundMisses, roundSafeMisses, sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';
import type { AccountList } from '../../../contract/routes/index.ts';
import { proposedWorld } from '../../support/daemon/proposed-world.ts';

setDefaultTimeout(120_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_ROUND_SAFE_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  // The real daemon: a ferret proposes, and the item its ask became and the owner's account list are what the scene is shown.
  const world = await proposedWorld();
  const fixture = JSON.stringify({
    item: world.item,
    list: (await world.h.request('GET', '/v1/accounts')).json<AccountList>(),
  });
  await world.h.stop();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-round-safe-recipe-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/recipe-proposal-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the recipe proposal scene did not build (${code}):\n${stderr}\n${stdout}`);
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
      if (path === '/fixture.json') return new Response(fixture, { headers: { 'content-type': 'application/json' } });
      return new Response(page, { headers: { 'content-type': 'text/html' } });
    },
  });
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

/** Each state: what the scene is told, what must be on the page, and what to do once it has drawn. */
const STATES: readonly { name: string; query: string; waitFor: string; act?: (page: Page) => Promise<void> }[] = [
  { name: 'ready', query: 'state=ready', waitFor: '[data-recipe-proposal-approve]' },
  { name: 'stale', query: 'state=stale', waitFor: '[data-recipe-proposal-stale]' },
  { name: 'gone', query: 'state=gone', waitFor: '[data-recipe-proposal-state="gone"]' },
  { name: 'unreadable', query: 'state=unreadable', waitFor: '[data-recipe-proposal-state="unreadable"]' },
  {
    name: 'approved',
    query: 'state=approved',
    waitFor: '[data-recipe-proposal-state="done"]',
    act: async page => {
      await page.click('[data-recipe-proposal-approve]');
    },
  },
  {
    name: 'refused',
    query: 'state=refused',
    waitFor: '[data-recipe-proposal-refused]',
    act: async page => {
      await page.click('[data-recipe-proposal-approve]');
    },
  },
];

for (const look of LOOKS) {
  for (const viewport of VIEWPORTS) {
    for (const scheme of ['light', 'dark'] as const) {
      describe(`round-safe recipe proposal card: ${look.style} ${viewport.name} ${scheme}`, () => {
        for (const state of STATES) {
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
              await page.goto(`${origin}/?theme=${look.palette}-${scheme}&motion=reduced&${state.query}`);
              await page.evaluate(style => document.documentElement.setAttribute('data-style', style), look.style);
              const ready = state.act === undefined ? state.waitFor : '[data-recipe-proposal-approve]';
              await page.waitForSelector(ready);
              await page.evaluate(async () => await document.fonts.ready);
              await state.act?.(page);
              await page.waitForSelector(state.waitFor);
              await page.waitForTimeout(400);
              if (shotsDir !== '')
                await page.screenshot({
                  path: join(shotsDir, `${look.style}-${viewport.name}-${scheme}-${state.name}.png`),
                  fullPage: true,
                });
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
        }
      });
    }
  }
}
