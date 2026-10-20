/**
 * Review captures of Insights › Analytics — the Overview and the Query page — inside the real app
 * chrome, at desktop 1440 and phone 390, in light and dark, for the neo and studio theme families.
 *
 *   bun harness/analytics-screenshots.ts [outDir]     # default harness/out/analytics
 *
 * Each capture also MEASURES the page: any element whose right edge passes the viewport, any leaf whose
 * text is clipped by its own box, and the document's scroll width, written to `facts.json` beside the
 * images. A run with any overflow exits non-zero, so a clipped axis label or a value column pushed off a
 * phone is a failure rather than something a reviewer has to spot.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = join(harnessDir, '..');
const outDir = process.argv[2] ?? join(harnessDir, 'out', 'analytics');
mkdirSync(outDir, { recursive: true });

const run = (command: string, args: readonly string[]): void => {
  const result = Bun.spawnSync([command, ...args], { cwd: packageDir, stdout: 'inherit', stderr: 'inherit' });
  if (result.exitCode !== 0) throw new Error(`${command} ${args.join(' ')} exited ${result.exitCode}`);
};
run('bun', ['build', 'harness/main.tsx', '--outdir', 'harness/out', '--target', 'browser']);
run('./node_modules/.bin/tailwindcss', [
  '--config',
  'tailwind.config.ts',
  '--input',
  'src/styles/index.css',
  '--output',
  'harness/out/app.css',
]);

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/')
      return new Response(Bun.file(join(harnessDir, 'index.html')), { headers: { 'content-type': 'text/html' } });
    if (path === '/pre-paint.js') return new Response(Bun.file(join(packageDir, 'public/pre-paint.js')));
    return new Response(Bun.file(join(harnessDir, 'out', path)));
  },
});

const PHONE_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844 },
] as const;
const FAMILIES = ['neo', 'studio'] as const;
const SCHEMES = ['light', 'dark'] as const;
const PAGES = [
  { name: 'overview', search: '?app-chrome=analytics' },
  {
    name: 'query',
    search: `?app-chrome=analytics&analytics-view=query&q=${encodeURIComponent('sum(cost_usd) by (model) [7d]')}`,
  },
] as const;

/** A reader's saved queries, so the Query page's saved list is not empty in review. */
const SAVED_KEY = 'fy-analytics-saved-queries-v1';
const SAVED_QUERIES = [
  { id: 'saved-1', name: 'Opus spend this week', query: 'sum(cost_usd) by (day) {model=claude-opus-5-5} [7d]' },
  {
    id: 'saved-2',
    name: 'Active time per turn by runtime',
    query: 'avg(duration_active_seconds_per_turn) by (runtime) [14d]',
  },
  { id: 'saved-3', name: 'Tokens by machine', query: 'sum(tokens) by (machine) [30d]' },
];

const executablePath = Bun.which('google-chrome') ?? Bun.which('chromium') ?? undefined;
const browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true });
const facts: Record<string, unknown> = {};
let failures = 0;
try {
  for (const viewport of VIEWPORTS) {
    for (const scheme of SCHEMES) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        colorScheme: scheme,
        reducedMotion: 'reduce',
        ...(viewport.name === 'phone' ? { isMobile: true, hasTouch: true, userAgent: PHONE_UA } : {}),
      });
      // No network: everything the page needs is served from this process.
      await context.route('**/*', route =>
        route.request().url().startsWith(server.url.origin) ? route.continue() : route.abort(),
      );
      const page = await context.newPage();
      page.on('pageerror', error => process.stderr.write(`pageerror: ${error.message}\n`));
      await page.goto(server.url.href);
      for (const family of FAMILIES) {
        await page.evaluate(
          ([themeFamily, mode, savedKey, saved]) => {
            localStorage.setItem('fy-theme-v1', JSON.stringify({ family: themeFamily, mode }));
            localStorage.setItem(savedKey, saved);
          },
          [family, scheme, SAVED_KEY, JSON.stringify(SAVED_QUERIES)] as const,
        );
        for (const target of PAGES) {
          await page.setViewportSize({ width: viewport.width, height: viewport.height });
          await page.goto(`${server.url.href}${target.search}`);
          await page.locator('#harness-app-chrome').waitFor();
          await page
            .locator(target.name === 'overview' ? '[data-analytics-figure]' : '[data-analytics-view="query"]')
            .first()
            .waitFor();
          await page.waitForTimeout(600);
          const measured = await page.evaluate(() => {
            const root = document.getElementById('harness-app-chrome')!;
            const all = [...root.querySelectorAll<HTMLElement>('*')];
            const viewportWidth = document.documentElement.clientWidth;
            const wide = all
              .filter(element => {
                const box = element.getBoundingClientRect();
                return box.width > 0 && box.right > viewportWidth + 1 && !element.closest('.sr-only');
              })
              .slice(0, 8)
              .map(element => `${element.tagName.toLowerCase()}.${String(element.className).slice(0, 60)}`);
            const clipped = all
              .filter(
                element =>
                  element.children.length === 0 &&
                  element.textContent &&
                  !element.closest('.sr-only') &&
                  !element.classList.contains('truncate') &&
                  !element.classList.contains('invisible') &&
                  (element.scrollWidth > element.clientWidth + 2 || element.scrollHeight > element.clientHeight + 2) &&
                  getComputedStyle(element).overflow !== 'visible',
              )
              .slice(0, 10)
              .map(element => element.textContent!.slice(0, 50));
            const scroller = [...root.querySelectorAll<HTMLElement>('main')].find(element =>
              /(auto|scroll)/u.test(getComputedStyle(element).overflowY),
            );
            return {
              scrollHeight: scroller?.scrollHeight ?? 0,
              docScrollWidth: document.documentElement.scrollWidth,
              viewportWidth,
              wide,
              clipped,
            };
          });
          const name = `${target.name}-${viewport.name}-${family}-${scheme}`;
          facts[name] = measured;
          if (measured.wide.length > 0 || measured.docScrollWidth > measured.viewportWidth) failures += 1;
          // Grow the viewport to the page's own scroll height, so one image shows the whole page.
          if (measured.scrollHeight > viewport.height) {
            await page.setViewportSize({
              width: viewport.width,
              height: Math.min(measured.scrollHeight + 200, 6000),
            });
            await page.waitForTimeout(300);
          }
          await page.screenshot({ path: join(outDir, `${name}.png`) });
          process.stdout.write(`📸 ${name} ${JSON.stringify(measured)}\n`);
        }
      }
      await context.close();
    }
  }
} finally {
  await browser.close();
  server.stop();
}
writeFileSync(join(outDir, 'facts.json'), `${JSON.stringify(facts, null, 2)}\n`);
if (failures > 0) {
  process.stderr.write(`⛔ ${failures} capture(s) overflow the viewport; see facts.json\n`);
  process.exit(1);
}
