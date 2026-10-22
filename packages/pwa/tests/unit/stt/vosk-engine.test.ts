/**
 * Proves the page's side of the Vosk worker with a fake worker: the worker starts on first use, the
 * model load is timed once, each utterance streams audio (transferred, never copied) and hears its
 * words, finishes with the worker's text, is cancelled or aborted cleanly, and hears a failure exactly
 * once — while streaming, while finishing, or when the worker itself dies or is unloaded.
 */

import { describe, it } from 'bun:test';
import should from 'should';
import {
  VoskEngine,
  VoskEngineError,
  type VoskHeardState,
  type VoskWorkerLike,
} from '../../../src/lib/stt/vosk-engine.ts';
import type { VoskWorkerReply, VoskWorkerRequest } from '../../../src/lib/stt/vosk-worker-core.ts';

class FakeWorker implements VoskWorkerLike {
  readonly posted: { message: VoskWorkerRequest; transfer: Transferable[] | undefined }[] = [];
  readonly listeners: { message: ((event: { data: unknown }) => void)[]; error: ((event: unknown) => void)[] } = {
    message: [],
    error: [],
  };
  terminated = 0;
  postMessage(message: VoskWorkerRequest, transfer?: Transferable[]): void {
    this.posted.push({ message, transfer });
  }
  addEventListener(type: 'message' | 'error', listener: (event: never) => void): void {
    this.listeners[type].push(listener as never);
  }
  terminate(): void {
    this.terminated += 1;
  }
  reply(data: VoskWorkerReply | unknown): void {
    for (const listener of this.listeners.message) listener({ data });
  }
  crash(): void {
    for (const listener of this.listeners.error) listener(new Event('error'));
  }
  messages(): VoskWorkerRequest[] {
    return this.posted.map(entry => entry.message);
  }
}

const setup = () => {
  const workers: FakeWorker[] = [];
  let clock = 0;
  const engine = new VoskEngine(
    () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    () => clock,
  );
  return {
    engine,
    workers,
    worker: () => workers.at(-1) as FakeWorker,
    advance: (ms: number) => {
      clock += ms;
    },
  };
};

const listen = () => {
  const heard: VoskHeardState[] = [];
  const failures: VoskEngineError[] = [];
  return {
    heard,
    failures,
    listeners: {
      onHeard: (state: VoskHeardState) => heard.push(state),
      onFailure: (error: VoskEngineError) => failures.push(error),
    },
  };
};

describe('VoskEngine loading', () => {
  it('starts the worker on first use, asks it to load, and times the load once', () => {
    const { engine, workers, worker, advance } = setup();
    should(workers).have.length(0);
    engine.preload();
    engine.preload();
    should(workers).have.length(1);
    should(worker().messages()).eql([{ type: 'load' }, { type: 'load' }]);
    advance(1_500);
    worker().reply({ type: 'ready' });
    should(engine.consumeLoadMs()).equal(1_500);
    should(engine.consumeLoadMs()).be.undefined();
    // A ready nobody was timing measures nothing.
    worker().reply({ type: 'ready' });
    should(engine.consumeLoadMs()).be.undefined();
  });

  it('times the load from the first utterance when nothing preloaded it', () => {
    const { engine, worker, advance } = setup();
    engine.open(listen().listeners);
    advance(40);
    worker().reply({ type: 'ready' });
    should(engine.consumeLoadMs()).equal(40);
  });

  it('ignores what is not a reply, and a failure about no utterance', () => {
    const { engine, worker } = setup();
    const { heard, failures, listeners } = listen();
    engine.open(listeners);
    for (const data of [
      null,
      'ready',
      { type: 'nope' },
      { type: 'failed', id: null, code: 'load-failed', message: 'x' },
    ])
      worker().reply(data);
    worker().reply({ type: 'heard', id: 99, committed: 'a', interim: 'b' });
    should(heard).eql([]);
    should(failures).eql([]);
  });
});

