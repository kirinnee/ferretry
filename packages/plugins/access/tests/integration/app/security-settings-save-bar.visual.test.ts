/**
 * THE SECURITY SETTINGS' sticky Save bar never covers a row at the end of the page: the content ends with room equal to
 * the bar's height (`fixtures/security-settings-scene.tsx`), in a real browser on a phone and a desktop, light and dark,
 * over fake data. Set `FY_SECURITY_SHOTS_DIR` to keep `<viewport>-<scheme>-<where>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(30_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_SECURITY_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-security-scene-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/security-settings-scene.tsx'],
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
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const VIEWPORTS = [
  { name: '1440', width: 1_440, height: 420, phone: false },
  { name: '390', width: 390, height: 420, phone: true },
] as const;

describe('the Security settings Save bar', () => {
  for (const viewport of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const)
      it(`leaves the last row clear of the bar at the end of the page (${viewport.name}, ${scheme})`, async () => {
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
          await tab.goto(`${origin}/?theme=studio-${scheme}`);
          await tab.waitForSelector('[data-security-save]', { timeout: 15_000 });
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${scheme}-top.png`) });
          // Part-way down, with the Limits form entered: the bar is stuck at the foot and covers whatever scrolls under it.
          await tab.evaluate(() => {
            const group = document.querySelector('[data-setting-saves="on-save"]') as HTMLElement | null;
            document.querySelector('[data-scene-scroll]')?.scrollTo(0, (group?.offsetTop ?? 0) - 40);
          });
          await tab.waitForTimeout(150);
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${scheme}-mid.png`) });
          await tab.evaluate(() => {
            const scroller = document.querySelector('[data-scene-scroll]');
            scroller?.scrollTo(0, scroller.scrollHeight);
          });
          await tab.waitForTimeout(150);
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${scheme}-end.png`) });
          // The foot of the last row, against the top of the bar: the bar rests where it sticks, and the row above it ends clear.
          const gap = await tab.evaluate(() => {
            const bar = document.querySelector('[data-setting-savebar]')?.getBoundingClientRect();
            const rows = [...document.querySelectorAll('[data-security-settings] ul > li')].map(row =>
              row.getBoundingClientRect(),
            );
            const last = rows.at(-1);
            return bar === undefined || last === undefined ? null : { gap: bar.top - last.bottom, bar: bar.height };
          });
          expect(gap).not.toBeNull();
          // Room equal to the bar's own height (a rounding pixel either way).
          expect(Math.abs((gap?.gap ?? 0) - (gap?.bar ?? 0))).toBeLessThanOrEqual(1.5);
        } finally {
          await context.close();
        }
      });
});
