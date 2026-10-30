/**
 * THE SESSIONS LIST, in a real browser: stopped sessions hidden until ticked, the All · Agents ·
 * Interactive segment with its live counts, the learning mark as an icon alone, and machine → folder →
 * session grouping across two machines — on a 1440px desktop column and a 390px phone drawer.
 *
 * The scene (`tests/integration/fixtures/sessions-list-scene.tsx`) is the real sessions bar over fixed
 * fake sessions, built in a child process — never inside this runner — and served from loopback, so no
 * request can leave the page.
 *
 * What is proved:
 *   - the stopped sessions are not drawn until "Show stopped" is ticked, and the tick says how many;
 *   - each segment's number is the length of the list choosing it would draw;
 *   - no segment label is ever cut short, at the phone drawer's width or a column dragged narrow;
 *   - the learning mark is the cap alone — small, wordless, named in full;
 *   - two machines list as Needs you, then each machine, then its folders;
 *   - neither shape scrolls sideways, in light or dark.
 *
 * Set `FY_SESSIONS_LIST_SHOTS_DIR` to keep the captures for review; every name in them is fake.
 */
import { afterAll, beforeAll, describe, expect } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { sharedChromium } from '../support/chromium.ts';
import { boundedContext, overlapped } from '../support/overlap.ts';

const packageRoot = resolve(import.meta.dir, '../../..');
const shotsDir = process.env.FY_SESSIONS_LIST_SHOTS_DIR ?? '';

const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

let browser: Browser;
const overlap = overlapped();
const bounded = boundedContext(() => browser, 3);
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-sessions-list-'));
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(packageRoot, 'scripts/build-composer-integration-fixture.ts'),
      '--out',
      directory,
      '--entry',
      'tests/integration/fixtures/sessions-list-scene.tsx',
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the sessions-list scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  return { css: await readFile(manifest.css, 'utf8'), js: await readFile(manifest.js, 'utf8') };
};

type View = 'column' | 'drawer';

