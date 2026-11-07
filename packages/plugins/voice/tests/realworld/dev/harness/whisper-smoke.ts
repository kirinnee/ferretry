/**
 * THE END-TO-END PROOF of Whisper dictation — manual, and NEVER in CI: it downloads the real model
 * (tiny.en about 53 MB with its runtime, base.en about 89 MB) from Hugging Face.
 *
 *   cd packages/pwa && bunx vite build && bun harness/whisper-smoke.ts
 *
 * `WHISPER_SMOKE_MODEL=whisper-base-en` picks the model (tiny by default). It runs on WebAssembly, the
 * only backend the app ships for Whisper (`src/worker/whisper-worker.ts`).
 *
 * It serves the BUILT app's assets with the app's real `public/_headers` (the CSP with
 * `'wasm-unsafe-eval'`, Trusted Types, the permissions policy), opens a fresh Chrome profile, installs
 * the model through the shipped store, transcribes a LibriSpeech sample through the shipped worker, and
 * fails on any policy violation, on any request that leaves this machine after the install, and on any
 * file transformers.js asked for that is not pinned (the worker logs each one it answers `404`).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const harnessDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(harnessDir, '..');
const dist = join(packageDir, 'dist');
/** Words LibriSpeech dev-clean 1.flac says, lower-cased. */
const EXPECTED = 'he hoped there would be stew for dinner';
const modelId = process.env.WHISPER_SMOKE_MODEL ?? 'whisper-tiny-en';

const appHeaders = (): Record<string, string> => {
  const lines = readFileSync(join(packageDir, 'public/_headers'), 'utf8').split('\n');
  const headers: Record<string, string> = {};
  for (const line of lines.slice(lines.indexOf('/*') + 1)) {
    if (!line.startsWith('  ')) break;
    const colon = line.indexOf(':');
    headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return headers;
};

const built = readdirSync(join(dist, 'assets'));
const named = (prefix: string, suffix: string): string => {
  const file = built.find(name => name.startsWith(prefix) && name.endsWith(suffix));
  if (file === undefined) throw new Error(`no ${prefix}*${suffix} in dist/assets — run \`bunx vite build\` first`);
  return `/assets/${file}`;
};
const assets = {
  workerUrl: named('whisper-worker-', '.js'),
  runtimeUrl: named('ort-wasm-simd-threaded-', '.wasm'),
};

const bundle = await Bun.build({ entrypoints: [join(harnessDir, 'whisper-smoke-page.ts')], target: 'browser' });
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

/** Resident memory of every Chrome renderer process, by pid (Linux `ps`); empty where there is none. */
const renderers = (): Map<number, number> => {
  const listed = Bun.spawnSync(['ps', '-eo', 'pid=,rss=,args=']).stdout.toString();
  const found = new Map<number, number>();
  for (const line of listed.split('\n')) {
    const [pid, rss, ...rest] = line.trim().split(/\s+/u);
    if (rest.join(' ').includes('--type=renderer')) found.set(Number(pid), Number(rss) * 1024);
  }
  return found;
};

interface TabRun {
  readonly result: { readonly ok: boolean; readonly value?: unknown; readonly error?: string };
  /** The renderer's growth from "installed, sample decoded, no worker" to "decoded twice". */
  readonly workerMb: number;
  readonly violations: readonly string[];
}

const executablePath = process.env.CHROME_PATH ?? 'google-chrome';
/** Renderers that are not this run's: any other Chrome on the machine. */
const foreign = renderers();
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const context = await browser.newContext();
  const consoleLines: string[] = [];
  const offMachine: string[] = [];
  let installed = false;
  context.on('request', request => {
    const url = request.url();
    if (installed && !url.startsWith(`http://127.0.0.1:${server.port}/`)) offMachine.push(url);
  });

  /**
   * One tab: install (a no-op once installed), decode the sample, then start the worker and decode
   * twice. The second tab's memory reading is the clean one: its install had nothing to download.
   */
  const runTab = async (): Promise<TabRun> => {
    const tab = await context.newPage();
    tab.on('pageerror', error => console.log(`[page error] ${error.message}`));
    tab.on('console', message => consoleLines.push(message.text()));
    tab.on('worker', worker => worker.on('console', message => consoleLines.push(`[worker] ${message.text()}`)));
    const ours = (): number =>
      [...renderers()].filter(([pid]) => !foreign.has(pid)).reduce((sum, [, rss]) => sum + rss, 0);
    const waitFor = async (probe: () => boolean, what: string): Promise<void> => {
      for (let tries = 0; !(await tab.evaluate(probe)); tries += 1) {
        if (tries > 6000) throw new Error(`the smoke page never ${what}`);
        await Bun.sleep(100);
      }
    };
    await tab.goto(`http://127.0.0.1:${server.port}/`);
    await waitFor(() => typeof (globalThis as { __smoke?: unknown }).__smoke === 'function', 'loaded');
    const running = tab.evaluate(async id => {
      const smoke = (globalThis as { __smoke?: (id: string) => Promise<unknown> }).__smoke;
      try {
        return { ok: true as const, value: await smoke?.(id) };
      } catch (error) {
        return { ok: false as const, error: String(error) };
      }
    }, modelId);
    await waitFor(() => typeof (globalThis as { __go?: unknown }).__go === 'function', 'finished installing');
    // From here on nothing but this page's own server may be asked for anything.
    installed = true;
    const baseline = ours();
    await tab.evaluate(() => (globalThis as { __go?: () => void }).__go?.());
    const result = await running;
    const workerMb = Math.round((ours() - baseline) / 1_000_000);
    // zod probes `new Function` once at start-up to pick its fast path; Trusted Types refusing that
    // probe is the policy working, and has nothing to do with speech.
    const violations = (
      (await tab.evaluate(() => (globalThis as { __violations?: string[] }).__violations)) ?? []
    ).filter(violation => !violation.includes('/__smoke.js'));
    await tab.close();
    installed = false;
    return { result, workerMb, violations };
  };

  const first = await runTab();
  const second = await runTab();
  const unpinned = consoleLines.filter(line => line.includes('not pinned'));
  console.log(JSON.stringify({ modelId, assets, first, second, offMachine, consoleLines }, null, 2));
  const heard = (run: TabRun): string =>
    run.result.ok ? String((run.result.value as { text?: unknown }).text ?? '').toLowerCase() : '';
  const clean = (run: TabRun): boolean => heard(run).includes(EXPECTED) && run.violations.length === 0;
  if (!clean(first) || !clean(second) || offMachine.length > 0 || unpinned.length > 0) process.exitCode = 1;
  else console.log(`✅ ${modelId} installed, verified and transcribed on-device under the app’s real policy`);
} finally {
  await browser.close();
  server.stop();
}
