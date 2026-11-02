/**
 * Every This-machine tab (Runtimes, Agents, Sign-ins, Profiles, Browser, Machine) at 390 and 1440, light and dark,
 * from the real Settings page in the shell harness (`?settings-harness=1`) with no real daemon. Serves the app's own
 * font files, waits for them, and fails if any tab scrolls sideways or the font did not load. The Agents tab is shot a second time with
 * the Page scripts (i) open (`agents-info-<vp>-<theme>.png`).
 * Run from packages/pwa: `bun harness/machine-tabs-screenshot.ts [outDir]`.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out');
const outDir = resolve(process.argv[2] ?? '/tmp/claude-1000/shots/b141/f-tab-regroup');

const fail = (message: string): never => {
  process.stderr.write(`❌ ${message}\n`);
  process.exit(1);
};
const run = (command: string, args: readonly string[]): void => {
  const result = spawnSync(command, args, { cwd: packageDir, stdio: 'inherit' });
  if (result.status !== 0) fail(`${command} exited ${result.status}`);
};

mkdirSync(buildDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
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
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/')
      return new Response(Bun.file(join(harnessDir, 'index.html')), { headers: { 'content-type': 'text/html' } });
    if (path === '/pre-paint.js') return new Response(Bun.file(join(packageDir, 'public/pre-paint.js')));
    const file = Bun.file(path.startsWith('/assets/fonts/') ? join(packageDir, 'src', path) : join(buildDir, path));
    return (await file.exists()) ? new Response(file) : new Response(null, { status: 404 });
  },
});

const TABS = ['runtimes', 'agents', 'sign-ins', 'profiles', 'browser', 'machine'] as const;
const PHONE_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
const VIEWPORTS = {
  '390': { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: PHONE_UA },
  '1440': { viewport: { width: 1440, height: 900 } },
} as const;

const executablePath =
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? fail('no system Chrome or Chromium found');
const browser = await chromium.launch({ executablePath, headless: true });
try {
  for (const theme of ['light', 'dark'] as const) {
    for (const [vp, options] of Object.entries(VIEWPORTS)) {
      const context = await browser.newContext({
        ...options,
        deviceScaleFactor: vp === '390' ? 2 : 1,
        colorScheme: theme,
        reducedMotion: 'reduce',
        timezoneId: 'UTC',
        locale: 'en-US',
      });
      try {
        await context.route('**/*', async route =>
          new URL(route.request().url()).origin !== server.url.origin ? await route.abort() : await route.continue(),
        );
        const page = await context.newPage();
        page.on('pageerror', error => process.stderr.write(`⚠ page error: ${error.message}\n`));
        await page.goto(`${server.url}?settings-harness=1`);
        const settings = page.getByLabel('Settings page preview', { exact: true });
        const navigation = settings.locator(vp === '390' ? '[data-settings-home]' : '[data-settings-sidebar]');
        await navigation.locator('[data-settings-machine="harness-daemon"]').click();
        const surface = settings.locator('[data-machines-surface="harness-daemon"]');
        await surface.waitFor({ state: 'visible' });
        for (const tab of TABS) {
          await surface.locator(`[data-machine-tab="${tab}"]`).click();
          await surface
            .locator(`[data-machine-tab-panel="${tab}"], [data-machine-tab-empty="${tab}"]`)
            .first()
            .waitFor({ state: 'visible' });
          await page.evaluate(async () => {
            await document.fonts.ready;
            for (const animation of document.getAnimations())
              if (animation.effect?.getTiming().iterations !== Number.POSITIVE_INFINITY) animation.finish();
          });
          await page.waitForTimeout(400);
          const state = await page.evaluate(() => ({
            overflow: document.documentElement.scrollWidth - window.innerWidth,
            font: document.fonts.check('16px Inter'),
          }));
          if (state.overflow > 1) fail(`${tab} scrolls sideways by ${state.overflow}px at ${vp}/${theme}`);
          if (!state.font) fail(`the app's font did not load at ${vp}/${theme}`);
          const file = join(outDir, `tab-${tab}-${vp}-${theme}.png`);
          // The page scrolls inside its own frame, so a tall window shows the whole tab, clipped to its bottom.
          const width = page.viewportSize()?.width ?? 390;
          await page.setViewportSize({ width, height: 4000 });
          await page.waitForTimeout(150);
          const bottom = await page.evaluate(
            tabId =>
              document
                .querySelector(`[data-machine-tab-panel="${tabId}"], [data-machine-tab-empty="${tabId}"]`)
                ?.getBoundingClientRect().bottom ?? 900,
            tab,
          );
          await page.screenshot({
            path: file,
            animations: 'disabled',
            clip: { x: 0, y: 0, width, height: Math.min(4000, Math.ceil(bottom) + 24) },
          });
          process.stdout.write(`📸 ${file}\n`);
          if (tab === 'agents') {
            // One (i) open: the Page scripts warning is one tap away, not gone.
            await surface.locator('[data-switch-row="Page scripts"] [data-switch-info]').click();
            await surface
              .locator('[data-switch-row="Page scripts"] [data-switch-explanation]')
              .waitFor({ state: 'visible' });
            await page.waitForTimeout(150);
            const openBottom = await page.evaluate(
              () => document.querySelector('[data-machine-tab-panel="agents"]')?.getBoundingClientRect().bottom ?? 900,
            );
            const infoFile = join(outDir, `agents-info-${vp}-${theme}.png`);
            await page.screenshot({
              path: infoFile,
              animations: 'disabled',
              clip: { x: 0, y: 0, width, height: Math.min(4000, Math.ceil(openBottom) + 24) },
            });
            process.stdout.write(`📸 ${infoFile}\n`);
          }
          await page.setViewportSize({ width, height: vp === '390' ? 844 : 900 });
        }
      } finally {
        await context.close();
      }
    }
  }
  process.stdout.write('✅ every tab drew in the app font and none scrolls sideways\n');
} finally {
  await browser.close();
  server.stop();
}
