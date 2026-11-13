/**
 * NEAR-LIVE PARAKEET, MEASURED IN A REAL BROWSER — manual, and NEVER in CI: like `parakeet-smoke.ts`
 * it installs the real ~683 MB model from Hugging Face (docs/voice.md).
 *
 *   cd packages/pwa && bunx vite build && bun harness/parakeet-near-live-smoke.ts
 *
 * It serves the BUILT app's assets under the app's real `public/_headers`, then plays three
 * LibriSpeech dev-clean clips and the first again (about 31 s) into the shipped near-live transcriber in real time,
 * through the shipped speech worker, and reports:
 *
 *   - how long each live pass takes, and the interval it settled on;
 *   - how far the live words trail the speech (interim and committed lag, p50/p95);
 *   - Stop-to-final time, and the word error rate of the near-live final text next to today's single
 *     pass over the same take.
 *
 * `PARAKEET_SMOKE_PROFILE=<dir>` keeps the Chrome profile (and the installed model) between runs, on
 * a fixed port so the origin — and its Cache Storage — is the same each time.
 * `PARAKEET_SMOKE_SLOWDOWN=3` makes every live pass take three times as long — a stand-in for a
 * phone, since DevTools CPU throttling does not reach a worker — to see live words back off and pause.
 * `PARAKEET_SMOKE_TIMELINE=1` prints every pass and every change of the live words.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const harnessDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(harnessDir, '..');
const dist = join(packageDir, 'dist');

/** What the four clips say, in order. */
const REFERENCE = [
  'He hoped there would be stew for dinner, turnips and carrots and bruised potatoes and fat mutton pieces to be ladled out in thick peppered flour fattened sauce.',
  'Stuff it into you, his belly counselled him.',
  'After early nightfall the yellow lamps would light up here and there the squalid quarter of the brothels.',
  'He hoped there would be stew for dinner, turnips and carrots and bruised potatoes and fat mutton pieces to be ladled out in thick peppered flour fattened sauce.',
].join(' ');

const normalise = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/u)
    .filter(Boolean);

const wordErrorRate = (reference: string, hypothesis: string): number => {
  const ref = normalise(reference);
  const hyp = normalise(hypothesis);
  let row = Array.from({ length: hyp.length + 1 }, (_, j) => j);
  for (let i = 1; i <= ref.length; i += 1) {
    const next = [i];
    for (let j = 1; j <= hyp.length; j += 1)
      next[j] = Math.min(
        (row[j] as number) + 1,
        (next[j - 1] as number) + 1,
        (row[j - 1] as number) + (ref[i - 1] === hyp[j - 1] ? 0 : 1),
      );
    row = next;
  }
  return (row[hyp.length] as number) / ref.length;
};

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
const assets = { workerUrl: named('parakeet-worker-', '.js'), runtimeUrl: named('ort-wasm-simd-threaded', '.wasm') };

const bundle = await Bun.build({
  entrypoints: [join(harnessDir, 'parakeet-near-live-smoke-page.ts')],
  target: 'browser',
});
const [script] = bundle.outputs;
if (!bundle.success || script === undefined) throw new Error(bundle.logs.join('\n'));
const scriptText = await script.text();

const headers = appHeaders();
const page = `<!doctype html><meta charset="utf-8"><script type="application/json" id="assets">${JSON.stringify(assets)}</script><script type="module" src="/__smoke.js"></script>`;
const types: Record<string, string> = { js: 'text/javascript', wasm: 'application/wasm', html: 'text/html' };
const profile = process.env.PARAKEET_SMOKE_PROFILE;
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: profile === undefined ? 0 : 43_117,
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
const context =
  profile === undefined
    ? await (await chromium.launch({ executablePath, headless: true })).newContext()
    : await chromium.launchPersistentContext(profile, { executablePath, headless: true });
try {
  const tab = await context.newPage();
  tab.on('pageerror', error => console.log(`[page error] ${error.message}`));
  const slowdown = Math.max(1, Number(process.env.PARAKEET_SMOKE_SLOWDOWN ?? '1') || 1);
  await tab.goto(`http://127.0.0.1:${server.port}/?slowdown=${slowdown}`);
  for (
    let tries = 0;
    !(await tab.evaluate(() => typeof (globalThis as { __nearLive?: unknown }).__nearLive));
    tries += 1
  ) {
    if (tries > 100) throw new Error('the smoke page never loaded');
    await Bun.sleep(100);
  }
  const result = await tab.evaluate(async () => {
    const run = (globalThis as { __nearLive?: () => Promise<unknown> }).__nearLive;
    try {
      return { ok: true as const, value: await run?.() };
    } catch (error) {
      return { ok: false as const, error: String(error) };
    }
  });
  if (!result.ok) throw new Error(result.error);
  const value = result.value as {
    single: { text: string };
    nearLive: { final: string; timeline?: unknown };
  };
  const werSingle = wordErrorRate(REFERENCE, value.single.text);
  const werNearLive = wordErrorRate(REFERENCE, value.nearLive.final);
  const verbose = process.env.PARAKEET_SMOKE_TIMELINE === '1';
  const { timeline, ...nearLive } = value.nearLive;
  console.log(
    JSON.stringify(
      {
        slowdown,
        ...value,
        nearLive: verbose ? value.nearLive : nearLive,
        wer: { single: +werSingle.toFixed(4), nearLive: +werNearLive.toFixed(4) },
      },
      null,
      2,
    ),
  );
  if (werNearLive > werSingle) {
    process.exitCode = 1;
    console.log('❌ the near-live final text was less accurate than the single pass');
  } else console.log('✅ near-live final text is at least as accurate as the single pass');
} finally {
  await context.close();
  server.stop();
}
