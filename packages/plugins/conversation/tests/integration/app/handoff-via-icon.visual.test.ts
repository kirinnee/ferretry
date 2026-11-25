/**
 * THE "VIA TURN FILE" NOTE IS AN ICON, in a real browser (owner decision L262 B).
 *
 * A message handed to the agent through a turn file used to carry the words "via turn file" on the foot of
 * the reader's own bubble — also on a short opening message, where they explain nothing the reader needs.
 * Now the foot draws the ⓘ alone; the words are its accessible label, its hover title, and a line that opens
 * under the foot on a tap or a keypress. The scene is the real `Transcript` of `send-handover-scene.tsx`
 * stopped on the stage where the message has landed and been read.
 *
 * Set `FY_VIA_SHOTS_DIR` to keep the closed and the opened foot at 390 and 1440, light and dark.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_VIA_SHOTS_DIR ?? '';
const WORDS = 'via turn file';

const SCENE_CSS = `
  html, body, #root { height: 100%; margin: 0; }
  .scene-chat { box-sizing: border-box; display: flex; flex-direction: column; inset: 0; position: fixed; }
  .scene-chat .fy-transcript-shell { flex: 1 1 auto; margin: 0 auto; max-width: 760px; padding: 0 16px; width: 100%; box-sizing: border-box; }
`;

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-via-icon-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/send-handover-scene.tsx'],
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
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>${SCENE_CSS}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
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

const VIEWPORTS = [
  { name: '390', width: 390, height: 844, phone: true },
  { name: '1440', width: 1_440, height: 900, phone: false },
] as const;

const landed = async (page: Page, origin: string, mode: 'light' | 'dark'): Promise<void> => {
  await page.goto(`${origin}/?path=turn-file&pause=1&read=0&theme=studio-${mode}`);
  await page.waitForSelector('.fy-transcript-content');
  await page.evaluate(() => (window as unknown as { __handover: { goto: (n: number) => void } }).__handover.goto(3));
  await page.waitForSelector('[data-stage="replied"]');
  await page.waitForSelector('.fy-handoff-via-button');
  await page.waitForTimeout(120);
};

describe('the "via turn file" note on the reader’s own message', () => {
  for (const viewport of VIEWPORTS)
    for (const mode of ['light', 'dark'] as const)
      it(`is the icon alone at ${viewport.name} ${mode}, with the words one tap away`, async () => {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          colorScheme: mode,
          deviceScaleFactor: viewport.phone ? 2 : 1,
          ...(viewport.phone ? { isMobile: true, hasTouch: true } : {}),
        });
        try {
          const origin = server?.url.origin ?? '';
          await context.route('**/*', async route =>
            new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
          );
          const page = await context.newPage();
          await landed(page, origin, mode);
          const via = page.locator('.fy-handoff-via-button');
          expect(await via.count()).toBe(1);

          // Closed: no words on the line, an icon drawn, the label and the hover title carry the words.
          expect(((await via.innerText()) ?? '').trim()).toBe('');
          expect(await via.locator('svg').count()).toBe(1);
          expect(await via.getAttribute('aria-label')).toContain(WORDS);
          expect(await via.getAttribute('title')).toBeTruthy();
          const body = (await page.locator('.fy-message-user:has(.fy-handoff-via-button)').innerText()).toLowerCase();
          expect(body).not.toContain(WORDS);
          expect(await page.locator('[data-handoff-note="explained"]').count()).toBe(0);
          const box = await via.boundingBox();
          expect(box).not.toBeNull();
          expect(box?.width ?? 99).toBeLessThanOrEqual(24);
          if (shotsDir !== '')
            await page.screenshot({ path: join(shotsDir, `via-icon-closed-${viewport.name}-${mode}.png`) });

          // Opened by a tap (a phone) or a click (a desktop): the explanation is drawn, inside the screen.
          await (viewport.phone ? via.tap() : via.click());
          const note = page.locator('[data-handoff-note="explained"]');
          await note.waitFor();
          expect(await note.innerText()).toContain('handed to the agent as a file');
          const noteBox = await note.boundingBox();
          expect(noteBox).not.toBeNull();
          expect((noteBox?.x ?? -1) >= 0 && (noteBox?.x ?? 0) + (noteBox?.width ?? 0) <= viewport.width).toBe(true);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
          if (shotsDir !== '')
            await page.screenshot({ path: join(shotsDir, `via-icon-open-${viewport.name}-${mode}.png`) });
        } finally {
          await context.close();
        }
      }, 60_000);
});
