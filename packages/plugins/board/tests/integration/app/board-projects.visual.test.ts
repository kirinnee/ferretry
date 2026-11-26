/**
 * THE BOARD BY PROJECT, in a real browser (W-89): every project is a named, countable, foldable row of lanes with ONE
 * plain control, and a line under the view tabs says what the view is. Set `FY_G5_SHOTS_DIR` to keep
 * `board-<width>-<mode>-<rounding>.png`.
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
  directory = await mkdtemp(join(tmpdir(), 'ferretry-board-projects-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/board-projects-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the board scene did not build (${code}):\n${stderr}\n${stdout}`);
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

/** Each project section as the owner reads it: its name and the count beside it. */
const readProjects = (tab: Page): Promise<Record<string, string>> =>
  tab.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll('.fy-board-project')].map(section => [
        section.querySelector('.fy-board-project__name')?.textContent ?? '',
        section.querySelector('.fy-board-project__count')?.textContent ?? '',
      ]),
    ),
  );
const waitForProjects = async (tab: Page, expected: Record<string, string>): Promise<void> => {
  await tab
    .waitForFunction(
      want =>
        JSON.stringify(
          Object.fromEntries(
            [...document.querySelectorAll('.fy-board-project')]
              .map(
                section =>
                  [
                    section.querySelector('.fy-board-project__name')?.textContent ?? '',
                    section.querySelector('.fy-board-project__count')?.textContent ?? '',
                  ] as const,
              )
              .toSorted(([a], [b]) => a.localeCompare(b)),
          ),
        ) === JSON.stringify(want),
      Object.fromEntries(Object.entries(expected).toSorted(([a], [b]) => a.localeCompare(b))),
      { timeout: 10_000 },
    )
    .catch(async () => {
      throw new Error(`projects were ${JSON.stringify(await readProjects(tab))}, not ${JSON.stringify(expected)}`);
    });
};
const live = (tab: Page, call: string): Promise<unknown> => tab.evaluate(`window.__board.${call}`);

describe('the board by project', () => {
  for (const { name, width, height, scale } of SIZES)
    for (const mode of ['light', 'dark'] as const)
      for (const [rounding, style] of Object.entries(ROUNDING))
        it(`folds, narrows and widens by project, and a live update moves the counts (${name}, ${mode}, ${rounding} rounding)`, async () => {
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
            // Exact counts per project, Unfiled included (the Closed lane is not a task the owner sees).
            await waitForProjects(tab, { ferretry: '4 tasks', 'docs-site': '2 tasks', Unfiled: '1 task' });
            expect(await tab.locator('[data-project-focus="only"]').count()).toBe(3);
            expect(await tab.locator('[data-board-hint="kanban"]').count()).toBe(1);
            // Nothing runs off the page sideways, and every control is a big-enough target.
            expect(await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
            for (const control of await tab.locator('.fy-board-project__toggle, .fy-board-project__focus').all())
              expect((await control.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(28);
            if (width === 390) {
              // No view tab is cut off at the strip's edge, and a project's lane panel leaves no tall empty gap.
              const cut = await tab.evaluate(() => {
                const strip = document.querySelector('.fy-board__views')?.getBoundingClientRect();
                return [...document.querySelectorAll('.fy-board__view')].filter(
                  each => strip === undefined || each.getBoundingClientRect().right > strip.right + 0.5,
                ).length;
              });
              expect(cut).toBe(0);
              const panel = await tab.locator('.fy-board-phone__panel').first().boundingBox();
              expect(panel?.height ?? Number.POSITIVE_INFINITY).toBeLessThan(200);
            }
            if (shotsDir !== '')
              await tab.screenshot({ path: join(shotsDir, `board-${name}-${mode}-${rounding}.png`) });

            // FOLD / UNFOLD: only that project's lanes go, and they come back.
            const ferretry = tab.locator('.fy-board-project', { hasText: 'ferretry' });
            const lanes = ferretry.locator('.fy-board-lane, .fy-board-phone-lane, [data-task]');
            expect(await lanes.count()).toBeGreaterThan(0);
            await ferretry.locator('.fy-board-project__toggle').click();
            expect(await ferretry.locator('.fy-board-project__toggle').getAttribute('aria-expanded')).toBe('false');
            expect(await lanes.count()).toBe(0);
            expect(
              await tab.locator('.fy-board-project', { hasText: 'docs-site' }).locator('[data-task]').count(),
            ).toBeGreaterThan(0);
            await ferretry.locator('.fy-board-project__toggle').click();
            expect(await ferretry.locator('.fy-board-project__toggle').getAttribute('aria-expanded')).toBe('true');
            expect(await ferretry.locator('[data-task]').count()).toBeGreaterThan(0);

            // A LIVE UPDATE closes a task: the count follows, nothing else moves.
            await live(tab, "move('F4', 'closed')");
            await live(tab, 'tick()');
            await waitForProjects(tab, { ferretry: '3 tasks', 'docs-site': '2 tasks', Unfiled: '1 task' });
            await live(tab, "move('F4', 'implement')");
            await live(tab, 'tick()');
            await waitForProjects(tab, { ferretry: '4 tasks', 'docs-site': '2 tasks', Unfiled: '1 task' });

            // "Only this project" narrows to Unfiled (and says so in the URL), "All projects" is its one control.
            await tab
              .locator('.fy-board-project', { hasText: 'Unfiled' })
              .locator('[data-project-focus="only"]')
              .click();
            await waitForProjects(tab, { Unfiled: '1 task' });
            expect(await tab.evaluate(() => window.location.search)).toContain('project=');
            expect(await tab.locator('[data-project-focus="only"]').count()).toBe(0);
            expect(await tab.locator('[data-project-focus="all"]').count()).toBe(1);
            if (shotsDir !== '')
              await tab.screenshot({ path: join(shotsDir, `board-${name}-${mode}-${rounding}-only.png`) });

            // ITS LAST CARD LEAVES: the project stays named, with the way back.
            await live(tab, "remove('F10')");
            await live(tab, 'tick()');
            await waitForProjects(tab, { Unfiled: '0 tasks' });
            expect(await tab.locator('[data-project-focus="all"]').count()).toBe(1);
            expect(await tab.locator('.fy-board').textContent()).not.toContain('No project has a board yet');
            await tab.locator('[data-project-focus="all"]').click();
            // All projects: the others' cards are all still there, Unfiled has nothing left to show.
            await waitForProjects(tab, { ferretry: '4 tasks', 'docs-site': '2 tasks' });
            expect(await tab.evaluate(() => window.location.search)).not.toContain('project=');
            expect(await tab.locator('[data-project-focus="all"]').count()).toBe(0);
            expect(
              await tab.locator('.fy-board-project', { hasText: 'docs-site' }).locator('[data-task]').count(),
            ).toBeGreaterThan(0);
            expect(await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
          } finally {
            await context.close();
          }
        }, 90_000);
});
