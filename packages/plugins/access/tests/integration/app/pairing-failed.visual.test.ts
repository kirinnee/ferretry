/**
 * THE "PAIRING FAILED" SCREEN in a real browser over fake data (`fixtures/pairing-failed-scene.tsx`): the owner's SSH
 * tunnel case, where the direct address answered nothing and the relay said the machine is not connected.
 *
 *  - it LEADS with what was tried, in order, and the loopback address is a clause, not the verdict;
 *  - "Most likely fix" is a real numbered list, in the order the fixes should be tried.
 *
 * Set `FY_PAIRING_FAILED_SHOTS_DIR` to keep `<viewport>-<scheme>.png` (phone 390 and desktop 1280, light and dark).
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(30_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_PAIRING_FAILED_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-pairing-failed-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/pairing-failed-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the pairing-failed scene did not build (${code}):\n${stderr}\n${stdout}`);
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
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const VARIANTS = [
  { name: 'desktop-light', width: 1_280, height: 800, phone: false, scheme: 'light' },
  { name: 'desktop-dark', width: 1_280, height: 800, phone: false, scheme: 'dark' },
  { name: 'phone-light', width: 390, height: 844, phone: true, scheme: 'light' },
  { name: 'phone-dark', width: 390, height: 844, phone: true, scheme: 'dark' },
] as const;

describe('Pairing failed', () => {
  for (const variant of VARIANTS) {
    it(`${variant.name}: leads with what was tried and lists the fixes in order`, async () => {
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
      try {
        await tab.goto(`${origin}/?theme=studio-${variant.scheme}`);
        await tab.getByRole('button', { name: 'Pair this device' }).click();
        await tab.waitForSelector('[data-pairing-failure="transport"]');
        const lines = await tab.locator('[data-pairing-failure] p').allInnerTexts();
        expect(lines[0]).toStartWith('First, directly at 127.0.0.1:7617: no answer.');
        expect(lines[1]).toStartWith("Then Ferretry's relay");
        expect(lines[2]).toBe('Most likely fix:');
        expect(await tab.locator('[data-pairing-failure] ol > li').count()).toBe(4);
        expect(await tab.locator('body').innerText()).not.toContain('can never reach');
        if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${variant.name}.png`) });
      } finally {
        await context.close();
      }
    });
  }
});
