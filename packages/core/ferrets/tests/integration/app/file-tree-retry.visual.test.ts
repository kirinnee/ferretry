/**
 * THE FILES TREE WHEN A FOLDER CANNOT BE LISTED, in a real browser (e-retry): the folder shows its failure with a Retry
 * button, and pressing it lists that folder again AS THE PERSON'S PRESS (`quiet: false`, so a passkey prompt can open) and
 * the files appear. The tree's own listing carries no press.
 * Set `FY_FILE_TREE_RETRY_SHOTS_DIR` to keep `<viewport>-<scheme>-failed.png` and `-loaded.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_FILE_TREE_RETRY_SHOTS_DIR ?? '';

type Browser = Awaited<ReturnType<typeof sharedChromium>>;

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-file-tree-retry-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/file-tree-retry-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the file-tree retry scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
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

const CASES = [
  { name: '390', width: 390, height: 844, scheme: 'dark', scale: 2 },
  { name: '768', width: 768, height: 900, scheme: 'dark', scale: 1 },
  { name: '1280', width: 1_280, height: 800, scheme: 'dark', scale: 1 },
  { name: '1280', width: 1_280, height: 800, scheme: 'light', scale: 1 },
] as const;

describe('the Files tree when a folder cannot be listed', () => {
  for (const { name, width, height, scheme, scale } of CASES)
    it(`Retry on the folder lists it as the person's press and the files appear (${name}, ${scheme})`, async () => {
      const context = await browser.newContext({
        viewport: { width, height },
        colorScheme: scheme,
        deviceScaleFactor: scale,
      });
      try {
        const origin = server?.url.origin ?? '';
        await context.route('**/*', async route =>
          new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
        );
        const tab = await context.newPage();
        await tab.goto(`${origin}/?theme=studio-${scheme}`);
        await tab.getByRole('button', { name: 'Expand src' }).click();
        await tab.waitForSelector('[role="alert"]');
        const retry = tab.getByRole('button', { name: 'Retry listing src' });
        expect(await retry.count()).toBe(1);
        if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${name}-${scheme}-failed.png`) });
        const reads = () => tab.evaluate(() => (window as unknown as { __listReads: (false | null)[] }).__listReads);
        expect(await reads()).toEqual([null]);

        await retry.click();
        await tab.waitForSelector('text=parser.ts');
        expect(await tab.locator('[role="alert"]').count()).toBe(0);
        expect(await reads()).toEqual([null, false]);
        if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${name}-${scheme}-loaded.png`) });
      } finally {
        await context.close();
      }
    });
});
