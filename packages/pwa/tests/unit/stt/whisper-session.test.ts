/**
 * Proves one Whisper dictation: the microphone opens, the model preloads while the person speaks, the
 * limit timer runs only while recording, Stop transcribes the whole take (never a take too short to be
 * speech, which Whisper would invent words for), the timings name the model AND the backend that ran
 * it, engine failures map into the dictation panel's vocabulary, there are never live words, and every
 * way of ending early (cancel, hidden page, failure) leaves nothing running.
 */

import { describe, it } from 'bun:test';
import should from 'should';
import type { AudioCapturePort, AudioRecording } from '../../../src/lib/stt/audio-capture.ts';
import { BrowserRecognitionError } from '../../../src/lib/stt/browser-recognition.ts';
import type { CaptureMonitor } from '../../../src/lib/stt/level-monitor.ts';
import { WhisperEngineError, type WhisperHeard } from '../../../src/lib/stt/whisper-engine.ts';
import {
  WHISPER_BACKEND_LABEL,
  WhisperRecognitionSession,
  type WhisperSessionPorts,
  whisperFailure,
} from '../../../src/lib/stt/whisper-session.ts';

const VERSION = 'Whisper tiny.en q8 · 2575352';
const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

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

/** A quarter of a second at 16 kHz: the shortest take that is sent to the model. */
const ENOUGH = 4_000;

class FakeRecording implements AudioRecording {
  monitor: CaptureMonitor | null = null;
  stops = 0;
  cancels = 0;
  peeks = 0;
  samples: Float32Array = new Float32Array(ENOUGH);

  peek(): Promise<Float32Array> {
    this.peeks += 1;
    return Promise.resolve(new Float32Array(16_000));
  }

  stop(): Promise<Float32Array> {
    this.stops += 1;
    return Promise.resolve(this.samples);
  }

  cancel(): void {
    this.cancels += 1;
  }
}

const world = (options: { maxDurationMs?: number; liveWords?: boolean; loadMs?: number; clock?: number[] } = {}) => {
  const { loadMs, clock = [], ...sessionOptions } = options;
  const recording = new FakeRecording();
  const open = deferred<AudioRecording>();
  const events: string[] = [];
  const failures: BrowserRecognitionError[] = [];
  const transcribed: { samples: Float32Array; signal: AbortSignal | undefined }[] = [];
  const timers: { callback: () => void; milliseconds: number; cleared: boolean }[] = [];
  const monitors: (CaptureMonitor | null)[] = [];
  let preloads = 0;
  let unwatched = 0;
  let hidden: () => void = () => undefined;
  const state = {
    preloadThrows: false,
    transcribe: async (samples: Float32Array, signal?: AbortSignal): Promise<WhisperHeard> => {
      transcribed.push({ samples, signal });
      return { text: 'hello world', backend: 'wasm' };
    },
  };
  const capture: AudioCapturePort = { start: () => open.promise };
  const ports: WhisperSessionPorts = {
    capture,
    versionLabel: VERSION,
    engine: {
      preload: () => {
        preloads += 1;
        if (state.preloadThrows) throw new Error('worker blocked');
      },
      transcribe: (samples, signal) => state.transcribe(samples, signal),
      consumeLoadMs: () => loadMs,
    },
    watchHidden: onHidden => {
      hidden = onHidden;
      return () => {
        unwatched += 1;
      };
    },
    setTimeout: (callback, milliseconds) => {
      timers.push({ callback, milliseconds, cleared: false });
      return timers.length - 1;
    },
    clearTimeout: handle => {
      const timer = timers[handle as number];
      if (timer !== undefined) timer.cleared = true;
    },
    now: () => clock.shift() ?? 0,
  };
  const session = new WhisperRecognitionSession(ports, {
    ...sessionOptions,
    onStart: () => events.push('start'),
    onTranscript: text => events.push(`transcript:${text}`),
    onFailure: failure => {
      failures.push(failure);
      events.push(`failure:${failure.code}`);
    },
    onAbort: () => events.push('abort'),
    onLimit: () => events.push('limit'),
    onLive: () => events.push('live'),
    onMonitor: monitor => monitors.push(monitor),
  });
  return {
    state,
    session,
    recording,
    open,
    events,
    failures,
    transcribed,
    timers,
    monitors,
    preloads: () => preloads,
    unwatched: () => unwatched,
    hide: () => hidden(),
  };
};

type World = ReturnType<typeof world>;

/** Start the session and let the microphone open. */
const recordingWorld = async (options: Parameters<typeof world>[0] = {}): Promise<World> => {
  const w = world(options);
  w.session.start();
  w.open.resolve(w.recording);
  await tick();
  return w;
};

