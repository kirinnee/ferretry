/**
 * Build the shell harness, serve it on an ephemeral loopback port, and
 * screenshot it at both viewports.
 *
 * Dev-only. It never runs in CI and is not part of the shipped bundle: its whole
 * job is to make "does the port still look like the original?" a thing a human
 * can answer by opening two PNGs.
 *
 * SAFETY: binds 127.0.0.1 on port 0 (the kernel picks a free port), reaches no
 * network, and shuts the server down in a finally.
 *
 *   bun harness/screenshot.ts            # writes harness/out/*.png
 *   bun harness/screenshot.ts --serve    # leave it running to look at by hand
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const harnessDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(harnessDir, '..');
const outDir = join(harnessDir, 'out');

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'desktop', width: 1440, height: 900 },
] as const;

const CHROME_CANDIDATES = ['google-chrome', 'chromium', 'chrome'];

function fail(message: string): never {
  process.stderr.write(`❌ ${message}\n`);
  process.exit(1);
}

function run(command: string, args: readonly string[]): void {
  const result = spawnSync(command, [...args], { cwd: packageDir, stdio: 'inherit' });
  if (result.error) fail(`${command} could not be started: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} ${args.join(' ')} exited ${result.status}`);
}

/**
 * Asynchronous, unlike `run`: the page being screenshotted is served by THIS
 * process, so a blocking spawn would stall the event loop and the browser would
 * meet a connection refusal instead of the harness.
 */
async function runServing(command: string, args: readonly string[]): Promise<void> {
  const child = Bun.spawn([command, ...args], { cwd: packageDir, stdout: 'inherit', stderr: 'ignore' });
  const exit = await child.exited;
  if (exit !== 0) fail(`${command} exited ${exit}`);
}

function findChrome(): string | null {
  for (const candidate of CHROME_CANDIDATES) {
    const found = spawnSync('command', ['-v', candidate], { shell: true, encoding: 'utf8' });
    if (found.status === 0 && found.stdout.trim().length > 0) return candidate;
  }
  return null;
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
    const file = path === '/' ? join(harnessDir, 'index.html') : join(outDir, path);
    return new Response(Bun.file(file));
  },
});

const url = `http://127.0.0.1:${server.port}/`;

try {
  if (process.argv.includes('--serve')) {
    process.stdout.write(`🌐 serving ${url} — Ctrl-C to stop\n`);
    await new Promise(() => {});
  }

  const chrome = findChrome();
  if (chrome === null) fail(`no headless browser found (looked for ${CHROME_CANDIDATES.join(', ')})`);

  for (const viewport of VIEWPORTS) {
    const target = join(outDir, `${viewport.name}.png`);
    await runServing(chrome, [
      '--headless=old',
      '--disable-gpu',
      // The Nix Chrome ships a non-setuid sandbox helper, so the SUID sandbox
      // aborts. This browser only ever loads the loopback page built one step
      // above it, on a developer machine, and exits when the shot is taken.
      '--no-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-crash-reporter',
      '--disable-dev-shm-usage',
      `--user-data-dir=${join(outDir, `profile-${viewport.name}`)}`,
      '--force-device-scale-factor=1',
      '--hide-scrollbars',
      `--window-size=${viewport.width},${viewport.height}`,
      '--virtual-time-budget=3000',
      `--screenshot=${target}`,
      url,
    ]);
    process.stdout.write(`📸 ${viewport.name} ${viewport.width}×${viewport.height} → ${target}\n`);
  }
} finally {
  server.stop(true);
}
