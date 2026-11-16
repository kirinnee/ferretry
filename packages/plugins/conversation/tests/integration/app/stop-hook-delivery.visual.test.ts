/**
 * A MESSAGE HANDED IN BY THE STOP HOOK, in a real browser: it is a NORMAL message row with its sender's name, not a
 * "Stop hook feedback" blob, at a phone (390 px) and a desktop (1280 px). Fake data only
 * (`tests/integration/app/fixtures/stop-hook-delivery-scene.tsx`).
 *
 * Set `FY_STOP_HOOK_SHOTS_DIR` to keep the screenshots.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_STOP_HOOK_SHOTS_DIR ?? '';

const SCENE_CSS = `
  html, body, #root { height: 100%; margin: 0; }
  .scene-chat { box-sizing: border-box; display: flex; flex-direction: column; inset: 0; position: fixed; }
  .scene-chat .fy-transcript-shell { flex: 1 1 auto; margin: 0 auto; max-width: 760px; padding: 0 16px; width: 100%; box-sizing: border-box; }
`;

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-stop-hook-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/stop-hook-delivery-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the stop-hook scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  return { css: await readFile(manifest.css, 'utf8'), js: await readFile(manifest.js, 'utf8') };
};

beforeAll(async () => {
  const { css, js } = await build();
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

const WIDTHS = [
  { name: 'phone-390', width: 390, height: 844, phone: true },
  { name: 'desktop-1280', width: 1_280, height: 800, phone: false },
] as const;

const newContext = async (shape: (typeof WIDTHS)[number]): Promise<BrowserContext> =>
  await browser.newContext({
    viewport: { width: shape.width, height: shape.height },
    colorScheme: 'light',
    deviceScaleFactor: shape.phone ? 2 : 1,
    ...(shape.phone ? { isMobile: true, hasTouch: true } : {}),
  });

const open = async (context: BrowserContext): Promise<Page> => {
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  await tab.goto(`${origin}/?theme=studio-light`);
  await tab.waitForSelector('.fy-transcript-content');
  return tab;
};

describe('a hook-delivered message in a real browser', () => {
  for (const shape of WIDTHS)
    it(`is a normal row from the sending ferret at ${shape.width} px, with no Stop-hook wrapping and no sideways scroll`, async () => {
      const context = await newContext(shape);
      try {
        const tab = await open(context);
        const peer = tab.locator('.fy-message-peer[data-peer="avary"]');
        expect(await peer.count()).toBe(1);
        expect(await peer.innerText()).toContain('The nightly build is red because the lockfile changed');
        const everything = await tab.locator('.fy-transcript-content').innerText();
        expect(everything.toLowerCase()).toContain('avary');
        expect(everything).not.toContain('Stop hook');
        expect(everything).not.toContain('task-notification');
        expect(everything).not.toContain('system-reminder');
        // The owner-waiting notice is a Ferretry notice with no owner words in it, and the owner's own message is the
        // plain one typed afterwards.
        expect(everything).toContain('A message from the owner is waiting to be typed into your input box');
        expect(everything).toContain('Please also run the full test suite before you finish.');
        // Nothing runs off the side of the screen.
        const overflow = await tab.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow).toBeLessThanOrEqual(0);
        if (shotsDir !== '') {
          await tab.waitForTimeout(150);
          await tab.screenshot({ path: join(shotsDir, `stop-hook-delivery-${shape.name}.png`) });
        }
      } finally {
        await context.close();
      }
    }, 60_000);
});
