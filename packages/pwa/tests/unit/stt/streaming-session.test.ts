/**
 * Proves one streaming dictation: the microphone opens, the stream hears only samples it has not heard
 * yet, reads never overlap, live words reach `onLive` only while recording, Stop pushes the rest and
 * resolves the whole text with its timings, and every way of ending early (cancel, a hidden page, a
 * stream failure, a refused microphone) leaves nothing running.
 */

import { describe, it } from 'bun:test';
import should from 'should';
import type { AudioCapturePort, AudioRecording } from '../../../src/lib/stt/audio-capture.ts';
import { BrowserRecognitionError } from '../../../src/lib/stt/browser-recognition.ts';
import type { NearLiveState } from '../../../src/lib/stt/near-live.ts';
import type { StreamWords } from '../../../src/lib/stt/sherpa-engine.ts';
import {
  STREAM_PUSH_MS,
  type StreamingEngine,
  type StreamingEngineStream,
  StreamingRecognitionSession,
} from '../../../src/lib/stt/streaming-session.ts';

const tick = async (): Promise<void> => {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
};

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

class FakeRecording implements AudioRecording {
  readonly monitor = null;
  /** The whole take so far, which every peek and the stop return. */
  take = new Float32Array(0);
  peeks = 0;
  peekFails = false;
  stops = 0;
  cancels = 0;
  peek(): Promise<Float32Array> {
    this.peeks += 1;
    return this.peekFails ? Promise.reject(new Error('decode failed')) : Promise.resolve(this.take);
  }
  stop(): Promise<Float32Array> {
    this.stops += 1;
    return Promise.resolve(this.take);
  }
  cancel(): void {
    this.cancels += 1;
  }
}

class FakeStream implements StreamingEngineStream {
  readonly pushed: number[] = [];
  readonly closing = deferred<string>();
  closes = 0;
  drops = 0;
  push(samples: Float32Array): void {
    this.pushed.push(samples.length);
  }
  close(): Promise<string> {
    this.closes += 1;
    return this.closing.promise;
  }
  drop(): void {
    this.drops += 1;
  }
}

