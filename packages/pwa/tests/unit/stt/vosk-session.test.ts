/**
 * Proves one Vosk dictation: the microphone opens, the model starts loading and an utterance opens at
 * once, each read of the recording feeds the worker ONLY the audio it has not had, the words heard
 * reach `onLive` while recording (and never after), Stop feeds the last stretch and returns the
 * worker's text with what it measured, engine failures map into the dictation panel's vocabulary and
 * end a dictation at once, and every way of ending early leaves nothing running.
 */

import { describe, it } from 'bun:test';
import should from 'should';
import type { AudioRecording } from '../../../src/lib/stt/audio-capture.ts';
import { BrowserRecognitionError } from '../../../src/lib/stt/browser-recognition.ts';
import type { CaptureMonitor } from '../../../src/lib/stt/level-monitor.ts';
import type { NearLiveState } from '../../../src/lib/stt/near-live.ts';
import type { OnDeviceSessionOptions } from '../../../src/lib/stt/on-device-voice.ts';
import {
  VoskEngineError,
  type VoskHeardState,
  type VoskStream,
  type VoskStreamListeners,
} from '../../../src/lib/stt/vosk-engine.ts';
import { VOSK_VERSION_LABEL } from '../../../src/lib/stt/vosk-model.ts';
import { PUMP_MS, VoskRecognitionSession, voskFailure } from '../../../src/lib/stt/vosk-session.ts';

const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
};

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

/** `n` samples whose values are their own indexes, so a test can see exactly which ones were fed. */
const counting = (n: number): Float32Array => Float32Array.from({ length: n }, (_, index) => index);

class FakeRecording implements AudioRecording {
  monitor: CaptureMonitor | null = { level: () => 0, release: () => undefined } as unknown as CaptureMonitor;
  peeks: (Float32Array | Error | Deferred<Float32Array>)[] = [];
  final: Float32Array | Error = counting(16_000);
  cancels = 0;
  stops = 0;
  peek(): Promise<Float32Array> {
    const next = this.peeks.shift() ?? new Float32Array();
    if (next instanceof Error) return Promise.reject(next);
    return next instanceof Float32Array ? Promise.resolve(next) : next.promise;
  }
  stop(): Promise<Float32Array> {
    this.stops += 1;
    return this.final instanceof Error ? Promise.reject(this.final) : Promise.resolve(this.final);
  }
  cancel(): void {
    this.cancels += 1;
  }
}

class FakeStream implements VoskStream {
  readonly fed: number[][] = [];
  cancels = 0;
  finishes: (AbortSignal | undefined)[] = [];
  answer: Promise<string> = Promise.resolve('restart the daemon');
  constructor(readonly listeners: VoskStreamListeners) {}
  feed(samples: Float32Array): void {
    this.fed.push([...samples]);
  }
  finish(signal?: AbortSignal): Promise<string> {
    this.finishes.push(signal);
    return this.answer;
  }
  cancel(): void {
    this.cancels += 1;
  }
}

interface Timer {
  readonly callback: () => void;
  readonly milliseconds: number;
  cleared: boolean;
}

