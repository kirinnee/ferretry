/**
 * A CODEX-QUEUED MESSAGE IS A NORMAL CHAT ROW, in a real browser, on a phone (390) and a desktop (1280).
 *
 * `codex queue` records the message as an ordinary user turn, so the chat draws an agent's send as a message row with
 * the ferret as its sender (the banner taken off) and the owner's send as the owner's row — never a system or hook
 * blob. The scene (`fixtures/codex-queued-scene.tsx`) is the real `Transcript` over FAKE data.
 *
 * Set `FY_CODEX_QUEUED_SHOTS_DIR` to keep `<width>-<scheme>.png` (e.g. `390-light.png`, `1280-light.png`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_CODEX_QUEUED_SHOTS_DIR ?? '';

const SCENE_CSS = `
  html, body, #root { height: 100%; margin: 0; }
  .scene-chat { box-sizing: border-box; display: flex; flex-direction: column; inset: 0; position: fixed; }
  .scene-chat .fy-transcript-shell { flex: 1 1 auto; margin: 0 auto; max-width: 760px; padding: 0 16px; width: 100%; box-sizing: border-box; }
`;

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-codex-queued-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/codex-queued-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the codex-queued scene did not build (${code}):\n${stderr}\n${stdout}`);
  const built = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(built.css, 'utf8');
  const js = await readFile(built.js, 'utf8');
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
  { width: 390, height: 844, phone: true },
  { width: 1_280, height: 800, phone: false },
] as const;

describe('a Codex-queued message in the chat', () => {
  for (const view of VIEWPORTS) {
    it(`draws the agent’s send as a message row from torrey and the owner’s as the owner’s, at ${view.width}`, async () => {
      const context = await browser.newContext({
        viewport: { width: view.width, height: view.height },
        colorScheme: 'light',
        deviceScaleFactor: view.phone ? 2 : 1,
        ...(view.phone ? { isMobile: true, hasTouch: true } : {}),
      });
      try {
        const origin = server?.url.origin ?? '';
        await context.route('**/*', async route =>
          new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
        );
        const tab = await context.newPage();
        await tab.goto(`${origin}/?theme=studio-light`);
        await tab.waitForSelector('.fy-transcript-content');

        // The agent's send: a peer row from torrey, its body shown and no banner words anywhere.
        const peer = tab.locator('.fy-message-peer[data-peer="torrey"]');
        expect(await peer.count()).toBe(1);
        expect(await peer.innerText()).toContain('Review is done');
        expect(await tab.getByText('not from the owner').count()).toBe(0);
        expect(await tab.getByText('To reply: fy send').count()).toBe(0);
        // The owner's send is a plain message, not a peer row and not a system row.
        expect(await tab.getByText('Please land the patch once CI is green.').count()).toBe(1);
        expect(await tab.locator('.fy-message-peer').count()).toBe(1);
        expect(await tab.locator('[data-transcript-kind="system"]').count()).toBe(0);

        if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${view.width}-light.png`) });
      } finally {
        await context.close();
      }
    }, 60_000);
  }
});
