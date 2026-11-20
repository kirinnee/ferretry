/**
 * THE PROCESSES PANEL HAS HEIGHT IN A FERRET'S SIDE COLUMN, in a real browser, over fixed fake data. On a desktop the
 * column is one long scroll of every panel at its natural height; the panel measured 0px there (its list was in the page
 * but drew nothing), so Processes could not be seen. On a phone it is the one panel on show and fills the page.
 *
 * Set `FY_PROCESSES_SIDE_SHOTS_DIR` to keep `<viewport>-<mode>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(30_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_PROCESSES_SIDE_SHOTS_DIR ?? '';

const VIEWPORTS = [
  { name: '1280', width: 1_280, height: 800, phone: false },
  { name: '390', width: 390, height: 844, phone: true },
] as const;

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-processes-side-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/processes-side-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the processes scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  return { css: await readFile(manifest.css, 'utf8'), js: await readFile(manifest.js, 'utf8') };
};

beforeAll(async () => {
  const { css, js } = await build();
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>html, body, #root { height: 100%; margin: 0; }</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
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

const open = async (viewport: (typeof VIEWPORTS)[number], mode: 'light' | 'dark') => {
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
  const tab = await context.newPage();
  await tab.goto(`${origin}/?theme=studio-${mode}${viewport.phone ? '&phone=1' : ''}`);
  await tab.waitForSelector('.fy-proc-row');
  return { tab, close: async () => await context.close() };
};

const heightOf = async (tab: Page, selector: string): Promise<number> =>
  await tab.evaluate(query => document.querySelector(query)?.getBoundingClientRect().height ?? -1, selector);

/** Whether the point at the centre of `selector` hits that element (or something in it): drawn, not clipped or covered. */
const onScreen = async (tab: Page, selector: string): Promise<boolean> =>
  await tab.evaluate(query => {
    const element = document.querySelector(query);
    if (element === null) throw new Error(`nothing matches ${query}`);
    element.scrollIntoView({ block: 'nearest' });
    const box = element.getBoundingClientRect();
    const at = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return box.height > 0 && at !== null && element.contains(at);
  }, selector);

describe('the Processes panel in a ferret’s side column', () => {
  for (const viewport of VIEWPORTS)
    for (const mode of ['light', 'dark'] as const)
      it(`at ${viewport.name} in ${mode}: has real height and its first row is on screen`, async () => {
        const { tab, close } = await open(viewport, mode);
        try {
          const panel = '[data-panel="terminals.processes"] .fy-proc';
          const height = await heightOf(tab, panel);
          expect(height, 'the panel is at least 160px tall').toBeGreaterThanOrEqual(160);
          expect(await onScreen(tab, `${panel} .fy-proc-row`), 'its first row is visible').toBe(true);
          await tab.evaluate(() =>
            document.querySelector('[data-panel="terminals.processes"]')?.scrollIntoView({ block: 'start' }),
          );
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${mode}.png`) });
        } finally {
          await close();
        }
      });
});
