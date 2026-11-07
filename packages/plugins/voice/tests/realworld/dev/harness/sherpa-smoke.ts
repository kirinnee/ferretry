/**
 * THE END-TO-END PROOF of streaming sherpa dictation — manual, and NEVER in CI: it downloads the real
 * sherpa-onnx runtime from the build and a real model (~44–73 MB) from Hugging Face.
 *
 *   cd packages/pwa && bunx vite build && bun harness/sherpa-smoke.ts [model-id]
 *
 * It serves the BUILT app's assets with the app's real `public/_headers` (the CSP with
 * `'wasm-unsafe-eval'`, Trusted Types, the permissions policy), opens a fresh Chrome profile, installs
 * the model and the shared runtime through the shipped stores, STREAMS a LibriSpeech sample through the
 * shipped worker a quarter-second at a time, and fails on a wrong transcript or any policy violation.
 * The default model is `sherpa-zipformer-en`; pass another sherpa catalog id to try it.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const harnessDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(harnessDir, '..');
const dist = join(packageDir, 'dist');
/** The sentence LibriSpeech dev-clean 1.flac says. */
const EXPECTED = 'He hoped there would be stew for dinner';

const appHeaders = (): Record<string, string> => {
  const lines = readFileSync(join(packageDir, 'public/_headers'), 'utf8').split('\n');
  const headers: Record<string, string> = {};
  for (const line of lines.slice(lines.indexOf('/*') + 1)) {
    if (!line.startsWith('  ')) break;
    const colon = line.indexOf(':');
    headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  if (process.env.SHERPA_SMOKE_NO_WASM === '1')
    headers['Content-Security-Policy'] = (headers['Content-Security-Policy'] ?? '').replace(" 'wasm-unsafe-eval'", '');
  return headers;
};

const built = readdirSync(join(dist, 'assets'));
const named = (prefix: string, suffix: string): string => {
  const file = built.find(name => name.startsWith(prefix) && name.endsWith(suffix));
  if (file === undefined) throw new Error(`no ${prefix}*${suffix} in dist/assets — run \`bunx vite build\` first`);
  return `/assets/${file}`;
};
const assets = {
  workerUrl: named('sherpa-worker-', '.js'),
  runtimeUrl: named('asr-', '.wasm'),
  model: process.argv[2] ?? 'sherpa-zipformer-en',
};

const bundle = await Bun.build({ entrypoints: [join(harnessDir, 'sherpa-smoke-page.ts')], target: 'browser' });
const [script] = bundle.outputs;
if (!bundle.success || script === undefined) throw new Error(bundle.logs.join('\n'));
const scriptText = await script.text();

const headers = appHeaders();
const page = `<!doctype html><meta charset="utf-8"><script type="application/json" id="assets">${JSON.stringify(assets)}</script><script type="module" src="/__smoke.js"></script>`;
const types: Record<string, string> = { js: 'text/javascript', wasm: 'application/wasm', html: 'text/html' };
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    const respond = (body: BodyInit, type: string): Response =>
      new Response(body, { headers: { ...headers, 'content-type': type } });
    if (path === '/') return respond(page, types.html as string);
    if (path === '/__smoke.js') return respond(scriptText, types.js as string);
    const file = Bun.file(join(dist, path));
    return path.startsWith('/assets/')
      ? respond(file, types[path.split('.').pop() ?? ''] ?? 'application/octet-stream')
      : new Response('not found', { status: 404 });
  },
});

const executablePath = process.env.CHROME_PATH ?? 'google-chrome';
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const tab = await (await browser.newContext()).newPage();
  tab.on('pageerror', error => console.log(`[page error] ${error.message}`));
  await tab.goto(`http://127.0.0.1:${server.port}/`);
  for (let tries = 0; !(await tab.evaluate(() => typeof (globalThis as { __smoke?: unknown }).__smoke)); tries += 1) {
    if (tries > 100) throw new Error('the smoke page never loaded');
    await Bun.sleep(100);
  }
  const result = await tab.evaluate(async () => {
    const smoke = (globalThis as { __smoke?: () => Promise<unknown> }).__smoke;
    try {
      return { ok: true as const, value: await smoke?.() };
    } catch (error) {
      return { ok: false as const, error: String(error) };
    }
  });
  // zod probes `new Function` once at start-up to pick its fast path; Trusted Types refusing that probe
  // is the policy working, and has nothing to do with speech.
  const violations = (
    (await tab.evaluate(() => (globalThis as { __violations?: string[] }).__violations)) ?? []
  ).filter(violation => !violation.includes('/__smoke.js'));
  console.log(JSON.stringify({ assets, result, violations }, null, 2));
  const heard = JSON.stringify(result.ok ? result.value : '').toLowerCase();
  if (!result.ok || !heard.includes(EXPECTED.toLowerCase()) || violations.length > 0) process.exitCode = 1;
  else console.log(`✅ ${assets.model} installed, verified and streamed on-device under the app’s real policy`);
} finally {
  await browser.close();
  server.stop();
}
