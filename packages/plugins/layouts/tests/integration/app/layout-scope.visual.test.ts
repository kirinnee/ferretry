/**
 * THE LAYOUT PAGE SAYS WHERE A CHANGE IS SAVED ONCE (S-46), in a real browser over fake data, INSIDE THE REAL SETTINGS SHELL
 * (`fixtures/layout-scope-register.tsx` over the app's `settings-shell-scene.tsx`). The page's switch ("Same on all my devices" /
 * "Just this device") is the one place that says it, so nothing around it may say otherwise: the tab is not filed under the nav's
 * "Just this device" block while the switch opens on "Same on all my devices", and no second chip repeats the switch.
 *
 * Set `FY_LAYOUT_SCOPE_SHOTS_DIR` to keep `<viewport>-<case>.png` (1440 and 390, light and dark).
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_LAYOUT_SCOPE_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-layout-scope-'));
  // The entry is generated, so the plugin reaches the app's scene by a path and never by an import (as Usage's settings test does).
  const entry = join(directory, 'entry.tsx');
  await Bun.write(
    entry,
    `import { registerLayoutScopeBody } from ${JSON.stringify(resolve(packageRoot, 'fixtures/layout-scope-register.tsx'))};\nregisterLayoutScopeBody();\nawait import(${JSON.stringify(resolve(packageRoot, '../../../../../app/tests/integration/fixtures/settings-shell-scene.tsx'))});\n`,
  );
  const child = Bun.spawn([process.execPath, sceneBuilder, '--out', directory, '--entry', entry], {
    cwd: packageRoot,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the layout scope scene did not build (${code}):\n${stderr}\n${stdout}`);
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
  { name: '1440-light', width: 1_440, height: 900, phone: false, scheme: 'light' },
  { name: '1440-dark', width: 1_440, height: 900, phone: false, scheme: 'dark' },
  { name: '390-light', width: 390, height: 844, phone: true, scheme: 'light' },
  { name: '390-dark', width: 390, height: 844, phone: true, scheme: 'dark' },
] as const;

describe('the Layout page says where a change is saved once', () => {
  for (const variant of VARIANTS) {
    it(`${variant.name}: the nav does not file Layout under "Just this device" and no chip repeats the switch`, async () => {
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
      try {
        await tab.goto(`${origin}/d/ws/settings/layouts/layout?theme=studio-${variant.scheme}`);
        await tab.waitForSelector('[data-layout-scope]');
        if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${variant.name}-layout.png`) });
        // A phone has no list beside the page, only the picker, whose option groups say the same thing: read whichever is drawn.
        const blockOfLayout = await tab.evaluate(() => {
          const link = [...document.querySelectorAll('nav[aria-label="Plugin settings"] a')].find(
            a => a.textContent?.trim() === 'Layout',
          );
          return link?.closest('section')?.getAttribute('aria-labelledby') ?? 'no-nav-link';
        });
        expect(blockOfLayout, 'Layout is filed under the machine block, not "Just this device"').toBe(
          'fy-settings-block-machine',
        );
        expect(await tab.locator('[data-layout-scope-chip]').count(), 'the switch is the only statement').toBe(0);
        expect(await tab.locator('[data-layout-scope]').getAttribute('data-layout-scope')).toBe('all');
        expect(problems).toEqual([]);
      } finally {
        await context.close();
      }
    });
  }
});
