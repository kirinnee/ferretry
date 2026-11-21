/**
 * r11-1b G5 (owner line 4: no loader for a fast step): moving from one Claude step page to the next draws the next page
 * at once, in a real browser, through the REAL app half (`app/index.ts`) and one Suspense boundary shaped like the
 * shell's step slot (`fixtures/step-switch-scene.tsx`).
 *
 * The defect it pins: each page loaded the shared pages module through its OWN lazy load, so every page suspended on its
 * first draw even with the module in memory. React holds a fallback it just showed for at least 300 ms, so each Claude
 * page took ~370 ms from Next to ready and put the shell's top bar up with every answer at 1 ms. Measured on the gate's
 * e2e at 1 ms answers (1280 light, 1-min load 49-57): 363-388 ms per Claude page before, 68-128 ms after.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

const packageRoot = import.meta.dir;
const STEPS = [
  'claude-code.import-settings',
  'claude-code.import-model-set',
  'claude-code.import-instructions',
  'claude-code.import-skills',
  'claude-code.import-mcp',
  'claude-code.conversations',
  'claude-code.import-run',
  'claude-code.permission',
] as const;
/** Well under React's 300 ms fallback hold: a page that suspends cannot draw inside it, a page that does not always does. */
const FAST_MS = 200;

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-g5-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/step-switch-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the step-switch scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const [css, js] = await Promise.all([readFile(manifest.css, 'utf8'), readFile(manifest.js, 'utf8')]);
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
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
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

describe('moving between the Claude step pages', () => {
  it('draws every later page at once: no fallback, under 200 ms from the move', async () => {
    const context = await browser.newContext({ viewport: { width: 1_280, height: 800 } });
    const tab = await context.newPage();
    const errors: string[] = [];
    tab.on('pageerror', error => errors.push(error.message));
    await tab.goto(`${server?.url.origin ?? ''}/`);
    // The segment's first page may wait for the module once: that is the one load.
    await tab.waitForFunction(() =>
      (window as unknown as { __shown: (subject: string) => boolean }).__shown('claude-code.import-choice'),
    );
    const moves: { subject: string; ms: number; fallback: boolean }[] = [];
    for (const subject of STEPS)
      moves.push(
        await tab.evaluate(
          next =>
            (
              window as unknown as {
                __walk: (s: string) => Promise<{ subject: string; ms: number; fallback: boolean }>;
              }
            ).__walk(next),
          subject,
        ),
      );
    console.log(
      `G5 step moves: ${moves.map(move => `${move.subject} ${move.ms} ms${move.fallback ? ' (fallback)' : ''}`).join(', ')}`,
    );
    expect(errors).toEqual([]);
    expect(
      moves.filter(move => move.fallback).map(move => move.subject),
      'a page that suspended on its move',
    ).toEqual([]);
    for (const move of moves) expect(move.ms, `${move.subject}: ms from the move to the page`).toBeLessThan(FAST_MS);
    await context.close();
  }, 120_000);
});
