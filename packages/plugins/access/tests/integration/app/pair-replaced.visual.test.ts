/** The replacement recovery must keep its reason on the real pair page, at phone/desktop and roundest looks. */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';
import { roundSafeMisses, sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve>;
const shots = process.env.FY_REPLACED_PAIR_SHOTS_DIR;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'fy-pair-replaced-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/pair-replaced-scene.tsx'],
    {
      cwd: import.meta.dir,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`scene failed: ${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  // A standalone page has document scrolling in place of the shell's inner scroll container.
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}\nhtml,body{height:auto;min-height:100%;overflow:auto}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 7489,
    fetch: request =>
      new URL(request.url).pathname === '/app.js'
        ? new Response(js, { headers: { 'content-type': 'text/javascript' } })
        : new Response(html, { headers: { 'content-type': 'text/html' } }),
  });
  browser = await sharedChromium();
  if (shots !== undefined) await mkdir(shots, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { recursive: true, force: true });
});

for (const style of ['studio', 'genz', 'neumorphism'])
  for (const width of [390, 1440])
    for (const scheme of ['light', 'dark'] as const)
      test(`replaced pair page: ${style} ${width} ${scheme}`, async () => {
        const context = await browser.newContext({
          viewport: { width, height: width === 390 ? 844 : 900 },
          colorScheme: scheme,
          reducedMotion: 'reduce',
        });
        try {
          const origin = server.url.origin;
          await context.route('**/*', route =>
            new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
          );
          const page = await context.newPage();
          await page.goto(`${origin}/pair?theme=studio-${scheme}&style=${style}`);
          await page.waitForSelector('[data-device-refused]');
          await page.evaluate(async () => await document.fonts.ready);
          const text = await page.locator('[data-device-refused]').innerText();
          expect(text).toContain('workstation');
          expect(text).toContain(
            'Ferretry on this machine was reinstalled or replaced. Pair this browser with it again.',
          );
          expect(text).not.toContain('no longer accepts this browser');
          expect(await page.getByRole('button', { name: 'Pair again', exact: true }).count()).toBe(1);
          expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
          expect(await roundSafeMisses(page)).toEqual([]);
          if (shots !== undefined)
            await page.screenshot({ path: join(shots, `${style}-${width}-${scheme}.png`), fullPage: true });
        } finally {
          await context.close();
        }
      }, 30_000);