const world = (options: { maxDurationMs?: number; loadMs?: number; openThrows?: unknown; consume?: boolean } = {}) => {
  const recording = new FakeRecording();
  const capture = deferred<AudioRecording>();
  const timers: Timer[] = [];
  const events: string[] = [];
  const live: NearLiveState[] = [];
  const monitors: (CaptureMonitor | null)[] = [];
  const failures: BrowserRecognitionError[] = [];
  const streams: FakeStream[] = [];
  let preloads = 0;
  let hide: () => void = () => undefined;
  let unwatched = 0;
  let clock = 0;
  const sessionOptions: OnDeviceSessionOptions = {
    onStart: () => events.push('start'),
    onTranscript: () => events.push('transcript'),
    onFailure: error => failures.push(error),
    onAbort: () => events.push('abort'),
    onLimit: () => events.push('limit'),
    onMonitor: monitor => monitors.push(monitor),
    onLive: state => live.push(state),
    ...(options.maxDurationMs === undefined ? {} : { maxDurationMs: options.maxDurationMs }),
  };
  const session = new VoskRecognitionSession(
    {
      capture: { start: () => capture.promise },
      engine: {
        preload: () => {
          preloads += 1;
        },
        open: listeners => {
          if (options.openThrows !== undefined) throw options.openThrows;
          const stream = new FakeStream(listeners);
          streams.push(stream);
          return stream;
        },
        ...(options.consume === false ? {} : { consumeLoadMs: () => options.loadMs }),
      },
      watchHidden: onHidden => {
        hide = onHidden;
        return () => {
          unwatched += 1;
        };
      },
      setTimeout: (callback, milliseconds) => {
        const timer: Timer = { callback, milliseconds, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimeout: handle => {
        (handle as Timer).cleared = true;
      },
      now: () => {
        clock += 5;
        return clock;
      },
    },
    sessionOptions,
  );
  /** Run the pending read of the recording, as its timer firing would. */
  const pump = async (): Promise<void> => {
    const timer = timers.filter(entry => entry.milliseconds === PUMP_MS && !entry.cleared).at(-1);
    if (timer === undefined) throw new Error('no read is scheduled');
    timer.cleared = true;
    timer.callback();
    await flush();
  };
  const opened = async (): Promise<FakeStream> => {
    session.start();
    capture.resolve(recording);
    await flush();
    return streams[0] as FakeStream;
  };
  return {
    session,
    recording,
    capture,
    timers,
    events,
    live,
    monitors,
    failures,
    streams,
    pump,
    opened,
    preloads: () => preloads,
    unwatched: () => unwatched,
    hide: () => hide(),
  };
};

describe('voskFailure', () => {
  it('maps engine failures into the dictation panel’s vocabulary', () => {
    should(voskFailure(new VoskEngineError('cancelled', 'gone')).code).equal('aborted');
    should(voskFailure(new VoskEngineError('not-installed', 'missing'))).match({
      code: 'model-not-installed',
      message: 'missing',
    });
    for (const code of ['integrity', 'load-failed', 'transcribe-failed', 'worker-failed'] as const)
      should(voskFailure(new VoskEngineError(code, code)).code).equal('recognition-failed');
    should(voskFailure(Object.assign(new Error('denied'), { name: 'NotAllowedError' }))).be.instanceOf(
      BrowserRecognitionError,
    );
  });
});

describe('VoskRecognitionSession recording', () => {
  it('opens the microphone, starts loading, opens an utterance and schedules the first read', async () => {
    const w = world();
    const stream = await w.opened();
    should(w.events).eql(['start']);
    should(w.monitors).eql([w.recording.monitor]);
    should(w.preloads()).equal(1);
    should(w.streams).have.length(1);
    should(stream.fed).eql([]);
    should(w.timers.map(timer => timer.milliseconds)).eql([120_000, PUMP_MS]);
  });

  it('feeds each read only the audio the worker has not had, and keeps reading', async () => {
    const w = world();
    const stream = await w.opened();
    w.recording.peeks = [counting(3), counting(3), counting(5)];
    await w.pump();
    await w.pump();
    await w.pump();
    should(stream.fed).eql([
      [0, 1, 2],
      [3, 4],
    ]);
    should(w.timers.filter(timer => timer.milliseconds === PUMP_MS)).have.length(4);
  });

  it('shows the words heard while recording, and nothing after Stop', async () => {
    const w = world();
    const stream = await w.opened();
    const heard: VoskHeardState = { committed: 'restart the', interim: 'daemon' };
    stream.listeners.onHeard(heard);
    should(w.live).eql([{ committed: 'restart the', interim: 'daemon', paused: false }]);
    const done = w.session.finish();
    stream.listeners.onHeard({ committed: 'late', interim: '' });
    await done;
    should(w.live).have.length(1);
  });

  it('keeps recording when a read fails, but reads no more', async () => {
    const w = world();
    const stream = await w.opened();
    w.recording.peeks = [new Error('decode failed')];
    await w.pump();
    should(stream.fed).eql([]);
    should(w.timers.filter(timer => timer.milliseconds === PUMP_MS)).have.length(1);
    should(await w.session.finish()).equal('restart the daemon');
  });

  it('drops a read that answers after Stop, and Stop feeds from where the last read left off', async () => {
    const w = world();
    const stream = await w.opened();
    const late = deferred<Float32Array>();
    w.recording.peeks = [counting(2), late];
    await w.pump();
    const timer = w.timers.at(-1) as Timer;
    timer.callback();
    w.recording.final = counting(16_000);
    const done = w.session.finish();
    late.resolve(counting(4));
    should(await done).equal('restart the daemon');
    should(stream.fed).have.length(2);
    should(stream.fed[0]).eql([0, 1]);
    should(stream.fed[1]?.length).equal(15_998);
    should(stream.fed[1]?.[0]).equal(2);
  });

  it('says the limit while recording, once its timer fires, and not after', async () => {
    const w = world({ maxDurationMs: 5_000 });
    await w.opened();
    const limit = w.timers[0] as Timer;
    should(limit.milliseconds).equal(5_000);
    limit.callback();
    should(w.events).eql(['start', 'limit']);
    await w.session.finish();
    limit.callback();
    should(w.events).eql(['start', 'limit']);
  });

  it('never waits less than a millisecond for the limit', async () => {
    const w = world({ maxDurationMs: 0 });
    await w.opened();
    should(w.timers[0]?.milliseconds).equal(1);
  });

  it('does not read once Stop has been pressed, even if the timer fires', async () => {
    const w = world();
    await w.opened();
    const read = w.timers.at(-1) as Timer;
    const done = w.session.finish();
    read.callback();
    await done;
    should(w.recording.peeks).eql([]);
  });
});

describe('VoskRecognitionSession.finish', () => {
  it('feeds the last stretch, returns the worker’s text, and says what it measured', async () => {
    const w = world({ loadMs: 1_200 });
    const stream = await w.opened();
    w.recording.peeks = [counting(6_000)];
    await w.pump();
    should(await w.session.finish()).equal('restart the daemon');
    should(stream.fed.map(piece => piece.length)).eql([6_000, 10_000]);
    should(stream.finishes).have.length(1);
    should(stream.finishes[0]?.aborted).be.false();
    should(w.session.timings()).eql({
      audioMs: 1_000,
      audioBytes: 64_000,
      prepareMs: 5,
      transcribeMs: 5,
      model: VOSK_VERSION_LABEL,
      loadMs: 1_200,
    });
    should(w.monitors).eql([w.recording.monitor, null]);
    should(w.unwatched()).equal(1);
    should(w.timers.every(timer => timer.cleared || timer.milliseconds !== PUMP_MS)).be.true();
  });

  it('feeds nothing more when the reads already had everything', async () => {
    const w = world({ consume: false });
    const stream = await w.opened();
    w.recording.peeks = [counting(16_000)];
    await w.pump();
    await w.session.finish();
    should(stream.fed.map(piece => piece.length)).eql([16_000]);
    should(w.session.timings()).not.have.property('loadMs');
  });

  it('answers nothing for a tap, closing the utterance', async () => {
    const w = world();
    const stream = await w.opened();
    w.recording.final = new Float32Array(100);
    should(await w.session.finish()).equal('');
    should(stream.cancels).equal(1);
    should(stream.finishes).eql([]);
    should(w.session.timings()?.transcribeMs).equal(0);
  });

  it('returns the same promise when pressed twice', async () => {
    const w = world();
    await w.opened();
    const first = w.session.finish();
    should(w.session.finish()).equal(first);
    await first;
  });

  it('answers nothing when Stop comes before the microphone opened', async () => {
    const w = world();
    w.session.start();
    const done = w.session.finish();
    w.capture.resolve(w.recording);
    should(await done).equal('');
    should(w.events).eql([]);
    should(w.streams).eql([]);
  });

  it('answers nothing for a session never started', async () => {
    should(await world().session.finish()).equal('');
  });

  it('maps a failed finish, and stays failed', async () => {
    const w = world();
    const stream = await w.opened();
    stream.answer = Promise.reject(new VoskEngineError('transcribe-failed', 'out of bounds'));
    await should(w.session.finish()).be.rejectedWith({ code: 'recognition-failed', message: 'out of bounds' });
    await should(w.session.finish()).be.rejectedWith({ code: 'recognition-failed' });
    should(w.session.timings()?.model).equal(VOSK_VERSION_LABEL);
  });

  it('reads an aborted finish as cancelled', async () => {
    const w = world();
    const stream = await w.opened();
    stream.answer = Promise.reject(new VoskEngineError('cancelled', 'Transcription was cancelled.'));
    await should(w.session.finish()).be.rejectedWith({ code: 'aborted' });
    await should(w.session.finish()).be.rejectedWith({ code: 'aborted' });
  });

  it('refuses a finish once the session ended early', async () => {
    const w = world();
    await w.opened();
    w.session.cancel();
    await should(w.session.finish()).be.rejectedWith({ code: 'aborted', message: 'Dictation already ended.' });
  });

  it('says it was cancelled when cancel comes while the text is on its way', async () => {
    const w = world();
    const stream = await w.opened();
    const answer = deferred<string>();
    stream.answer = answer.promise;
    const done = w.session.finish();
    await flush();
    w.session.cancel();
    should(stream.finishes[0]?.aborted).be.true();
    answer.resolve('too late');
    await should(done).be.rejectedWith({ code: 'aborted', message: 'Dictation was cancelled.' });
  });

  it('keeps its cancelled state when the text that was on its way fails', async () => {
    const w = world();
    const stream = await w.opened();
    const answer = deferred<string>();
    stream.answer = answer.promise;
    const done = w.session.finish();
    await flush();
    w.session.cancel();
    answer.reject(new VoskEngineError('transcribe-failed', 'boom'));
    await should(done).be.rejectedWith({ code: 'recognition-failed' });
    w.session.cancel();
  });
});

describe('VoskRecognitionSession ending early', () => {
  it('cancels: closes the utterance, stops reading, releases the microphone, once', async () => {
    const w = world();
    const stream = await w.opened();
    w.session.cancel();
    w.session.cancel();
    await flush();
    should(stream.cancels).equal(1);
    should(w.recording.cancels).equal(1);
    should(w.monitors).eql([w.recording.monitor, null]);
    should(w.timers.every(timer => timer.cleared)).be.true();
    should(w.unwatched()).equal(1);
  });

  it('releases a microphone that opens after cancel', async () => {
    const w = world();
    w.session.start();
    w.session.cancel();
    w.capture.resolve(w.recording);
    await flush();
    should(w.recording.cancels).equal(2);
    should(w.events).eql([]);
  });

  it('says nothing when a microphone that was cancelled while opening is then refused', async () => {
    const w = world();
    w.session.start();
    w.session.cancel();
    w.capture.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
    await flush();
    should(w.failures).eql([]);
  });

  it('aborts when the page is hidden, and ignores a hide once it is over', async () => {
    const w = world();
    await w.opened();
    w.hide();
    should(w.events).eql(['start', 'abort']);
    w.hide();
    should(w.events).eql(['start', 'abort']);
  });

  it('fails when the microphone cannot open, and not again', async () => {
    const w = world();
    w.session.start();
    w.capture.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
    await flush();
    should(w.failures.map(failure => failure.code)).eql(['permission-denied']);
    should(w.streams).eql([]);
  });

  it('ends at once when the engine fails mid-dictation, saying why', async () => {
    const w = world();
    const stream = await w.opened();
    stream.listeners.onFailure(new VoskEngineError('not-installed', 'Vosk is not installed on this device.'));
    await flush();
    should(w.failures.map(failure => [failure.code, failure.message])).eql([
      ['model-not-installed', 'Vosk is not installed on this device.'],
    ]);
    should(stream.cancels).equal(1);
    should(w.recording.cancels).equal(1);
    stream.listeners.onFailure(new VoskEngineError('worker-failed', 'again'));
    should(w.failures).have.length(1);
  });

  it('fails when the utterance cannot even open', async () => {
    const w = world({ openThrows: new VoskEngineError('worker-failed', 'no worker') });
    w.session.start();
    w.capture.resolve(w.recording);
    await flush();
    should(w.failures.map(failure => failure.code)).eql(['recognition-failed']);
    should(w.timers.filter(timer => timer.milliseconds === PUMP_MS)).eql([]);
  });
});
