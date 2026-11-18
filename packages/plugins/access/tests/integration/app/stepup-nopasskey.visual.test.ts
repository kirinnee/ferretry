/**
 * THE STEP-UP PROMPT for a device with NO passkey, in a real browser over fake data (`fixtures/stepup-nopasskey-scene.tsx`):
 *
 *  - (a) a passkey window is open: "Add a passkey to this device" with the Add a passkey button, no command;
 *  - (b) no window: "This device has no passkey yet", the exact command (the program the daemon reports) and its copy button.
 *
 * Set `FY_STEPUP_NOPASSKEY_SHOTS_DIR` to keep `<state>-<viewport>-<scheme>.png` (phone 390, desktop 1280, light and dark).
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(30_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_STEPUP_NOPASSKEY_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-stepup-nopasskey-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/stepup-nopasskey-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the step-up scene did not build (${code}):\n${stderr}\n${stdout}`);
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

const VIEWPORTS = [
  { name: 'desktop-light', width: 1_280, height: 800, phone: false, scheme: 'light' },
  { name: 'desktop-dark', width: 1_280, height: 800, phone: false, scheme: 'dark' },
  { name: 'phone-light', width: 390, height: 844, phone: true, scheme: 'light' },
  { name: 'phone-dark', width: 390, height: 844, phone: true, scheme: 'dark' },
] as const;

describe('Confirm it’s you, for a device with no passkey', () => {
  for (const state of ['window', 'no-window'] as const)
    for (const variant of VIEWPORTS) {
      it(`${state} ${variant.name}: shows the right step and never overflows`, async () => {
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
          await tab.goto(`${origin}/?theme=studio-${variant.scheme}&state=${state}`);
          await tab.waitForSelector('[data-step-up-dialog]');
          // The read settles after the first paint: wait for the step it leads to.
          await tab.waitForSelector(
            state === 'window' ? '[data-step-up-first-passkey]' : '[data-passkey-owner-command]',
          );
          const dialog = tab.locator('[data-step-up-dialog]');
          const text = await dialog.innerText();
          expect(text).toContain('Add a passkey');
          if (state === 'window') expect(text).not.toContain('passkey window');
          else {
            expect(text).toContain('This device has no passkey yet');
            expect(await tab.locator('[data-passkey-owner-command] code').innerText()).toBe(
              "fy5 passkey window 'Fake Browser'",
            );
            expect(text.indexOf('no passkey yet')).toBeLessThan(text.indexOf('No window is open'));
          }
          const overflow = await tab.evaluate(
            () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
          );
          expect(overflow).toBe(false);
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${state}-${variant.name}.png`) });
        } finally {
          await context.close();
        }
      });
    }
});
