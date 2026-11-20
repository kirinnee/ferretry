/**
 * r11 O3 — THE 300 ms WAIT GATE on the folder explorer's "Reading your home folder…" status, in a real browser over the
 * real `FolderExplorer` (`fixtures/wait-gate-scene.tsx`). A read that answers in 250 ms paints no status (sampled every
 * frame); one that answers in 600 ms shows it from about 300 ms (the control: the gate delays, it does not remove).
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(90_000);

const packageRoot = import.meta.dir;
let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-explorer-wait-gate-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/wait-gate-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the wait gate scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request =>
      new URL(request.url).pathname === '/app.js'
        ? new Response(js, { headers: { 'content-type': 'text/javascript' } })
        : new Response(page, { headers: { 'content-type': 'text/html' } }),
  });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

interface Sample {
  readonly firstVisible: number | null;
  readonly lastVisible: number | null;
  readonly frames: number;
}

const run = async (ms: number, theme = 'studio-light'): Promise<Sample> => {
  const context = await browser.newContext({ viewport: { width: 1_280, height: 800 } });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  tab.setDefaultTimeout(10_000);
  try {
    await tab.goto(`${origin}/?theme=${theme}&ms=${ms}`);
    await tab.waitForFunction(
      expected =>
        (window as unknown as { __loader: { frames: number } }).__loader.frames > 0 && performance.now() > expected,
      ms + 1_700,
    );
    const measured = await tab.evaluate(() => (window as unknown as { __loader: Sample }).__loader);
    console.log(
      `measured explorer ${ms}ms: first=${measured.firstVisible?.toFixed(0) ?? 'never'} last=${measured.lastVisible?.toFixed(0) ?? 'never'} frames=${measured.frames}`,
    );
    return measured;
  } finally {
    await context.close();
  }
};

describe('explorer: the wait status holds back for 300 ms', () => {
  it('a 250 ms read stays blank', async () => {
    const seen = await run(250);
    expect(seen.frames).toBeGreaterThan(20);
    expect(seen.firstVisible).toBeNull();
  });
  it('a 600 ms read shows it from about 300 ms', async () => {
    const seen = await run(600, 'studio-dark');
    expect(seen.firstVisible).not.toBeNull();
    expect(seen.firstVisible as number).toBeGreaterThanOrEqual(295);
    expect(seen.firstVisible as number).toBeLessThanOrEqual(420);
  });
});
