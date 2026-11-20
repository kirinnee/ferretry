/**
 * A TUNNEL SWITCH HELD FOR THE OWNER, on the Connection screen, in a real browser over fake data
 * (`fixtures/tunnel-held-scene.tsx`): after "Turn on" the card says the change waits for the owner's approval and exactly
 * how to approve it, on a phone (390) and a desktop (1280), dark.
 *
 * Set `FY_TUNNEL_HELD_SHOTS_DIR` to keep the pictures.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';
import { TUNNEL_APPROVE_COMMAND, TUNNEL_APPROVE_IN_APP, TUNNEL_HELD_TITLE } from '../../../contract/index.ts';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_TUNNEL_HELD_SHOTS_DIR ?? '';

let browser: Awaited<ReturnType<typeof sharedChromium>>;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-tunnel-held-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/tunnel-held-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the tunnel held scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>html, body, #root { height: 100%; margin: 0; }</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request =>
      new URL(request.url).pathname === '/app.js'
        ? new Response(js, { headers: { 'content-type': 'text/javascript' } })
        : new Response(page, { headers: { 'content-type': 'text/html' } }),
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

describe('a tunnel switch held for the owner', () => {
  for (const viewport of VIEWPORTS) {
    it(`says it waits for approval and how to approve it, as a status and not an error (${viewport.name}, dark)`, async () => {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: viewport.phone ? 2 : 1,
        hasTouch: viewport.phone,
        isMobile: viewport.phone,
      });
      const origin = server?.url.origin ?? '';
      await context.route('**/*', async route =>
        new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
      );
      const tab = await context.newPage();
      try {
        await tab.goto(`${origin}/?theme=studio-dark`);
        await tab.getByRole('button', { name: 'Turn on' }).click();
        const held = tab.locator('[data-tunnel-offer="held"]');
        await held.waitFor({ state: 'visible' });
        expect(await tab.locator('[data-tunnel-held]').innerText()).toBe(TUNNEL_HELD_TITLE);
        expect(await tab.locator('[data-tunnel-approve-app]').innerText()).toBe(TUNNEL_APPROVE_IN_APP);
        expect(await tab.locator('[data-tunnel-approve-machine] code').innerText()).toBe(TUNNEL_APPROVE_COMMAND);
        expect(await tab.locator('[role="alert"]').count()).toBe(0);
        const check = tab.getByRole('button', { name: 'Check again' });
        expect((await check.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
        expect(await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${viewport.name}-dark-tunnel-held.png`) });
      } finally {
        await context.close();
      }
    });
  }
});
