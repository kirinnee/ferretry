/**
 * THE HONEST COPY OF A SEND'S RETRY, in a real browser. The daemon's explicit send retry answers 503, so a flagged
 * send row offers no Retry and says typing it again is not in 5.0 yet, and the notice under the composer draws only
 * "Send it" and "Clear it". The scene (`fixtures/retry-pending-scene.tsx`) draws FIXED fake data at a fixed clock
 * (2026-11-12T09:00Z, UTC, en-GB): a send the agent never showed, one proven absent, and the composer notice.
 *
 * It checks the sentence is on screen, that no Retry button or menu item is drawn, that the text is readable
 * (contrast from the COMPUTED colours, at least 4.5:1), and that nothing overflows the viewport.
 *
 * Set `FY_RETRY_PENDING_SHOTS_DIR` to keep the scene at a phone and a desktop, light and dark.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_RETRY_PENDING_SHOTS_DIR ?? '';

const SCENE_CSS = `
  html, body, #root { height: 100%; margin: 0; }
  .scene-chat { box-sizing: border-box; display: flex; flex-direction: column; inset: 0; position: fixed; }
  .scene-chat .fy-transcript-shell { flex: 1 1 auto; margin: 0 auto; max-width: 760px; padding: 0 16px; width: 100%; box-sizing: border-box; }
  .scene-notice { box-sizing: border-box; margin: 0 auto; max-width: 760px; padding: 0 16px 12px; width: 100%; }
`;

const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844, phone: true },
  { name: 'desktop', width: 1_440, height: 900, phone: false },
] as const;

const ROW_COPY =
  'Not in 5.0 yet: typing this message again (Retry). If it is missing from the chat, send it again yourself.';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-retry-pending-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/retry-pending-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the retry-pending scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const html = `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>${SCENE_CSS}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      const path = new URL(request.url).pathname;
      if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
      if (path === '/') return new Response(html, { headers: { 'content-type': 'text/html' } });
      return new Response('not here', { status: 404 });
    },
  });
  browser = await sharedChromium();
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const newContext = async (viewport: (typeof VIEWPORTS)[number], mode: 'light' | 'dark'): Promise<BrowserContext> => {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme: mode,
    locale: 'en-GB',
    timezoneId: 'UTC',
    reducedMotion: 'reduce',
    deviceScaleFactor: viewport.phone ? 2 : 1,
    ...(viewport.phone ? { isMobile: true, hasTouch: true } : {}),
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  return context;
};

const open = async (context: BrowserContext, mode: 'light' | 'dark'): Promise<Page> => {
  const tab = await context.newPage();
  await tab.goto(`${server?.url.origin ?? ''}/?theme=studio-${mode}`);
  await tab.waitForSelector('.fy-transcript-content');
  await tab.waitForSelector('[data-send-retry-pending]');
  await tab.waitForTimeout(150);
  return tab;
};

/** WCAG relative luminance of an `rgb(…)`/`rgba(…)` string; the page's solid background is composited by the caller. */
const contrastOf = async (tab: Page, selector: string): Promise<number> =>
  await tab.evaluate(sel => {
    const channels = (value: string): number[] => (value.match(/[\d.]+/g) ?? []).map(Number);
    const luminance = ([r, g, b]: number[]): number => {
      const lin = (c: number): number => {
        const s = (c ?? 0) / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * lin(r ?? 0) + 0.7152 * lin(g ?? 0) + 0.0722 * lin(b ?? 0);
    };
    const node = document.querySelector(sel) as HTMLElement;
    const fg = channels(getComputedStyle(node).color);
    // The first ancestor with an opaque-enough background; the body's is always set.
    let background = [255, 255, 255];
    for (let at: HTMLElement | null = node; at !== null; at = at.parentElement) {
      const parsed = channels(getComputedStyle(at).backgroundColor);
      if (parsed.length >= 3 && (parsed[3] ?? 1) > 0.99) {
        background = parsed;
        break;
      }
    }
    const alpha = fg[3] ?? 1;
    const mixed = [0, 1, 2].map(i => (fg[i] ?? 0) * alpha + (background[i] ?? 0) * (1 - alpha));
    const a = luminance(mixed);
    const b = luminance(background);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }, selector);

describe('the send Retry’s copy, at a fixed clock', () => {
  for (const viewport of VIEWPORTS)
    for (const mode of ['light', 'dark'] as const)
      it(`says Retry is not in 5.0 yet and draws none, readably, at ${viewport.name} in ${mode}`, async () => {
        const context = await newContext(viewport, mode);
        try {
          const tab = await open(context, mode);
          const rows = tab.locator('[data-send-retry-pending]');
          expect(await rows.count()).toBe(2);
          for (const row of await rows.all()) expect(await row.innerText()).toBe(ROW_COPY);
          expect(await tab.locator('[data-unconfirmed-action]').allInnerTexts()).toEqual(['Send it', 'Clear it']);
          expect(await tab.locator('[data-unconfirmed-send]').innerText()).toContain('Retry) is not in 5.0 yet.');
          const page = await tab.locator('body').innerText();
          expect(page).not.toContain('Send again');
          expect(page).not.toContain('cannot send it twice');
          expect(await tab.getByRole('button', { name: /^retry$/i }).count()).toBe(0);
          for (const selector of ['[data-send-retry-pending]', '.fy-occupied-composer__hint'])
            expect(await contrastOf(tab, selector)).toBeGreaterThanOrEqual(4.5);
          expect(await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
          if (shotsDir !== '')
            await tab.screenshot({ path: join(shotsDir, `retry-pending-${viewport.name}-${mode}.png`) });
        } finally {
          await context.close();
        }
      }, 60_000);
});
