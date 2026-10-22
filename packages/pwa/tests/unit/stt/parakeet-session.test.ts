/**
 * Proves one on-device dictation: the microphone opens, the limit timer runs only while recording,
 * Stop transcribes the take, engine failures map into the dictation panel's vocabulary, and every
 * way of ending early (cancel, hidden page, failure) leaves nothing running.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import type { AudioCapturePort, AudioRecording } from '../../../src/lib/stt/audio-capture.ts';
import { BrowserRecognitionError } from '../../../src/lib/stt/browser-recognition.ts';
import type { CaptureMonitor } from '../../../src/lib/stt/level-monitor.ts';
import type { NearLiveState, TimedTranscript } from '../../../src/lib/stt/near-live.ts';
import { ParakeetEngineError } from '../../../src/lib/stt/parakeet-engine.ts';
import { PARAKEET_VERSION_LABEL } from '../../../src/lib/stt/parakeet-model.ts';
import {
  ParakeetRecognitionSession,
  type ParakeetSessionPorts,
  parakeetFailure,
} from '../../../src/lib/stt/parakeet-session.ts';

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

const ENOUGH = 4_000;

class FakeRecording implements AudioRecording {
  monitor: CaptureMonitor | null = null;
  stops = 0;
  cancels = 0;
  samples: Float32Array = new Float32Array(ENOUGH);
  stopDeferred: Deferred<Float32Array> | null = null;
  /** A second of audio: enough new sound for a near-live pass. */
  peeked: Float32Array = new Float32Array(16_000);
  peeks = 0;

  peek(): Promise<Float32Array> {
    this.peeks += 1;
    return Promise.resolve(this.peeked);
  }

  stop(): Promise<Float32Array> {
    this.stops += 1;
    return this.stopDeferred === null ? Promise.resolve(this.samples) : this.stopDeferred.promise;
  }

  cancel(): void {
    this.cancels += 1;
  }
}

interface World {
  readonly session: ParakeetRecognitionSession;
  readonly recording: FakeRecording;
  readonly open: Deferred<AudioRecording>;
  readonly events: string[];
  readonly failures: BrowserRecognitionError[];
  readonly transcribed: { samples: Float32Array; signal: AbortSignal | undefined }[];
  readonly timers: { callback: () => void; milliseconds: number; cleared: boolean }[];
  readonly preloads: () => number;
  readonly unwatched: () => number;
  hide(): void;
  engine: {
    transcribe: (samples: Float32Array, signal?: AbortSignal) => Promise<string>;
    transcribeTimed: (samples: Float32Array, signal?: AbortSignal) => Promise<TimedTranscript>;
  };
  readonly live: NearLiveState[];
  readonly monitors: (CaptureMonitor | null)[];
  preloadThrows: boolean;
}