describe('whisperFailure', () => {
  it('maps engine errors into the panel vocabulary, keeping the message', () => {
    should(whisperFailure(new WhisperEngineError('cancelled', 'c'))).have.property('code', 'aborted');
    should(whisperFailure(new WhisperEngineError('not-installed', 'n'))).have.property('code', 'model-not-installed');
    for (const code of ['integrity', 'load-failed', 'transcribe-failed', 'worker-failed'] as const)
      should(whisperFailure(new WhisperEngineError(code, 'x'))).have.properties({
        code: 'recognition-failed',
        message: 'x',
      });
  });

  it('maps other errors through the browser mapping', () => {
    should(whisperFailure({ name: 'NotAllowedError' })).have.property('code', 'permission-denied');
  });
});

describe('WhisperRecognitionSession', () => {
  it('opens the microphone, then reports start, hands over the meter, arms the limit and preloads', async () => {
    const w = world({ maxDurationMs: 5_000 });
    const monitor = { createAnalyser: () => null } as unknown as CaptureMonitor;
    w.recording.monitor = monitor;
    w.session.start();
    should(w.events).eql([]);
    w.open.resolve(w.recording);
    await tick();
    should(w.events).eql(['start']);
    should(w.monitors).eql([monitor]);
    should(w.timers.map(timer => timer.milliseconds)).eql([5_000]);
    should(w.preloads()).equal(1);
  });

  it('defaults the limit to two minutes, never arms a zero timer, and limits only while recording', async () => {
    const standard = await recordingWorld();
    should(standard.timers[0]?.milliseconds).equal(120_000);
    standard.timers[0]?.callback();
    should(standard.events).eql(['start', 'limit']);
    await standard.session.finish();
    standard.timers[0]?.callback();
    should(standard.events).eql(['start', 'limit']);
    const zero = await recordingWorld({ maxDurationMs: 0 });
    should(zero.timers[0]?.milliseconds).equal(1);
  });

  it('swallows a preload that throws: the transcribe that follows reports it', async () => {
    const w = world();
    w.state.preloadThrows = true;
    w.session.start();
    w.open.resolve(w.recording);
    await tick();
    should(w.events).eql(['start']);
    should(w.failures).have.length(0);
  });

  it('never shows live words, even when asked for them', async () => {
    const w = await recordingWorld({ liveWords: true });
    await w.session.finish();
    should(w.events).eql(['start']);
    should(w.recording.peeks).equal(0);
  });

  it('transcribes the whole take on Stop, with timings that name the model and the backend', async () => {
    // prepare: 10 → 25; transcribe: 30 → 230.
    const w = await recordingWorld({ loadMs: 900, clock: [10, 25, 30, 230] });
    w.recording.samples = new Float32Array(32_000);
    w.state.transcribe = async (samples, signal) => {
      w.transcribed.push({ samples, signal });
      return { text: 'on the gpu', backend: 'webgpu' };
    };
    should(await w.session.finish()).equal('on the gpu');
    should(w.recording.stops).equal(1);
    should(w.transcribed[0]?.samples).equal(w.recording.samples);
    should(w.timers[0]?.cleared).be.true();
    should(w.monitors.at(-1)).be.null();
    should(w.unwatched()).equal(1);
    should(w.session.timings()).eql({
      audioMs: 2_000,
      audioBytes: 128_000,
      prepareMs: 15,
      transcribeMs: 200,
      model: `${VERSION} · WebGPU`,
      loadMs: 900,
    });
  });

  it('says WebAssembly when that is what ran, and leaves out a load nobody paid', async () => {
    const w = await recordingWorld();
    await w.session.finish();
    should(w.session.timings()?.model).equal(`${VERSION} · ${WHISPER_BACKEND_LABEL.wasm}`);
    should(w.session.timings()).not.have.property('loadMs');
  });

  it('answers an empty take without sending it to Whisper, naming the model alone', async () => {
    const w = await recordingWorld();
    w.recording.samples = new Float32Array(ENOUGH - 1);
    should(await w.session.finish()).equal('');
    should(w.transcribed).have.length(0);
    should(w.session.timings()).eql({
      audioMs: ((ENOUGH - 1) / 16_000) * 1000,
      audioBytes: (ENOUGH - 1) * 4,
      prepareMs: 0,
      transcribeMs: 0,
      model: VERSION,
    });
  });

  it('measures a failed transcribe too, without a backend', async () => {
    const w = await recordingWorld();
    w.state.transcribe = async () => {
      throw new WhisperEngineError('transcribe-failed', 'decode broke');
    };
    await should(w.session.finish()).be.rejectedWith({ code: 'recognition-failed', message: 'decode broke' });
    should(w.session.timings()?.model).equal(VERSION);
    await should(w.session.finish()).be.rejectedWith({ code: 'recognition-failed' });
  });

  it('waits for a microphone that is still opening, and finishes without start or preload', async () => {
    const w = world();
    w.session.start();
    const outcome = settle(w.session.finish());
    w.open.resolve(w.recording);
    await tick();
    should(outcome.value).equal('hello world');
    should(w.events).eql([]);
    should(w.timers).have.length(0);
    should(w.preloads()).equal(0);
  });

  it('finishes empty without a start, and answers a second finish with the first', async () => {
    should(await world().session.finish()).equal('');
    const w = await recordingWorld();
    const first = w.session.finish();
    should(w.session.finish()).equal(first);
    await first;
    should(w.recording.stops).equal(1);
  });

  it('fails a denied microphone through onFailure, and a later finish as aborted', async () => {
    const w = world();
    w.session.start();
    w.open.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' }));
    await tick();
    should(w.events).eql(['failure:permission-denied']);
    should(w.unwatched()).equal(1);
    should(w.monitors).eql([null]);
    await should(w.session.finish()).be.rejectedWith({ code: 'aborted' });
  });

  it('rejects finish, not onFailure, for a capture failure while finishing', async () => {
    const w = world();
    w.session.start();
    const outcome = settle(w.session.finish());
    w.open.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' }));
    await tick();
    should(outcome.error).be.instanceOf(BrowserRecognitionError);
    should(outcome.error).have.property('code', 'permission-denied');
    should(w.failures).have.length(0);
  });

  it('aborts the take when the engine was unloaded under it', async () => {
    const w = await recordingWorld();
    w.state.transcribe = async () => {
      throw new WhisperEngineError('cancelled', 'unloaded');
    };
    await should(w.session.finish()).be.rejectedWith({ code: 'aborted', message: 'unloaded' });
    await should(w.session.finish()).be.rejectedWith({ code: 'aborted' });
  });

  it('cancel aborts the transcribe’s signal, cancels the recording, and rejects finish as aborted', async () => {
    const w = await recordingWorld();
    const gate = deferred<WhisperHeard>();
    w.state.transcribe = (samples, signal) => {
      w.transcribed.push({ samples, signal });
      return gate.promise;
    };
    const outcome = settle(w.session.finish());
    await tick();
    should(w.transcribed[0]?.signal?.aborted).be.false();
    w.session.cancel();
    should(w.transcribed[0]?.signal?.aborted).be.true();
    await tick();
    should(w.recording.cancels).equal(1);
    gate.resolve({ text: 'late words', backend: 'wasm' });
    await tick();
    should(outcome.error).have.property('code', 'aborted');
  });

  it('cancel while finishing stays aborted even if the engine then fails', async () => {
    const w = await recordingWorld();
    const gate = deferred<WhisperHeard>();
    w.state.transcribe = () => gate.promise;
    const outcome = settle(w.session.finish());
    await tick();
    w.session.cancel();
    gate.reject(new WhisperEngineError('transcribe-failed', 'late failure'));
    await tick();
    should(outcome.error).have.property('code', 'aborted');
  });

  it('cancels a recording that opens after the cancel, and is quiet when it fails instead', async () => {
    const late = world();
    late.session.start();
    late.session.cancel();
    late.open.resolve(late.recording);
    await tick();
    should(late.recording.cancels).be.greaterThanOrEqual(1);
    should(late.events).eql([]);
    should(late.timers).have.length(0);

    const refused = world();
    refused.session.start();
    refused.session.cancel();
    refused.open.reject(new Error('nope'));
    await tick();
    should(refused.events).eql([]);
  });

  it('cancel is idempotent, harmless without start, and does nothing once the take finished', async () => {
    const done = await recordingWorld();
    await done.session.finish();
    done.session.cancel();
    should(done.recording.cancels).equal(0);

    const twice = await recordingWorld();
    twice.session.cancel();
    twice.session.cancel();
    await tick();
    should(twice.recording.cancels).equal(1);
    should(twice.timers[0]?.cleared).be.true();
    await should(twice.session.finish()).be.rejectedWith({ code: 'aborted' });

    world().session.cancel();
  });

  it('a hidden page cancels and reports an abort while opening or recording, and is ignored after', async () => {
    const recording = await recordingWorld();
    recording.hide();
    should(recording.events).eql(['start', 'abort']);

    const opening = world();
    opening.session.start();
    opening.hide();
    should(opening.events).eql(['abort']);

    const finishing = await recordingWorld();
    const outcome = settle(finishing.session.finish());
    finishing.hide();
    await tick();
    should(outcome.value).equal('hello world');
    should(finishing.events).eql(['start']);
  });

  it('a microphone that opens while finishing is not started again', async () => {
    const w = world();
    w.session.start();
    const outcome = settle(w.session.finish());
    w.open.resolve(w.recording);
    await tick();
    should(outcome.done).be.true();
    should(w.events).eql([]);
    should(w.recording.cancels).equal(0);
  });
});
