// Realworld: loads the real 615 MB Google AudioTranscriber model in a real Chrome under the BUILT app's real policy.
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { GOOGLE_TRANSCRIBER_MODEL } from '../../app/lib/stt/google-transcriber-model.ts';

/**
 * The red/green proof of the Google live-words engine, through the shipped voice's own entry (`browserGoogleVoice`:
 * Install → the worker loads the verified bytes → a dictation session with a microphone):
 *  - RED: a server that sends the real model with one flipped bit is refused by Install (`integrity`), and the voice is
 *    not installed;
 *  - GREEN: the pinned bytes install, a fake microphone plays `clip-5s.wav` (a synthetic voice saying one sentence)
 *    into a real dictation session, live words appear before Stop, and the text Stop answers is that sentence. The real-
 *    time wait after Stop, the load time and the browser's memory are printed for the PR.
 *
 * Needs, by environment: FY_VOICE_APP_DIST (the built app: `bunx vite build --outDir <dir>` in packages/app) and
 * FY_VOICE_GOOGLE_MODEL (the model file, named by its pinned size and hash — a 615 MB download is not a thing a test run
 * does by itself). CHROME_PATH names the browser. To stand in for a mid-range phone the run can be
 * limited to a quarter of one core (`FY_VOICE_LIMITED=1 systemd-run --user --scope -p CPUQuota=25% bun test …`): the research benchmark's 4×
 * CPU throttle (`Emulation.setCPUThrottlingRate`) is refused for workers ("only supported for pages"), and the engine
 * runs in one. Without them the test says so and skips.
 */
const DIST = process.env.FY_VOICE_APP_DIST;
const MODEL = process.env.FY_VOICE_GOOGLE_MODEL;
const here = dirname(fileURLToPath(import.meta.url));
const CLIP = join(here, 'dev/speed-bench/clip-5s.wav');
const HEADERS_FILE = resolve(here, '../../../../app/public/_headers');
const SENTENCE = 'please fix the login redirect and run the tests again';
const words = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[^a-z ]/gu, '')
    .split(/\s+/u)
    .filter(Boolean);

