/**
 * SETTINGS › FILES, DOCTOR AND HOST CHECKS, in a real browser, on a phone and a desktop, in light and dark, over fake
 * data (`fixtures/config-doctor-scene.tsx`): the real views and the stylesheet that ships; no daemon.
 *
 * Each view fits the width (no sideways scroll at 390), keeps its words on screen, and the editor sheet opens over the
 * Files panel. Set `FY_CONFIG_DOCTOR_SHOTS_DIR` to keep `<viewport>-<scheme>-<view>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(30_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_CONFIG_DOCTOR_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-config-doctor-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/config-doctor-scene.tsx'],
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

const VIEWS = [
  {
    view: 'files',
    words: ['These settings live in files on this machine', 'Waiting for you', 'Problems', 'AI logins'],
  },
  { view: 'files-empty', words: ['No configuration files yet'] },
  { view: 'editor', words: ['Edit as YAML', 'Never paste a key here'] },
  {
    view: 'doctor',
    words: ['Host checks', 'Required dependencies are present.', 'alternative', 'is all this report proves'],
  },
  { view: 'doctor-down', words: ['A required dependency is missing; sessions will not work yet.'] },
  { view: 'host-checks', words: ['Reachable', 'Technical identity'] },
] as const;

const open = async (viewport: (typeof VIEWPORTS)[number], scheme: 'light' | 'dark', view: string) => {
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
  await tab.goto(`${origin}/?theme=studio-${scheme}&view=${view}`);
  await tab.waitForSelector('[data-scene-ready] *');
  await tab.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  return { tab, close: async () => await context.close() };
};

describe('Settings › Files, Doctor and Host checks', () => {
  for (const viewport of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const)
      for (const { view, words } of VIEWS)
        it(`draws ${view} whole, with its words and no sideways scroll (${viewport.name}, ${scheme})`, async () => {
          const { tab, close } = await open(viewport, scheme, view);
          try {
            const text = await tab.evaluate(() => document.body.innerText);
            for (const word of words) expect(text, `${view} says "${word}"`).toContain(word);
            const overflow = await tab.evaluate(
              () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
            );
            expect(overflow, 'the page does not scroll sideways').toBeLessThanOrEqual(0);
            if (shotsDir !== '')
              await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${scheme}-${view}.png`) });
          } finally {
            await close();
          }
        });
});
