/**
 * THE THREE USAGE SETTINGS TABS in a real browser over fake data (`fixtures/usage-settings-scene.tsx`): each draws its
 * groups and rows with no card inside a group, no sideways scroll at 1280 or 390, and every button at least 44px tall.
 *
 * Set `FY_USAGE_SETTINGS_SHOTS_DIR` to keep `<viewport>-<case>.png` (1280 and 390, light and dark).
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_USAGE_SETTINGS_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-usage-settings-'));
  const child = Bun.spawn(
    [
      process.execPath,
      sceneBuilder,
      '--out',
      directory,
      '--entry',
      resolve(packageRoot, 'fixtures/usage-settings-scene.tsx'),
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the usage settings scene did not build (${code}):\n${stderr}\n${stdout}`);
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
  { name: '1280-light', width: 1_280, height: 900, phone: false, scheme: 'light' },
  { name: '1280-dark', width: 1_280, height: 900, phone: false, scheme: 'dark' },
  { name: '390-light', width: 390, height: 900, phone: true, scheme: 'light' },
  { name: '390-dark', width: 390, height: 900, phone: true, scheme: 'dark' },
] as const;
type Variant = (typeof VARIANTS)[number];

const CASES = [
  { name: 'budgets', query: '&tab=budgets', ready: '[data-budget-editor]' },
  { name: 'pricing', query: '&tab=pricing', ready: '[data-pricing-row]' },
  { name: 'pricing-add', query: '&tab=pricing&act=add', ready: '[data-pricing-editor]' },
  { name: 'pricing-feed', query: '&tab=pricing&act=feed', ready: '[data-pricing-change]' },
  { name: 'performance', query: '&tab=performance', ready: '[data-performance]' },
  { name: 'performance-report', query: '&tab=performance&act=record', ready: '[data-performance-report]' },
] as const;

const open = async (variant: Variant, query: string, ready: string) => {
  const context = await browser.newContext({
    viewport: { width: variant.width, height: variant.height },
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
  tab.setDefaultTimeout(12_000);
  const problems: string[] = [];
  tab.on('pageerror', error => problems.push(error.message));
  await tab.goto(`${origin}/?theme=studio-${variant.scheme}${query}`);
  await tab.waitForSelector(ready);
  return { tab, problems, close: async () => await context.close() };
};

describe('the Usage settings tabs', () => {
  for (const variant of VARIANTS) {
    for (const scene of CASES) {
      it(`${variant.name} · ${scene.name}: grouped rows, no card in a group, no sideways scroll, tall buttons`, async () => {
        const { tab, problems, close } = await open(variant, scene.query, scene.ready);
        try {
          expect(await tab.locator('[data-setting-group]').count(), 'at least one group').toBeGreaterThan(0);
          expect(await tab.locator('.kt-groupcard .kt-panel').count(), 'no card inside a group').toBe(0);
          const overflow = await tab.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
          expect(overflow, 'no sideways scroll').toBeLessThanOrEqual(0);
          const short = await tab.evaluate(() =>
            [...document.querySelectorAll<HTMLElement>('button:not([disabled])')]
              .filter(button => button.offsetParent !== null && button.getBoundingClientRect().height < 43)
              .map(button => button.textContent?.trim() ?? ''),
          );
          expect(short, 'every visible button is at least 44px tall').toEqual([]);
          if (shotsDir !== '')
            await tab.screenshot({ fullPage: true, path: join(shotsDir, `${variant.name}-${scene.name}.png`) });
          expect(problems).toEqual([]);
        } finally {
          await close();
        }
      });
    }
  }
});
