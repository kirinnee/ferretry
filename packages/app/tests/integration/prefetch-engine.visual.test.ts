/**
 * A CLEAN START DOES NOT FETCH THE ANIMATION ENGINE (r12 H8 recheck, end-list). `scripts/prefetch-view-chunks.ts` lists the
 * plugin view chunks the built page prefetches at idle; it listed Durian's lazy 2D animation engine (`animation-stage`, 36.6 KB
 * gzipped) as if it were a view, so every app start paid for a drawing most conversations never use.
 *
 * Proved on the REAL built app: one `vite build` of the shell's own config, served as static files, opened in Chromium with a
 * clean profile and left past the idle prefetch. The request ledger is the claim: the view prefetch DID run (view chunks were
 * asked for, so the check cannot pass by the script never firing), and neither the engine's chunk nor the 3D stage's was.
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
let engineChunk = '';
let threeChunk = '';

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
    if (code.includes('WebGLRenderer')) threeChunk = `assets/${name}`;
    else if (/^animation-stage-/u.test(name)) engineChunk = `assets/${name}`;
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
  it('finds the engine chunk and the 3D stage in the build', () => {
    expect(engineChunk).not.toBe('');
    expect(threeChunk).not.toBe('');
  });

  it('lists view chunks to prefetch, and not the engine or the 3D stage', async () => {
    const files = await listed();
    expect(files.length).toBeGreaterThan(10);
    expect(files).not.toContain(engineChunk);
    expect(files).not.toContain(threeChunk);
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
    expect(asked).not.toContain(engineChunk);
    expect(asked).not.toContain(threeChunk);
  }, 120_000);
});
