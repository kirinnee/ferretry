/**
 * O8-14 P3: WITH THE WORK SWITCH OFF THE APP DRAWS NO TRACE OF BOARD OR AGENDA, in a real browser over fake data
 * (`fixtures/frame-scene.tsx`, `?work=off`): the real shell, the default layout and the stylesheet that ships; the fake
 * machine's inventory says `board` and `agenda` are off. The nav and the Settings list leave them out at 390 and 1280,
 * light and dark; with the switch on (the default of that scene) both are there, as before.
 *
 * Set `FY_WORK_SHOTS_DIR` to keep `<viewport>-<theme>-<page>-<work>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '../support/browser/index.ts';

setDefaultTimeout(30_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_WORK_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-frame-work-off-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', resolve(packageRoot, 'fixtures/frame-scene.tsx')],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the frame scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request =>
      new URL(request.url).pathname === '/app.js'
        ? new Response(js, { headers: { 'content-type': 'text/javascript' } })
        : new Response(page, { headers: { 'content-type': 'text/html' } }),
  });
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const VIEWPORTS = [
  { name: '1280', width: 1_280, height: 800, phone: false },
  { name: '390', width: 390, height: 844, phone: true },
] as const;
const THEMES = ['studio-light', 'studio-dark'] as const;

/** The whole page's text, plus every accessible name and title on it (a hidden label would still be a trace). */
const traces = async (
  path: string,
  viewport: (typeof VIEWPORTS)[number],
  theme: string,
  work: 'on' | 'off' | 'split',
  finder = false,
) => {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme: theme.endsWith('dark') ? 'dark' : 'light',
    deviceScaleFactor: viewport.phone ? 2 : 1,
    hasTouch: viewport.phone,
    isMobile: viewport.phone,
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  tab.setDefaultTimeout(8_000);
  await tab.goto(`${origin}${path}?theme=${theme}&work=${work}`);
  await tab.waitForSelector('.fy-main', { timeout: 8_000 });
  await tab.waitForTimeout(400);
  // The phone keeps its places in the drawer: open it, so the shot and the text include them.
  if (viewport.phone) {
    await tab.click('button[aria-label="Menu"]');
    await tab.waitForSelector('.fy-drawer--overlay');
    await tab.waitForTimeout(300);
  }
  // The destination finder (Ctrl+K), opened over the page: what it lists is part of what the page offers.
  if (finder) {
    await tab.keyboard.press('Control+k');
    await tab.waitForSelector('[role="dialog"]');
    await tab.waitForTimeout(300);
  }
  if (shotsDir !== '')
    await tab.screenshot({
      path: join(
        shotsDir,
        `${viewport.name}-${theme}-${path.split('/').slice(2).join('-')}-${work}${finder ? '-find' : ''}.png`,
      ),
    });
  const found = await tab.evaluate(() => {
    const words: string[] = [document.body.textContent ?? '', document.title];
    for (const element of document.querySelectorAll('[aria-label],[title],[alt],[data-panel],[href]'))
      words.push(
        element.getAttribute('aria-label') ?? '',
        element.getAttribute('title') ?? '',
        element.getAttribute('data-panel') ?? '',
        element.getAttribute('href') ?? '',
      );
    return words.join(' | ');
  });
  await context.close();
  return found;
};

const TRACE = /\b(board|agenda)\b/i;

describe('the work switch off: no trace of Board or Agenda in the nav or Settings', () => {
  for (const viewport of VIEWPORTS)
    for (const theme of THEMES)
      for (const path of ['/d/ws/ferrets', '/d/ws/settings']) {
        it(`${viewport.name} ${theme} ${path}: off leaves neither, on shows both`, async () => {
          const off = await traces(path, viewport, theme, 'off');
          expect(off.match(TRACE), `a trace of Board or Agenda with work off: ${off.match(TRACE)?.[0]}`).toBeNull();
          const on = await traces(path, viewport, theme, 'on');
          expect(on).toMatch(/board/i);
          expect(on).toMatch(/agenda/i);
        });
      }
});

// Two paired machines: `ws` has the work switch OFF, `ws2` has it ON. What each machine offers is its own: `ws` draws no
// trace although `ws2` has Board and Agenda on, and `ws2` draws both (the nav, the Settings list and the finder).
describe('two machines, one off and one on: each machine offers its own', () => {
  for (const viewport of VIEWPORTS)
    for (const theme of THEMES)
      for (const page of ['ferrets', 'settings']) {
        it(`${viewport.name} ${theme} ${page}: ws (off) leaves neither, ws2 (on) shows both`, async () => {
          const off = await traces(`/d/ws/${page}`, viewport, theme, 'split');
          expect(off.match(TRACE), `a trace on the OFF machine: ${off.match(TRACE)?.[0]}`).toBeNull();
          const on = await traces(`/d/ws2/${page}`, viewport, theme, 'split');
          expect(on).toMatch(/board/i);
          expect(on).toMatch(/agenda/i);
        });
      }

  for (const theme of THEMES)
    it(`1280 ${theme}: the finder on ws (off) lists neither, on ws2 (on) both`, async () => {
      const wide = VIEWPORTS[0];
      const off = await traces('/d/ws/ferrets', wide, theme, 'split', true);
      expect(off.match(TRACE), `a trace in the finder on the OFF machine: ${off.match(TRACE)?.[0]}`).toBeNull();
      const on = await traces('/d/ws2/ferrets', wide, theme, 'split', true);
      expect(on).toMatch(/board/i);
      expect(on).toMatch(/agenda/i);
    });
});
