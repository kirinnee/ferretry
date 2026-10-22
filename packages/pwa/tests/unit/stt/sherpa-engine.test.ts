/**
 * Proves the page's side of the sherpa worker: it spawns lazily and once, names its model first,
 * transfers samples, routes partial words and results to their own stream or caller, honours abort
 * and drop, and gives a terminated or crashed worker's callers a clear answer instead of a hang.
 */

import { describe, it } from 'bun:test';
import should from 'should';
import {
  SherpaEngine,
  SherpaEngineError,
  type SherpaWorkerLike,
  type StreamWords,
} from '../../../src/lib/stt/sherpa-engine.ts';
import type { SherpaWorkerRequest } from '../../../src/lib/stt/sherpa-worker-core.ts';

class FakeWorker implements SherpaWorkerLike {
  readonly posts: { message: SherpaWorkerRequest; transfer: Transferable[] | undefined }[] = [];
  terminated = 0;
  readonly #message: ((event: { readonly data: unknown }) => void)[] = [];
  readonly #error: ((event: unknown) => void)[] = [];

  postMessage(message: SherpaWorkerRequest, transfer?: Transferable[]): void {
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

const setup = () => {
  const workers: FakeWorker[] = [];
  const engine = new SherpaEngine(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  }, 'sherpa-zipformer-en');
  return { engine, workers, worker: () => workers.at(-1) as FakeWorker };
};

const streamLog = () => {
  const partials: StreamWords[] = [];
  const failures: SherpaEngineError[] = [];
  return {
    partials,
    failures,
    callbacks: {
      onPartial: (words: StreamWords) => partials.push(words),
      onFailure: (error: SherpaEngineError) => failures.push(error),
    },
  };
};

describe('SherpaEngine', () => {
  it('spawns once on first use and names its model before anything else', () => {
    const { engine, workers, worker } = setup();
    should(workers).have.length(0);
    engine.preload();
    engine.preload();
    should(workers).have.length(1);
    should(worker().posts.map(post => post.message)).eql([{ type: 'load', model: 'sherpa-zipformer-en' }]);
  });

  it('remembers the load time once', () => {
    const { engine, worker } = setup();
    engine.preload();
    worker().emit({ type: 'ready', loadMs: 1200 });
    should(engine.consumeLoadMs()).equal(1200);
    should(engine.consumeLoadMs()).be.undefined();
  });

  it('streams: transfers each slice, routes partials to their stream, and resolves the close', async () => {
    const { engine, worker } = setup();
    const log = streamLog();
    const stream = engine.openStream(log.callbacks);
    const slice = new Float32Array(4);
    stream.push(slice);
    const posts = worker().posts;
    should(posts[1]?.message).eql({ type: 'stream-open', id: 1 });
    should(posts[2]?.message.type).equal('stream-push');
    should(posts[2]?.transfer).eql([slice.buffer]);
    worker().emit({ type: 'partial', id: 1, committed: 'Hello', interim: 'there' });
    worker().emit({ type: 'partial', id: 99, committed: 'not', interim: 'ours' });
    worker().emit({ nonsense: true });
    should(log.partials).eql([{ committed: 'Hello', interim: 'there' }]);
    const closing = stream.close();
    should(worker().posts.at(-1)?.message).eql({ type: 'stream-close', id: 1 });
    worker().emit({ type: 'result', id: 1, text: 'Hello there' });
    should(await closing).equal('Hello there');
    stream.push(new Float32Array(1));
    stream.drop();
    await should(stream.close()).be.rejectedWith({ code: 'cancelled' });
    should(worker().posts.at(-1)?.message).eql({ type: 'stream-close', id: 1 });
  });

  it('drops a stream: tells the worker once, and stops hearing it', () => {
    const { engine, worker } = setup();
    const log = streamLog();
    const stream = engine.openStream(log.callbacks);
    stream.drop();
    stream.drop();
    should(worker().posts.filter(post => post.message.type === 'stream-drop')).have.length(1);
    worker().emit({ type: 'partial', id: 1, committed: 'late', interim: '' });
    should(log.partials).eql([]);
  });

  it('tells a stream its worker failed it, before or after close', async () => {
    const { engine, worker } = setup();
    const before = streamLog();
    engine.openStream(before.callbacks);
    worker().emit({ type: 'failed', id: 1, code: 'transcribe-failed', message: 'Decode failed.' });
    should(before.failures.map(error => error.message)).eql(['Decode failed.']);
    worker().emit({ type: 'failed', id: 1, code: 'transcribe-failed', message: 'Twice.' });
    worker().emit({ type: 'failed', id: null, code: 'not-installed', message: 'Not installed.' });
    should(before.failures).have.length(1);

    const after = streamLog();
    const stream = engine.openStream(after.callbacks);
    const closing = stream.close();
    worker().emit({ type: 'failed', id: 2, code: 'not-installed', message: 'Install it first.' });
    await should(closing).be.rejectedWith({ code: 'not-installed', message: 'Install it first.' });
    should(after.failures).eql([]);
  });

  it('refuses to close a stream its worker already lost', async () => {
    const { engine, worker } = setup();
    const log = streamLog();
    const stream = engine.openStream(log.callbacks);
    worker().emit({ type: 'failed', id: 1, code: 'transcribe-failed', message: 'Gone.' });
    await should(stream.close()).be.rejectedWith({
      code: 'cancelled',
      message: 'The speech model stopped before the take finished.',
    });
  });

  it('transcribes a whole take, honouring an abort before and during', async () => {
    const { engine, worker } = setup();
    const samples = new Float32Array(3);
    const answer = engine.transcribe(samples);
    should(worker().posts.at(-1)).eql({ message: { type: 'transcribe', id: 1, samples }, transfer: [samples.buffer] });
    worker().emit({ type: 'result', id: 1, text: 'done' });
    should(await answer).equal('done');

    const aborted = new AbortController();
    aborted.abort();
    await should(engine.transcribe(new Float32Array(1), aborted.signal)).be.rejectedWith({ code: 'cancelled' });

    const later = new AbortController();
    const pending = engine.transcribe(new Float32Array(1), later.signal);
    later.abort();
    await should(pending).be.rejectedWith({ code: 'cancelled' });

    const failing = new AbortController();
    const failed = engine.transcribe(new Float32Array(1), failing.signal);
    worker().emit({ type: 'failed', id: 4, code: 'transcribe-failed', message: 'No.' });
    await should(failed).be.rejectedWith({ code: 'transcribe-failed' });
  });

  it('unloads: terminates, answers every waiting caller and stream, and starts afresh next time', async () => {
    const { engine, workers, worker } = setup();
    const log = streamLog();
    engine.openStream(log.callbacks);
    const closing = engine.openStream(streamLog().callbacks).close();
    const answer = engine.transcribe(new Float32Array(1));
    engine.unload();
    should(workers[0]?.terminated).equal(1);
    await should(answer).be.rejectedWith({ code: 'cancelled' });
    await should(closing).be.rejectedWith({ code: 'cancelled' });
    should(log.failures.map(error => error.code)).eql(['cancelled']);
    workers[0]?.emit({ type: 'result', id: 3, text: 'late' });
    engine.preload();
    should(workers).have.length(2);
    should(worker().posts[0]?.message).eql({ type: 'load', model: 'sherpa-zipformer-en' });
    engine.unload();
    engine.unload();
  });

  it('turns a crashed worker into a clear failure for everyone waiting', async () => {
    const { engine, workers } = setup();
    const log = streamLog();
    engine.openStream(log.callbacks);
    const answer = engine.transcribe(new Float32Array(1));
    workers[0]?.crash();
    await should(answer).be.rejectedWith({ code: 'worker-failed' });
    should(log.failures[0]).be.instanceOf(SherpaEngineError);
    should(workers[0]?.terminated).equal(1);
    workers[0]?.crash();
    should(workers[0]?.terminated).equal(1);
  });
});
