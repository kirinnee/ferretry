/**
 * Proves the page's side of the speech worker: it spawns lazily and once, transfers samples, routes
 * each reply to its own caller, ignores anything it cannot attribute, honours abort, and gives a
 * terminated or crashed worker's callers a clear answer instead of a hang.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { ParakeetEngine, ParakeetEngineError, type ParakeetWorkerLike } from '../../../src/lib/stt/parakeet-engine.ts';
import type { ParakeetWorkerRequest } from '../../../src/lib/stt/parakeet-worker-core.ts';

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
