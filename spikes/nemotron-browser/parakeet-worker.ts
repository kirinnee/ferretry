// SPIKE: the SAME Parakeet stack Ferretry ships (parakeet.js 1.4.4 + onnxruntime-web 1.24.1 wasm,
// single thread, the same pinned int8 files), behind the bench's worker protocol, so a phone can
// compare it with the streaming models on one page. Bundled by build.ts.

import * as ort from 'onnxruntime-web/wasm';
import { JsPreprocessor } from 'parakeet.js/mel';
import { ParakeetModel } from 'parakeet.js/parakeet';
import { ParakeetVocabulary } from '../../packages/pwa/src/lib/stt/parakeet-vocabulary.ts';

const scope = globalThis as unknown as {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: { id: number; type: string } & Record<string, unknown> }) => void) | null;
  location: { href: string };
};
const SLOWDOWN = Math.max(1, Number(new URL(scope.location.href).searchParams.get('slowdown') ?? '1') || 1);
const CACHE = 'nemotron-bench-v1';

const ParakeetWithParts = ParakeetModel as unknown as new (parts: Record<string, unknown>) => ParakeetModel;
let model: ParakeetModel | null = null;

const spin = (ms: number): void => {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    /* stand-in for a slower CPU */
  }
};

async function fetchCached(url: string, name: string, size: number): Promise<{ bytes: Uint8Array; cached: boolean }> {
  const cache = await caches.open(CACHE).catch(() => null);
  const hit = cache ? await cache.match(url) : undefined;
  if (hit) return { bytes: new Uint8Array(await hit.arrayBuffer()), cached: true };
  const response = await fetch(url);
  if (!response.ok || response.body === null) throw new Error(`${url}: HTTP ${response.status}`);
  const total = Number(response.headers.get('content-length') ?? 0) || size;
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    received += value.length;
    scope.postMessage({ type: 'progress', file: name, got: received, total });
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  if (cache) await cache.put(url, new Response(bytes)).catch(() => undefined);
  return { bytes, cached: false };
}

const handlers: Record<string, (body: Record<string, unknown>) => Promise<unknown>> = {
  async load(body) {
    const files = body.files as { name: string; url: string; bytes: number }[];
    const t0 = performance.now();
    const got: Record<string, Uint8Array> = {};
    let fromCache = true;
    let downloaded = 0;
    for (const file of files) {
      const { bytes, cached } = await fetchCached(file.url, file.name, file.bytes);
      got[file.name] = bytes;
      fromCache &&= cached;
      downloaded += bytes.length;
    }
    const tFetched = performance.now();
    ort.env.wasm.wasmBinary = got.runtime as Uint8Array;
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    const options: ort.InferenceSession.SessionOptions = {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
      logSeverityLevel: 3,
    };
    const encoderSession = await ort.InferenceSession.create(got.encoder as Uint8Array, options);
    const joinerSession = await ort.InferenceSession.create(got.decoder as Uint8Array, options);
    model = new ParakeetWithParts({
      tokenizer: ParakeetVocabulary.parse(new TextDecoder().decode(got.vocabulary)),
      encoderSession,
      joinerSession,
      preprocessor: new JsPreprocessor({ nMels: 128 }),
      ort,
      nMels: 128,
    });
    const tInit = performance.now();
    return {
      downloadMs: tFetched - t0,
      fromCache,
      downloadedBytes: downloaded,
      initMs: tInit - tFetched,
      totalMs: tInit - t0,
      heapNow: null,
    };
  },
  async transcribe(body) {
    if (model === null) throw new Error('load first');
    const samples = body.samples as Float32Array;
    const t0 = performance.now();
    const heard = await model.transcribe(samples, 16_000, { returnTimestamps: true, returnConfidences: false });
    let ms = performance.now() - t0;
    if (SLOWDOWN > 1) {
      spin(ms * (SLOWDOWN - 1));
      ms *= SLOWDOWN;
    }
    return {
      decodeMs: ms,
      text: heard.utterance_text.trim(),
      words: (heard.words ?? []).map(w => ({ text: w.text, start: w.start_time, end: w.end_time })),
    };
  },
};

scope.onmessage = event => {
  const { id, type, ...body } = event.data;
  const handler = handlers[type];
  if (handler === undefined) return;
  handler(body).then(
    value => scope.postMessage({ type: 'reply', id, ok: true, value }),
    (error: unknown) =>
      scope.postMessage({ type: 'reply', id, ok: false, error: String(error instanceof Error ? error.stack : error) }),
  );
};
