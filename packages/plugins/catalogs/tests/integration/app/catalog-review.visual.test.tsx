/** The catalog review at phone and desktop widths, light and dark: it never scrolls sideways and every warning says it in words. */
import { afterAll, beforeAll, describe, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';
import should from 'should';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

import { reviewPreview } from './fixtures/catalog-review-cases.ts';

/** This file's folder: the scene path below is relative to it, and the builder runs here. */
const packageRoot = import.meta.dir;

const viewports = [
  { width: 390, height: 844 },
  { width: 1_440, height: 900 },
] as const;
const themes = ['studio-light', 'studio-dark'] as const;

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

/**
 * The app's real stylesheet (Tailwind over every app half, then the design system) and the scene, built by the shell's
 * one scene builder in a child process — never a compile inside this runner.
 */
const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-catalog-review-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/catalog-review-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the catalog review scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  return { css: await readFile(manifest.css, 'utf8'), js: await readFile(manifest.js, 'utf8') };
};

describe('catalog review', () => {
  beforeAll(async () => {
    // The process's one Chromium (`@ferretry/app/testing/browser`): this file never launches or closes its own.
    browser = await sharedChromium();
    const { css, js } = await build();
    const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: request => {
        const path = new URL(request.url).pathname;
        if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
        if (path === '/') return new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8' } });
        return new Response('not here', { status: 404 });
      },
    });
  }, 180_000);

  afterAll(async () => {
    server?.stop(true);
    if (directory !== '') await rm(directory, { force: true, recursive: true });
  });

  it('never scrolls sideways, and each warning has an icon and a label', async () => {
    const origin = server?.url.origin ?? '';
    for (const theme of themes) {
      for (const viewport of viewports) {
        const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
        try {
          await context.route('**/*', async route =>
            new URL(route.request().url()).origin !== origin ? await route.abort() : await route.continue(),
          );
          const page = await context.newPage();
          await page.goto(`${origin}/?theme=${theme}`);
          await page.waitForSelector('html[data-scene-ready="1"]');
          const metrics = await page.evaluate<{ inner: number; scroll: number }>(
            '({ inner: innerWidth, scroll: document.documentElement.scrollWidth })',
          );
          should(metrics.scroll).be.belowOrEqual(metrics.inner);
          should(await page.locator('[data-warning]').count()).equal(reviewPreview.warnings.length);
          for (const item of await page.locator('[data-warning]').all()) {
            should(await item.locator('svg').count()).equal(1);
            should((await item.innerText()).trim().split('\n').length).be.aboveOrEqual(2);
          }
          should(await page.locator('[data-hidden-marker]').count()).be.aboveOrEqual(1);
        } finally {
          await context.close();
        }
      }
    }
  }, 180_000);
});
