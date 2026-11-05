/**
 * THE SPEED BENCHMARK under the app's real policy — manual, NEVER in CI (it downloads the on-device models).
 *
 *   cd packages/pwa && bunx vite build && bun harness/stt-speed-bench.ts [options]
 *
 *   --engines a,b,c   catalog ids (default: parakeet,parakeet-tdt-110m,whisper-base-en,vosk-small-en)
 *   --isolated        answer every request with COOP same-origin + COEP require-corp, so the page is
 *                     cross-origin isolated and `wasm-threads` can run
 *   --blob-workers    ALSO allow `blob:` in `worker-src`, to show whether threads need that policy change
 *   --no-threads      measure single-thread only
 *   --profile <dir>   the browser profile (models installed in it stay installed between runs)
 *   --warm <n>        warm decodes per run (default 3)
 *   --port <n>        the loopback port (default 47831). FIXED, because the installed models live in Cache Storage
 *                     and that is per origin: a new port would download them all again
 *
 * It serves the BUILT app's assets with the app's real `public/_headers` (the CSP, Trusted Types, the
 * permissions policy), launches Chrome, and prints the timings-only JSON plus every policy violation. The
 * one-click page for a phone or a GPU machine is `speed-bench/` on the dev server instead.
 * `CHROME_PATH` names the browser; `CHROME_ARGS` adds flags (e.g. `--enable-unsafe-swiftshader` to see a
 * software WebGPU adapter).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const harnessDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(harnessDir, '..');
const dist = join(packageDir, 'dist');

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(`--${name}`);
const value = (name: string, fallback: string): string => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] !== undefined ? (args[at + 1] as string) : fallback;
};
const isolated = flag('isolated');
const engines = value('engines', 'parakeet,parakeet-tdt-110m,whisper-base-en,vosk-small-en').split(',');
const profile = value('profile', join(packageDir, 'harness/out/stt-speed-bench-profile'));

const appHeaders = (): Record<string, string> => {
  const lines = readFileSync(join(packageDir, 'public/_headers'), 'utf8').split('\n');
  const headers: Record<string, string> = {};
  for (const line of lines.slice(lines.indexOf('/*') + 1)) {
    if (!line.startsWith('  ')) break;
    const colon = line.indexOf(':');
    headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  if (flag('blob-workers'))
    headers['Content-Security-Policy'] = (headers['Content-Security-Policy'] ?? '').replace(
      "worker-src 'self'",
      "worker-src 'self' blob:",
    );
  if (isolated) {
    headers['Cross-Origin-Opener-Policy'] = 'same-origin';
    headers['Cross-Origin-Embedder-Policy'] = 'require-corp';
  }
  return headers;
};

const built = readdirSync(join(dist, 'assets'));
const named = (prefix: string, suffix: string): string => {
  const file = built.find(name => name.startsWith(prefix) && name.endsWith(suffix));
  if (file === undefined) throw new Error(`no ${prefix}*${suffix} in dist/assets — run \`bunx vite build\` first`);
  return `/assets/${file}`;
};
const ort = named('ort-wasm-simd-threaded', '.wasm');
const assets = {
  parakeet: { workerUrl: named('parakeet-worker-', '.js'), runtimeUrl: ort },
  sherpa: { workerUrl: named('sherpa-worker-', '.js'), runtimeUrl: named('asr-', '.wasm') },
  vosk: { workerUrl: named('vosk-worker-', '.js'), runtimeUrl: named('vosk-', '.wasm') },
  whisper: { workerUrl: named('whisper-worker-', '.js'), runtimeUrl: ort },
};

const bundle = await Bun.build({ entrypoints: [join(harnessDir, 'stt-speed-bench-page.ts')], target: 'browser' });
const [script] = bundle.outputs;
if (!bundle.success || script === undefined) throw new Error(bundle.logs.join('\n'));
const scriptText = await script.text();

const headers = appHeaders();
const page = `<!doctype html><meta charset="utf-8"><script type="application/json" id="assets">${JSON.stringify(assets)}</script><script type="module" src="/__bench.js"></script>`;
const types: Record<string, string> = {
  js: 'text/javascript',
  wasm: 'application/wasm',
  html: 'text/html',
  wav: 'audio/wav',
};
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: Number(value('port', '47831')),
  fetch(request) {
    const path = new URL(request.url).pathname;
    const respond = (body: BodyInit, type: string): Response =>
      new Response(body, { headers: { ...headers, 'content-type': type } });
    if (path === '/') return respond(page, types.html as string);
    if (path === '/__bench.js') return respond(scriptText, types.js as string);
    if (path === '/clip-5s.wav')
      return respond(Bun.file(join(packageDir, 'speed-bench/clip-5s.wav')), types.wav as string);
    if (path.startsWith('/assets/'))
      return respond(Bun.file(join(dist, path)), types[path.split('.').pop() ?? ''] ?? 'application/octet-stream');
    return new Response('not found', { status: 404 });
  },
});

const executablePath = process.env.CHROME_PATH ?? 'google-chrome';
const extra = (process.env.CHROME_ARGS ?? '').split(' ').filter(word => word !== '');
const context = await chromium.launchPersistentContext(profile, { executablePath, headless: true, args: extra });
try {
  const tab = context.pages()[0] ?? (await context.newPage());
  tab.on('pageerror', error => console.error(`[page error] ${error.message}`));
  // A worker's own console (the speech workers warn when they give up on threads, and say which URL a thread used).
  tab.on('worker', worker => worker.on('console', message => console.error(`[worker] ${message.text()}`)));
  await tab.goto(`http://127.0.0.1:${server.port}/`);
  for (let tries = 0; !(await tab.evaluate(() => typeof (globalThis as { __bench?: unknown }).__bench)); tries += 1) {
    if (tries > 100) throw new Error('the benchmark page never loaded');
    await Bun.sleep(100);
  }
  const options = {
    engines,
    paths: flag('no-threads') ? ['wasm-single'] : ['wasm-single', 'wasm-threads'],
    warmRuns: Number(value('warm', '3')),
    pauseMs: 1_500,
    install: true,
  };
  const timer = setInterval(async () => {
    const lines = await tab
      .evaluate(() => (globalThis as { __progress?: string[] }).__progress?.splice(0) ?? [])
      .catch(() => []);
    for (const line of lines) console.error(line);
  }, 2_000);
  const report = await tab.evaluate(
    async opts => await (globalThis as unknown as { __bench: (o: unknown) => Promise<unknown> }).__bench(opts),
    options,
  );
  clearInterval(timer);
  const violations = (
    (await tab.evaluate(() => (globalThis as { __violations?: string[] }).__violations)) ?? []
  ).filter(violation => !violation.includes('/__bench.js'));
  console.log(
    JSON.stringify({ isolatedServer: isolated, blobWorkers: flag('blob-workers'), report, violations }, null, 2),
  );
} finally {
  await context.close();
  server.stop();
}
