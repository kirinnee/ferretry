/**
 * THE SAME SCREEN IN EVERY THEME, with the fonts it really drew — evidence that a theme is not just a
 * palette over one typeface.
 *
 * Serves the REAL `dist/` (build it first, or pass nothing and this builds it) on an ephemeral loopback
 * port, opens the first-run screen once per theme family in the light scheme at a desktop and a phone
 * width, and records for each load:
 *
 *   - the PNG;
 *   - the computed `font-family` of the body, a heading and a code element, and the faces the page
 *     says it LOADED (`document.fonts`), which are what the screenshot was actually drawn with;
 *   - every font file the page requested and its bytes — the "only the active theme's fonts are
 *     fetched" and "inside the byte budget" claims, measured rather than asserted.
 *
 * Dev-only, never runs in CI. Every request that leaves the loopback origin is aborted.
 *
 *   bun harness/theme-fonts-screenshot.ts [--no-build] [--out /tmp/claude-1000]
 *   # writes <out>/theme-fonts-<family>-<desktop|phone>.png and <out>/theme-fonts-report.json
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { THEME_FAMILIES } from '../src/lib/theme-preferences.ts';

const packageDir = resolve(import.meta.dir, '..');
const distDir = join(packageDir, 'dist');
const flag = (name: string): string | undefined => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
};
const outDir = flag('out') ?? '/tmp/claude-1000';
mkdirSync(outDir, { recursive: true });

const fail = (message: string): never => {
  process.stderr.write(`❌ ${message}\n`);
  process.exit(1);
};

if (!process.argv.includes('--no-build')) {
  const build = spawnSync('./node_modules/.bin/vite', ['build'], { cwd: packageDir, stdio: 'inherit' });
  if (build.status !== 0) fail(`vite build exited ${build.status}`);
}

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    const direct = Bun.file(join(distDir, path));
    if (path !== '/' && (await direct.exists())) {
      return new Response(
        direct,
        path.endsWith('.webmanifest') ? { headers: { 'content-type': 'application/manifest+json' } } : undefined,
      );
    }
    return new Response(Bun.file(join(distDir, 'app/index.html')), {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  },
});
const origin = `http://127.0.0.1:${server.port}`;

const VIEWPORTS = [
  { name: 'desktop', width: 1_440, height: 900, mobile: false },
  { name: 'phone', width: 390, height: 844, mobile: true },
] as const;

interface Capture {
  readonly family: string;
  readonly viewport: string;
  readonly body: string;
  readonly heading: string;
  readonly code: string;
  readonly loaded: readonly string[];
  readonly fontFiles: ReadonlyArray<{ readonly file: string; readonly bytes: number }>;
  readonly fontBytes: number;
}

const chrome = Bun.which('google-chrome') ?? Bun.which('chromium');
if (chrome === null) fail('no system Chrome or Chromium found');
const browser = await chromium.launch({ executablePath: chrome ?? undefined, headless: true });
const captures: Capture[] = [];

try {
  for (const { id } of THEME_FAMILIES) {
    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        isMobile: viewport.mobile,
        hasTouch: viewport.mobile,
        colorScheme: 'light',
        serviceWorkers: 'block',
      });
      await context.addInitScript(
        ([family]) => localStorage.setItem('fy-theme-v1', JSON.stringify({ family, mode: 'light' })),
        [id],
      );
      await context.route('**/*', async route => {
        if (route.request().url().startsWith(origin)) await route.continue();
        else await route.abort();
      });
      const page = await context.newPage();
      const fontFiles: Array<{ file: string; bytes: number }> = [];
      page.on('response', async response => {
        const url = new URL(response.url());
        if (!url.pathname.endsWith('.woff2')) return;
        fontFiles.push({ file: url.pathname.split('/').at(-1) ?? url.pathname, bytes: (await response.body()).length });
      });
      await page.goto(`${origin}/setup`, { waitUntil: 'networkidle' });
      // Put code on screen: the first-run screen has none of its own, and the code face only loads on use.
      await page.evaluate(() => {
        const code = document.createElement('code');
        code.id = 'fy-font-probe';
        code.textContent = 'fy new --runtime claude  // 0123456789 → ✓';
        code.style.cssText =
          'position:fixed;left:16px;bottom:16px;z-index:9999;padding:4px 8px;background:var(--bg);color:var(--fg)';
        document.body.append(code);
      });
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      await page.waitForTimeout(400);
      const probe = await page.evaluate(() => {
        const style = (selector: string): string => {
          const element = document.querySelector(selector);
          return element === null ? '(none)' : getComputedStyle(element).fontFamily;
        };
        return {
          body: style('body'),
          heading: style('h1, h2'),
          code: style('#fy-font-probe'),
          loaded: [...document.fonts]
            .filter(face => face.status === 'loaded')
            .map(face => `${face.family} ${face.weight}`),
        };
      });
      const target = join(outDir, `theme-fonts-${id}-${viewport.name}.png`);
      await page.screenshot({ path: target });
      captures.push({
        family: id,
        viewport: viewport.name,
        ...probe,
        loaded: probe.loaded.map(name => name.replaceAll('"', '')),
        fontFiles: [...fontFiles].sort((a, b) => a.file.localeCompare(b.file)),
        fontBytes: fontFiles.reduce((sum, file) => sum + file.bytes, 0),
      });
      process.stdout.write(
        `📸 ${id} ${viewport.name} -> ${target} (${fontFiles.length} font files, ${fontFiles.reduce((s, f) => s + f.bytes, 0)} B)\n`,
      );
      await context.close();
    }
  }
} finally {
  await browser.close();
  server.stop(true);
}

writeFileSync(join(outDir, 'theme-fonts-report.json'), `${JSON.stringify(captures, null, 2)}\n`);
process.stdout.write(`📄 ${join(outDir, 'theme-fonts-report.json')}\n`);
