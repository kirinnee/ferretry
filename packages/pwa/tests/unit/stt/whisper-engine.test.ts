/**
 * Proves the page's side of a Whisper worker: it spawns lazily and once, names its model in every
 * message, transfers samples, routes each reply to its own caller with the backend that answered,
 * measures the model load once, honours abort, and gives a terminated or crashed worker's callers a
 * clear answer instead of a hang.
 */

import { describe, it } from 'bun:test';
import should from 'should';
import { WhisperEngine, WhisperEngineError, type WhisperWorkerLike } from '../../../src/lib/stt/whisper-engine.ts';
import type { WhisperWorkerRequest } from '../../../src/lib/stt/whisper-worker-core.ts';

const MODEL = 'whisper-tiny-en';

class FakeWorker implements WhisperWorkerLike {
  readonly posts: { message: WhisperWorkerRequest; transfer: Transferable[] | undefined }[] = [];
  terminated = 0;
  readonly #message: ((event: { readonly data: unknown }) => void)[] = [];
  readonly #error: ((event: unknown) => void)[] = [];

  postMessage(message: WhisperWorkerRequest, transfer?: Transferable[]): void {
    this.posts.push({ message, transfer });
  }

  addEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
  addEventListener(type: 'error', listener: (event: unknown) => void): void;
  addEventListener(type: string, listener: (event: never) => void): void {
    if (type === 'message') this.#message.push(listener as (event: { readonly data: unknown }) => void);
    else this.#error.push(listener as (event: unknown) => void);
  }

  terminate(): void {
    this.terminated += 1;
  }

