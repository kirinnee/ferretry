/**
 * THE INPUT CARD SAYS WHERE THE FORM NOW SENDS WHAT IS TYPED (E-314) in a real browser over fake data
 * (`fixtures/input-card-origin-scene.tsx`): the amber warning is shown, in words, and the card stays inside the rounded
 * box it sits in, at 390 and 1440, light and dark, in the default look (Studio) and the roundest (Neumorphism).
 * Set `FY_INPUT_CARD_ORIGIN_SHOTS_DIR` to keep `<look>-<viewport>-<scheme>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser } from 'playwright-core';
import { describeRoundMisses, roundSafeMisses, sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_INPUT_CARD_ORIGIN_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-input-card-origin-'));
  const child = Bun.spawn(
    [
      process.execPath,
      sceneBuilder,
      '--out',
      directory,
      '--entry',
      resolve(packageRoot, 'fixtures/input-card-origin-scene.tsx'),
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
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

const LOOKS = ['studio', 'neumorphism'] as const;
const VIEWPORTS = [
  { name: '1440', width: 1_440, height: 900, phone: false },
  { name: '390', width: 390, height: 844, phone: true },
] as const;

for (const style of LOOKS)
  for (const viewport of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const)
      describe(`input card, form sends elsewhere: ${style} ${viewport.name} ${scheme}`, () => {
        it('shows the warning in words and keeps every part inside its rounded box', async () => {
          const context = await browser.newContext({
            viewport: { width: viewport.width, height: viewport.height },
            colorScheme: scheme,
            deviceScaleFactor: viewport.phone ? 2 : 1,
            hasTouch: viewport.phone,
            isMobile: viewport.phone,
            reducedMotion: 'reduce',
          });
          try {
            const origin = server?.url.origin ?? '';
            await context.route('**/*', async route =>
              new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
            );
            const tab = await context.newPage();
            await tab.goto(`${origin}/?theme=studio-${scheme}&style=${style}`);
            await tab.waitForSelector('[data-scene-ready] [data-input-warning]', { timeout: 15_000 });
            await tab.evaluate(async () => await document.fonts.ready);
            const words = (await tab.locator('[data-input-warning]').textContent()) ?? '';
            expect(words).toContain('now sends what you type to another site than when you were asked');
            expect(
              await tab.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
            ).toBeLessThanOrEqual(0);
            if (shotsDir !== '')
              await tab.screenshot({ path: join(shotsDir, `${style}-${viewport.name}-${scheme}.png`), fullPage: true });
            const misses = await roundSafeMisses(tab);
            expect(misses, `\n${describeRoundMisses(misses)}`).toEqual([]);
          } finally {
            await context.close();
          }
        });
      });
