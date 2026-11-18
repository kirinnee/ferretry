/**
 * THE MACHINE NAME, in a real browser, on a phone and a desktop, in light and dark, over fake data
 * (`fixtures/machine-name-scene.tsx`): Settings › General › Name and the daemon list say the one name the
 * owner gave, and the form falls back to the host name as its placeholder. No daemon, no pairing code.
 *
 * Set `FY_MACHINE_NAME_SHOTS_DIR` to keep `<viewport>-<scheme>-<view>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '../support/browser/index.ts';

setDefaultTimeout(30_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_MACHINE_NAME_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-machine-name-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/machine-name-scene.tsx'],
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
  { name: '1280', width: 1_280, height: 800, phone: false },
  { name: '390', width: 390, height: 844, phone: true },
] as const;

const VIEWS = [
  { view: 'name', path: '/d/ws/settings/kernel/name', words: ['General', 'Name', 'Shown now: pebox'] },
  { view: 'name-host', path: '/d/ws/settings/kernel/name', words: ['Using the host name (kirin-mbp.local)'] },
  { view: 'pair-name', path: '/d/ws', words: ['Name this machine', 'Machine name', 'Save name', 'Not now'] },
  { view: 'connecting', path: '/d/ws', words: ['pebox'] },
  // An app opened fresh goes straight to its machine: the list is reached on purpose, from the machine picker.
  { view: 'daemons', path: '/d/ws', words: ['Daemons', 'pebox', 'kirin-laptop'], viaPicker: true },
] as const;

const open = async (viewport: (typeof VIEWPORTS)[number], scheme: 'light' | 'dark', view: string, path: string) => {
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
  const tab: Page = await context.newPage();
  await tab.goto(`${origin}${path}?theme=studio-${scheme}&view=${view}`);
  // The machine switcher is a closed menu button, so a page can be drawn with little text: it counts as drawn too.
  await tab.waitForFunction(
    () => document.body.innerText.trim().length > 40 || document.querySelector('.fy-daemon-picker') !== null,
    undefined,
    { timeout: 15_000 },
  );
  await tab.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  return { tab, close: async () => await context.close() };
};

describe('the machine name on every screen that shows it', () => {
  for (const viewport of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const)
      for (const { view, path, words, ...rest } of VIEWS)
        it(`draws ${view} with its words and no sideways scroll (${viewport.name}, ${scheme})`, async () => {
          const { tab, close } = await open(viewport, scheme, view, path);
          try {
            if ('viaPicker' in rest) {
              await tab.waitForSelector('button.fy-daemon-picker');
              await tab.click('button.fy-daemon-picker');
              await tab.getByRole('menuitem', { name: 'All daemons' }).click();
            }
            await tab.waitForFunction(
              (wanted: readonly string[]) => wanted.every(word => document.body.innerText.includes(word)),
              words,
              { timeout: 15_000 },
            );
            const text = await tab.evaluate(() => document.body.innerText);
            for (const word of words) expect(text, `${view} says "${word}"`).toContain(word);
            const overflow = await tab.evaluate(
              () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
            );
            expect(overflow, `${view} does not scroll sideways`).toBeLessThanOrEqual(0);
            if (shotsDir !== '')
              await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${scheme}-${view}.png`), fullPage: true });
          } finally {
            await close();
          }
        });
});