const open = async (
  view: View,
  machines: 'one' | 'two',
  theme: string,
  tree = false,
  extra = '',
): Promise<{ readonly context: BrowserContext; readonly tab: Page }> => {
  const phone = view === 'drawer';
  const context = await bounded({
    viewport: phone ? { width: 390, height: 844 } : { width: 1_440, height: 900 },
    colorScheme: theme.endsWith('dark') ? 'dark' : 'light',
    reducedMotion: 'reduce',
    deviceScaleFactor: 2,
    ...(phone ? { isMobile: true, hasTouch: true, userAgent: ANDROID_UA } : {}),
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  await tab.goto(`${origin}/?view=${view}&machines=${machines}&theme=${theme}${tree ? '&tree=1' : ''}${extra}`);
  await tab.waitForSelector('[data-sbar-session]');
  return { context, tab };
};

/** Switches theme and colour scheme on a loaded page — the scene only sets `data-theme` once, so this is what a reload with `?theme=` would give. */
const restyle = async (tab: Page, theme: string, mode: 'light' | 'dark'): Promise<void> => {
  await tab.emulateMedia({ colorScheme: mode });
  await tab.evaluate(
    value =>
      new Promise<void>(resolve => {
        document.documentElement.dataset.theme = value;
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
    `${theme}-${mode}`,
  );
};

/** "Show stopped" lives in the bar's ⋯ menu: its row text (with the hidden count), read without choosing it. */
const stoppedRow = async (tab: Page): Promise<string> => {
  await tab.click('[data-sbar-options]');
  const text = (
    await tab.$eval('[data-menu-key="show-stopped"]', row => {
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      const parts: string[] = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) parts.push(node.textContent ?? '');
      return parts.join(' ');
    })
  )
    .replace(/\s+/g, ' ')
    .trim();
  await tab.keyboard.press('Escape');
  return text;
};
const toggleStopped = async (tab: Page): Promise<void> => {
  await tab.click('[data-sbar-options]');
  await tab.click('[data-menu-key="show-stopped"]');
};

const texts = async (tab: Page, selector: string): Promise<readonly string[]> =>
  await tab.$$eval(selector, nodes => nodes.map(node => (node as HTMLElement).innerText.replace(/\s+/gu, ' ').trim()));

const rowIds = async (tab: Page): Promise<readonly string[]> =>
  await tab.$$eval('[data-sbar-session]', nodes => nodes.map(node => node.getAttribute('data-sbar-session') ?? ''));

const segments = async (tab: Page): Promise<readonly string[]> => await texts(tab, '[data-sbar-filter]');

const shot = async (tab: Page, name: string): Promise<void> => {
  if (shotsDir !== '') await writeFile(join(shotsDir, `${name}.png`), await tab.screenshot({ animations: 'disabled' }));
};

/** No label in the segment strip or the tick is wider than the box it sits in. */
const clippedControls = async (tab: Page): Promise<readonly string[]> =>
  await tab.$$eval('[data-sbar-filter]', nodes =>
    nodes
      .filter(node => (node as HTMLElement).scrollWidth > (node as HTMLElement).clientWidth)
      .map(node => node.textContent ?? ''),
  );

describe('the sessions list', () => {
  beforeAll(async () => {
    browser = await sharedChromium();
    const { css, js } = await build();
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: request => {
        const path = new URL(request.url).pathname;
        if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
        if (path === '/app.css') return new Response(css, { headers: { 'content-type': 'text/css' } });
        if (path === '/') return new Response(html, { headers: { 'content-type': 'text/html' } });
        return new Response('not here', { status: 404 });
      },
    });
    if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
  }, 180_000);

  beforeAll(overlap.start);

  afterAll(async () => {
    server?.stop(true);
    if (directory !== '') await rm(directory, { force: true, recursive: true });
  });

  overlap.it(
    'hides stopped sessions until ticked, counts each kind, and never clips a label',
    async () => {
      await Promise.all(
        (['column', 'drawer'] as const).map(async view => {
          const { context, tab } = await open(view, 'one', 'studio-light');
          try {
            const live = (await rowIds(tab)).slice().sort();
            expect(live).toEqual(['s-hadi', 's-ivo', 's-lea', 's-ora']);
            expect(await segments(tab)).toEqual(['Interactive 2', 'All 4', 'Agents 2']);
            expect(await stoppedRow(tab)).toBe('Show stopped Completed, failed, stalled or stopped sessions 3');
            expect(await clippedControls(tab)).toEqual([]);
            await shot(tab, `sessions-list-${view}-hidden`);

            await toggleStopped(tab);
            expect((await rowIds(tab)).slice().sort()).toEqual([
              's-hadi',
              's-ivo',
              's-kai',
              's-lea',
              's-noa',
              's-ora',
              's-rue',
            ]);
            expect(await segments(tab)).toEqual(['Interactive 3', 'All 7', 'Agents 4']);
            expect(await stoppedRow(tab)).toBe('Show stopped Completed, failed, stalled or stopped sessions');
            await shot(tab, `sessions-list-${view}-stopped`);

            await tab.click('[data-sbar-filter="auto"]');
            expect((await rowIds(tab)).slice().sort()).toEqual(['s-ivo', 's-kai', 's-lea', 's-noa']);
            // Choosing a kind leaves the other segments' numbers alone.
            expect(await segments(tab)).toEqual(['Interactive 3', 'All 7', 'Agents 4']);
            await toggleStopped(tab);
            expect((await rowIds(tab)).slice().sort()).toEqual(['s-ivo', 's-lea']);
            expect(await stoppedRow(tab)).toBe('Show stopped Completed, failed, stalled or stopped sessions 2');
            await shot(tab, `sessions-list-${view}-agents`);
          } finally {
            await context.close();
          }
        }),
      );
    },
    120_000,
  );

  overlap.it(
    'opens a new device on Interactive, listed first, and remembers a chosen kind',
    async () => {
      await Promise.all(
        (['column', 'drawer'] as const).flatMap(view =>
          ['studio-light', 'studio-dark'].map(async theme => {
            const { context, tab } = await open(view, 'one', theme, false, '&mode=default');
            try {
              expect(await segments(tab)).toEqual(['Interactive 2', 'All 4', 'Agents 2']);
              expect(await tab.getAttribute('[data-sbar-filter="interactive"]', 'aria-pressed')).toBe('true');
              expect((await rowIds(tab)).slice().sort()).toEqual(['s-hadi', 's-ora']);
              expect(await clippedControls(tab)).toEqual([]);
              await shot(tab, `sessions-filter-default-${view}-${theme.replace('studio-', '')}`);
            } finally {
              await context.close();
            }
          }),
        ),
      );
    },
    120_000,
  );

  overlap.it(
    'nests a pack under its lead: a fold with a rollup, a faint stub when the lead is filtered out',
    async () => {
      await Promise.all(
        (['column', 'drawer'] as const).flatMap(view =>
          ['studio-light', 'studio-dark'].map(async theme => {
            const { context, tab } = await open(view, 'one', theme, true);
            try {
              const tag = `${view}-${theme.replace('studio-', '')}`;
              expect(await rowIds(tab)).toEqual(['p-lead', 'p-pim', 'p-ula', 'p-ada', 'p-kai', 'p-ora']);
              expect(await texts(tab, '[data-sbar-fold]')).toEqual([
                '4 sub-ferrets 1 needs you · 3 running',
                '1 sub-ferret 1 running',
              ]);
              const indent = await tab.$$eval('[data-sbar-session]', nodes =>
                nodes.map(node => Math.round(node.getBoundingClientRect().left)),
              );
              expect(indent[1]).toBeGreaterThan(indent[0] as number);
              expect(indent[4]).toBeGreaterThan(indent[1] as number);
              expect(await tab.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(
                0,
              );
              await shot(tab, `sessions-tree-${tag}-expanded`);

              await tab.click('[data-sbar-fold="p-lead"]');
              expect(await rowIds(tab)).toEqual(['p-lead', 'p-ora']);
              expect(await texts(tab, '[data-sbar-fold]')).toEqual(['4 sub-ferrets 1 needs you · 3 running']);
              await shot(tab, `sessions-tree-${tag}-collapsed`);

              await tab.click('[data-sbar-fold="p-lead"]');
              await tab.click('[data-sbar-filter="auto"]');
              expect(await rowIds(tab)).toEqual(['p-pim', 'p-ula', 'p-ada', 'p-kai']);
              expect(await texts(tab, '.fy-sbar__stub-link')).toContain('Ivo · Session p-lead');
              await shot(tab, `sessions-tree-${tag}-filtered`);
            } finally {
              await context.close();
            }
          }),
        ),
      );
    },
    180_000,
  );

  overlap.it(
    'keeps every label whole in a column dragged narrow, wrapping before it would clip',
    async () => {
      const { context, tab } = await open('column', 'one', 'studio-light');
      try {
        await tab.evaluate(() => {
          const nav = document.querySelector<HTMLElement>('[data-sessions-bar="column"]');
          if (nav !== null) nav.style.width = '190px';
        });
        expect(await clippedControls(tab)).toEqual([]);
        expect(await segments(tab)).toEqual(['Interactive 2', 'All 4', 'Agents 2']);
        const wide = await tab.evaluate(() => document.documentElement.scrollWidth - innerWidth);
        expect(wide).toBeLessThanOrEqual(0);
      } finally {
        await context.close();
      }
    },
    60_000,
  );

  overlap.it(
    'shows the learning mark as the cap alone, named in full',
    async () => {
      const { context, tab } = await open('column', 'one', 'studio-light');
      try {
        const marks = await tab.$$eval('[data-learning-passive]', nodes =>
          nodes.map(node => {
            const box = node.getBoundingClientRect();
            return {
              row: node.closest('[data-sbar-session]')?.getAttribute('data-sbar-session'),
              text: node.textContent,
              label: node.getAttribute('aria-label'),
              title: node.getAttribute('title'),
              width: Math.round(box.width),
              height: Math.round(box.height),
            };
          }),
        );
        expect(marks.map(mark => mark.row)).toEqual(['s-ivo', 's-ora']);
        for (const mark of marks) {
          expect(mark.text).toBe('');
          expect(mark.label).toContain('Learning: passive');
          expect(mark.title).toBe(mark.label);
          expect(mark.width).toBeLessThanOrEqual(16);
          expect(mark.height).toBeLessThanOrEqual(16);
        }
        // A tap on the mark is a tap on the row: it opens the session.
        await tab.click('[data-sbar-session="s-ora"] [data-learning-passive]');
        const seen = await tab.evaluate(
          () => (globalThis as unknown as { __sessionsList: { navigations: string[] } }).__sessionsList.navigations,
        );
        expect(seen.at(-1)).toBe('/d/studio-daemon/session/s-ora');
      } finally {
        await context.close();
      }
    },
    60_000,
  );

  overlap.it(
    'lists two machines as Needs you, then each machine, then its folders',
    async () => {
      await Promise.all(
        (['column', 'drawer'] as const).map(async view => {
          const { context, tab } = await open(view, 'two', 'studio-light');
          try {
            expect(await texts(tab, '[data-sbar-needs-you-group] [data-sbar-session]')).toHaveLength(2);
            expect(await texts(tab, '.fy-sbar__machine-label')).toEqual(['studio', 'laptop']);
            expect(
              (await texts(tab, '[data-sbar-machine-group="studio-daemon"] h3')).map(h => h.toLowerCase()),
            ).toEqual(['ferretry 2', 'notes 1']);
            expect(
              (await texts(tab, '[data-sbar-machine-group="laptop-daemon"] h3')).map(h => h.toLowerCase()),
            ).toEqual(['site 1']);
            // Stopped sessions on either machine are hidden, and the segment counts both.
            expect(await segments(tab)).toEqual(['Interactive 3', 'All 6', 'Agents 3']);
            expect(await stoppedRow(tab)).toBe('Show stopped Completed, failed, stalled or stopped sessions 4');
            await shot(tab, `sessions-list-${view}-machines`);

            await toggleStopped(tab);
            expect(await rowIds(tab)).toContain('l-ada');
            await shot(tab, `sessions-list-${view}-machines-stopped`);
          } finally {
            await context.close();
          }
        }),
      );
    },
    120_000,
  );

  overlap.it(
    'never scrolls sideways, light or dark, in two theme families',
    async () => {
      // One load per view; the four theme and scheme combinations are switched in place.
      await Promise.all(
        (['column', 'drawer'] as const).map(async view => {
          const { context, tab } = await open(view, 'two', 'studio-light');
          try {
            for (const theme of ['studio', 'neo'])
              for (const mode of ['light', 'dark'] as const) {
                await restyle(tab, theme, mode);
                const wide = await tab.evaluate(() => document.documentElement.scrollWidth - innerWidth);
                expect(wide).toBeLessThanOrEqual(0);
                expect(await clippedControls(tab)).toEqual([]);
                await shot(tab, `sessions-list-${view}-${theme}-${mode}`);
              }
          } finally {
            await context.close();
          }
        }),
      );
    },
    180_000,
  );
});
