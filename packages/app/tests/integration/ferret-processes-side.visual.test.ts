/**
 * THE PROCESSES PANEL HAS HEIGHT WHERE A FERRET PUTS IT, in a real browser, over fake data: the REAL app over the REAL
 * generated plugins (`fixtures/ferret-asks-scene.tsx`, with its fake processes answer), reached the way a person reaches it.
 *
 *  - at a desk the side column starts closed: the REAL 'Show side panels' button opens it, and every panel stacks at its
 *    natural height in one long scroll. The Processes panel measured 0px there (its list was in the page and drew nothing).
 *  - on a phone the side panels are chips: the REAL Processes chip is tapped, and that one panel fills the page.
 *
 * Both are asserted the same way: the panel is at least 160px tall and its first row is what a point at its centre hits.
 *
 * Set `FY_PROCESSES_SIDE_SHOTS_DIR` to keep `<viewport>-<theme>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '../support/browser/index.ts';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_PROCESSES_SIDE_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-processes-side-'));
  const child = Bun.spawn(
    [
      process.execPath,
      sceneBuilder,
      '--out',
      directory,
      '--entry',
      resolve(packageRoot, 'fixtures/ferret-asks-scene.tsx'),
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the ferret scene did not build (${code}):\n${stderr}\n${stdout}`);
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
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 240_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const VIEWPORTS = [
  { name: '1280', width: 1_280, height: 800, phone: false },
  { name: '390', width: 390, height: 844, phone: true },
] as const;
type Viewport = (typeof VIEWPORTS)[number];

const PANEL = '[data-panel="terminals.processes"] .fy-proc';
const FIRST_ROW = `${PANEL} .fy-proc-row`;

const open = async (viewport: Viewport, mode: 'light' | 'dark') => {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme: mode,
    deviceScaleFactor: 2,
    hasTouch: viewport.phone,
    isMobile: viewport.phone,
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  tab.setDefaultTimeout(15_000);
  const problems: string[] = [];
  tab.on('pageerror', error => problems.push(error.message));
  await tab.goto(`${origin}/d/ws/ferrets/zoe/chat?theme=studio-${mode}&agenda=off&asks=0`);
  const entry = viewport.phone ? '[data-phone-chip]' : '[data-side-toggle]';
  try {
    await tab.waitForSelector(entry, { timeout: 20_000 });
  } catch (error) {
    throw new Error(`the scene did not draw ${entry}: ${String(error)}\n${problems.join('\n')}`);
  }
  return { tab, close: async () => await context.close() };
};

/** The real controls, as a person uses them: the desk's toggle, or the phone's Processes chip. */
const reachProcesses = async (tab: Page, viewport: Viewport): Promise<void> => {
  if (viewport.phone) await tab.locator('[data-phone-chip]', { hasText: 'Processes' }).tap();
  else await tab.getByRole('button', { name: 'Show side panels' }).click();
  await tab.waitForSelector(FIRST_ROW);
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

describe('the Processes panel in a ferret’s side panels', () => {
  for (const viewport of VIEWPORTS)
    for (const mode of ['light', 'dark'] as const)
      it(`at ${viewport.name} in ${mode}: opened through the real control, it has real height and its first row is on screen`, async () => {
        const { tab, close } = await open(viewport, mode);
        try {
          await reachProcesses(tab, viewport);
          const height = await heightOf(tab, PANEL);
          expect(height, 'the panel is at least 160px tall').toBeGreaterThanOrEqual(160);
          expect(await onScreen(tab, FIRST_ROW), 'its first row is visible').toBe(true);
          await tab.evaluate(
            query => document.querySelector(query)?.scrollIntoView({ block: 'start' }),
            '[data-panel="terminals.processes"]',
          );
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${mode}.png`) });
        } finally {
          await close();
        }
      });
});
