/**
 * THE CI TIMELINE in a real browser over fake data (`fixtures/ci-timeline-scene.tsx`): a finished run, a running run and
 * a matrix, in light and dark, at 390 and 1280 wide.
 *
 *  - on a phone the chart scrolls sideways INSIDE its own box and never the page, the job names stay while it scrolls,
 *    and Fit squeezes the whole run into the box; on a wide screen there is no Fit and nothing scrolls;
 *  - hover shows ONE ring and one readout; a live run has a now-line.
 *
 * Set `FY_CI_TIMELINE_SHOTS_DIR` to keep `<case>-<viewport>-<theme>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(30_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_CI_TIMELINE_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-ci-timeline-'));
  const child = Bun.spawn(
    [
      process.execPath,
      sceneBuilder,
      '--out',
      directory,
      '--entry',
      resolve(packageRoot, 'fixtures/ci-timeline-scene.tsx'),
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the timeline scene did not build (${code}):\n${stderr}\n${stdout}`);
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

const VARIANTS = [
  { name: '1280-light', width: 1_280, phone: false, scheme: 'light' },
  { name: '1280-dark', width: 1_280, phone: false, scheme: 'dark' },
  { name: '390-light', width: 390, phone: true, scheme: 'light' },
  { name: '390-dark', width: 390, phone: true, scheme: 'dark' },
] as const;
const CASES = ['finished', 'running', 'matrix'] as const;

describe('the CI timeline', () => {
  for (const variant of VARIANTS)
    for (const scene of CASES) {
      it(`${scene} ${variant.name}: drawn once, scrolls only inside its box on a phone, one ring on hover`, async () => {
        const context = await browser.newContext({
          viewport: { width: variant.width, height: 900 },
          deviceScaleFactor: variant.phone ? 2 : 1,
          hasTouch: variant.phone,
          isMobile: variant.phone,
          colorScheme: variant.scheme,
        });
        const origin = server?.url.origin ?? '';
        await context.route('**/*', async route =>
          new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
        );
        const tab = await context.newPage();
        const problems: string[] = [];
        tab.on('pageerror', error => problems.push(error.message));
        try {
          await tab.goto(`${origin}/?theme=studio-${variant.scheme}&case=${scene}`);
          await tab.waitForSelector('[data-scene-ready] [data-ci-timeline] [data-step]');
          const overflow = await tab.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
          expect(overflow, 'the page never scrolls sideways').toBeLessThanOrEqual(0);

          const scroll = tab.locator('[data-ci-timeline-scroll]');
          const inner = await scroll.evaluate(box => box.scrollWidth - box.clientWidth);
          const fit = tab.locator('[data-ci-timeline-fit]');
          if (variant.phone) {
            expect(inner, 'the chart scrolls inside its own box').toBeGreaterThan(0);
            expect(await fit.count()).toBe(1);
          } else {
            expect(inner).toBeLessThanOrEqual(0);
            expect(await fit.count()).toBe(0);
          }

          if (shotsDir !== '')
            await tab.screenshot({ path: join(shotsDir, `${scene}-${variant.name}.png`), fullPage: true });

          // The first view shows the answer: a live run opens at its now-line, a failed run at its failing bar.
          if (variant.phone && scene !== 'matrix') {
            const target = scene === 'running' ? '[data-now-line] line' : '[data-step="j1s1"]';
            const inside = await tab.evaluate(
              ([boxSel, targetSel]) => {
                const scrollBox = document.querySelector(boxSel as string)!.getBoundingClientRect();
                const mark = document.querySelector(targetSel as string)!.getBoundingClientRect();
                const names = document.querySelector('[data-ci-timeline-row]')!.getBoundingClientRect();
                return mark.left >= names.right - 1 && mark.left < scrollBox.right - 8;
              },
              ['[data-ci-timeline-scroll]', target],
            );
            expect(inside, 'the first view starts at the now-line / the failing step, clear of the names').toBe(true);
          }

          // Hover one step: one ring, the readout names it.
          const step = tab.locator('[data-mark="j0s0"]');
          await step.scrollIntoViewIfNeeded();
          const box = await step.boundingBox();
          if (box !== null) await tab.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          if (!variant.phone) {
            expect(await tab.locator('[data-ring]').count()).toBe(1);
            expect(await tab.locator('[data-ci-timeline-readout]').textContent()).toContain('›');
            if (shotsDir !== '')
              await tab.screenshot({ path: join(shotsDir, `${scene}-${variant.name}-hover.png`), fullPage: true });
          }
          if (scene === 'running') expect(await tab.locator('[data-now-line]').count()).toBe(1);

          if (variant.phone) {
            await fit.click();
            expect(await fit.getAttribute('aria-pressed')).toBe('true');
            expect(await scroll.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
            if (shotsDir !== '')
              await tab.screenshot({ path: join(shotsDir, `${scene}-${variant.name}-fit.png`), fullPage: true });
          }
          expect(problems).toEqual([]);
        } finally {
          await context.close();
        }
      });
    }
});
