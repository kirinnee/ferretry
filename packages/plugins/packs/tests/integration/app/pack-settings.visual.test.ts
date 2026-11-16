/**
 * SETTINGS › PACK MODE in a real browser, on a phone and a desktop, in light and dark, over fake routes
 * (`fixtures/pack-settings-scene.tsx`): the real tab and the stylesheet that ships; no daemon.
 *
 * The filled page keeps its words and never scrolls sideways; a save that loosens (Jev decides) is held and the page says
 * it waits for the owner's confirmation. Set `FY_PACK_SETTINGS_SHOTS_DIR` to keep `<viewport>-<scheme>-<view>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(30_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_PACK_SETTINGS_SHOTS_DIR ?? '';

let browser: Awaited<ReturnType<typeof sharedChromium>>;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-pack-settings-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/pack-settings-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  return { css: await readFile(manifest.css, 'utf8'), js: await readFile(manifest.js, 'utf8') };
};

beforeAll(async () => {
  browser = await sharedChromium();
  const { css, js } = await build();
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

const VIEWPORTS = [
  { name: '1280', width: 1_280, height: 800, phone: false },
  { name: '390', width: 390, height: 844, phone: true },
] as const;

describe('Settings › Pack mode', () => {
  for (const viewport of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const)
      for (const view of ['filled', 'held'] as const)
        it(`draws the ${view} page whole, with no sideways scroll (${viewport.name}, ${scheme})`, async () => {
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
          try {
            const tab = await context.newPage();
            await tab.goto(`${origin}/?theme=studio-${scheme}`);
            await tab.waitForSelector('[data-pack-settings]');
            if (view === 'held') {
              await tab.click('input[name="pack-decision"] >> nth=1');
              await tab.waitForSelector('[data-pack-outcome="pending"]');
            }
            await tab.evaluate(
              () => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
            );
            const text = await tab.evaluate(() => document.body.innerText);
            for (const word of ['Pack mode on this machine', 'Helpers for an interactive ferret', 'Deepest nesting'])
              expect(text).toContain(word);
            if (view === 'held') {
              expect(text).toContain('not in effect until you confirm it');
              expect(text).toContain('Jev decides which model each helper runs on');
            } else expect(text).not.toContain('not in effect');
            const overflow = await tab.evaluate(
              () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
            );
            expect(overflow, 'the page does not scroll sideways').toBeLessThanOrEqual(0);
            if (shotsDir !== '') {
              // Size the window to the page so every card is painted (a full-page capture leaves the lower cards blank).
              const height = await tab.evaluate(() => document.documentElement.scrollHeight);
              await tab.setViewportSize({ width: viewport.width, height });
              await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${scheme}-${view}.png`) });
            }
          } finally {
            await context.close();
          }
        });
});