/** Word error rate against the one sentence: edits / reference words. */
const wer = (heard: string): number => {
  const a = words(SENTENCE);
  const b = words(heard);
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j += 1) (rows[0] as number[])[j] = j;
  for (let i = 1; i <= a.length; i += 1)
    for (let j = 1; j <= b.length; j += 1)
      (rows[i] as number[])[j] = Math.min(
        (rows[i - 1] as number[])[j]! + 1,
        (rows[i] as number[])[j - 1]! + 1,
        (rows[i - 1] as number[])[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
  return (rows[a.length] as number[])[b.length]! / a.length;
};

const appHeaders = (): Record<string, string> => {
  const lines = readFileSync(HEADERS_FILE, 'utf8').split('\n');
  const headers: Record<string, string> = {};
  for (const line of lines.slice(lines.indexOf('/*') + 1)) {
    if (!line.startsWith('  ')) break;
    const colon = line.indexOf(':');
    headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return headers;
};

/** Resident memory of every process of this run's browser, in MB (the profile folder is on every command line). */
const browserMegabytes = (profile: string): number => {
  const table = execFileSync('ps', ['-eo', 'rss,args'], { encoding: 'utf8' });
  return Math.round(
    table
      .split('\n')
      .filter(line => line.includes(profile))
      .reduce((sum, line) => sum + Number(line.trim().split(/\s+/u)[0] ?? 0), 0) / 1024,
  );
};

describe.skipIf(DIST === undefined || MODEL === undefined)('the Google live-words engine, with the real model', () => {
  test('refuses a flipped bit, then installs, hears a fake microphone live and answers the sentence', async () => {
    const dist = DIST as string;
    const model = new Uint8Array(await Bun.file(MODEL as string).arrayBuffer());
    expect(model.byteLength).toBe(GOOGLE_TRANSCRIBER_MODEL.files[0]?.bytes ?? -1);
    const assetNames = new Bun.Glob('assets/*').scanSync({ cwd: dist });
    const built = [...assetNames];
    const named = (prefix: string, suffix: string): string => {
      const file = built.find(name => name.startsWith(`assets/${prefix}`) && name.endsWith(suffix));
      if (file === undefined) throw new Error(`no ${prefix}*${suffix} in ${dist}/assets`);
      return `/${file}`;
    };
    const assets = {
      workerUrl: named('google-worker-', '.js'),
      runtimeUrl: named('audio_wasm_module_internal-', '.wasm'),
    };
    const bundle = await Bun.build({
      entrypoints: [join(here, 'dev/harness/google-transcriber-page.ts')],
      target: 'browser',
    });
    const [script] = bundle.outputs;
    if (!bundle.success || script === undefined) throw new Error(bundle.logs.join('\n'));
    const scriptText = await script.text();
    const headers = appHeaders();
    const types: Record<string, string> = { js: 'text/javascript', wasm: 'application/wasm', html: 'text/html' };
    let flipped: Uint8Array<ArrayBuffer> | null = model.slice();
    flipped[1_000] = (flipped[1_000] ?? 0) ^ 1;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        const respond = (body: BodyInit, type: string): Response =>
          new Response(body, { headers: { ...headers, 'content-type': type } });
        if (path.startsWith('/__hf/')) {
          // The model, ranges answered like Hugging Face's CDN; one bit flipped while `flipped` is held.
          const range = /^bytes=(\d+)-(\d*)$/u.exec(request.headers.get('range') ?? '');
          const from = range === null ? 0 : Number(range[1]);
          const body: Blob =
            flipped === null ? Bun.file(MODEL as string).slice(from) : new Blob([flipped.subarray(from)]);
          return new Response(body, {
            status: range === null ? 200 : 206,
            headers: {
              'content-type': 'application/octet-stream',
              ...(range === null
                ? {}
                : { 'content-range': `bytes ${from}-${model.byteLength - 1}/${model.byteLength}` }),
            },
          });
        }
        if (path === '/')
          return respond(
            '<!doctype html><meta charset="utf-8"><script type="module" src="/__page.js"></script>',
            'text/html',
          );
        if (path === '/__page.js') return respond(scriptText, types.js as string);
        if (path.startsWith('/assets/'))
          return respond(Bun.file(join(dist, path)), types[path.split('.').pop() ?? ''] ?? 'application/octet-stream');
        return new Response('not found', { status: 404 });
      },
    });
    const profile = await mkdtemp(join(tmpdir(), 'fy-google-transcriber-'));
    const context = await chromium.launchPersistentContext(profile, {
      executablePath: process.env.CHROME_PATH ?? 'google-chrome',
      headless: true,
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        `--use-file-for-fake-audio-capture=${CLIP}%noloop`,
        ...(process.env.CHROME_ARGS ?? '').split(' ').filter(word => word !== ''),
      ],
    });
    try {
      const tab = context.pages()[0] ?? (await context.newPage());
      tab.on('crash', () => console.log('[page crashed]'));
      tab.on('pageerror', error => console.log(`[page error] ${error.message}`));
      await tab.goto(`http://127.0.0.1:${server.port}/`);
      await tab.waitForFunction(() => (globalThis as { __api?: unknown }).__api !== undefined);
      const api = <T>(method: 'install' | 'dictate', ...args: unknown[]): Promise<T> =>
        tab.evaluate(
          ([name, parameters]) =>
            (globalThis as unknown as { __api: Record<string, (...a: unknown[]) => Promise<unknown>> }).__api[
              name as string
            ]!(...(parameters as unknown[])),
          [method, args] as const,
        ) as Promise<T>;

      // RED
      const refused = await api<{ phase: string; error?: { code: string } }>('install', assets);
      console.log('tampered install →', refused.phase, refused.error?.code);
      expect(refused.phase).not.toBe('installed');
      expect(refused.error?.code).toBe('integrity');

      // GREEN
      flipped = null;
      const began = Date.now();
      const ready = await api<{ phase: string; downloadedBytes: number; totalBytes: number }>('install', assets);
      console.log('install →', ready.phase, `${Math.round((Date.now() - began) / 1000)} s`, ready.totalBytes);
      expect(ready.phase).toBe('installed');
      const both = await api<{
        cold: { afterStopMs: number; failure: string };
        warm: {
          text: string;
          failure: string;
          afterStopMs: number;
          live: { at: number; committed: string; interim: string }[];
        };
      }>('dictate', assets, 5_000);
      const heard = both.warm;
      console.log('cold start (first take, model load): Stop → text', both.cold.afterStopMs, 'ms');
      const megabytes = browserMegabytes(profile);
      console.log('dictation →', JSON.stringify(heard));
      console.log(`browser memory with the model loaded: ${megabytes} MB; WER ${wer(heard.text)};`);
      expect(heard.failure).toBe('');
      // Live words need a machine that keeps up: held to a quarter of one core (FY_VOICE_LIMITED=1) none appear in 5 s, and that is the finding.
      if (process.env.FY_VOICE_LIMITED !== '1')
        expect(heard.live.some(state => state.interim !== '' || state.committed !== '')).toBe(true);
      expect(wer(heard.text)).toBeLessThanOrEqual(0);
      const violations = await tab.evaluate(() => (globalThis as { __violations?: string[] }).__violations ?? []);
      console.log('policy violations →', violations);
      // The harness bundle's own zod probes `new Function('')` once, catches the refusal and goes on (the app's page does the same
      // and says so in its console); nothing from the worker, the loader or MediaPipe may be refused.
      expect(violations.filter(violation => !violation.endsWith('/__page.js'))).toEqual([]);
    } finally {
      await context.close().catch(() => undefined);
      server.stop(true);
      await rm(profile, { recursive: true, force: true });
    }
  }, 900_000);
});
