/**
 * Build the shell harness, serve it on an ephemeral loopback port, and
 * screenshot it at both viewports.
 *
 * Dev-only. It never runs in CI and is not part of the shipped bundle: its whole
 * job is to make "does the port still look like the original?" a thing a human
 * can answer by opening two PNGs.
 *
 * It drives the browser through playwright-core with the system Chrome, exactly
 * as the visual integration tests already do, and aborts every request that
 * leaves the loopback origin — a shell harness has no business reaching the
 * network.
 *
 *   bun harness/screenshot.ts            # writes harness/out/*.png
 *   bun harness/screenshot.ts --serve    # leave it running to look at by hand
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const harnessDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(harnessDir, '..');
const outDir = join(harnessDir, 'out');

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'desktop', width: 1_440, height: 900 },
] as const;

/** Harness sections that live below the fold and are captured element by element. */
const SECTIONS = ['harness-session-screen', 'harness-marks', 'harness-chat-width', 'harness-dead-pane'] as const;

function fail(message: string): never {
  process.stderr.write(`❌ ${message}\n`);
  process.exit(1);
}

function run(command: string, args: readonly string[]): void {
  const result = spawnSync(command, [...args], { cwd: packageDir, stdio: 'inherit' });
  if (result.error) fail(`${command} could not be started: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} ${args.join(' ')} exited ${result.status}`);
}

mkdirSync(outDir, { recursive: true });

process.stdout.write('📦 bundling the harness page…\n');
run('bun', ['build', 'harness/main.tsx', '--outdir', 'harness/out', '--target', 'browser']);

process.stdout.write('🎨 compiling the design system…\n');
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
    return new Response(Bun.file(path === '/' ? join(harnessDir, 'index.html') : join(outDir, path)));
  },
});

try {
  if (process.argv.includes('--serve')) {
    process.stdout.write(`🌐 serving ${server.url} — Ctrl-C to stop\n`);
    await new Promise(() => {});
  }

  const chrome = Bun.which('google-chrome') ?? Bun.which('chromium');
  if (chrome === null) fail('no system Chrome or Chromium found');

  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  try {
    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        colorScheme: 'dark',
        reducedMotion: 'reduce',
      });
      await context.route('**/*', async route => {
        if (new URL(route.request().url()).origin !== server.url.origin) {
          await route.abort();
          return;
        }
        await route.continue();
      });
      const page = await context.newPage();
      await page.goto(server.url.toString());
      const target = join(outDir, `${viewport.name}.png`);
      await page.screenshot({ path: target });
      process.stdout.write(`📸 ${viewport.name} ${viewport.width}x${viewport.height} -> ${target}\n`);

      const browserTarget = join(outDir, `remote-browser-${viewport.name}.png`);
      await page.getByLabel('Remote browser display').screenshot({ path: browserTarget });
      process.stdout.write(`📸 remote browser -> ${browserTarget}\n`);
      const learningTarget = join(outDir, `learning-${viewport.name}.png`);
      await page.getByLabel('Learning proposals').screenshot({ path: learningTarget });
      process.stdout.write(`📸 learning -> ${learningTarget}\n`);
      const analyticsTarget = join(outDir, `analytics-${viewport.name}.png`);
      await page.getByLabel('Analytics cost ledger').screenshot({ path: analyticsTarget });
      process.stdout.write(`📸 analytics -> ${analyticsTarget}\n`);
      const analyticsResponseTarget = join(outDir, `analytics-response-${viewport.name}.png`);
      await page.getByLabel('Analytics raw query result').screenshot({ path: analyticsResponseTarget });
      process.stdout.write(`📸 analytics response -> ${analyticsResponseTarget}\n`);
      const analyticsSeriesTarget = join(outDir, `analytics-time-series-${viewport.name}.png`);
      await page.getByLabel('Analytics time series').screenshot({ path: analyticsSeriesTarget });
      process.stdout.write(`📸 analytics time series -> ${analyticsSeriesTarget}\n`);
      const composerSettingsTarget = join(outDir, `markdown-composer-settings-${viewport.name}.png`);
      await page.getByLabel('Markdown composer settings').screenshot({ path: composerSettingsTarget });
      process.stdout.write(`📸 Markdown composer settings -> ${composerSettingsTarget}\n`);
      const learningHeaderTarget = join(outDir, `learning-header-${viewport.name}.png`);
      await page.getByLabel('Learning header').screenshot({ path: learningHeaderTarget });
      process.stdout.write(`📸 Learning header -> ${learningHeaderTarget}\n`);

      // The harness stacks every ported surface down one column, so most of it
      // is below the fold. A full-page stitch cannot prove those: the app bar
      // is sticky, and Chrome repaints a fixed layer into every stitched tile.
      // So each surface below the fold is captured as ITS OWN element shot,
      // which is both immune to that and easier to compare against the
      // original screen by screen.
      for (const section of SECTIONS) {
        const element = page.locator(`#${section}`);
        await element.scrollIntoViewIfNeeded();
        const sectionTarget = join(outDir, `${viewport.name}-${section}.png`);
        await element.screenshot({ path: sectionTarget });
        process.stdout.write(`📸 ${viewport.name} ${section} -> ${sectionTarget}\n`);
      }

      // The context menu is anchored and `fixed`, which is exactly what a
      // full-page stitch cannot capture — so it gets its own viewport-sized
      // pass behind a fragment.
      const menuTarget = join(outDir, `${viewport.name}-menu.png`);
      await page.goto(`${server.url}#menu`);
      await page.reload();
      // Wait for the rows, not just for load: the menu paints hidden and is
      // revealed by a layout effect once it has been measured and clamped.
      await page.locator('[role="menuitem"]').last().waitFor({ state: 'visible' });
      await page.screenshot({ path: menuTarget });
      process.stdout.write(`📸 ${viewport.name} context menu -> ${menuTarget}\n`);

      await context.close();
    }
  } finally {
    await browser.close();
  }
} finally {
  server.stop(true);
}
