/**
 * THE FULL-PAGE "CANNOT USE THIS MACHINE" SCREENS ARE ROUND-SAFE (owner ask &B210, 2026-11-25). These pages replaced the
 * device-refused banner on the daemons page, so they are held to the same geometric rule (`tests/support/browser/round-safe.ts`):
 * no content leaves the inner rounded rectangle of the box it sits in, at a phone (390) and a desktop (1440), light and dark, in
 * the default look and the two roundest, in every end state (`fixtures/machine-stop-scene.tsx`).
 * Set `FY_ROUND_SAFE_SHOTS_DIR` to keep `<look>-<viewport>-<scheme>-<state>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';
import { describeRoundMisses, roundSafeMisses, sceneBuilder, sharedChromium } from '../support/browser/index.ts';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_ROUND_SAFE_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-round-safe-stop-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/machine-stop-scene.tsx'],
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

const LOOKS = ['studio', 'genz', 'neumorphism'] as const;
const VIEWPORTS = [
  { name: '1440', width: 1_440, height: 900, phone: false },
  { name: '390', width: 390, height: 844, phone: true },
] as const;
const STATES = [
  'refused',
  'turned-away',
  'no-key',
  'unreadable',
  'needs-update',
  'needs-reload',
  'not-paired',
  'no-key-other',
  'not-paired-other',
] as const;

for (const style of LOOKS)
  for (const viewport of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const)
      describe(`machine-stop ${style} ${viewport.name} ${scheme}`, () => {
        for (const state of STATES)
          it(`${state}: no content leaves the inner rounded rectangle of its box`, async () => {
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
              await tab.goto(`${origin}/d/ws?theme=studio-${scheme}&style=${style}&state=${state}`);
              await tab.waitForSelector('[data-machine-stop]', { timeout: 15_000 });
              await tab.evaluate(async () => await document.fonts.ready);
              await tab.evaluate(
                () => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
              );
              if (shotsDir !== '')
                await tab.screenshot({
                  path: join(shotsDir, `${style}-${viewport.name}-${scheme}-${state}.png`),
                  fullPage: true,
                });
              const misses = await roundSafeMisses(tab);
              expect(misses, `\n${describeRoundMisses(misses)}`).toEqual([]);
            } finally {
              await context.close();
            }
          });
      });
