// SPIKE: streaming ASR through sherpa-onnx WebAssembly, in a dedicated worker.
// Downloads one model's four files from Hugging Face (Cache Storage keeps them between visits),
// writes them into the Emscripten filesystem, builds an OnlineRecognizer and decodes audio chunks
// as they arrive. Every reply carries the wasm heap size, which is the memory that matters.

/* global importScripts, createOnlineRecognizer, FS */
'use strict';

const params = new URL(self.location.href).searchParams;
const SLOWDOWN = Math.max(1, Number(params.get('slowdown') || '1') || 1);
const CACHE = 'nemotron-bench-v1';

let ready;
const runtimeReady = new Promise(resolve => {
  ready = resolve;
});
self.Module = {
  locateFile: path => path,
  onRuntimeInitialized: () => ready(),
  print: () => {},
  printErr: text => self.postMessage({ type: 'log', text: String(text) }),
};
importScripts('sherpa-onnx-asr.js', 'sherpa-onnx-wasm-main-asr.js');

let recognizer = null;
let stream = null;
let peakHeap = 0;

const heapBytes = () => {
  const bytes = self.Module.HEAPU8 ? self.Module.HEAPU8.buffer.byteLength : 0;
  peakHeap = Math.max(peakHeap, bytes);
  return bytes;
};

const spin = ms => {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    /* stand-in for a slower CPU */
  }
};

async function fetchCached(url, onProgress) {
  const cache = await caches.open(CACHE).catch(() => null);
  const hit = cache ? await cache.match(url) : undefined;
  if (hit) return { bytes: new Uint8Array(await hit.arrayBuffer()), cached: true };
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const total = Number(response.headers.get('content-length') || 0);
  const reader = response.body.getReader();
  const parts = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    received += value.length;
    onProgress(received, total);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  if (cache) await cache.put(url, new Response(bytes)).catch(() => {});
  return { bytes, cached: false };
}

async function load({ files, multilingual }) {
  const t0 = performance.now();
  await runtimeReady;
  const tRuntime = performance.now();
  if (recognizer) {
    recognizer.free();
    recognizer = null;
  }
  try {
    FS.mkdir('/m');
  } catch {
    /* exists */
  }
  let downloaded = 0;
  let fromCache = true;
  const downloadStart = performance.now();
  for (const file of files) {
    const { bytes, cached } = await fetchCached(file.url, (got, total) =>
      self.postMessage({ type: 'progress', file: file.name, got, total: total || file.bytes }),
    );
    fromCache = fromCache && cached;
    downloaded += bytes.length;
    FS.writeFile(`/m/${file.name}`, bytes);
  }
  const tFetched = performance.now();
  const heapAfterFs = heapBytes();
  const config = {
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: '/m/encoder.int8.onnx', decoder: '/m/decoder.int8.onnx', joiner: '/m/joiner.int8.onnx' },
      paraformer: { encoder: '', decoder: '' },
      zipformer2Ctc: { model: '' },
      nemoCtc: { model: '' },
      toneCtc: { model: '' },
      tokens: '/m/tokens.txt',
      numThreads: 1,
      provider: 'cpu',
      debug: 0,
      modelType: '',
      modelingUnit: '',
      bpeVocab: '',
    },
    decodingMethod: 'greedy_search',
    maxActivePaths: 4,
    enableEndpoint: 0,
    rule1MinTrailingSilence: 2.4,
    rule2MinTrailingSilence: 1.2,
    rule3MinUtteranceLength: 20,
    hotwordsFile: '',
    hotwordsScore: 1.5,
    ctcFstDecoderConfig: { graph: '', maxActive: 3000 },
    ruleFsts: '',
    ruleFars: '',
  };
  recognizer = createOnlineRecognizer(self.Module, config);
  if (!recognizer.handle) throw new Error('sherpa-onnx refused the model (see log)');
  const tRecognizer = performance.now();
  const heapAfterInit = heapBytes();
  // The recognizer holds its own copy of the weights; the file copies are dead weight now.
  for (const file of files) FS.unlink(`/m/${file.name}`);
  self.multilingual = multilingual;
  return {
    runtimeMs: tRuntime - t0,
    downloadMs: tFetched - downloadStart,
    fromCache,
    downloadedBytes: downloaded,
    initMs: tRecognizer - tFetched,
    totalMs: tRecognizer - t0,
    heapAfterFs,
    heapAfterInit,
    heapNow: heapBytes(),
  };
}

function result() {
  const r = recognizer.getResult(stream);
  return { text: (r.text || '').trim(), tokens: r.tokens || [], timestamps: r.timestamps || [] };
}

function decodeReady() {
  const t0 = performance.now();
  let steps = 0;
  while (recognizer.isReady(stream)) {
    recognizer.decode(stream);
    steps += 1;
  }
  let ms = performance.now() - t0;
  if (SLOWDOWN > 1 && steps > 0) {
    spin(ms * (SLOWDOWN - 1));
    ms *= SLOWDOWN;
  }
  return { ms, steps };
}

const handlers = {
  load,
  begin({ language }) {
    if (stream) stream.free();
    stream = recognizer.createStream();
    if (self.multilingual && language) stream.setOption('language', language);
    return { heapNow: heapBytes() };
  },
  chunk({ samples }) {
    stream.acceptWaveform(16000, samples);
    const { ms, steps } = decodeReady();
    return { decodeMs: ms, steps, ...result(), heapNow: heapBytes() };
  },
  end() {
    stream.acceptWaveform(16000, new Float32Array(16000));
    stream.inputFinished();
    const { ms, steps } = decodeReady();
    const out = { decodeMs: ms, steps, ...result(), heapNow: heapBytes(), peakHeap };
    stream.free();
    stream = null;
    return out;
  },
};

self.onmessage = async event => {
  const { id, type, ...body } = event.data;
  try {
    const value = await handlers[type](body);
    self.postMessage({ type: 'reply', id, ok: true, value, at: performance.timeOrigin + performance.now() });
  } catch (error) {
    self.postMessage({ type: 'reply', id, ok: false, error: String(error && error.stack ? error.stack : error) });
  }
};