describe('VoskEngine streaming', () => {
  it('opens an utterance, transfers each stretch of audio, hears its words, and finishes with the text', async () => {
    const { engine, worker } = setup();
    const { heard, listeners } = listen();
    const stream = engine.open(listeners);
    const samples = new Float32Array([0.1, 0.2]);
    stream.feed(samples);
    should(worker().posted[1]).eql({ message: { type: 'audio', id: 1, samples }, transfer: [samples.buffer] });
    worker().reply({ type: 'heard', id: 1, committed: '', interim: 'hello' });
    worker().reply({ type: 'heard', id: 1, committed: 'hello there', interim: '' });
    should(heard).eql([
      { committed: '', interim: 'hello' },
      { committed: 'hello there', interim: '' },
    ]);
    const text = stream.finish();
    should(worker().messages().at(-1)).eql({ type: 'finish', id: 1 });
    // Words heard after Stop are not news: the result is.
    worker().reply({ type: 'heard', id: 1, committed: 'late', interim: '' });
    worker().reply({ type: 'result', id: 1, text: 'hello there friend' });
    should(await text).equal('hello there friend');
    should(heard).have.length(2);
    should(worker().messages()[0]).eql({ type: 'open', id: 1 });
  });

  it('numbers utterances, and refuses to finish one twice', async () => {
    const { engine, worker } = setup();
    const first = engine.open(listen().listeners);
    engine.open(listen().listeners);
    should(worker().messages()).eql([
      { type: 'open', id: 1 },
      { type: 'open', id: 2 },
    ]);
    const done = first.finish();
    await should(first.finish()).be.rejectedWith({ code: 'cancelled', message: 'Dictation already ended.' });
    worker().reply({ type: 'result', id: 1, text: '' });
    should(await done).equal('');
  });

  it('cancels an utterance once, and feeds nothing after', async () => {
    const { engine, worker } = setup();
    const stream = engine.open(listen().listeners);
    stream.cancel();
    stream.cancel();
    stream.feed(new Float32Array([1]));
    should(worker().messages()).eql([
      { type: 'open', id: 1 },
      { type: 'close', id: 1 },
    ]);
    await should(stream.finish()).be.rejectedWith({ code: 'cancelled' });
  });

  it('closes an utterance whose finish is aborted, before or while it waits', async () => {
    const { engine, worker } = setup();
    const before = new AbortController();
    before.abort();
    await should(engine.open(listen().listeners).finish(before.signal)).be.rejectedWith({
      code: 'cancelled',
      message: 'Transcription was cancelled.',
    });
    should(worker().messages().at(-1)).eql({ type: 'close', id: 1 });
    const during = new AbortController();
    const waiting = engine.open(listen().listeners).finish(during.signal);
    during.abort();
    await should(waiting).be.rejectedWith({ code: 'cancelled' });
    should(worker().messages().slice(-2)).eql([
      { type: 'finish', id: 2 },
      { type: 'close', id: 2 },
    ]);
    // The answer that comes anyway is nobody's.
    worker().reply({ type: 'result', id: 2, text: 'late' });
  });

  it('resolves a finish whose signal never fired, and stops listening to it', async () => {
    const { engine, worker } = setup();
    const signal = new AbortController();
    const text = engine.open(listen().listeners).finish(signal.signal);
    worker().reply({ type: 'result', id: 1, text: 'done' });
    should(await text).equal('done');
    signal.abort();
    should(worker().messages().at(-1)).eql({ type: 'finish', id: 1 });
  });
});

describe('VoskEngine failures', () => {
  it('tells a streaming utterance it failed, once, stops feeding it, and rejects its finish with the cause', async () => {
    const { engine, worker } = setup();
    const { failures, listeners } = listen();
    const stream = engine.open(listeners);
    worker().reply({ type: 'failed', id: 1, code: 'not-installed', message: 'Vosk is not installed on this device.' });
    worker().reply({ type: 'failed', id: 1, code: 'load-failed', message: 'again' });
    should(failures.map(error => [error.code, error.message])).eql([
      ['not-installed', 'Vosk is not installed on this device.'],
    ]);
    should(failures[0]).be.instanceOf(VoskEngineError);
    should(failures[0]?.name).equal('VoskEngineError');
    stream.feed(new Float32Array([1]));
    should(worker().messages()).eql([{ type: 'open', id: 1 }]);
    await should(stream.finish()).be.rejectedWith({ code: 'not-installed' });
  });

  it('rejects a finish that is waiting when the worker fails it, without calling the listener', async () => {
    const { engine, worker } = setup();
    const { failures, listeners } = listen();
    const text = engine.open(listeners).finish();
    worker().reply({ type: 'failed', id: 1, code: 'transcribe-failed', message: 'out of bounds' });
    await should(text).be.rejectedWith({ code: 'transcribe-failed', message: 'out of bounds' });
    should(failures).eql([]);
  });

  it('fails every utterance when the worker dies, and starts a fresh worker next time', async () => {
    const { engine, workers, worker } = setup();
    const streaming = listen();
    engine.open(streaming.listeners);
    const finishing = engine.open(listen().listeners).finish();
    const dead = worker();
    dead.crash();
    should(dead.terminated).equal(1);
    should(streaming.failures.map(error => error.code)).eql(['worker-failed']);
    await should(finishing).be.rejectedWith({
      code: 'worker-failed',
      message: 'The on-device speech engine could not start in this browser.',
    });
    // A dead worker's last words and errors are ignored.
    dead.crash();
    dead.reply({ type: 'heard', id: 1, committed: 'ghost', interim: '' });
    engine.preload();
    should(workers).have.length(2);
  });

  it('unloads: terminates the worker, cancels every utterance, and forgets the load timing', async () => {
    const { engine, worker, advance } = setup();
    const streaming = listen();
    engine.preload();
    const stream = engine.open(streaming.listeners);
    const first = worker();
    advance(10);
    engine.unload();
    engine.unload();
    should(first.terminated).equal(1);
    should(streaming.failures.map(error => [error.code, error.message])).eql([
      ['cancelled', 'The speech model was unloaded.'],
    ]);
    await should(stream.finish()).be.rejectedWith({ code: 'cancelled' });
    should(engine.consumeLoadMs()).be.undefined();
  });
});

describe('VoskEngine clock', () => {
  it('times on the page’s monotonic clock by default', () => {
    const worker = new FakeWorker();
    const engine = new VoskEngine(() => worker);
    engine.preload();
    worker.reply({ type: 'ready' });
    should(engine.consumeLoadMs()).be.aboveOrEqual(0);
  });
});
