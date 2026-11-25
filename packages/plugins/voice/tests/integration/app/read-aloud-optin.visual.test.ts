/**
 * r11 S12 · READ ALOUD IS OPT-IN (the owner: "Read aloud is really annoying"). The ASSERT, in real Chromium over fixed fake data
 * (`fixtures/read-aloud-optin-scene.tsx`), at 1280 and 390 wide, light and dark:
 *
 *   1. A FRESH device (no stored voice settings) with a chat of 3 assistant messages has ZERO elements named "Read aloud".
 *   2. Settings › Voice has the switch "Show Read aloud on each reply", OFF. Turning it on, then going back to the chat, gives each of
 *      the 3 messages exactly one "Read aloud" button.
 *   3. A reload keeps it on (it is stored on this device).
 *   4. A settings record stored BEFORE this field existed (format 1, no `readAloudButton`) shows no button.
 *   5. Turning the switch off again removes the buttons.
 *   6. On a computer known to run an older Ferretry, the note names the switch by its exact on-screen label (L96).
 *
 * Set `FY_READ_ALOUD_OPTIN_SHOTS_DIR` to keep `<viewport>-<scheme>-<step>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_READ_ALOUD_OPTIN_SHOTS_DIR ?? '';
const SETTINGS_KEY = 'fy:voice:live-settings';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-read-aloud-optin-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/read-aloud-optin-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the read-aloud opt-in scene did not build (${code}):\n${stderr}\n${stdout}`);
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
}, 240_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const VIEWPORTS = [
  { name: '1280', width: 1_280, height: 900, phone: false },
  { name: '390', width: 390, height: 844, phone: true },
] as const;

type Viewport = (typeof VIEWPORTS)[number];

const shoot = async (page: Page, viewport: Viewport, scheme: string, step: string): Promise<void> => {
  if (shotsDir === '') return;
  await page.waitForTimeout(450); // let a switch finish its slide before the picture
  await page.screenshot({ path: join(shotsDir, `${viewport.name}-${scheme}-${step}.png`), fullPage: true });
};

const readAloudButtons = async (page: Page): Promise<number> =>
  await page.getByRole('button', { name: 'Read aloud' }).count();

describe('r11 S12: Read aloud is opt-in', () => {
  for (const viewport of VIEWPORTS) {
    for (const scheme of ['light', 'dark'] as const) {
      it(`${viewport.name} ${scheme}: none by default; the Voice switch turns it on for every message, and it stays on`, async () => {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          deviceScaleFactor: viewport.phone ? 2 : 1,
          hasTouch: viewport.phone,
          isMobile: viewport.phone,
          colorScheme: scheme,
        });
        const origin = server?.url.origin ?? '';
        await context.route('**/*', async route =>
          new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
        );
        const page = await context.newPage();
        page.setDefaultTimeout(8_000);
        const problems: string[] = [];
        page.on('pageerror', error => problems.push(error.message));
        const open = async (view: 'chat' | 'settings'): Promise<void> => {
          await page.goto(`${origin}/?view=${view}&theme=studio-${scheme}`);
          await page.waitForSelector(view === 'chat' ? '[data-message]' : '[data-auto-read-settings]');
        };
        try {
          // 1. A fresh device: three assistant messages, no button anywhere.
          await open('chat');
          expect(await page.locator('[data-message]').count()).toBe(3);
          await page.waitForTimeout(250);
          expect(await readAloudButtons(page)).toBe(0);
          expect(await page.getByText('Read aloud', { exact: false }).count()).toBe(0);
          await shoot(page, viewport, scheme, '1-chat-default');

          // 2. Settings › Voice: the switch is there, labelled, and OFF.
          await open('settings');
          const toggle = page.getByRole('switch', { name: 'Show Read aloud on each reply' });
          expect(await toggle.count()).toBe(1);
          expect(await toggle.getAttribute('aria-checked')).toBe('false');
          expect(await page.getByText('Off by default.', { exact: false }).count()).toBeGreaterThan(0);
          await shoot(page, viewport, scheme, '2-settings-off');
          await toggle.click();
          expect(await toggle.getAttribute('aria-checked')).toBe('true');
          await shoot(page, viewport, scheme, '3-settings-on');

          // ... and back in the chat every assistant message has exactly one button.
          await open('chat');
          await page.waitForSelector('.fy-read-aloud-button');
          expect(await readAloudButtons(page)).toBe(3);
          for (const message of await page.locator('[data-message]').all())
            expect(await message.getByRole('button', { name: 'Read aloud' }).count()).toBe(1);
          await shoot(page, viewport, scheme, '4-chat-on');

          // 3. A reload: still on (stored on this device).
          await page.reload();
          await page.waitForSelector('.fy-read-aloud-button');
          expect(await readAloudButtons(page)).toBe(3);

          // 5. Off again: the buttons go.
          await open('settings');
          await page.getByRole('switch', { name: 'Show Read aloud on each reply' }).click();
          await open('chat');
          await page.waitForTimeout(250);
          expect(await readAloudButtons(page)).toBe(0);

          // 4. A record from before the field existed (format 1, no `readAloudButton`): no button.
          await page.evaluate(
            ([key]) => localStorage.setItem(key as string, JSON.stringify({ format: 1, autoRead: false, rate: 1.1 })),
            [SETTINGS_KEY],
          );
          await open('chat');
          await page.waitForTimeout(250);
          expect(await readAloudButtons(page)).toBe(0);
          expect(problems).toEqual([]);
        } finally {
          await context.close();
        }
      });
    }
  }
});

describe('L96: the older-computer note names the Read aloud switch', () => {
  for (const viewport of VIEWPORTS) {
    for (const scheme of ['light', 'dark'] as const) {
      it(`${viewport.name} ${scheme}: the note quotes the label of the switch that is on screen`, async () => {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          deviceScaleFactor: viewport.phone ? 2 : 1,
          hasTouch: viewport.phone,
          isMobile: viewport.phone,
          colorScheme: scheme,
        });
        const origin = server?.url.origin ?? '';
        await context.route('**/*', async route =>
          new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
        );
        const page = await context.newPage();
        page.setDefaultTimeout(8_000);
        const problems: string[] = [];
        page.on('pageerror', error => problems.push(error.message));
        try {
          await page.goto(`${origin}/?view=settings&older=1&theme=studio-${scheme}`);
          await page.waitForSelector('[data-auto-read-needs-update]');
          const note = (await page.locator('[data-auto-read-needs-update]').textContent()) ?? '';
          const switchLabel = 'Show Read aloud on each reply';
          expect(await page.getByRole('switch', { name: switchLabel }).count()).toBe(1);
          expect(note).toContain(`“${switchLabel}”`);
          expect(note).not.toContain('still works');
          // The note is whole on screen: not clipped sideways and not wider than the viewport.
          const box = await page.locator('[data-auto-read-needs-update]').boundingBox();
          expect(box === null ? 0 : box.x + box.width).toBeLessThanOrEqual(viewport.width);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
          await shoot(page, viewport, scheme, '6-older-machine-note');
          expect(problems).toEqual([]);
        } finally {
          await context.close();
        }
      });
    }
  }
});
