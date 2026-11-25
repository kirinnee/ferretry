/**
 * THE NATIVE SPEECH HOST: the program a native engine runs in, a CHILD PROCESS of the daemon (docs/design/voice-modes.md
 * §2.3.1). The daemon starts it with `speech` or `reply` and speaks to it in frames (`lib/native/frames.ts`) over stdin and
 * stdout. It holds that engine's own worker program (`speech.worker.ts` / `reply.worker.ts`) in a worker thread and carries
 * messages to it and back, so the engines' code is the same whether they run here or, for WebAssembly, in the daemon.
 *
 * The native library therefore lives in this process alone: a fault inside sherpa-onnx or onnxruntime ends THIS process, the
 * daemon sees its exit and the engine reports itself stopped. This thread does no native work, so it can always notice that
 * its stdin closed (the daemon ended, however it ended) and leave, taking the worker with it: a host cannot outlive the
 * daemon, even one stuck inside a native call.
 *
 * The same file is a declared worker program of the voice plugin (so a compiled `fyd` embeds it, and `fyd --check` proves it
 * is there): started as a worker thread it answers the check's probe and does nothing else.
 */
import { isMainThread } from 'node:worker_threads';
import { encodeFrame, FrameError, FrameReader } from '../lib/native/frames.ts';

declare const self: {
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  postMessage(message: unknown): void;
};

if (!isMainThread) {
  self.onmessage = () => self.postMessage({ probe: true, ok: true });
} else {
  void host();
}

async function host(): Promise<void> {
  const engine = process.argv.at(-1);
  if (engine !== 'speech' && engine !== 'reply') {
    process.stderr.write('speech-host: name the engine, speech or reply\n');
    process.exit(64);
  }
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  const worker = new Worker(new URL(`./${engine}.worker.${extension}`, import.meta.url));
  worker.onmessage = (event: MessageEvent) => {
    process.stdout.write(encodeFrame(event.data));
  };
  worker.onerror = () => process.exit(1);
  const reader = new FrameReader();
  try {
    for await (const chunk of Bun.stdin.stream()) {
      for (const { message, buffers } of reader.push(chunk)) worker.postMessage(message, [...buffers]);
    }
  } catch (error) {
    if (!(error instanceof FrameError)) throw error;
    process.exit(65);
  }
  // The daemon closed its end: it is gone, or it let this host go.
  process.exit(0);
}
