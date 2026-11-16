/**
 * Screenshots for u2-07 (fake data): the "Not good" box with its "+" (answer files) and the quote menu on an open item,
 * at 390 and 1280, light and dark. Set `FY_U207_SHOTS_DIR`.
 */
import { afterAll, beforeAll, describe, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_U207_SHOTS_DIR ?? '';
let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-u207-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/u207-shots-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`scene did not build (${code}):\n${stderr}\n${stdout}`);
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
      if (path === '/') return new Response(page, { headers: { 'content-type': 'text/html' } });
      return new Response('not here', { status: 404 });
    },
  });
  await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const VIEWPORTS = [
  { name: '390', width: 390, height: 844, phone: true },
  { name: '1280', width: 1_280, height: 800, phone: false },
] as const;

describe('u2-07 screenshots', () => {
  for (const viewport of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const)
      for (const scene of ['ask', 'quote'] as const)
        it(`${scene} ${viewport.name} ${scheme}`, async () => {
          const context = await browser.newContext({
            viewport: { width: viewport.width, height: viewport.height },
            colorScheme: scheme,
            deviceScaleFactor: viewport.phone ? 2 : 1,
            hasTouch: false,
            isMobile: false,
          });
          const origin = server?.url.origin ?? '';
          await context.route('**/*', async route =>
            new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
          );
          const tab = await context.newPage();
          const problems: string[] = [];
          tab.on('pageerror', error => problems.push(error.message));
          await tab.goto(`${origin}/?theme=studio-${scheme}&case=${scene}`);
          try {
            if (scene === 'ask') {
              const notGood = tab.locator('.fy-attn-deck__top [data-agenda-option="Not good"]');
              await notGood.waitFor({ timeout: 5_000 });
              await notGood.click();
              await tab.waitForSelector('[data-inbox-gate-why] button[data-composer-attach]', { timeout: 5_000 });
            } else {
              await tab.waitForSelector('.fy-attn-deck__top', { timeout: 5_000 });
              await tab.evaluate(() => {
                const target = [...document.querySelectorAll<HTMLElement>('.fy-attn-deck__top p')].find(
                  p => p.textContent?.includes('keeps every finished item') && p.getClientRects().length > 0,
                );
                if (target === undefined) throw new Error('no visible prose to select');
                const range = document.createRange();
                range.selectNodeContents(target);
                const selection = window.getSelection();
                selection?.removeAllRanges();
                selection?.addRange(range);
                const rects = [...range.getClientRects()];
                const last = rects[rects.length - 1] ?? target.getBoundingClientRect();
                target.dispatchEvent(new Event('pointerdown', { bubbles: true }));
                target.dispatchEvent(
                  new MouseEvent('contextmenu', {
                    bubbles: true,
                    cancelable: true,
                    clientX: Math.max(last.left + 8, last.right - 60),
                    clientY: last.top + last.height / 2,
                  }),
                );
              });
              await tab.waitForSelector('[role="menu"][aria-label="Quote menu"]', { timeout: 5_000 });
            }
          } catch (error) {
            throw new Error(`${scene} did not draw: ${String(error)}\n${problems.join('\n')}`);
          }
          await tab.waitForTimeout(300);
          await tab.screenshot({ path: join(shotsDir, `${scene}-${viewport.name}-${scheme}.png`) });
          await context.close();
        }, 30_000);
});
