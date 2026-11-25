/**
 * THE TERMINALS PLUGIN'S THREE PANELS READ CLEANLY, in a real browser over fakes (`fixtures/terminal-panels-scene.tsx`).
 *
 *  - E199: a passkey refusal is ONE sentence in the panel's own name — Processes never says "session terminals", and the daemon's
 *    own sentence is not run on after ours.
 *  - E195b: a Console whose first read is refused says so without an age ("stale · last update — ago" claimed a snapshot that was
 *    never read); once a snapshot has been read, a later refusal is stale, with its age.
 *  - L288a: at 300px the deck's ledger gives the working directory the whole row — the counter moves to a second line — so the
 *    path's end (where it differs) is legible rather than cut.
 *
 * Set `FY_TERMINAL_PANELS_SHOTS_DIR` to keep `<name>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_TERMINAL_PANELS_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-terminal-panels-'));
  const child = Bun.spawn(
    [
      process.execPath,
      sceneBuilder,
      '--out',
      directory,
      '--entry',
      resolve(packageRoot, 'fixtures/terminal-panels-scene.tsx'),
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the panels scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-bg text-fg" style="margin:0"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request =>
      new URL(request.url).pathname === '/app.js'
        ? new Response(js, { headers: { 'content-type': 'text/javascript' } })
        : new Response(page, { headers: { 'content-type': 'text/html' } }),
  });
  browser = await sharedChromium();
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const VIEWS = [
  { name: '390', width: 390, phone: true },
  { name: '1440', width: 1_440, phone: false },
] as const;
const SCHEMES = ['light', 'dark'] as const;

/** Opens one panel in a box the width of `width`, in a scheme, and waits for it to draw. */
const open = async (
  query: string,
  view: (typeof VIEWS)[number],
  scheme: (typeof SCHEMES)[number],
  box: { w: number; h: number },
) => {
  const context = await browser.newContext({
    viewport: { width: view.width, height: 700 },
    colorScheme: scheme,
    deviceScaleFactor: 1,
    hasTouch: view.phone,
    isMobile: view.phone,
  });
  const tab = await context.newPage();
  tab.setDefaultTimeout(8_000);
  const problems: string[] = [];
  tab.on('pageerror', error => problems.push(error.message));
  await tab.goto(`${server?.url.origin}/?theme=studio-${scheme}&w=${box.w}&h=${box.h}&${query}`);
  await tab.waitForFunction(() => '__panel' in window);
  await tab.waitForTimeout(700);
  return { tab, problems, close: async () => await context.close() };
};

const textOf = async (tab: Page, selector: string): Promise<string> =>
  await tab.evaluate(query => (document.querySelector(query) as HTMLElement | null)?.innerText ?? '', selector);

describe('E199: a passkey refusal is one sentence in the panel’s own name', () => {
  for (const view of VIEWS)
    for (const scheme of SCHEMES)
      it(`${view.name} ${scheme}: Processes names itself, not "session terminals", and says it once`, async () => {
        const { tab, close } = await open('panel=processes&refuse=step-up', view, scheme, {
          w: view.phone ? 358 : 366,
          h: 400,
        });
        try {
          const text = (await textOf(tab, '[data-scene-box]')).replace(/\s+/g, ' ');
          if (shotsDir !== '')
            await tab.screenshot({ path: join(shotsDir, `e199-processes-${view.name}-${scheme}.png`) });
          expect(text, 'it asks for the passkey').toContain('passkey');
          expect(text, 'it names its own panel').toContain('Processes');
          expect(text, 'it never calls itself session terminals').not.toContain('session terminals');
          expect(text, 'one passkey sentence: the daemon’s own is not run on after it').not.toContain(
            'needs a passkey confirmation',
          );
          expect(text.match(/passkey/g)?.length, 'the passkey is asked for once').toBe(1);
        } finally {
          await close();
        }
      });
});

describe('E195b: a Console that was never read is not "stale"', () => {
  for (const view of VIEWS)
    for (const scheme of SCHEMES) {
      it(`${view.name} ${scheme}: a refused first read shows the refusal with no age`, async () => {
        const { tab, close } = await open('panel=console&refuse=step-up', view, scheme, {
          w: view.phone ? 358 : 366,
          h: 400,
        });
        try {
          const header = (await textOf(tab, '[role="status"]')).replace(/\s+/g, ' ');
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `e195b-first-${view.name}-${scheme}.png`) });
          expect(header, 'no age before any snapshot was read').not.toMatch(/— ago|stale/);
          expect(header, 'no "last update" before any snapshot was read').not.toContain('last update');
          expect(header, 'the refusal is named once, in the Console’s name').toContain('Console');
          expect(header.match(/passkey/g)?.length, 'the passkey is asked for once').toBe(1);
        } finally {
          await close();
        }
      });
      it(`${view.name} ${scheme}: after a good read a later refusal is stale, with its age`, async () => {
        const { tab, close } = await open('panel=console&refuse=step-up&first=read', view, scheme, {
          w: view.phone ? 358 : 366,
          h: 400,
        });
        try {
          await tab.waitForFunction(() => document.body.innerText.includes('stale'), undefined, { timeout: 8_000 });
          const header = (await textOf(tab, '[role="status"]')).replace(/\s+/g, ' ');
          if (shotsDir !== '')
            await tab.screenshot({ path: join(shotsDir, `e195b-retained-${view.name}-${scheme}.png`) });
          expect(header, 'stale, with an age').toMatch(/stale/);
          if (!view.phone) expect(header).toMatch(/last update (<1s|\d+s) ago/);
        } finally {
          await close();
        }
      });
    }
});

describe('L288a: at 300px the working directory gets the row', () => {
  for (const view of VIEWS)
    for (const scheme of SCHEMES)
      it(`${view.name} ${scheme}: the end of a long cwd is legible, and the counter sits on its own line`, async () => {
        const { tab, close } = await open('panel=deck', view, scheme, { w: 300, h: 360 });
        try {
          const reading = await tab.evaluate(() => {
            const cwd = document.querySelector('.kt-webterm__cwd') as HTMLElement;
            const counter = document.querySelector('.kt-webterm__ledger > span:last-child') as HTMLElement;
            const row = cwd.getBoundingClientRect();
            return {
              cwdWidth: row.width,
              cwdCut: cwd.scrollWidth > cwd.clientWidth + 1,
              ledgerWidth: (cwd.parentElement as HTMLElement).clientWidth,
              counterTop: counter.getBoundingClientRect().top,
              cwdBottom: row.bottom,
              counterText: counter.innerText,
            };
          });
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `l288a-${view.name}-${scheme}.png`) });
          expect(reading.counterText, 'the counter is there').not.toBe('');
          expect(reading.cwdWidth, `the path has the whole row: ${JSON.stringify(reading)}`).toBeGreaterThanOrEqual(
            reading.ledgerWidth - 24,
          );
          expect(
            reading.counterTop,
            `the counter is on a second line: ${JSON.stringify(reading)}`,
          ).toBeGreaterThanOrEqual(reading.cwdBottom - 1);
        } finally {
          await close();
        }
      });
});
