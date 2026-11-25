/**
 * THE ANSWER-QUICKLY DECK'S EMPTY REPLY FIELD SHOWS ITS WHOLE PLACEHOLDER (end-list E208b), in a real browser over the REAL
 * app on the fake machine (`fixtures/mobile-scene.tsx`).
 *
 * At 390 the deck's composer was 326px wide against 382px in the chat (the foot's 16px inset on top of the page's 16px
 * gutter), so the field was 148px idle and 102px busy (the Interrupt button joins the row) and the placeholder read
 * "Message this fe…" or "Message t…". Idle and busy, light and dark, on a phone and a desktop, the open item's reply
 * field must be wide enough for the whole "Message this ferret" line.
 *
 * Needs fonts in the browser (a font-less Chromium draws zero-width text; the test says so). Set
 * `FY_DECK_REPLY_SHOTS_DIR` to keep `<width>-<theme>-<state>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';
import { sceneServer, sharedChromium } from '../support/browser/index.ts';

setDefaultTimeout(60_000);

const shotsDir = process.env.FY_DECK_REPLY_SHOTS_DIR ?? '';
const scene = new URL('./fixtures/mobile-scene.tsx', import.meta.url).pathname;

let browser: Browser;
let server: ReturnType<typeof Bun.spawn> | undefined;
let origin = '';

beforeAll(async () => {
  browser = await sharedChromium();
  server = Bun.spawn([process.execPath, sceneServer, '--entry', scene], { stderr: 'inherit', stdout: 'pipe' });
  const reader = (server.stdout as ReadableStream<Uint8Array>).getReader();
  const first = await Promise.race([
    reader.read(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the scene server did not start')), 90_000)),
  ]);
  origin = (JSON.parse(new TextDecoder().decode(first.value).trim().split('\n')[0] as string) as { origin: string })
    .origin;
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 120_000);

afterAll(() => {
  server?.kill();
});

/** The deck opens on kai's ask: his turn is idle, or running (`?busy=kai`). */
const STATES = [
  { name: 'idle', busy: '' },
  { name: 'busy', busy: 'kai' },
] as const;

const VIEWPORTS = [
  { width: 390, height: 844, phone: true },
  { width: 1_440, height: 900, phone: false },
] as const;

describe('the deck reply field shows its whole placeholder', () => {
  for (const viewport of VIEWPORTS)
    for (const theme of ['light', 'dark'] as const)
      for (const state of STATES)
        it(`${state.name} ferret, ${viewport.width}, ${theme}`, async () => {
          const context = await browser.newContext({
            viewport: { width: viewport.width, height: viewport.height },
            deviceScaleFactor: viewport.phone ? 2 : 1,
            hasTouch: viewport.phone,
            isMobile: viewport.phone,
            colorScheme: theme,
          });
          try {
            const tab = await context.newPage();
            tab.setDefaultTimeout(20_000);
            const busy = state.busy === '' ? '' : `&busy=${state.busy}`;
            await tab.goto(`${origin}/d/ws/agenda?theme=studio-${theme}${busy}`);
            await tab.waitForSelector('[data-agenda-quick]', { timeout: 30_000 });
            await tab.click('[data-agenda-quick]');
            await tab.waitForSelector('[data-inbox-composer] .fy-live-editor', { timeout: 20_000 });
            await tab.waitForTimeout(1_500);
            expect(await tab.$$('[data-composer-interrupt]')).toHaveLength(state.busy === '' ? 0 : 1);
            const reading = await tab.evaluate(() => {
              const editor = document.querySelector('[data-inbox-composer] .fy-live-editor') as HTMLElement;
              const placeholder = editor.getAttribute('data-placeholder') ?? '';
              // The placeholder drawn whole: its text measured in the field's own type, on one line.
              const canvas = document.createElement('canvas').getContext('2d') as CanvasRenderingContext2D;
              canvas.font = getComputedStyle(editor).font;
              return {
                field: editor.getBoundingClientRect().width,
                whole: canvas.measureText(placeholder).width,
                placeholder,
              };
            });
            if (shotsDir !== '')
              await tab.screenshot({ path: join(shotsDir, `${viewport.width}-${theme}-${state.name}.png`) });
            expect(reading.placeholder).toBe('Message this ferret');
            expect(reading.whole, 'the browser has fonts, so the text has a width').toBeGreaterThan(0);
            expect(reading.field, 'the field is wide enough for the whole placeholder').toBeGreaterThanOrEqual(
              reading.whole,
            );
          } finally {
            await context.close();
          }
        });
});
