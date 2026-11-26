/**
 * EVERY SCREEN OF THE APP IS ROUND-SAFE (owner ask &B210, 2026-11-25: "for high rounded, we need to take that into consideration
 * when writing"; PR 2559 review: the matrix had to reach the whole route inventory, not three pages). The REAL `App` over every
 * shipped plugin's own app half (`fixtures/mobile-scene.tsx`, one fake machine, no daemon, no network) draws each route below at a
 * phone (390) and a desktop (1440), light and dark, in the default look (Studio) and in the two roundest looks (Gen Z: pill controls
 * and stacked colour shadows; Neumorphism: the widest radii and the most padding), and asserts the geometric rule of
 * `tests/support/browser/round-safe.ts`: no content, not even a part of it, leaves the inner rounded rectangle of the box it sits in.
 *
 * The routes: the machine's home, the standalone Settings (this device), every place the nav holds (Ferrets, Chat, Agenda, Board,
 * Projects, PRs & CI, Sharing, Lessons, Insights, Warden), the machine's own settings, and the pairing page. A route is listed in
 * `ROUTES`; what cannot be drawn here is listed in `NOT_DRAWN` with the reason, so no gap is silent. (Every settings TAB is `round-safe-settings.visual.test.ts`; "Your daemons" and its notice are
 * `daemons-round-safe.visual.test.ts`; the pair page's own states are `pair-round-safe.visual.test.ts`; the full-page machine
 * stops are `round-safe-machine-stop.visual.test.ts`.)
 *
 * `FY_ROUND_SAFE_ONLY=<route>,…` narrows the routes; `FY_ROUND_SAFE_LOOKS=genz,studio` narrows the looks;
 * `FY_ROUND_SAFE_SHOTS_DIR` keeps `<look>-<viewport>-<scheme>-<route>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';
import { describeRoundMisses, roundSafeMisses, sceneServer, sharedChromium } from '../support/browser/index.ts';

setDefaultTimeout(120_000);

const shotsDir = process.env.FY_ROUND_SAFE_SHOTS_DIR ?? '';
const only = (process.env.FY_ROUND_SAFE_ONLY ?? '').split(',').filter(Boolean);
const onlyLooks = (process.env.FY_ROUND_SAFE_LOOKS ?? '').split(',').filter(Boolean);
const scene = new URL('./fixtures/mobile-scene.tsx', import.meta.url).pathname;

let browser: Browser;
let server: ReturnType<typeof Bun.spawn> | undefined;
let origin = '';

beforeAll(async () => {
  browser = await sharedChromium();
  server = Bun.spawn([process.execPath, sceneServer, '--entry', scene], { stderr: 'inherit', stdout: 'pipe' });
  const reader = (server.stdout as ReadableStream<Uint8Array>).getReader();
  const first = await Promise.race([
    reader.read(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the scene server did not start')), 90_000)),
  ]);
  origin = (JSON.parse(new TextDecoder().decode(first.value).trim().split('\n')[0] as string) as { origin: string })
    .origin;
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 120_000);

afterAll(() => {
  server?.kill();
});

/** Every route the fake machine draws, and what proves it has drawn (not the loading line, not an error). */
export const ROUTES = [
  { name: 'daemon-home', path: '/d/ws', ready: '[data-home-tile]' },
  { name: 'this-device-settings', path: '/settings', ready: '[data-palette-chips]' },
  { name: 'ferrets', path: '/d/ws/ferrets', ready: '[data-sbar-session]' },
  { name: 'chat', path: '/d/ws/ferrets/zoe/chat', ready: '[data-composer-send]' },
  { name: 'agenda', path: '/d/ws/agenda', ready: '.fy-main' },
  { name: 'board', path: '/d/ws/board', ready: '.fy-main' },
  { name: 'projects', path: '/d/ws/projects', ready: '.fy-main' },
  { name: 'pulls', path: '/d/ws/pulls', ready: '.fy-main' },
  { name: 'sharing', path: '/d/ws/sharing', ready: '.fy-main' },
  { name: 'lessons', path: '/d/ws/lessons', ready: '.fy-main' },
  { name: 'insights', path: '/d/ws/insights', ready: '.fy-main' },
  { name: 'warden', path: '/d/ws/warden', ready: '.fy-main' },
  { name: 'machine-settings', path: '/d/ws/settings', ready: '.fy-page' },
  { name: 'pair', path: '/pair', ready: '.fy-main' },
] as const;

