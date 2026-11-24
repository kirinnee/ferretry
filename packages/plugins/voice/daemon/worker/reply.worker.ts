/**
 * THE REPLY VOICE'S WORKER: Kokoro-82M, spoken by sherpa-onnx's WebAssembly build for Node and Bun. It is its own thread,
 * apart from the speech worker, so a person talking over a reply is heard while the reply is still being made. One thread
 * per daemon, started on the first use and ended after ten idle minutes (`daemon/lib/reply/engine.ts`).
 *
 * The runtime's WebAssembly arrives from the main thread as a transferred ArrayBuffer (it read it from its own state
 * folder), and the glue is handed those bytes instead of fetching them. The MODEL FILES are not sent: the runtime's file
 * system is the host's, so it reads each from its path in the state folder, which also means the 114 MB model is held
 * once and not twice. NO NETWORK. A failure says what failed and never the text that was being spoken.
 */
import initSherpa from 'sherpa-onnx/sherpa-onnx-wasm-nodejs.js';
import { createOfflineTts, type OfflineTts } from 'sherpa-onnx/sherpa-onnx-tts.js';
import { resample24to16 } from '../lib/reply/resample.ts';
import type { ReplyReply, ReplyRequest } from '../lib/reply/protocol.ts';

const MEMORY_UNIT = 1_048_576;

declare const self: {
  onmessage: ((event: { readonly data: ReplyRequest }) => void) | null;
  postMessage(reply: ReplyReply, transfer?: ArrayBuffer[]): void;
};

let tts: OfflineTts | undefined;
let heapBytes = 0;

async function load(request: Extract<ReplyRequest, { kind: 'load' }>): Promise<number> {
  const started = performance.now();
  const module = (await initSherpa({
    wasmBinary: new Uint8Array(request.runtime),
    // The loader asks where its file is even when it was handed the bytes: any name will do, nothing is opened.
    locateFile: (file: string) => file,
    print: () => undefined,
    printErr: () => undefined,
  })) as { readonly HEAPU8: { readonly length: number } };
  tts = createOfflineTts(module, {
    offlineTtsModelConfig: {
      offlineTtsKokoroModelConfig: {
        model: request.paths.model,
        voices: request.paths.voices,
        tokens: request.paths.tokens,
        lexicon: request.paths.lexicon,
        dataDir: '',
        lang: '',
        lengthScale: 1.0,
      },
      numThreads: 1,
      debug: 0,
      provider: 'cpu',
    },
    ruleFsts: '',
    ruleFars: '',
    maxNumSentences: 1,
  });
  heapBytes = module.HEAPU8.length;
  return performance.now() - started;
}

function speak(text: string, speaker: number): { samples: Float32Array; speakMs: number } {
  if (tts === undefined) throw new Error('the reply voice is not loaded');
  const started = performance.now();
  const made = tts.generate({ text, sid: speaker, speed: 1.0 });
  // The model's own rate is 24 kHz; anything else would be resampled wrongly, so it is refused rather than guessed at.
  if (made.sampleRate !== 24_000) throw new Error('the reply voice answered at an unexpected sample rate');
  return { samples: resample24to16(made.samples), speakMs: performance.now() - started };
}

async function answer(request: ReplyRequest): Promise<{ reply: ReplyReply; transfer: ArrayBuffer[] }> {
  switch (request.kind) {
    case 'load': {
      const loadMs = await load(request);
      return {
        reply: { id: request.id, ok: true, kind: 'load', loadMs, memoryMb: Math.round(heapBytes / MEMORY_UNIT) },
        transfer: [],
      };
    }
    case 'speak': {
      const made = speak(request.text, request.speaker);
      return {
        reply: { id: request.id, ok: true, kind: 'speak', ...made },
        transfer: [made.samples.buffer as ArrayBuffer],
      };
    }
  }
}

self.onmessage = event => {
  const request = event.data;
  // `fyd --check` starts this thread with nothing granted and asks `{ probe: true }`: answering it proves the program
  // and the runtime's JavaScript loaded in this binary, without touching a model.
  if ((request as { probe?: unknown }).probe === true) {
    (self as unknown as { postMessage(reply: unknown): void }).postMessage({ probe: true, ok: true });
    return;
  }
  void answer(request).then(
    ({ reply, transfer }) => self.postMessage(reply, transfer),
    (error: unknown) =>
      self.postMessage({
        id: request.id,
        ok: false,
        // Only a load says why: its error names a file or a runtime, never speech. A speak's could hold the words.
        sentence: `The reply voice could not ${request.kind}${request.kind === 'load' ? `: ${String((error as Error)?.message ?? error).slice(0, 300)}` : ''}.`,
      }),
  );
};