const world = (options: { maxDurationMs?: number; openThrows?: boolean; loadMs?: number } = {}) => {
  const recording = new FakeRecording();
  const open = deferred<AudioRecording>();
  const stream = new FakeStream();
  const timers: { callback: () => void; milliseconds: number; cleared: boolean }[] = [];
  const events: string[] = [];
  const live: NearLiveState[] = [];
  const failures: BrowserRecognitionError[] = [];
  let partial: (words: StreamWords) => void = () => undefined;
  let streamFailure: (error: unknown) => void = () => undefined;
  let hidden: () => void = () => undefined;
  let unwatched = 0;
  let preloads = 0;
  let clock = 0;
  const engine: StreamingEngine = {
    preload: () => {
      preloads += 1;
    },
    ...(options.loadMs === undefined ? {} : { consumeLoadMs: () => options.loadMs }),
    openStream: callbacks => {
      if (options.openThrows === true) throw new Error('no stream for you');
      partial = callbacks.onPartial;
      streamFailure = callbacks.onFailure;
      return stream;
    },
  };
  const capture: AudioCapturePort = { start: () => open.promise };
  const session = new StreamingRecognitionSession(
    {
      capture,
      engine,
      model: 'Zipformer test',
      failure: error =>
        new BrowserRecognitionError('recognition-failed', error instanceof Error ? error.message : 'failed'),
      watchHidden: onHidden => {
        hidden = onHidden;
        return () => {
          unwatched += 1;
        };
      },
      setTimeout: (callback, milliseconds) => {
        const timer = { callback, milliseconds, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimeout: handle => {
        (handle as { cleared: boolean }).cleared = true;
      },
      now: () => clock,
    },
    {
      ...(options.maxDurationMs === undefined ? {} : { maxDurationMs: options.maxDurationMs }),
      onStart: () => events.push('start'),
      onTranscript: () => events.push('transcript'),
      onFailure: failure => failures.push(failure),
      onAbort: () => events.push('abort'),
      onLimit: () => events.push('limit'),
      onMonitor: monitor => events.push(monitor === null ? 'monitor:off' : 'monitor:on'),
      onLive: state => live.push(state),
    },
  );
  /** Fire the pending push read. */
  const pushTick = async (): Promise<void> => {
    const timer = timers.filter(entry => entry.milliseconds === STREAM_PUSH_MS && !entry.cleared).at(-1);
    timer?.callback();
    await tick();
  };
  return {
    session,
    recording,
    open,
    stream,
    timers,
    events,
    live,
    failures,
    pushTick,
    partial: (words: StreamWords) => partial(words),
    streamFailure: (error: unknown) => streamFailure(error),
    hide: () => hidden(),
    unwatched: () => unwatched,
    preloads: () => preloads,
    advance: (milliseconds: number) => {
      clock += milliseconds;
    },
  };
};

const opened = async (w: ReturnType<typeof world>): Promise<void> => {
  w.session.start();
  w.open.resolve(w.recording);
  await tick();
};

describe('StreamingRecognitionSession', () => {
  it('opens the stream once recording, and pushes only the samples it has not heard yet', async () => {
    const w = world();
    await opened(w);
    should(w.events).eql(['start', 'monitor:off']);
    should(w.preloads()).equal(1);
    w.recording.take = new Float32Array(4_000);
    await w.pushTick();
    await w.pushTick();
    w.recording.take = new Float32Array(10_000);
    await w.pushTick();
    should(w.stream.pushed).eql([4_000, 6_000]);
    should(w.recording.peeks).equal(3);
  });

  it('reports live words while recording, and not after Stop', async () => {
    const w = world();
    await opened(w);
    w.partial({ committed: 'Hello', interim: 'there' });
    const finishing = w.session.finish();
    w.partial({ committed: 'late', interim: '' });
    should(w.live).eql([{ committed: 'Hello', interim: 'there', paused: false }]);
    await tick();
    w.stream.closing.resolve('Hello there');
    should(await finishing).equal('Hello there');
  });

  it('on Stop pushes the rest, closes the stream, and measures the take', async () => {
    const w = world({ loadMs: 900 });
    await opened(w);
    w.recording.take = new Float32Array(8_000);
    await w.pushTick();
    w.recording.take = new Float32Array(16_000);
    const finishing = w.session.finish();
    should(w.session.finish()).equal(finishing);
    await tick();
    should(w.recording.stops).equal(1);
    should(w.stream.pushed).eql([8_000, 8_000]);
    w.advance(50);
    w.stream.closing.resolve('the words');
    should(await finishing).equal('the words');
    should(w.session.timings()).eql({
      audioMs: 1000,
      audioBytes: 64_000,
      prepareMs: 0,
      transcribeMs: 50,
      model: 'Zipformer test',
      loadMs: 900,
    });
    should(w.timers.every(timer => timer.cleared || timer.milliseconds === STREAM_PUSH_MS)).be.true();
    should(w.unwatched()).equal(1);
    w.session.cancel();
    should(w.stream.drops).equal(0);
  });

  it('keeps reading after a read fails, and stops reading once Stop is pressed', async () => {
    const w = world();
    await opened(w);
    w.recording.peekFails = true;
    await w.pushTick();
    w.recording.peekFails = false;
    w.recording.take = new Float32Array(100);
    await w.pushTick();
    should(w.stream.pushed).eql([100]);
    const peeks = w.recording.peeks;
    void w.session.finish();
    await w.pushTick();
    should(w.recording.peeks).equal(peeks);
  });

  it('drops a read that lands after Stop, and a failed read after Stop does not reschedule', async () => {
    const w = world();
    await opened(w);
    const timer = w.timers.find(entry => entry.milliseconds === STREAM_PUSH_MS);
    w.recording.take = new Float32Array(500);
    timer?.callback();
    void w.session.finish();
    await tick();
    should(w.stream.pushed).eql([500]);
    const other = world();
    await opened(other);
    other.recording.peekFails = true;
    other.timers.find(entry => entry.milliseconds === STREAM_PUSH_MS)?.callback();
    other.session.cancel();
    await tick();
    should(other.timers.filter(entry => entry.milliseconds === STREAM_PUSH_MS)).have.length(1);
  });

  it('asks to stop at the duration limit, and only while recording', async () => {
    const w = world({ maxDurationMs: 5_000 });
    await opened(w);
    const limit = w.timers.find(timer => timer.milliseconds === 5_000);
    limit?.callback();
    should(w.events).containEql('limit');
    void w.session.finish();
    limit?.callback();
    should(w.events.filter(event => event === 'limit')).have.length(1);
  });

  it('a stop before the microphone opens returns nothing and releases it', async () => {
    const w = world();
    w.session.start();
    const finishing = w.session.finish();
    w.open.resolve(w.recording);
    should(await finishing).equal('');
    should(w.recording.stops).equal(1);
    should(w.events).not.containEql('start');
  });

  it('a failed close fails the take and drops the stream', async () => {
    const w = world();
    await opened(w);
    const finishing = w.session.finish();
    await tick();
    w.stream.closing.reject(new Error('worker died'));
    await should(finishing).be.rejectedWith({ code: 'recognition-failed', message: 'worker died' });
    should(w.stream.drops).equal(1);
    await should(w.session.finish()).be.rejectedWith({ code: 'recognition-failed' });
    const fresh = world();
    await opened(fresh);
    fresh.session.cancel();
    await should(fresh.session.finish()).be.rejectedWith({ code: 'aborted' });
  });

  it('an abort during the close reads as cancelled, and a cancel during it wins', async () => {
    const w = world();
    await opened(w);
    const finishing = w.session.finish();
    await tick();
    w.stream.closing.reject(new BrowserRecognitionError('aborted', 'Unloaded.'));
    await should(finishing).be.rejectedWith({ code: 'aborted' });

    const c = world();
    await opened(c);
    const racing = c.session.finish();
    c.session.cancel();
    await tick();
    c.stream.closing.resolve('too late');
    await should(racing).be.rejectedWith({ code: 'aborted', message: 'Dictation was cancelled.' });
  });

  it('cancels: drops the stream, releases the microphone, and ignores a second cancel', async () => {
    const w = world();
    await opened(w);
    w.session.cancel();
    w.session.cancel();
    await tick();
    should(w.stream.drops).equal(1);
    should(w.recording.cancels).equal(1);
    should(w.events).containEql('monitor:off');
    should(w.unwatched()).equal(1);
  });

  it('a microphone that opens after a cancel is released at once', async () => {
    const w = world();
    w.session.start();
    w.session.cancel();
    w.open.resolve(w.recording);
    await tick();
    should(w.recording.cancels).be.above(0);
    should(w.events).not.containEql('start');
  });

  it('a microphone that is refused after a cancel is not reported and leaves nothing to release', async () => {
    const w = world();
    w.session.start();
    w.session.cancel();
    w.open.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
    await tick();
    should(w.failures).eql([]);
    should(w.recording.cancels).equal(0);
    should(w.events).not.containEql('start');
  });

  it('a hidden page cancels and says so, but not once the take has ended', async () => {
    const w = world();
    await opened(w);
    w.hide();
    should(w.events).containEql('abort');
    should(w.stream.drops).equal(1);
    const done = world();
    await opened(done);
    done.session.cancel();
    done.hide();
    should(done.events).not.containEql('abort');
  });

  it('fails the take when the stream dies, the stream cannot open, or the microphone is refused', async () => {
    const w = world();
    await opened(w);
    w.streamFailure(new Error('decode failed'));
    w.streamFailure(new Error('twice'));
    should(w.failures.map(failure => failure.message)).eql(['decode failed']);
    await tick();
    should(w.recording.cancels).equal(1);
    should(w.stream.drops).equal(1);

    const unopened = world({ openThrows: true });
    await opened(unopened);
    should(unopened.failures.map(failure => failure.message)).eql(['no stream for you']);

    const refused = world();
    refused.session.start();
    refused.open.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
    await tick();
    should(refused.failures.map(failure => failure.code)).eql(['permission-denied']);
  });
});
