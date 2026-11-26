/**
 * THE PAIR PAGE IS ROUND-SAFE IN EVERY STATE IT OPENS INTO (owner ask &B210; PR 2559 review: "the empty pair view and its opened
 * scanner/paste/help states"). A real browser draws the REAL `PairingScreen` (`fixtures/pairing-scene.tsx`, fake seed, no daemon)
 * at a phone (390) and a desktop (1440), light and dark, in the default look (Studio) and in the two roundest looks (Gen Z,
 * Neumorphism), and asserts the geometric rule of `round-safe.ts`: no content leaves the inner rounded rectangle of the box it sits in.
 *
 *   cold            no link, a browser that can scan: the three ways in ("Scan QR code", "Upload a QR image", "Paste a link")
 *   cold-no-camera  no link, a browser that cannot scan: the pasted-link field is the way
 *   paste           "Paste a link" chosen: the field and its button open
 *   scanner         "Scan QR code" chosen: the camera viewfinder and its how-to line open
 *   help            "How this works" opened
 *   confirm         a link arrived: the machine to pair with, and its one button
 *   failed          the link was redeemed and the machine did not answer: the failure card
 *
 * Set `FY_ROUND_SAFE_SHOTS_DIR` to keep `<look>-<viewport>-<scheme>-<state>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { describeRoundMisses, roundSafeMisses, sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(120_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_ROUND_SAFE_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-round-safe-pair-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/pairing-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the pairing scene did not build (${code}):\n${stderr}\n${stdout}`);
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

const LOOKS = [
  { style: 'studio', palette: 'studio' },
  { style: 'genz', palette: 'vaporwave' },
  { style: 'neumorphism', palette: 'afterglow' },
] as const;
const VIEWPORTS = [
  { name: '390', width: 390, height: 844, phone: true },
  { name: '1440', width: 1_440, height: 900, phone: false },
] as const;

/** Each state: the scene's query, and what to do on the page once it has drawn. */
const STATES: readonly { name: string; query: string; act?: (page: Page) => Promise<void> }[] = [
  { name: 'cold', query: 'arrival=cold&scan=camera' },
  { name: 'cold-no-camera', query: 'arrival=cold' },
  {
    name: 'paste',
    query: 'arrival=cold&scan=camera',
    act: async page => {
      await page.getByText('Paste a link', { exact: true }).click();
      await page.waitForSelector('#pairing-link');
    },
  },
  {
    name: 'scanner',
    query: 'arrival=cold&scan=camera',
    act: async page => {
      await page.getByText('Scan QR code', { exact: true }).click();
      await page.waitForSelector('[aria-label="Camera viewfinder"]');
    },
  },
  {
    name: 'help',
    query: 'arrival=cold&scan=camera',
    act: async page => {
      await page.getByText('How this works', { exact: true }).click();
    },
  },
  { name: 'confirm', query: 'arrival=link' },
  { name: 'failed', query: 'arrival=broken&scan=camera' },
];

for (const look of LOOKS) {
  for (const viewport of VIEWPORTS) {
    for (const scheme of ['light', 'dark'] as const) {
      describe(`round-safe pair: ${look.style} ${viewport.name} ${scheme}`, () => {
        for (const state of STATES) {
          it(state.name, async () => {
            const context = await browser.newContext({
              viewport: { width: viewport.width, height: viewport.height },
              deviceScaleFactor: viewport.phone ? 2 : 1,
              hasTouch: viewport.phone,
              isMobile: viewport.phone,
              colorScheme: scheme,
              reducedMotion: 'reduce',
            });
            try {
              const origin = server?.url.origin ?? '';
              await context.route('**/*', async route =>
                new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
              );
              const page = await context.newPage();
              await page.goto(`${origin}/?theme=${look.palette}-${scheme}&motion=reduced&${state.query}`);
              await page.evaluate(style => document.documentElement.setAttribute('data-style', style), look.style);
              await page.waitForSelector('[data-pairing-stage]');
              await page.evaluate(async () => await document.fonts.ready);
              await state.act?.(page);
              await page.waitForTimeout(400);
              if (shotsDir !== '')
                await page.screenshot({
                  path: join(shotsDir, `${look.style}-${viewport.name}-${scheme}-${state.name}.png`),
                  fullPage: true,
                });
              const misses = await roundSafeMisses(page);
              expect(misses, `\n${describeRoundMisses(misses)}`).toEqual([]);
            } finally {
              await context.close();
            }
          });
        }
      });
    }
  }
}
