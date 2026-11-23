/**
 * A CLEAN START DOES NOT FETCH THE ANIMATION ENGINE (r12 H8 recheck, end-list). `scripts/prefetch-view-chunks.ts` lists the
 * plugin view chunks the built page prefetches at idle; it listed Durian's lazy 2D animation engine (`animation-stage`, 36.6 KB
 * gzipped) as if it were a view, so every app start paid for a drawing most conversations never use.
 *
 * Proved on the REAL built app: one `vite build` of the shell's own config, served as static files, opened in Chromium with a
 * clean profile and left past the idle prefetch. The request ledger is the claim: the view prefetch DID run (view chunks were
 * asked for, so the check cannot pass by the script never firing), and neither the engine's chunk nor the 3D stage's was.
 *
 * SINCE r12 H11 THE BUILD CARRIES NEITHER. The Durian worker reads every message and has no scene compiler, so the product no
 * longer asks for the engine (`animation-engine.ts`: `loadAnimationEngine` has no caller) and an `animation` fence is shown as
 * code. Nothing imports `animation-stage.tsx`, so Vite emits no `animation-stage-*` chunk, and nothing imports Durian's 3D
 * stage, so no chunk holds `WebGLRenderer`. The first case therefore pins that truth (a build that brings an engine back
 * fails it, and its author moves the proof back to the request ledger with the chunk names); the ledger cases read every
 * chunk the page was served and every chunk the prefetch lists by what it HOLDS, so they cannot pass by a rename.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';
import { build } from 'vite';
import { sharedChromium } from '../support/browser/chromium.ts';

const APP = join(import.meta.dir, '../..');
const TYPES: Readonly<Record<string, string>> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

let browser: Browser;
let dist = '';
let server: ReturnType<typeof Bun.serve> | undefined;
let origin = '';
/** Every built chunk that is the 2D engine's stage (by name) or the 3D stage's renderer (by content). Empty since r12 H11. */
const engineChunks: string[] = [];
/** The built chunk files and their code, for the ledger cases to read by content. */
const built = new Map<string, string>();

beforeAll(async () => {
  browser = await sharedChromium();
  dist = await mkdtemp(join(tmpdir(), 'ferretry-prefetch-engine-'));
  await build({
    configFile: join(APP, 'vite.config.ts'),
    root: APP,
    logLevel: 'silent',
    mode: 'production',
    build: { outDir: dist, emptyOutDir: true },
  });
  // The chunks, found by what they hold (not by a hashed name): the 2D engine's stage, and the 3D stage's renderer.
  for (const name of await readdir(join(dist, 'assets'))) {
    if (!name.endsWith('.js')) continue;
    const code = await readFile(join(dist, 'assets', name), 'utf8');
    built.set(`assets/${name}`, code);
    if (code.includes('WebGLRenderer') || /^animation-stage-/u.test(name)) engineChunks.push(`assets/${name}`);
  }
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async request => {
      const path = decodeURIComponent(new URL(request.url).pathname);
      const target = path.endsWith('/') ? `${path}index.html` : path;
      if (target.includes('..')) return new Response('no', { status: 400 });
      const file = Bun.file(join(dist, target));
      if (!(await file.exists())) return new Response('not here', { status: 404 });
      const type = TYPES[target.slice(target.lastIndexOf('.'))] ?? 'application/octet-stream';
      return new Response(file, { headers: { 'content-type': type } });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
}, 280_000);

afterAll(async () => {
  await server?.stop(true);
  if (dist !== '') await rm(dist, { force: true, recursive: true });
});

const listed = async (): Promise<string[]> => {
  const html = await readFile(join(dist, 'app/index.html'), 'utf8');
  const list = /data-chunks="([^"]*)"/u.exec(html)?.[1] ?? '';
  return list === '' ? [] : list.split(',');
};

describe('what a clean start of the built app fetches', () => {
  it('builds neither the 2D engine nor the 3D stage: the worker reads every message and holds an animation as code', () => {
    expect(engineChunks).toEqual([]);
    // The worker's chunk is where the parser lives, so a build that dropped it would pass the case above for the wrong reason.
    expect([...built.keys()].some(file => /^assets\/durian-worker-/u.test(file))).toBe(true);
  });

  it('lists view chunks to prefetch, and not the engine or the 3D stage', async () => {
    const files = await listed();
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      expect(file).not.toMatch(/animation-stage/u);
      expect(built.has(file)).toBe(true);
      expect(built.get(file) ?? '').not.toContain('WebGLRenderer');
    }
  });

  it('prefetches the views at idle on a clean start, and never asks for the engine or the 3D stage', async () => {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1_280, height: 900 } });
    const page = await context.newPage();
    const asked: string[] = [];
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.origin === origin) asked.push(url.pathname.slice(1));
    });
    await page.goto(`${origin}/app/`, { waitUntil: 'load' });
    // The prefetch waits for load, then for the browser to be idle (at most 5 s): give it that and a margin.
    await page.waitForTimeout(8_000);
    await context.close();
    const views = (await listed()).filter(file => asked.includes(file));
    expect(views.length).toBeGreaterThan(10);
    for (const file of asked) {
      expect(file).not.toMatch(/animation-stage/u);
      expect(built.get(file) ?? '').not.toContain('WebGLRenderer');
    }
  }, 120_000);
});
