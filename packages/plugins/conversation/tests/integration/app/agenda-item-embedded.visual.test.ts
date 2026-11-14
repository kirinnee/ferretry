/**
 * AN OPEN AGENDA ITEM'S CONVERSATION IS THE CONVERSATION ALONE — not the ferret's whole page — in a real browser, over fake data
 * (`fixtures/agenda-item-embedded-scene.tsx`): Conversation's real chat, `embedded`, under a stand-in item card
 * as the `agenda.conversation` slot draws it. The sweep: opening an item embedded terminal, browser, files, Warden, MCP, skills
 * and insights, and the terminal panel asked for a passkey on every item.
 *
 * Set `FY_AGENDA_ITEM_EMBEDDED_SHOTS_DIR` to keep `<viewport>-<scheme>-open-item.png` at 1280 and 390, light and dark.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_AGENDA_ITEM_EMBEDDED_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-agenda-item-embedded-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/agenda-item-embedded-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the embedded item scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>html, body, #root { height: 100%; margin: 0; }</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
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
  { name: '1280', width: 1_280, height: 800, phone: false },
  { name: '390', width: 390, height: 844, phone: true },
] as const;

describe('an open agenda item', () => {
  for (const viewport of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const)
      it(`draws the ask and its conversation, with no terminal or side panels (${viewport.name}, ${scheme})`, async () => {
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
        const problems: string[] = [];
        tab.on('pageerror', error => problems.push(error.message));
        try {
          await tab.goto(`${origin}/?theme=studio-${scheme}`);
          try {
            await tab.waitForSelector('[data-fake-conversation] [data-embedded]', { timeout: 8_000 });
          } catch (error) {
            throw new Error(`the scene did not draw: ${String(error)}\n${problems.join('\n')}`);
          }
          await tab.waitForTimeout(300);
          const found = await tab.evaluate(() => ({
            asked: document.body.textContent?.includes('Which fix should I apply?') === true,
            chat: document.querySelector('[data-fake-conversation] [data-chat-messages]') !== null,
            side: document.querySelectorAll('[data-slot="ferret.side"], [data-slot="ferret.toolbar"]').length,
            passkey: document.body.textContent?.includes('passkey') === true,
            overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          }));
          expect(found.asked, 'the ask is on the page').toBe(true);
          expect(found.chat, 'its conversation is under it').toBe(true);
          expect(found.side, 'no toolbar or side panels').toBe(0);
          expect(found.passkey, 'nothing asks for a passkey').toBe(false);
          expect(found.overflow, 'no sideways scroll').toBeLessThanOrEqual(0);
          if (shotsDir !== '')
            await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${scheme}-open-item.png`) });
        } finally {
          await context.close();
        }
      });
});
