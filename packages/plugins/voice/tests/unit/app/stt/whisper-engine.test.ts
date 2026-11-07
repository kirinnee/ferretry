/**
 * Proves the page's side of a Whisper worker: it spawns lazily and once, names its model in every
 * message, transfers samples, routes each reply to its own caller with the backend that answered,
 * measures the model load once, honours abort, and gives a terminated or crashed worker's callers a
 * clear answer instead of a hang.
 */

import { describe, it } from 'bun:test';
import should from 'should';
import { WhisperEngine, WhisperEngineError, type WhisperWorkerLike } from '../../../../app/lib/stt/whisper-engine.ts';
import type { WhisperWorkerRequest } from '../../../../app/lib/stt/whisper-worker-core.ts';

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

describe('WhisperEngine — threads', () => {
  const threaded = (threads: number) => {
    const workers: FakeWorker[] = [];
    let failed = 0;
    const engine = new WhisperEngine(
      MODEL,
      () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
      undefined,
      { threads: () => threads, onThreadsFailed: () => (failed += 1) },
    );
    return { engine, workers, failed: () => failed };
  };

  it('asks for no threads by default', () => {
    const { engine, workers } = setup();
    engine.preload();
    should(workers[0]?.posts[0]?.message).eql({ type: 'load', model: MODEL });
  });

  it('puts the requested threads on load and on transcribe', () => {
    const { engine, workers } = threaded(3);
    engine.preload();
    void engine.transcribe(new Float32Array(4));
    const [load, transcribe] = workers[0]?.posts.map(post => post.message) ?? [];
    should(load?.type === 'load' && load.threads).equal(3);
    should(transcribe?.type === 'transcribe' && transcribe.threads).equal(3);
  });

  it('on threads-failed: tells the page once, replaces the worker, and repeats the waiting audio on one thread', async () => {
    const { engine, workers, failed } = threaded(3);
    const outcome = settle(engine.transcribe(new Float32Array([0.5, 0.25])));
    const first = workers[0] as FakeWorker;
    const asked = first.posts[0]?.message;
    first.emit({
      type: 'failed',
      id: asked?.type === 'transcribe' ? asked.id : null,
      code: 'threads-failed',
      message: 'out of memory',
    });
    should(failed()).equal(1);
    should(first.terminated).equal(1);
    const second = workers[1] as FakeWorker;
    const repeat = second.posts.find(post => post.message.type === 'transcribe')?.message;
    should(repeat?.type === 'transcribe' && [...repeat.samples]).eql([0.5, 0.25]);
    should(repeat?.type === 'transcribe' && repeat.threads).equal(undefined);
    second.emit({ type: 'result', id: repeat?.type === 'transcribe' ? repeat.id : -1, text: 'hi', backend: 'wasm' });
    await tick();
    should(outcome.value).eql({ text: 'hi', backend: 'wasm' });
  });
  describe('thread configuration is pinned per worker', () => {
    const drifting = (initial: number) => {
      const workers: FakeWorker[] = [];
      const state = { threads: initial };
      const engine = new WhisperEngine(
        MODEL,
        () => {
          const worker = new FakeWorker();
          workers.push(worker);
          return worker;
        },
        undefined,
        { threads: () => state.threads },
      );
      return { engine, workers, state };
    };

    it('a worker preloaded on 4 keeps asking for 4 and keeps the audio, even when the planner now says 1', async () => {
      const { engine, workers, state } = drifting(4);
      engine.preload();
      state.threads = 1;
      const outcome = settle(engine.transcribe(new Float32Array([0.5, 0.25])));
      const first = workers[0] as FakeWorker;
      const sent = first.posts[1]?.message;
      should(sent?.type === 'transcribe' && sent.threads).equal(4);
      first.emit({ type: 'failed', id: idOf(first, 1), code: 'threads-failed', message: 'out of memory' });
      const second = workers[1] as FakeWorker;
      should(second.posts[0]?.message).eql({ type: 'load', model: MODEL });
      const repeat = second.posts[1]?.message;
      should(repeat?.type === 'transcribe' && [...repeat.samples]).eql([0.5, 0.25]);
      second.emit({ type: 'result', id: idOf(second, 1), text: 'hi', backend: 'wasm' });
      await tick();
      should(outcome.value).eql({ text: 'hi', backend: 'wasm' });
    });

    it('a worker preloaded on 1 keeps asking for 1 when the planner now says 4, and keeps no copy', () => {
      const { engine, workers, state } = drifting(1);
      engine.preload();
      state.threads = 4;
      void engine.transcribe(new Float32Array(4));
      const sent = workers[0]?.posts[1]?.message;
      should(sent?.type === 'transcribe' && sent.threads).equal(undefined);
    });

    it('a fresh worker after unload or a crash takes the planner current answer', () => {
      const { engine, workers, state } = drifting(1);
      engine.preload();
      engine.unload();
      state.threads = 4;
      engine.preload();
      should(workers[1]?.posts[0]?.message).eql({ type: 'load', model: MODEL, threads: 4 });
      workers[1]?.crash();
      state.threads = 3;
      engine.preload();
      should(workers[2]?.posts[0]?.message).eql({ type: 'load', model: MODEL, threads: 3 });
    });

    it('a one-thread worker that reports threads-failed settles every waiting request instead of hanging', async () => {
      const { engine, workers } = drifting(1);
      const one = settle(engine.transcribe(new Float32Array(4)));
      const two = settle(engine.transcribe(new Float32Array(4)));
      workers[0]?.emit({ type: 'failed', id: null, code: 'threads-failed', message: 'x' });
      await tick();
      should(one.error).be.instanceOf(WhisperEngineError);
      should(two.error).be.instanceOf(WhisperEngineError);
    });

    it('a request waiting on the replacement when it also reports threads-failed is settled, not left hanging', async () => {
      const { engine, workers } = drifting(4);
      const outcome = settle(engine.transcribe(new Float32Array(4)));
      workers[0]?.emit({ type: 'failed', id: null, code: 'threads-failed', message: 'x' });
      workers[1]?.emit({ type: 'failed', id: null, code: 'threads-failed', message: 'x' });
      await tick();
      should(outcome.error).be.instanceOf(WhisperEngineError);
    });
  });

  describe('the one-thread replacement itself fails to start', () => {
    /** Engine whose second worker (the replacement) is made by `makeSecond`. */
    const failing = (makeSecond: () => FakeWorker) => {
      const workers: FakeWorker[] = [];
      let spawned = 0;
      const engine = new WhisperEngine(
        MODEL,
        () => {
          spawned += 1;
          const worker = spawned === 2 ? makeSecond() : new FakeWorker();
          workers.push(worker);
          return worker;
        },
        undefined,
        { threads: () => 4 },
      );
      return { engine, workers };
    };

    it('a replacement that cannot be created settles every waiting request and leaves the engine reusable', async () => {
      let spawned = 0;
      const workers: FakeWorker[] = [];
      const engine = new WhisperEngine(
        MODEL,
        () => {
          spawned += 1;
          if (spawned === 2) throw new Error('QuotaExceededError');
          const worker = new FakeWorker();
          workers.push(worker);
          return worker;
        },
        undefined,
        { threads: () => 4 },
      );
      const one = settle(engine.transcribe(new Float32Array(4)));
      const two = settle(engine.transcribe(new Float32Array(4)));
      workers[0]?.emit({ type: 'failed', id: null, code: 'threads-failed', message: 'x' });
      await tick();
      should(workers[0]?.terminated).equal(1);
      should(one.error).be.instanceOf(WhisperEngineError);
      should(two.error).be.instanceOf(WhisperEngineError);
      // Nothing is stuck: a later request starts a fresh worker.
      void engine.transcribe(new Float32Array(4));
      should(workers).have.length(2);
    });

    it('a replacement that cannot be given the audio is terminated and every waiting request is settled', async () => {
      class Refusing extends FakeWorker {
        override postMessage(message: never, transfer?: Transferable[]): void {
          if ((message as { type: string }).type === 'transcribe') throw new Error('DataCloneError');
          super.postMessage(message, transfer);
        }
      }
      const { engine, workers } = failing(() => new Refusing());
      const one = settle(engine.transcribe(new Float32Array(4)));
      const two = settle(engine.transcribe(new Float32Array(4)));
      workers[0]?.emit({ type: 'failed', id: null, code: 'threads-failed', message: 'x' });
      await tick();
      should(workers[1]?.terminated).equal(1);
      should(one.error).be.instanceOf(WhisperEngineError);
      should(two.error).be.instanceOf(WhisperEngineError);
      // The dead replacement is forgotten: a later request starts another worker.
      void engine.transcribe(new Float32Array(4));
      should(workers).have.length(3);
    });
  });
});