const world = (
  options: { maxDurationMs?: number; liveWords?: boolean; now?: () => number; loadMs?: number | undefined } = {},
): World => {
  const { now = () => 0, loadMs, ...sessionOptions } = options;
  const recording = new FakeRecording();
  const open = deferred<AudioRecording>();
  const events: string[] = [];
  const failures: BrowserRecognitionError[] = [];
  const transcribed: World['transcribed'] = [];
  const timers: World['timers'] = [];
  const live: NearLiveState[] = [];
  const monitors: (CaptureMonitor | null)[] = [];
  let preloads = 0;
  let unwatched = 0;
  let hidden: () => void = () => undefined;
  const w = {
    preloadThrows: false,
    engine: {
      transcribe: async (samples: Float32Array, signal?: AbortSignal): Promise<string> => {
        transcribed.push({ samples, signal });
        return 'hello world';
      },
      transcribeTimed: async (samples: Float32Array, signal?: AbortSignal): Promise<TimedTranscript> => {
        transcribed.push({ samples, signal });
        return { text: 'hello', words: [{ text: 'hello', start: 0, end: 0.1 }] };
      },
    },
  } as World;
  const capture: AudioCapturePort = { start: () => open.promise };
  const ports: ParakeetSessionPorts = {
    capture,
    engine: {
      preload: () => {
        preloads += 1;
        if (w.preloadThrows) throw new Error('worker blocked');
      },
      transcribe: (samples, signal) => w.engine.transcribe(samples, signal),
      transcribeTimed: (samples, signal) => w.engine.transcribeTimed(samples, signal),
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
    now,
  };
  const session = new ParakeetRecognitionSession(ports, {
    ...sessionOptions,
    onStart: () => events.push('start'),
    onTranscript: text => events.push(`transcript:${text}`),
    onFailure: failure => {
      failures.push(failure);
      events.push(`failure:${failure.code}`);
    },
    onAbort: () => events.push('abort'),
    onLimit: () => events.push('limit'),
    onLive: state => live.push(state),
    onMonitor: monitor => monitors.push(monitor),
  });
  return Object.assign(w, {
    session,
    live,
    monitors,
    recording,
    open,
    events,
    failures,
    transcribed,
    timers,
    preloads: () => preloads,
    unwatched: () => unwatched,
    hide: () => hidden(),
  });
};

/** Start the session and let the microphone open. */
const recordingWorld = async (options: Parameters<typeof world>[0] = {}): Promise<World> => {
  const w = world(options);
  w.session.start();
  w.open.resolve(w.recording);
  await tick();
  return w;
};

describe('parakeetFailure', () => {
  it('maps engine errors into the panel vocabulary', () => {
    should(parakeetFailure(new ParakeetEngineError('cancelled', 'c'))).have.property('code', 'aborted');
    should(parakeetFailure(new ParakeetEngineError('not-installed', 'n'))).have.property('code', 'model-not-installed');
    for (const code of ['integrity', 'load-failed', 'transcribe-failed', 'worker-failed'] as const)
      should(parakeetFailure(new ParakeetEngineError(code, 'x'))).have.property('code', 'recognition-failed');
  });

  it('keeps the engine message', () => {
    should(parakeetFailure(new ParakeetEngineError('integrity', 'tampered'))).have.property('message', 'tampered');
  });

  it('maps other errors through the browser mapping', () => {
    should(parakeetFailure({ name: 'NotAllowedError' })).have.property('code', 'permission-denied');
  });
});

describe('ParakeetRecognitionSession', () => {
  it('start opens the microphone, then reports start, arms the limit timer and preloads', async () => {
    const w = world({ maxDurationMs: 5_000 });
    w.session.start();
    should(w.events).eql([]);
    w.open.resolve(w.recording);
    await tick();
    should(w.events).eql(['start']);
    should(w.timers).have.length(1);
    should(w.timers[0]?.milliseconds).equal(5_000);
    should(w.preloads()).equal(1);
  });

  it('defaults the limit to two minutes and never arms a zero timer', async () => {
    const standard = await recordingWorld();
    should(standard.timers[0]?.milliseconds).equal(120_000);
    const zero = await recordingWorld({ maxDurationMs: 0 });
    should(zero.timers[0]?.milliseconds).equal(1);
  });

  it('swallows a preload that throws', async () => {
    const w = world();
    w.preloadThrows = true;
    w.session.start();
    w.open.resolve(w.recording);
    await tick();
    should(w.events).eql(['start']);
    should(w.failures).have.length(0);
  });

  it('finish stops the recording and resolves the engine text', async () => {
    const w = await recordingWorld();
    const text = await w.session.finish();
    should(text).equal('hello world');
    should(w.recording.stops).equal(1);
    should(w.transcribed).have.length(1);
    should(w.transcribed[0]?.samples).equal(w.recording.samples);
    should(w.timers[0]?.cleared).be.true();
    should(w.unwatched()).equal(1);
  });

  it('returns an empty string for a take too short to be speech, without transcribing', async () => {
    const w = await recordingWorld();
    w.recording.samples = new Float32Array(3_999);
    should(await w.session.finish()).equal('');
    should(w.transcribed).have.length(0);
  });

  it('transcribes a take of exactly a quarter of a second', async () => {
    const w = await recordingWorld();
    w.recording.samples = new Float32Array(4_000);
    should(await w.session.finish()).equal('hello world');
  });

  it('finish before the microphone has opened waits for it and still transcribes', async () => {
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

  it('finish without start resolves empty', async () => {
    const w = world();
    should(await w.session.finish()).equal('');
  });

  it('finish twice returns the same promise', async () => {
    const w = await recordingWorld();
    const first = w.session.finish();
    const second = w.session.finish();
    should(second).equal(first);
    await first;
    should(w.recording.stops).equal(1);
    should(w.session.finish()).equal(first);
  });

  it('a denied microphone fails through onFailure with permission-denied', async () => {
    const w = world();
    w.session.start();
    w.open.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' }));
    await tick();
    should(w.events).eql(['failure:permission-denied']);
    should(w.unwatched()).equal(1);
    await should(w.session.finish()).be.rejectedWith({ code: 'aborted' });
  });

  it('a capture failure while finishing rejects finish instead of calling onFailure', async () => {
    const w = world();
    w.session.start();
    const outcome = settle(w.session.finish());
    w.open.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' }));
    await tick();
    should(outcome.error).be.instanceOf(BrowserRecognitionError);
    should(outcome.error).have.property('code', 'permission-denied');
    should(w.failures).have.length(0);
    await should(w.session.finish()).be.rejectedWith({ code: 'permission-denied' });
  });

  it('an engine cancellation during finish aborts the take', async () => {
    const w = await recordingWorld();
    w.engine.transcribe = async () => {
      throw new ParakeetEngineError('cancelled', 'unloaded');
    };
    await should(w.session.finish()).be.rejectedWith({ code: 'aborted', message: 'unloaded' });
    await should(w.session.finish()).be.rejectedWith({ code: 'aborted' });
  });

  it('a model that is not installed maps to model-not-installed', async () => {
    const w = await recordingWorld();
    w.engine.transcribe = async () => {
      throw new ParakeetEngineError('not-installed', 'no model');
    };
    await should(w.session.finish()).be.rejectedWith({ code: 'model-not-installed' });
    await should(w.session.finish()).be.rejectedWith({ code: 'model-not-installed' });
  });

  it('other engine errors map to recognition-failed', async () => {
    const w = await recordingWorld();
    w.engine.transcribe = async () => {
      throw new ParakeetEngineError('transcribe-failed', 'decode broke');
    };
    await should(w.session.finish()).be.rejectedWith({ code: 'recognition-failed', message: 'decode broke' });
  });

  it('a non-engine error goes through the browser mapping', async () => {
    const w = await recordingWorld();
    w.recording.stop = () => Promise.reject(Object.assign(new Error('gone'), { name: 'NotFoundError' }));
    await should(w.session.finish()).be.rejectedWith({ code: 'no-microphone' });
  });

  it('cancel aborts the signal given to transcribe and cancels the recording', async () => {
    const w = await recordingWorld();
    const engineGate = deferred<string>();
    w.engine.transcribe = (samples, signal) => {
      w.transcribed.push({ samples, signal });
      return engineGate.promise;
    };
    const outcome = settle(w.session.finish());
    await tick();
    should(w.transcribed[0]?.signal?.aborted).be.false();
    w.session.cancel();
    should(w.transcribed[0]?.signal?.aborted).be.true();
    await tick();
    should(w.recording.cancels).equal(1);
    engineGate.resolve('late words');
    await tick();
    should(outcome.error).have.property('code', 'aborted');
  });

  it('cancel while finishing rejects finish as aborted even if the engine then fails', async () => {
    const w = await recordingWorld();
    const engineGate = deferred<string>();
    w.engine.transcribe = () => engineGate.promise;
    const outcome = settle(w.session.finish());
    await tick();
    w.session.cancel();
    engineGate.reject(new ParakeetEngineError('cancelled', 'Transcription was cancelled.'));
    await tick();
    should(outcome.error).have.property('code', 'aborted');
    should(w.unwatched()).equal(1);
  });

  it('cancel cancels a recording that opens after the cancel', async () => {
    const w = world();
    w.session.start();
    w.session.cancel();
    w.open.resolve(w.recording);
    await tick();
    should(w.recording.cancels).be.greaterThanOrEqual(1);
    should(w.events).eql([]);
    should(w.timers).have.length(0);
  });

  it('cancel before the microphone fails is quiet', async () => {
    const w = world();
    w.session.start();
    w.session.cancel();
    w.open.reject(new Error('nope'));
    await tick();
    should(w.events).eql([]);
  });

  it('cancel is idempotent, and does nothing after the take finished', async () => {
    const w = await recordingWorld();
    await w.session.finish();
    w.session.cancel();
    should(w.recording.cancels).equal(0);

    const other = await recordingWorld();
    other.session.cancel();
    other.session.cancel();
    await tick();
    should(other.recording.cancels).equal(1);
    should(other.timers[0]?.cleared).be.true();
  });

  it('cancel without start is harmless', () => {
    const w = world();
    w.session.cancel();
    should(w.recording.cancels).equal(0);
  });

  it('finish after cancel rejects aborted', async () => {
    const w = await recordingWorld();
    w.session.cancel();
    await should(w.session.finish()).be.rejectedWith({ code: 'aborted' });
    should(w.transcribed).have.length(0);
  });

  it('a hidden page while recording cancels and reports an abort', async () => {
    const w = await recordingWorld();
    w.hide();
    should(w.events).eql(['start', 'abort']);
    await tick();
    should(w.recording.cancels).equal(1);
    should(w.unwatched()).equal(1);
  });

  it('a hidden page while the microphone is opening cancels and reports an abort', () => {
    const w = world();
    w.session.start();
    w.hide();
    should(w.events).eql(['abort']);
  });

  it('a hidden page while finishing or after the end is ignored', async () => {
    const finishing = await recordingWorld();
    const gate = deferred<string>();
    finishing.engine.transcribe = () => gate.promise;
    const outcome = settle(finishing.session.finish());
    await tick();
    finishing.hide();
    should(finishing.events).eql(['start']);
    gate.resolve('words');
    await tick();
    should(outcome.value).equal('words');

    const ended = await recordingWorld();
    ended.session.cancel();
    ended.hide();
    should(ended.events).eql(['start']);
  });

  it('the limit timer reports onLimit only while recording', async () => {
    const w = await recordingWorld();
    w.timers[0]?.callback();
    should(w.events).eql(['start', 'limit']);

    const finishing = await recordingWorld();
    const gate = deferred<string>();
    finishing.engine.transcribe = () => gate.promise;
    const outcome = settle(finishing.session.finish());
    await tick();
    finishing.timers[0]?.callback();
    should(finishing.events).eql(['start']);
    gate.resolve('x');
    await tick();
    should(outcome.value).equal('x');
  });
});

describe('ParakeetRecognitionSession — the input meter', () => {
  const monitor: CaptureMonitor = { createAnalyser: () => null };

  it('hands over the open recording’s own level tap, once the microphone is open', async () => {
    const w = world();
    w.recording.monitor = monitor;
    w.session.start();
    should(w.monitors).eql([]);
    w.open.resolve(w.recording);
    await tick();
    should(w.monitors).eql([monitor]);
  });

  it('offers a null tap when the page has no Web Audio, and the take carries on', async () => {
    const w = await recordingWorld();
    should(w.monitors).eql([null]);
    should(await w.session.finish()).equal('hello world');
  });

  it('withdraws the tap the moment Stop is pressed', async () => {
    const w = world();
    w.recording.monitor = monitor;
    w.session.start();
    w.open.resolve(w.recording);
    await tick();
    const finishing = w.session.finish();
    should(w.monitors).eql([monitor, null]);
    await finishing;
  });

  it('withdraws the tap on cancel, and when the microphone is refused', async () => {
    const cancelled = world();
    cancelled.recording.monitor = monitor;
    cancelled.session.start();
    cancelled.open.resolve(cancelled.recording);
    await tick();
    cancelled.session.cancel();
    should(cancelled.monitors).eql([monitor, null]);

    const refused = world();
    refused.session.start();
    refused.open.reject({ name: 'NotAllowedError' });
    await tick();
    should(refused.monitors).eql([null]);
  });
});

describe('ParakeetRecognitionSession — near-live words', () => {
  it('without Live words, schedules no pass and never peeks', async () => {
    const w = await recordingWorld();
    should(w.timers).have.length(1);
    should(w.recording.peeks).equal(0);
  });

  it('with Live words, runs passes over the open recording and reports them', async () => {
    const w = await recordingWorld({ liveWords: true });
    // The duration limit, then the first pass.
    should(w.timers).have.length(2);
    w.timers[1]?.callback();
    await tick();
    should(w.recording.peeks).equal(1);
    should(w.live).eql([{ committed: '', interim: 'hello', paused: false }]);
    should(w.transcribed[0]?.signal?.aborted).be.false();
  });

  it('Stop transcribes only the uncommitted tail and joins it to the committed words', async () => {
    const w = await recordingWorld({ liveWords: true });
    // Two agreeing passes commit "hello" at the pause the silent take ends in (2 s), cut a pre-roll
    // before its end.
    w.timers[1]?.callback();
    await tick();
    w.recording.peeked = new Float32Array(32_000);
    w.timers[2]?.callback();
    await tick();
    should(w.live.at(-1)).eql({ committed: 'hello', interim: '', paused: false });
    w.recording.samples = new Float32Array(48_000);
    w.engine.transcribeTimed = async (samples, signal) => {
      w.transcribed.push({ samples, signal });
      return { text: 'world', words: [{ text: 'world', start: 0.2, end: 0.5 }] };
    };
    should(await w.session.finish()).equal('hello world');
    const final = w.transcribed.at(-1);
    should(final?.samples.length).equal(48_000 - (32_000 - 2_880));
  });

  it('cancel stops the passes, and nothing is reported once Stop is pressed', async () => {
    const cancelled = await recordingWorld({ liveWords: true });
    cancelled.session.cancel();
    should(cancelled.timers[1]?.cleared).be.true();

    const stopped = await recordingWorld({ liveWords: true });
    const gate = deferred<TimedTranscript>();
    stopped.engine.transcribeTimed = () => gate.promise;
    stopped.timers[1]?.callback();
    await tick();
    const outcome = settle(stopped.session.finish());
    gate.resolve({ text: 'late', words: [{ text: 'late', start: 0, end: 0.1 }] });
    await tick();
    should(stopped.live).eql([]);
    should(outcome.value).equal('hello world');
  });
});

describe('ParakeetRecognitionSession timings', () => {
  /** A clock that reads `script[0]`, then `script[1]`, and so on. */
  const scripted = (...script: number[]) => {
    let read = 0;
    return () => script[Math.min(read++, script.length - 1)] ?? 0;
  };

  it('times the recorder stop and the transcription, and sizes the take before it is transferred away', async () => {
    // Arrange: stop begins at 100 and ends at 130; transcription begins at 130 and ends at 1130
    const w = await recordingWorld({ now: scripted(100, 130, 130, 1130), loadMs: 2_500 });
    w.recording.samples = new Float32Array(32_000);
    w.engine.transcribe = async samples => {
      w.transcribed.push({ samples, signal: undefined });
      samples.fill(0);
      return 'hello world';
    };

    // Act
    await w.session.finish();

    // Assert
    should(w.session.timings()).eql({
      audioMs: 2_000,
      audioBytes: 128_000,
      prepareMs: 30,
      transcribeMs: 1_000,
      model: PARAKEET_VERSION_LABEL,
      loadMs: 2_500,
    });
  });

  it('says nothing about a model load that this dictation did not pay for', async () => {
    const w = await recordingWorld({ now: scripted(0, 1, 1, 2) });
    await w.session.finish();
    should(w.session.timings()).not.have.property('loadMs');
  });

  it('still reports the time of a transcription that failed', async () => {
    const w = await recordingWorld({ now: scripted(0, 5, 5, 45) });
    w.engine.transcribe = async () => {
      throw new ParakeetEngineError('worker-failed', 'down');
    };
    await w.session.finish().catch(() => undefined);
    should(w.session.timings()?.transcribeMs).equal(40);
  });

  it('reports no transcription time for a take too short to be speech', async () => {
    const w = await recordingWorld({ now: scripted(0, 5, 5, 6) });
    w.recording.samples = new Float32Array(100);
    await w.session.finish();
    should(w.session.timings()?.transcribeMs).equal(0);
  });

  it('has no timings before it has finished', async () => {
    const w = await recordingWorld();
    should(w.session.timings()).be.undefined();
  });
});

describe('ParakeetRecognitionSession — another whole-take engine', () => {
  const ports = (failure: (error: unknown) => BrowserRecognitionError, open: Promise<AudioRecording>) => ({
    capture: { start: () => open } as AudioCapturePort,
    engine: { preload: () => undefined, transcribe: async () => 'Good morning.' },
    model: 'Moonshine tiny en int8 · test',
    failure,
    watchHidden: () => () => undefined,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    now: () => 0,
  });
  const options = (failures: BrowserRecognitionError[]) => ({
    liveWords: true,
    onStart: () => undefined,
    onTranscript: () => undefined,
    onFailure: (failure: BrowserRecognitionError) => failures.push(failure),
    onAbort: () => undefined,
    onLimit: () => undefined,
  });

  it('never runs near-live passes without timed words, and names its own model in the timings', async () => {
    const recording = new FakeRecording();
    const session = new ParakeetRecognitionSession(
      ports(() => new BrowserRecognitionError('recognition-failed', 'x'), Promise.resolve(recording)),
      options([]),
    );
    session.start();
    await tick();
    should(recording.peeks).equal(0);
    should(await session.finish()).equal('Good morning.');
    should(session.timings()?.model).equal('Moonshine tiny en int8 · test');
  });

  it('reads its failures through its own mapper', async () => {
    const failures: BrowserRecognitionError[] = [];
    const session = new ParakeetRecognitionSession(
      ports(
        () => new BrowserRecognitionError('model-not-installed', 'Install Moonshine.'),
        Promise.reject(new Error('no')),
      ),
      options(failures),
    );
    session.start();
    await tick();
    should(failures.map(failure => failure.message)).eql(['Install Moonshine.']);
  });
});
