/**
 * THE SETUP FLOW (`fixtures/setup-flow-scene.tsx`) in a real browser on a phone and a desktop, light and dark, over fake
 * data: the loading cover, a choice page, the "Only on" chip, a busy page, a frame mid slide-in and the end page. Set
 * `FY_SETUP_FLOW_SHOTS_DIR` to keep `<viewport>-<scheme>-<case>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_SETUP_FLOW_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-setup-flow-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/setup-flow-scene.tsx'],
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
    fetch: request => {
      const path = new URL(request.url).pathname;
      if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
      return new Response(page, { headers: { 'content-type': 'text/html' } });
    },
  });
  browser = await sharedChromium();
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
const CASES = [
  'loading',
  'silent',
  'choice',
  'chip',
  'busy',
  'transition',
  'end',
  'legacy',
  'unsaved',
  'end-unsaved',
] as const;

describe('the setup flow', () => {
  for (const viewport of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const)
      it(`draws every page state without sideways scroll, the footer in view and buttons that are not full width (${viewport.name}, ${scheme})`, async () => {
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
        const tab = await context.newPage();
        try {
          for (const scene of CASES) {
            await tab.goto(`${origin}/?theme=studio-${scheme}&case=${scene}`);
            await tab.waitForSelector('[data-scene-ready]');
            if (scene === 'silent') {
              await tab.waitForSelector('[data-flow-silent]');
              // The loader fades in after a beat (no flash for a fast answer): shoot it settled.
              await tab.waitForTimeout(900);
            } else await tab.waitForTimeout(scene === 'transition' ? 50 : 300);
            const overflow = await tab.evaluate(
              () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
            );
            expect(overflow, `${scene}: the page does not scroll sideways`).toBeLessThanOrEqual(0);
            // The cover and the page never show together.
            const covered = (await tab.$$('[data-flow-cover]')).length;
            const slot = await tab.$('.fy-sf-slot');
            const slotShown = slot === null ? false : await slot.isVisible();
            expect(covered > 0 && slotShown, `${scene}: the cover and the page never show together`).toBe(false);
            expect(covered > 0, `${scene}: the cover is up exactly while the page has not said ready`).toBe(
              scene === 'loading' || scene === 'silent',
            );
            // The footer is in the viewport, and no footer button is anywhere near full width.
            const footer = await tab.$('[data-step-footer]');
            expect(footer, `${scene}: a footer`).not.toBeNull();
            const box = await footer?.boundingBox();
            expect(
              box === null || box === undefined ? 0 : box.y + box.height,
              `${scene}: the footer is on screen`,
            ).toBeLessThanOrEqual(viewport.height + 1);
            const widths = await tab.$$eval('[data-step-footer] button', buttons =>
              buttons.map(button => ({
                w: button.getBoundingClientRect().width,
                h: button.getBoundingClientRect().height,
              })),
            );
            for (const size of widths) {
              expect(size.w, `${scene}: a footer button is not full width`).toBeLessThan(
                (viewport.phone ? 0.7 : 0.5) * viewport.width,
              );
              expect(size.h, `${scene}: a footer button is at least 44px tall`).toBeGreaterThanOrEqual(43.5);
            }
            if (scene === 'silent') {
              expect(await tab.$$('[data-flow-skip]')).toHaveLength(1);
              const skip = await (await tab.$('[data-flow-skip]'))?.boundingBox();
              expect(skip?.height ?? 0, 'Skip this step is a 44px target').toBeGreaterThanOrEqual(43.5);
              expect(
                await tab.$$('[data-flow-cover] [data-loading]'),
                'the spinner is drawn with the note',
              ).toHaveLength(1);
            }
            if (scene === 'choice') {
              const later = await (await tab.$('[data-flow-later]'))?.boundingBox();
              expect(later?.height ?? 0, 'Later is a 44px target').toBeGreaterThanOrEqual(43.5);
            }
            if (scene === 'chip') expect(await tab.textContent('[data-only-on]')).toBe('Only on studio-box');
            if (scene === 'busy') {
              expect(await tab.$eval('[data-step-next]', next => (next as HTMLButtonElement).disabled)).toBe(true);
              expect(await tab.$eval('[data-step-back]', back => (back as HTMLButtonElement).disabled)).toBe(true);
              expect(await tab.$eval('[data-flow-later]', later => (later as HTMLButtonElement).disabled)).toBe(true);
            }
            if (scene === 'legacy') {
              expect(await tab.$eval('[data-step-next]', next => (next as HTMLButtonElement).disabled)).toBe(false);
              expect(await tab.$('[data-flow-cover]'), 'a legacy page has no cover').toBeNull();
            }
            if (scene === 'unsaved' || scene === 'end-unsaved') {
              expect(await tab.$('[data-flow-unsaved]'), `${scene}: says an answer was not saved`).not.toBeNull();
              const retries = await tab.$$eval('[data-flow-retry-save]', buttons =>
                buttons.map(button => button.getBoundingClientRect().height),
              );
              expect(retries.length, `${scene}: a Try again`).toBeGreaterThan(0);
              for (const height of retries)
                expect(height, `${scene}: Try again is a 44px target`).toBeGreaterThanOrEqual(43.5);
            }
            if (shotsDir !== '')
              await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${scheme}-${scene}.png`), fullPage: true });
          }
        } finally {
          await context.close();
        }
      });
});
