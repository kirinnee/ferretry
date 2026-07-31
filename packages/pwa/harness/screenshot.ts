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
      await context.close();
      process.stdout.write(`📸 ${viewport.name} ${viewport.width}x${viewport.height} -> ${target}\n`);
    }
  } finally {
    await browser.close();
  }
} finally {
  server.stop(true);
}
