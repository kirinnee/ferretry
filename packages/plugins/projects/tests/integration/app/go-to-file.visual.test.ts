/**
 * F6061 U7's "Go to file" in the command bar, in a real browser, over FAKE data: the REAL `CommandBar` with Projects' own
 * source on a project page. Measured, not snapshotted:
 *  - the options of `src/entry.ts` and `src/entry-ts` have DIFFERENT DOM ids, and ArrowDown moves `aria-activedescendant`
 *    onto the option that is selected (the one whose text is on the highlighted row), for every row;
 *  - Enter on `src/entry-ts` goes to THAT file in the file view of the ferret working in the project
 *    (`/d/<daemon>/ferrets/<id>?file=src%2Fentry-ts`), or to the seeded project page when no ferret works there;
 *  - a refused (403) or unavailable (503) search says so in the list instead of "no results", and is not kept: clearing the
 *    box and typing the same text again reads again and answers once access is given.
 * Set `FY_FINDER_SHOTS_DIR` to keep `<viewport>-<scheme>-bar-<shot>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(90_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_FINDER_SHOTS_DIR ?? '';
const PROJECT_HERE = '/d/fake/projects/00000000-0000-4000-8000-000000000001';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-bar-'));
  const child = Bun.spawn([process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/bar-scene.tsx'], {
    cwd: packageRoot,
    stderr: 'pipe',
    stdout: 'pipe',
  });
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
    port: 0,
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

const VIEWPORTS = [
  { name: '1280', width: 1_280, height: 900, phone: false },
  { name: '390', width: 390, height: 844, phone: true },
] as const;
type Viewport = (typeof VIEWPORTS)[number];

const withBar = async (
  viewport: Viewport,
  scheme: 'light' | 'dark',
  view: string,
  run: (tab: Page, shot: (name: string) => Promise<void>) => Promise<void>,
): Promise<void> => {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme: scheme,
    deviceScaleFactor: viewport.phone ? 2 : 1,
    hasTouch: viewport.phone,
    isMobile: viewport.phone,
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  await tab.goto(`${origin}/?theme=studio-${scheme}&view=${view}`);
  await tab.waitForSelector('#fy-command-bar-input', { timeout: 15_000 });
  const shot = async (name: string): Promise<void> => {
    if (shotsDir === '') return;
    await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${scheme}-bar-${name}.png`) });
  };
  try {
    await run(tab, shot);
  } finally {
    await context.close();
  }
};

/** The options on screen: id, text, and whether the bar marks it selected. */
const options = (tab: Page) =>
  tab.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[role="option"]')].map(node => ({
      id: node.id,
      text: node.innerText.replaceAll(/\s+/gu, ' ').trim(),
      selected: node.getAttribute('aria-selected') === 'true',
    })),
  );

const active = (tab: Page) => tab.locator('#fy-command-bar-input').getAttribute('aria-activedescendant');

const typeEntry = async (tab: Page): Promise<void> => {
  await tab.locator('#fy-command-bar-input').fill('entry');
  await tab.waitForFunction(() => document.querySelectorAll('[role="option"]').length >= 5, undefined, {
    timeout: 8_000,
  });
};