/**
 * What this harness cannot draw, so no gap is silent. The fake machine has no GitHub read, no CI and no first-run state; each is
 * held by another test or stated here.
 */
export const NOT_DRAWN = [
  {
    route: '/d/ws/pulls (rows), /d/ws/pulls/:project/:repo/:number, …/runs/:runId',
    why: 'the fake machine has no GitHub read: the list draws its "could not read your pull requests" card (judged); the PR rows, the PR page and the CI run page have no data to draw',
  },
  {
    route: '/d/ws/sharing/:tab (other than Subscriptions)',
    why: 'the fake machine holds no catalogs: the Subscriptions tab and its empty state are judged; the other tabs are not drawn',
  },
  {
    route: '/onboarding, /setup, /d/ws/onboarding/setup',
    why: 'they need the onboarding scene (an empty paired list, a machine that pairs): round-safe-first-run.visual.test.ts walks them',
  },
] as const;

const LOOKS = [
  { style: 'studio', palette: 'studio' },
  { style: 'genz', palette: 'vaporwave' },
  { style: 'neumorphism', palette: 'afterglow' },
].filter(look => onlyLooks.length === 0 || onlyLooks.includes(look.style));
const VIEWPORTS = [
  { name: '390', width: 390, height: 844, phone: true },
  { name: '1440', width: 1_440, height: 1_000, phone: false },
] as const;

for (const look of LOOKS) {
  for (const viewport of VIEWPORTS) {
    for (const scheme of ['light', 'dark'] as const) {
      describe(`round-safe routes: ${look.style} ${viewport.name} ${scheme}`, () => {
        for (const route of ROUTES.filter(r => only.length === 0 || only.includes(r.name))) {
          it(route.name, async () => {
            const context = await browser.newContext({
              viewport: { width: viewport.width, height: viewport.height },
              deviceScaleFactor: viewport.phone ? 2 : 1,
              hasTouch: viewport.phone,
              isMobile: viewport.phone,
              colorScheme: scheme,
              timezoneId: 'America/Los_Angeles',
              locale: 'en-US',
              reducedMotion: 'reduce',
            });
            try {
              const page = await context.newPage();
              const problems: string[] = [];
              page.on('pageerror', error => problems.push(error.message));
              const joiner = route.path.includes('?') ? '&' : '?';
              await page.goto(
                `${origin}${route.path}${joiner}theme=${look.palette}-${scheme}&style=${look.style}&palette=${look.palette}&mode=${scheme}`,
              );
              try {
                await page.waitForSelector(route.ready, { timeout: 30_000 });
              } catch (error) {
                throw new Error(`${route.path} did not draw ${route.ready}: ${String(error)}\n${problems.join('\n')}`);
              }
              await page.waitForTimeout(1_500);
              await page.evaluate(async () => await document.fonts.ready);
              expect(await page.evaluate(() => document.documentElement.getAttribute('data-style'))).toBe(look.style);
              if (shotsDir !== '')
                await page.screenshot({
                  path: join(shotsDir, `${look.style}-${viewport.name}-${scheme}-${route.name}.png`),
                  fullPage: true,
                });
              const misses = await roundSafeMisses(page);
              expect(misses, `\n${describeRoundMisses(misses)}`).toEqual([]);
            } finally {
              await context.close();
            }
          });
        }
      });
    }
  }
}
