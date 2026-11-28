/**
 * C-80b: THE "PAIR AGAIN" OFFER, in a real browser over fake data, at phone (390) and desktop (1440), light and dark, in
 * the default look and the roundest two. Two places draw it:
 *
 * - `card`: a relay-only machine's Connection card after a long outage (`fixtures/pair-again-card-scene.tsx`).
 * - `stop`: the same offer above the machine's stop page, for a machine whose plugin list cannot be read when the app
 *   opens (`fixtures/pair-again-stop-scene.tsx`, the real App and ShellRuntime).
 *
 * Set `FY_PAIR_AGAIN_SHOTS_DIR` to keep the pictures.
 */
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { roundSafeMisses, sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(60_000);
const shots = process.env.FY_PAIR_AGAIN_SHOTS_DIR ?? '';
let browser: Awaited<ReturnType<typeof sharedChromium>>;
const directories: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];

const SCENES = [
  { name: 'card', entry: 'fixtures/pair-again-card-scene.tsx', port: 7490 },
  { name: 'stop', entry: 'fixtures/pair-again-stop-scene.tsx', port: 7491 },
] as const;

async function serve(entry: string, port: number): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'ferretry-pair-again-'));
  directories.push(directory);
  const child = Bun.spawn([process.execPath, sceneBuilder, '--out', directory, '--entry', entry], {
    cwd: import.meta.dir,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the pair-again scene ${entry} did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>html, body, #root { height: 100%; margin: 0; }</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  servers.push(
    Bun.serve({
      hostname: '127.0.0.1',
      port,
      fetch: request =>
        new URL(request.url).pathname === '/app.js'
          ? new Response(js, { headers: { 'content-type': 'text/javascript' } })
          : new Response(page, { headers: { 'content-type': 'text/html' } }),
    }),
  );
}

beforeAll(async () => {
  browser = await sharedChromium();
  for (const scene of SCENES) await serve(scene.entry, scene.port);
  if (shots !== '') await mkdir(shots, { recursive: true });
}, 480_000);

afterAll(async () => {
  for (const server of servers) server.stop(true);
  for (const directory of directories) await rm(directory, { force: true, recursive: true });
});

for (const scene of SCENES)
  for (const style of ['studio', 'genz', 'neumorphism'])
    for (const width of [390, 1440])
      for (const scheme of ['light', 'dark'] as const)
        test(`C-80b Pair again ${scene.name}: ${style} ${width} ${scheme}`, async () => {
          const context = await browser.newContext({
            viewport: { width, height: width === 390 ? 844 : 900 },
            deviceScaleFactor: width === 390 ? 2 : 1,
            colorScheme: scheme,
            reducedMotion: 'reduce',
          });
          const origin = `http://127.0.0.1:${scene.port}`;
          await context.route('**/*', route =>
            new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
          );
          const page = await context.newPage();
          try {
            await page.goto(`${origin}/?theme=studio-${scheme}&style=${style}`);
            await page.waitForSelector('[data-pair-again]');
            await page.evaluate(async () => await document.fonts.ready);
            expect(await page.locator('[data-pair-again]').innerText()).toContain(
              'If Ferretry was reinstalled there, pair again.',
            );
            if (scene.name === 'stop') expect(await page.locator('[data-machine-stop]').count()).toBe(1);
            const button = page.locator('[data-pair-again-button]');
            expect(await button.innerText()).toBe('Pair again');
            expect((await button.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
            expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
            expect(await roundSafeMisses(page)).toEqual([]);
            if (shots !== '')
              await page.screenshot({
                path: join(shots, `${scene.name === 'card' ? '' : 'stop-'}${style}-${width}-${scheme}.png`),
                fullPage: true,
              });
          } finally {
            await context.close();
          }
        }, 30_000);
