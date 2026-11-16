/**
 * Proves the page's side of the speech worker: it spawns lazily and once, transfers samples, routes
 * each reply to its own caller, ignores anything it cannot attribute, honours abort, and gives a
 * terminated or crashed worker's callers a clear answer instead of a hang.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import {
  ParakeetEngine,
  ParakeetEngineError,
  type ParakeetWorkerLike,
} from '../../../../app/lib/stt/parakeet-engine.ts';
import type { ParakeetWorkerRequest } from '../../../../app/lib/stt/parakeet-worker-core.ts';

class FakeWorker implements ParakeetWorkerLike {
  readonly posts: { message: ParakeetWorkerRequest; transfer: Transferable[] | undefined }[] = [];
  terminated = 0;
  readonly #message: ((event: { readonly data: unknown }) => void)[] = [];
  readonly #error: ((event: unknown) => void)[] = [];

  postMessage(message: ParakeetWorkerRequest, transfer?: Transferable[]): void {
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

const setup = (now?: () => number): { engine: ParakeetEngine; workers: FakeWorker[] } => {
  const workers: FakeWorker[] = [];
  const engine = new ParakeetEngine(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  }, now);
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

const idOf = (worker: FakeWorker, index = 0): number => {
  const message = worker.posts[index]?.message;
  if (message?.type !== 'transcribe') throw new Error('not a transcribe post');
  return message.id;
};

describe('ParakeetEngine', () => {
  it('does not spawn until it is used', () => {
    const { workers } = setup();
    should(workers).have.length(0);
  });

  it('preload spawns the worker once and posts load each time', () => {
    const { engine, workers } = setup();
    engine.preload();
    engine.preload();
    should(workers).have.length(1);
    should(workers[0]?.posts.map(p => p.message)).eql([{ type: 'load' }, { type: 'load' }]);
  });

  it('posts id and samples with the buffer transferred and resolves on the result', async () => {
    const { engine, workers } = setup();
    const samples = new Float32Array([1, 2, 3]);
    const outcome = settle(engine.transcribe(samples));
    const worker = workers[0] as FakeWorker;
    const post = worker.posts[0];
    should(post?.message).eql({ type: 'transcribe', id: 1, samples });
    should(post?.transfer).eql([samples.buffer]);
    worker.emit({ type: 'result', id: 1, text: 'hello' });
    await tick();
    should(outcome.value).equal('hello');
  });

  it('a timed transcribe asks for word times and keeps only well-formed words', async () => {
    const { engine, workers } = setup();
    const samples = new Float32Array([1, 2]);
    const outcome = settle(engine.transcribeTimed(samples));
    const worker = workers[0] as FakeWorker;
    should(worker.posts[0]?.message).eql({ type: 'transcribe', id: 1, samples, timed: true });
    worker.emit({
      type: 'result',
      id: 1,
      text: 'one two',
      words: [
        { text: 'one', start: 0, end: 0.4 },
        { text: 'two', start: 0.5, end: Number.NaN },
        { text: 3, start: 0, end: 1 },
        null,
        'two',
      ],
    });
    await tick();
    should(outcome.value).eql({ text: 'one two', words: [{ text: 'one', start: 0, end: 0.4 }] });

    const bare = settle(engine.transcribeTimed(new Float32Array(1)));
    worker.emit({ type: 'result', id: 2, text: 'no times', words: 'not a list' });
    await tick();
    should(bare.value).eql({ text: 'no times', words: [] });
  });

  it('gives each utterance its own id and routes replies independently', async () => {
    const { engine, workers } = setup();
    const a = settle(engine.transcribe(new Float32Array(1)));
    const b = settle(engine.transcribe(new Float32Array(1)));
    const worker = workers[0] as FakeWorker;
    should(worker.posts.map((_, i) => idOf(worker, i))).eql([1, 2]);
    worker.emit({ type: 'result', id: 2, text: 'second' });
    await tick();
    should(a.done).be.false();
    should(b.value).equal('second');
    worker.emit({ type: 'result', id: 1, text: 'first' });
    await tick();
    should(a.value).equal('first');
  });

  it('rejects with a ParakeetEngineError carrying the code when the worker fails an utterance', async () => {
    const { engine, workers } = setup();
    const outcome = settle(engine.transcribe(new Float32Array(1)));
    (workers[0] as FakeWorker).emit({ type: 'failed', id: 1, code: 'integrity', message: 'tampered' });
    await tick();
    should(outcome.error).be.instanceOf(ParakeetEngineError);
    should(outcome.error).have.property('code', 'integrity');
    should(outcome.error).have.property('message', 'tampered');
    should(outcome.error).have.property('name', 'ParakeetEngineError');
  });

  it('ignores a failure with a null id, a ready, junk and replies for unknown ids', async () => {
    const { engine, workers } = setup();
    const outcome = settle(engine.transcribe(new Float32Array(1)));
    const worker = workers[0] as FakeWorker;
    worker.emit({ type: 'failed', id: null, code: 'load-failed', message: 'no one waits' });
    worker.emit({ type: 'ready' });
    worker.emit(null);
    worker.emit('result');
    worker.emit({ type: 'unknown' });
    worker.emit({ type: 'result', id: 99, text: 'stranger' });
    worker.emit({ type: 'failed', id: 98, code: 'load-failed', message: 'stranger' });
    await tick();
    should(outcome.done).be.false();
    worker.emit({ type: 'result', id: 1, text: 'ok' });
    await tick();
    should(outcome.value).equal('ok');
  });

  it('rejects cancelled when the signal is already aborted, and never resolves later', async () => {
    const { engine, workers } = setup();
    const controller = new AbortController();
    controller.abort();
    const outcome = settle(engine.transcribe(new Float32Array(1), controller.signal));
    await tick();
    should(outcome.error).have.property('code', 'cancelled');
    should((workers[0] as FakeWorker).posts).have.length(0);
  });

  it('rejects cancelled on abort after posting and ignores a later result', async () => {
    const { engine, workers } = setup();
    const controller = new AbortController();
    const outcome = settle(engine.transcribe(new Float32Array(1), controller.signal));
    const worker = workers[0] as FakeWorker;
    controller.abort();
    await tick();
    should(outcome.error).be.instanceOf(ParakeetEngineError);
    should(outcome.error).have.property('code', 'cancelled');
    worker.emit({ type: 'result', id: 1, text: 'late' });
    await tick();
    should(outcome.value).be.undefined();
  });

  it('stops listening for abort once the result arrives', async () => {
    const { engine, workers } = setup();
    const controller = new AbortController();
    const outcome = settle(engine.transcribe(new Float32Array(1), controller.signal));
    (workers[0] as FakeWorker).emit({ type: 'result', id: 1, text: 'done' });
    await tick();
    controller.abort();
    await tick();
    should(outcome.value).equal('done');
    should(outcome.error).be.undefined();
  });

  it('stops listening for abort once the worker fails the utterance', async () => {
    const { engine, workers } = setup();
    const controller = new AbortController();
    const outcome = settle(engine.transcribe(new Float32Array(1), controller.signal));
    (workers[0] as FakeWorker).emit({ type: 'failed', id: 1, code: 'transcribe-failed', message: 'bad' });
    await tick();
    controller.abort();
    await tick();
    should(outcome.error).have.property('code', 'transcribe-failed');
  });

  it('unload terminates, cancels pending, and the next call spawns a new worker', async () => {
    const { engine, workers } = setup();
    const a = settle(engine.transcribe(new Float32Array(1)));
    const b = settle(engine.transcribe(new Float32Array(1)));
    engine.unload();
    await tick();
    should((workers[0] as FakeWorker).terminated).equal(1);
    should(a.error).have.property('code', 'cancelled');
    should(b.error).have.property('code', 'cancelled');
    engine.preload();
    should(workers).have.length(2);
  });

  it('unload with no worker is harmless', () => {
    const { engine, workers } = setup();
    engine.unload();
    should(workers).have.length(0);
  });

  it('a worker error rejects every pending call, terminates, and ignores the dead worker afterwards', async () => {
    const { engine, workers } = setup();
    const a = settle(engine.transcribe(new Float32Array(1)));
    const b = settle(engine.transcribe(new Float32Array(1)));
    const worker = workers[0] as FakeWorker;
    worker.crash();
    await tick();
    should(worker.terminated).equal(1);
    should(a.error).have.property('code', 'worker-failed');
    should(b.error).have.property('code', 'worker-failed');
    worker.emit({ type: 'result', id: 1, text: 'ghost' });
    await tick();
    should(a.value).be.undefined();
    engine.preload();
    should(workers).have.length(2);
  });

  it('ignores messages and errors from a superseded worker', async () => {
    const { engine, workers } = setup();
    engine.preload();
    const old = workers[0] as FakeWorker;
    engine.unload();
    const outcome = settle(engine.transcribe(new Float32Array(1)));
    const fresh = workers[1] as FakeWorker;
    old.emit({ type: 'result', id: 1, text: 'from the dead' });
    old.crash();
    await tick();
    should(outcome.done).be.false();
    should(fresh.terminated).equal(0);
    should(old.terminated).equal(1);
    fresh.emit({ type: 'result', id: 1, text: 'live' });
    await tick();
    should(outcome.value).equal('live');
  });
});

describe('ParakeetEngine model load time', () => {
  it('measures from the first load request to the worker saying it is ready, once', () => {
    // Arrange
    let at = 1_000;
    const { engine, workers } = setup(() => at);

    // Act
    engine.preload();
    at = 3_400;
    workers[0]?.emit({ type: 'ready' });

    // Assert
    should(engine.consumeLoadMs()).equal(2_400);
    should(engine.consumeLoadMs()).be.undefined();
  });

  it('counts a load that began with the first transcription when nothing preloaded', async () => {
    // Arrange
    let at = 50;
    const { engine, workers } = setup(() => at);
    const heard = settle(engine.transcribe(new Float32Array(4)));

    // Act
    at = 650;
    workers[0]?.emit({ type: 'ready' });
    workers[0]?.emit({ type: 'result', id: idOf(workers[0] as FakeWorker), text: 'hi' });
    await tick();

    // Assert
    should(heard.value).equal('hi');
    should(engine.consumeLoadMs()).equal(600);
  });

  it('reports nothing for a worker that was already loaded', () => {
    // Arrange
    let at = 0;
    const { engine, workers } = setup(() => at);
    engine.preload();
    at = 10;
    workers[0]?.emit({ type: 'ready' });
    engine.consumeLoadMs();

    // Act
    at = 500;
    engine.preload();
    workers[0]?.emit({ type: 'ready' });

    // Assert: the second ready follows a second load request, so it is measured; a stray ready is not
    workers[0]?.emit({ type: 'ready' });
    should(engine.consumeLoadMs()).equal(0);
  });

  it('forgets a load that was unloaded before it finished', () => {
    // Arrange
    let at = 0;
    const { engine } = setup(() => at);
    engine.preload();

    // Act
    at = 900;
    engine.unload();

    // Assert
    should(engine.consumeLoadMs()).be.undefined();
  });
});

describe('ParakeetEngine — threads', () => {
  const threaded = (threads: number): { engine: ParakeetEngine; workers: FakeWorker[]; failed: () => number } => {
    const workers: FakeWorker[] = [];
    let failed = 0;
    const engine = new ParakeetEngine(
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

  it('asks for no threads by default: the messages are exactly what they were', () => {
    const { engine, workers } = setup();
    engine.preload();
    void engine.transcribe(new Float32Array(4));
    should(workers[0]?.posts.map(post => post.message)).eql([
      { type: 'load' },
      { type: 'transcribe', id: 1, samples: new Float32Array(4) },
    ]);
  });

  it('puts the requested threads on load and on transcribe', () => {
    const { engine, workers } = threaded(4);
    engine.preload();
    void engine.transcribe(new Float32Array(4));
    should(workers[0]?.posts.map(post => post.message.type === 'load' && post.message.threads)).eql([4, false]);
    const transcribe = workers[0]?.posts[1]?.message;
    should(transcribe?.type === 'transcribe' && transcribe.threads).equal(4);
  });

  it('treats a nonsense thread count as one', () => {
    for (const bad of [0, -3, 1, 2.5, Number.NaN]) {
      const { engine, workers } = threaded(bad);
      engine.preload();
      should(workers[0]?.posts[0]?.message).eql({ type: 'load' });
    }
  });

  it('on threads-failed: tells the page once, replaces the worker, and repeats the waiting audio on one thread', async () => {
    const { engine, workers, failed } = threaded(4);
    engine.preload();
    const outcome = settle(engine.transcribe(new Float32Array([0.1, 0.2, 0.3])));
    const first = workers[0] as FakeWorker;
    first.emit({ type: 'failed', id: null, code: 'threads-failed', message: 'no sub-workers' });
    should(failed()).equal(1);
    should(first.terminated).equal(1);
    should(workers.length).equal(2);
    const second = workers[1] as FakeWorker;
    should(second.posts[0]?.message).eql({ type: 'load' });
    const repeat = second.posts[1]?.message;
    should(repeat?.type).equal('transcribe');
    should(repeat?.type === 'transcribe' && [...repeat.samples]).eql([
      Math.fround(0.1),
      Math.fround(0.2),
      Math.fround(0.3),
    ]);
    should(repeat?.type === 'transcribe' && repeat.threads).equal(undefined);
    second.emit({ type: 'result', id: idOf(second, 1), text: 'hi' });
    await tick();
    should(outcome.value).equal('hi');
  });

  it('asks for one thread from then on, and does not tell the page twice', () => {
    const { engine, workers, failed } = threaded(4);
    engine.preload();
    workers[0]?.emit({ type: 'failed', id: null, code: 'threads-failed', message: 'x' });
    workers[1]?.emit({ type: 'failed', id: null, code: 'threads-failed', message: 'x' });
    should(failed()).equal(1);
    void engine.transcribe(new Float32Array(4));
    const next = workers[1]?.posts.at(-1)?.message;
    should(next?.type === 'transcribe' && next.threads).equal(undefined);
  });

  it('keeps no copy of the audio for a single-thread request, and none after it is answered', async () => {
    const { engine, workers } = threaded(4);
    const outcome = settle(engine.transcribe(new Float32Array(4)));
    workers[0]?.emit({ type: 'result', id: idOf(workers[0] as FakeWorker), text: 'ok' });
    await tick();
    should(outcome.value).equal('ok');
    // A later failure has nothing stale to repeat.
    workers[0]?.emit({ type: 'failed', id: null, code: 'threads-failed', message: 'x' });
    should(workers[1]?.posts.length).equal(1);
  });
  describe('thread configuration is pinned per worker', () => {
    const drifting = (initial: number) => {
      const workers: FakeWorker[] = [];
      const state = { threads: initial };
      const engine = new ParakeetEngine(
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
      state.threads = 1; // another tab recorded a failure
      const outcome = settle(engine.transcribe(new Float32Array([0.5, 0.25])));
      const first = workers[0] as FakeWorker;
      const sent = first.posts[1]?.message;
      should(sent?.type === 'transcribe' && sent.threads).equal(4);
      // The cached model ran threaded and failed: the request must be repeated on the replacement, not hang.
      first.emit({ type: 'failed', id: idOf(first, 1), code: 'threads-failed', message: 'out of memory' });
      const second = workers[1] as FakeWorker;
      should(second.posts[0]?.message).eql({ type: 'load' });
      const repeat = second.posts[1]?.message;
      should(repeat?.type === 'transcribe' && [...repeat.samples]).eql([0.5, 0.25]);
      second.emit({ type: 'result', id: idOf(second, 1), text: 'hi' });
      await tick();
      should(outcome.value).equal('hi');
    });

    it('a worker preloaded on 1 keeps asking for 1 when the planner now says 4, and keeps no copy', () => {
      const { engine, workers, state } = drifting(1);
      engine.preload();
      state.threads = 4;
      void engine.transcribe(new Float32Array(4));
      const sent = workers[0]?.posts[1]?.message;
      should(sent?.type === 'transcribe' && sent.threads).equal(undefined);
    });

    it('a fresh worker after unload takes the planner current answer', () => {
      const { engine, workers, state } = drifting(1);
      engine.preload();
      engine.unload();
      state.threads = 4;
      engine.preload();
      should(workers[1]?.posts[0]?.message).eql({ type: 'load', threads: 4 });
    });

    it('a fresh worker after a crash takes the planner current answer', () => {
      const { engine, workers, state } = drifting(1);
      engine.preload();
      workers[0]?.crash();
      state.threads = 4;
      engine.preload();
      should(workers[1]?.posts[0]?.message).eql({ type: 'load', threads: 4 });
    });

    it('a one-thread worker that reports threads-failed settles every waiting request instead of hanging', async () => {
      const { engine, workers } = drifting(1);
      const one = settle(engine.transcribe(new Float32Array(4)));
      const two = settle(engine.transcribe(new Float32Array(4)));
      workers[0]?.emit({ type: 'failed', id: null, code: 'threads-failed', message: 'x' });
      await tick();
      should(one.error).be.instanceOf(ParakeetEngineError);
      should(two.error).be.instanceOf(ParakeetEngineError);
    });

    it('a request waiting on the replacement when it also reports threads-failed is settled, not left hanging', async () => {
      const { engine, workers } = drifting(4);
      const outcome = settle(engine.transcribe(new Float32Array(4)));
      workers[0]?.emit({ type: 'failed', id: null, code: 'threads-failed', message: 'x' });
      workers[1]?.emit({ type: 'failed', id: null, code: 'threads-failed', message: 'x' });
      await tick();
      should(outcome.error).be.instanceOf(ParakeetEngineError);
    });
  });

  describe('the one-thread replacement itself fails to start', () => {
    /** Engine whose second worker (the replacement) is made by `makeSecond`. */
    const failing = (makeSecond: () => FakeWorker) => {
      const workers: FakeWorker[] = [];
      let spawned = 0;
      const engine = new ParakeetEngine(
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
      const engine = new ParakeetEngine(
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
      should(one.error).be.instanceOf(ParakeetEngineError);
      should(two.error).be.instanceOf(ParakeetEngineError);
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
      should(one.error).be.instanceOf(ParakeetEngineError);
      should(two.error).be.instanceOf(ParakeetEngineError);
      // The dead replacement is forgotten: a later request starts another worker.
      void engine.transcribe(new Float32Array(4));
      should(workers).have.length(3);
    });
  });
});
