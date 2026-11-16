/**
 * A MESSAGE DELIVERED THROUGH FERRETRY'S MCP CHANNEL, in a real browser, over fixed fake data.
 *
 * The scene (`fixtures/channel-delivery-scene.tsx`) feeds what Claude Code records for a channel message (idle: a meta user
 * record; busy: a `queued_command` attachment) through the real transcript parser into the real `Transcript`. The claim:
 * each is a NORMAL message row attributed to its sender — a ferret's as a peer message, the daemon's as "Ferretry · Delivery" —
 * and the `<channel …>` wrapper is never on the screen, at a phone and at a desktop.
 *
 * Set `FY_CHANNEL_SHOTS_DIR` to keep a screenshot of each viewport.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_CHANNEL_SHOTS_DIR ?? '';

const SCENE_CSS = `
  html, body, #root { height: 100%; margin: 0; }
  .scene-chat { box-sizing: border-box; display: flex; flex-direction: column; inset: 0; position: fixed; }
  .scene-chat .fy-transcript-shell { flex: 1 1 auto; margin: 0 auto; max-width: 760px; padding: 0 16px; width: 100%; box-sizing: border-box; }
`;

const VIEWPORTS = [
  { name: 'phone-390', width: 390, height: 844, phone: true },
  { name: 'desktop-1280', width: 1_280, height: 900, phone: false },
] as const;

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-channel-delivery-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/channel-delivery-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the channel-delivery scene did not build (${code}):\n${stderr}\n${stdout}`);
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

const newContext = async (viewport: (typeof VIEWPORTS)[number]): Promise<BrowserContext> =>
  await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme: 'light',
    deviceScaleFactor: viewport.phone ? 2 : 1,
    ...(viewport.phone ? { isMobile: true, hasTouch: true } : {}),
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

describe('a message delivered through the channel', () => {
  for (const viewport of VIEWPORTS)
    it(`draws a ferret’s and the daemon’s channel messages as ordinary rows at ${viewport.name}`, async () => {
      const context = await newContext(viewport);
      try {
        const tab = await open(context);
        const text = await tab.locator('.fy-transcript-content').innerText();
        // The wrapper, its attributes and the banner's own brackets are gone from what is read.
        expect(text).not.toContain('<channel');
        expect(text).not.toContain('</channel>');
        expect(text).not.toContain('send_id');
        expect(text).not.toContain('— not from the owner');
        // Idle ferret message and busy ferret message: each is a peer row with its sender.
        expect(await tab.locator('.fy-message-peer[data-peer="torrey"]').count()).toBe(1);
        expect(await tab.locator('.fy-message-peer[data-peer="lizzette"]').count()).toBe(1);
        expect(text).toContain('The relay tests pass on my branch');
        expect(text).toContain('Done — pushed to the branch.');
        // The daemon's notice is Ferretry's own, never a system blob.
        expect(await tab.locator('[data-ferretry-message]').count()).toBe(1);
        expect(await tab.locator('[data-ferretry-message]').innerText()).toContain('Delivery');
        expect(text).toContain('Your message to Ryu did not arrive.');
        // The person's own prompt is untouched beside them.
        expect(text).toContain('Please keep going on the relay review.');
        // Nothing is cut at the screen's edge.
        expect(await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        if (shotsDir !== '') {
          await tab.waitForTimeout(150);
          await tab.screenshot({ path: join(shotsDir, `channel-delivery-${viewport.name}.png`) });
        }
      } finally {
        await context.close();
      }
    }, 60_000);
});