  emit(data: unknown): void {
    for (const listener of this.#message) listener({ data });
  }

  crash(): void {
    for (const listener of this.#error) listener(new Event('error'));
  }
}

const setup = (now?: () => number): { engine: WhisperEngine; workers: FakeWorker[] } => {
  const workers: FakeWorker[] = [];
  const engine = new WhisperEngine(
    MODEL,
    () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    now,
  );
  return { engine, workers };
};

/** Observe a promise's outcome without leaving it unhandled. */
const settle = <T>(promise: Promise<T>): { value?: T; error?: unknown; done: boolean } => {
  const outcome: { value?: T; error?: unknown; done: boolean } = { done: false };
  promise.then(
    value => {
      outcome.value = value;
      outcome.done = true;
    },
    error => {
      outcome.error = error;
      outcome.done = true;
    },
  );
  return outcome;
};

const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

const idOf = (worker: FakeWorker | undefined, index = 0): number => {
  const message = worker?.posts[index]?.message;
  if (message?.type !== 'transcribe') throw new Error('not a transcribe post');
  return message.id;
};

describe('WhisperEngine', () => {
  it('spawns on first use only, once, and names its model in every message', () => {
    const { engine, workers } = setup();
    should(workers).have.length(0);
    engine.preload();
    const samples = new Float32Array([0.5]);
    void engine.transcribe(samples).catch(() => undefined);
    should(workers).have.length(1);
    should(workers[0]?.posts[0]?.message).eql({ type: 'load', model: MODEL });
    should(workers[0]?.posts[1]?.message).eql({ type: 'transcribe', id: 1, model: MODEL, samples });
    should(workers[0]?.posts[1]?.transfer).eql([samples.buffer]);
    engine.unload();
  });

  it('resolves each transcribe with its own text and the backend that ran it', async () => {
    const { engine, workers } = setup();
    const first = settle(engine.transcribe(new Float32Array(1)));
    const second = settle(engine.transcribe(new Float32Array(1)));
    const worker = workers[0];
    worker?.emit({ type: 'result', id: idOf(worker, 1), text: 'second', backend: 'webgpu' });
    worker?.emit({ type: 'result', id: idOf(worker, 0), text: 'first', backend: 'wasm' });
    worker?.emit({ type: 'result', id: 99, text: 'nobody', backend: 'wasm' });
    await tick();
    should(first.value).eql({ text: 'first', backend: 'wasm' });
    should(second.value).eql({ text: 'second', backend: 'webgpu' });
  });

  it('reads anything but webgpu as WebAssembly, and ignores replies it cannot read', async () => {
    const { engine, workers } = setup();
    const heard = settle(engine.transcribe(new Float32Array(1)));
    workers[0]?.emit(null);
    workers[0]?.emit({ type: 'progress' });
    workers[0]?.emit({ type: 'failed', id: null, code: 'load-failed', message: 'a preload nobody waits on' });
    await tick();
    should(heard.done).be.false();
    workers[0]?.emit({ type: 'result', id: idOf(workers[0]), text: 'hi', backend: 'cuda' });
    await tick();
    should(heard.value).eql({ text: 'hi', backend: 'wasm' });
  });

  it('rejects a failed transcribe with the worker’s code and message', async () => {
    const { engine, workers } = setup();
    const heard = settle(engine.transcribe(new Float32Array(1)));
    workers[0]?.emit({ type: 'failed', id: idOf(workers[0]), code: 'not-installed', message: 'Install it first.' });
    await tick();
    should(heard.error).be.instanceOf(WhisperEngineError);
    should((heard.error as WhisperEngineError).code).equal('not-installed');
    should((heard.error as WhisperEngineError).message).equal('Install it first.');
  });

  it('measures the model load from preload to ready, once', async () => {
    let clock = 100;
    const { engine, workers } = setup(() => clock);
    engine.preload();
    engine.preload();
    clock = 1_600;
    workers[0]?.emit({ type: 'ready', backend: 'wasm' });
    workers[0]?.emit({ type: 'ready', backend: 'wasm' });
    should(engine.consumeLoadMs()).equal(1_500);
    should(engine.consumeLoadMs()).be.undefined();
  });

  it('reports no separate load for a transcribe that loaded the model itself', async () => {
    let clock = 0;
    const { engine, workers } = setup(() => clock);
    const heard = settle(engine.transcribe(new Float32Array(1)));
    clock = 900;
    workers[0]?.emit({ type: 'result', id: idOf(workers[0]), text: 'x', backend: 'wasm' });
    await tick();
    should(heard.done).be.true();
    should(engine.consumeLoadMs()).be.undefined();
    // A later preload of the already-loaded model measures from its own start.
    engine.preload();
    clock = 950;
    workers[0]?.emit({ type: 'ready', backend: 'wasm' });
    should(engine.consumeLoadMs()).equal(50);
  });

  it('defaults to the page’s clock', () => {
    const engine = new WhisperEngine(MODEL, () => new FakeWorker());
    engine.preload();
    should(engine.consumeLoadMs()).be.undefined();
    engine.unload();
  });

  it('rejects at once when already aborted, and stops waiting when aborted later', async () => {
    const { engine, workers } = setup();
    const aborted = new AbortController();
    aborted.abort();
    const early = settle(engine.transcribe(new Float32Array(1), aborted.signal));
    await tick();
    should((early.error as WhisperEngineError).code).equal('cancelled');
    should(workers[0]?.posts).have.length(0);

    const later = new AbortController();
    const waiting = settle(engine.transcribe(new Float32Array(1), later.signal));
    later.abort();
    await tick();
    should((waiting.error as WhisperEngineError).code).equal('cancelled');
    // The worker's late answer goes nowhere.
    workers[0]?.emit({ type: 'result', id: idOf(workers[0]), text: 'late', backend: 'wasm' });

    const kept = new AbortController();
    const answered = settle(engine.transcribe(new Float32Array(1), kept.signal));
    workers[0]?.emit({ type: 'failed', id: idOf(workers[0], 1), code: 'transcribe-failed', message: 'no' });
    await tick();
    should((answered.error as WhisperEngineError).code).equal('transcribe-failed');
  });

  it('terminates on unload, fails everything waiting, and starts a fresh worker next time', async () => {
    const { engine, workers } = setup();
    const waiting = settle(engine.transcribe(new Float32Array(1)));
    engine.unload();
    await tick();
    should(workers[0]?.terminated).equal(1);
    should((waiting.error as WhisperEngineError).code).equal('cancelled');
    // A stale worker's message is not this engine's any more.
    workers[0]?.emit({ type: 'ready', backend: 'wasm' });
    engine.preload();
    should(workers).have.length(2);
    engine.unload();
    engine.unload();
  });

  it('fails every caller when the worker script itself fails, and ignores a dead worker’s error', async () => {
    const { engine, workers } = setup();
    const waiting = settle(engine.transcribe(new Float32Array(1)));
    workers[0]?.crash();
    await tick();
    should((waiting.error as WhisperEngineError).code).equal('worker-failed');
    should(workers[0]?.terminated).equal(1);
    workers[0]?.crash();
    should(workers[0]?.terminated).equal(1);
  });
});
