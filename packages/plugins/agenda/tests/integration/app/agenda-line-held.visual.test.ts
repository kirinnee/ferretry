/**
 * E9, in a real browser, on a phone (390px) and a desktop, in light and dark, over fake data:
 *
 *  - the agenda line's pill keeps its chevron whole while the held-replies notice shares the row (it was clipped by the
 *    pill's `overflow: hidden`);
 *  - the card of a held config write links to its held text.
 *
 * Set `FY_E9_SHOTS_DIR` to keep `<viewport>-<scheme>-<scene>.png`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_E9_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-e9-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/agenda-line-held-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the E9 scene did not build (${code}):\n${stderr}\n${stdout}`);
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
  { name: 'phone', viewport: { width: 390, height: 500 }, deviceScaleFactor: 2 },
  { name: 'desktop', viewport: { width: 1_280, height: 500 }, deviceScaleFactor: 1 },
] as const;

const open = async (
  scene: string,
  name: (typeof VIEWPORTS)[number]['name'],
  scheme: 'light' | 'dark',
): Promise<{ tab: Page; close: () => Promise<void> }> => {
  const viewport = VIEWPORTS.find(entry => entry.name === name) ?? VIEWPORTS[0];
  const context = await browser.newContext({
    viewport: viewport.viewport,
    colorScheme: scheme,
    deviceScaleFactor: viewport.deviceScaleFactor,
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  await tab.goto(`${origin}/?theme=studio-${scheme}&scene=${scene}`);
  return { tab, close: async () => await context.close() };
};

describe('the agenda line pill beside the held-replies notice', () => {
  for (const { name } of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const)
      it(`E9 keeps the chevron whole inside the pill (${name}, ${scheme})`, async () => {
        const { tab, close } = await open('line', name, scheme);
        try {
          await tab.waitForSelector('[data-agenda-line-toggle] .fy-agenda-line__chevron');
          await tab.waitForSelector('[data-agenda-replies]');
          await tab.evaluate(
            () => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
          );
          const boxes = await tab.evaluate(() => {
            const pill = document.querySelector('[data-agenda-line-toggle]')?.getBoundingClientRect();
            const chevron = document.querySelector('.fy-agenda-line__chevron')?.getBoundingClientRect();
            const row = document.querySelector('.fy-agenda-line')?.getBoundingClientRect();
            if (pill === undefined || chevron === undefined || row === undefined) throw new Error('no pill');
            return {
              pillRight: pill.right,
              chevronLeft: chevron.left,
              chevronRight: chevron.right,
              rowRight: row.right,
            };
          });
          expect(boxes.chevronRight, 'the chevron ends inside the pill').toBeLessThanOrEqual(boxes.pillRight + 0.5);
          expect(boxes.chevronLeft, 'the chevron is not pushed out of the pill to its left').toBeGreaterThan(0);
          expect(boxes.pillRight, 'the pill ends inside the row').toBeLessThanOrEqual(boxes.rowRight + 0.5);
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${name}-${scheme}-line.png`) });
        } finally {
          await close();
        }
      });
});

describe('the card of a held config write', () => {
  for (const { name } of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const)
      it(`E9 links to the held text (${name}, ${scheme})`, async () => {
        const { tab, close } = await open('held', name, scheme);
        try {
          const link = await tab.waitForSelector('[data-agenda-held-text-link]');
          expect(await link.getAttribute('href')).toBe('/d/studio/settings/kernel/files');
          const box = await link.boundingBox();
          expect(box?.width ?? 0).toBeGreaterThan(40);
          expect(box?.x ?? 0).toBeGreaterThanOrEqual(0);
          expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(name === 'phone' ? 390 : 1_280);
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${name}-${scheme}-held.png`) });
        } finally {
          await close();
        }
      });
});