describe('Go to file in the command bar', () => {
  for (const viewport of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const) {
      const where = `${viewport.name}, ${scheme}`;

      it(`gives src/entry.ts and src/entry-ts their own option ids, and ArrowDown points at the selected one (${where})`, () =>
        withBar(viewport, scheme, 'ready', async (tab, shot) => {
          await typeEntry(tab);
          const listed = await options(tab);
          const ids = listed.map(option => option.id);
          console.info(`[u7] bar ${where}: ${String(ids.length)} options, ${String(new Set(ids).size)} distinct ids`);
          expect(new Set(ids).size, 'every option has its own DOM id').toBe(ids.length);
          const dotted = listed.find(option => option.text.startsWith('entry.ts'));
          const dashed = listed.find(option => option.text.startsWith('entry-ts'));
          expect(dotted, 'entry.ts is listed').toBeDefined();
          expect(dashed, 'entry-ts is listed').toBeDefined();
          expect(dotted?.id).not.toBe(dashed?.id);

          // ArrowDown through every row: the id the input points at is the id of the row the bar marks selected.
          for (let press = 0; press < listed.length + 1; press += 1) {
            const pointed = await active(tab);
            const selected = (await options(tab)).filter(option => option.selected);
            expect(selected.length, 'exactly one option is selected').toBe(1);
            expect(pointed, `press ${String(press)}: aria-activedescendant names the selected option`).toBe(
              selected[0]?.id ?? null,
            );
            expect(await tab.evaluate(id => (id === null ? null : document.getElementById(id)?.id), pointed)).toBe(
              pointed,
            );
            await tab.keyboard.press('ArrowDown');
          }
          await shot('entry');
        }));

      it(`Enter on src/entry-ts opens THAT file in the file view of the ferret working here (${where})`, () =>
        withBar(viewport, scheme, 'ready', async tab => {
          await typeEntry(tab);
          for (
            let press = 0;
            press < 12 && !(await options(tab)).some(o => o.selected && o.text.startsWith('entry-ts'));
            press += 1
          )
            await tab.keyboard.press('ArrowDown');
          const chosen = (await options(tab)).find(option => option.selected);
          expect(chosen?.text.startsWith('entry-ts'), 'the highlighted row is entry-ts').toBe(true);
          expect(await active(tab), 'and aria-activedescendant names it, not entry.ts').toBe(chosen?.id ?? null);
          await tab.keyboard.press('Enter');
          await tab.waitForFunction(() => document.body.hasAttribute('data-went'), undefined, { timeout: 8_000 });
          expect(await tab.evaluate(() => document.body.getAttribute('data-went'))).toBe(
            '/d/fake/ferrets/f-1?file=src%2Fentry-ts',
          );
        }));

      it(`with no ferret working here Enter opens the project page with its finder seeded (${where})`, () =>
        withBar(viewport, scheme, 'alone', async tab => {
          await typeEntry(tab);
          for (
            let press = 0;
            press < 12 && !(await options(tab)).some(o => o.selected && o.text.startsWith('entry-ts'));
            press += 1
          )
            await tab.keyboard.press('ArrowDown');
          await tab.keyboard.press('Enter');
          await tab.waitForFunction(() => document.body.hasAttribute('data-went'), undefined, { timeout: 8_000 });
          expect(await tab.evaluate(() => document.body.getAttribute('data-went'))).toBe(
            `${PROJECT_HERE}?find=src%2Fentry-ts`,
          );
        }));

      for (const [view, status, label, sentence] of [
        ['denied', '403', 'Search refused by the daemon', 'needs filesystem.configure'],
        ['busy', '503', 'File search is not ready', 'still being built'],
      ] as const)
        it(`a ${status} search says so instead of “no results”, and is not kept once access is back (${where})`, () =>
          withBar(viewport, scheme, view, async (tab, shot) => {
            await tab.locator('#fy-command-bar-input').fill('entry');
            await tab.waitForFunction(() => document.querySelectorAll('[role="option"]').length === 1, undefined, {
              timeout: 8_000,
            });
            const text = await tab.evaluate(
              () => document.querySelector<HTMLElement>('#fy-command-bar')?.innerText ?? '',
            );
            expect(text, 'the line says what happened').toContain(label);
            expect(text, 'the daemon’s own sentence is shown').toContain(sentence);
            // Not faded (a faded row measured ~2.4:1): the line is the one the reader has to act on.
            const opacity = await tab.evaluate(() => {
              const row = document.querySelector<HTMLElement>('[role="option"]');
              let product = 1;
              for (let node: HTMLElement | null = row; node !== null; node = node.parentElement)
                product *= Number.parseFloat(getComputedStyle(node).opacity);
              return product;
            });
            expect(opacity, 'the refusal line is drawn at full strength').toBe(1);
            expect(text.toLowerCase(), 'and it is not reported as an empty result').not.toContain('no results');
            await shot(`refused-${status}`);

            // Access is given; the box is cleared and the same text typed again: it reads again and answers.
            await tab.evaluate(() => (window as unknown as { __allow: () => void }).__allow());
            await tab.locator('#fy-command-bar-input').fill('');
            await tab.locator('#fy-command-bar-input').fill('entry');
            await tab.waitForFunction(() => document.querySelectorAll('[role="option"]').length >= 5, undefined, {
              timeout: 8_000,
            });
            const reads = await tab.evaluate(
              () =>
                (window as unknown as { __calls: { route: string }[] }).__calls.filter(call =>
                  call.route.endsWith('/files'),
                ).length,
            );
            expect(reads, 'the same text was asked for again, not remembered as empty').toBeGreaterThanOrEqual(2);
          }));
    }
});
