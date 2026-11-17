/**
 * THE OWNER'S WORDS STILL ON THIS DEVICE, in an open item's History, in a real browser, in light and dark: one message
 * waits for the machine ("Saved on this device", the chat's one tick) and one was refused ("Not sent"); a message about
 * another item is not drawn. Fake data only.
 *
 * Set `FY_AGENDA_DEVICE_SHOTS_DIR` to keep `<scheme>.png`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_AGENDA_DEVICE_SHOTS_DIR ?? '';

const SCENE_CSS = `
  html, body, #root { height: 100%; margin: 0; }
  .scene-chat { box-sizing: border-box; display: flex; flex-direction: column; inset: 0; position: fixed; }
  .scene-chat .fy-chat-log { flex: 1 1 0; }
`;

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-agenda-device-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/device-history-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the device-history scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  return { css: await readFile(manifest.css, 'utf8'), js: await readFile(manifest.js, 'utf8') };
};

beforeAll(async () => {
  browser = await sharedChromium();
  const { css, js } = await build();
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>${SCENE_CSS}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      const path = new URL(request.url).pathname;
      if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
      if (path === '/') return new Response(page, { headers: { 'content-type': 'text/html' } });
      return new Response('not here', { status: 404 });
    },
  });
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

describe('the open item’s History with words still on this device', () => {
  for (const scheme of ['light', 'dark'] as const)
    it(`draws one saved and one refused row, and not another item’s (phone, ${scheme})`, async () => {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        colorScheme: scheme,
        deviceScaleFactor: 2,
        hasTouch: true,
        isMobile: true,
      });
      const origin = server?.url.origin ?? '';
      await context.route('**/*', async route =>
        new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
      );
      const tab = await context.newPage();
      try {
        await tab.goto(`${origin}/?theme=studio-${scheme}`);
        await tab.click('[data-agenda-fold="conversation"]');
        await tab.waitForSelector('[data-send-receipt="saved"]');
        const rows = await tab.evaluate(() =>
          [...document.querySelectorAll('[data-agenda-history] [data-history="owner"]')].map(row => ({
            said: row.querySelector('.fy-hist__said')?.textContent ?? '',
            receipt: row.querySelector('[data-send-receipt]')?.getAttribute('data-send-receipt') ?? '',
          })),
        );
        expect(rows).toEqual([
          { said: 'Pause, I think.', receipt: 'read' },
          { said: 'Switch them over tonight, please.', receipt: 'saved' },
          { said: 'And tell the team.', receipt: 'failed' },
        ]);
        await tab.evaluate(() => {
          for (const mark of document.querySelectorAll<HTMLButtonElement>(
            '[data-send-receipt="saved"], [data-send-receipt="failed"]',
          ))
            mark.click();
        });
        await tab.evaluate(() => document.querySelector('[data-agenda-history]')?.scrollIntoView({ block: 'center' }));
        await tab.evaluate(
          () => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
        );
        if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${scheme}.png`) });
      } finally {
        await context.close();
      }
    });
});
