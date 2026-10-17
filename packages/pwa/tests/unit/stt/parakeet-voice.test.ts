/**
 * Proves the Parakeet voice service: its install snapshot (check, install with throttled progress,
 * cancel, remove, failures), the sessions it will and will not hand out, the support reading with
 * each refusal reason, and the production wiring over a fake page (worker URL and options, the
 * hidden-page watch, and the timer passthroughs).
 */

import { describe, it } from 'bun:test';
import should from 'should';
import {
  BrowserRecognitionError,
  type BrowserRecognitionSessionOptions,
} from '../../../src/lib/stt/browser-recognition.ts';
import { formatMegabytes, PARAKEET_TOTAL_BYTES } from '../../../src/lib/stt/parakeet-model.ts';
import { ParakeetRecognitionSession } from '../../../src/lib/stt/parakeet-session.ts';
import {
  ParakeetInstallError,
  type ParakeetInstallProgress,
  type ParakeetStoreStatus,
} from '../../../src/lib/stt/parakeet-store.ts';
import {
  browserParakeetVoice,
  type ParakeetGlobalLike,
  type ParakeetInstallSnapshot,
  ParakeetVoice,
  type ParakeetVoiceOptions,
  readParakeetSupport,
} from '../../../src/lib/stt/parakeet-voice.ts';

const TOTAL = 1_000_000;

interface InstallCall {
  readonly signal: AbortSignal | undefined;
  readonly onProgress: ((progress: ParakeetInstallProgress) => void) | undefined;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

class FakeStore {
  readonly totalBytes = TOTAL;
  status$: () => Promise<ParakeetStoreStatus> = () => Promise.resolve({ state: 'absent' });
  statusCalls = 0;
  removeCalls = 0;
  removeImpl: () => Promise<void> = () => Promise.resolve();
  readonly installs: InstallCall[] = [];

  status(): Promise<ParakeetStoreStatus> {
    this.statusCalls += 1;
    return this.status$();
  }

  install(options: { signal?: AbortSignal; onProgress?(progress: ParakeetInstallProgress): void } = {}): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.installs.push({ signal: options.signal, onProgress: options.onProgress, resolve, reject });
    });
  }

  remove(): Promise<void> {
    this.removeCalls += 1;
    return this.removeImpl();
  }
}

class FakeEngine {
  preloads = 0;
  unloads = 0;
  preload(): void {
    this.preloads += 1;
  }
  transcribe(): Promise<string> {
    return Promise.resolve('');
  }
  transcribeTimed(): Promise<{ text: string; words: [] }> {
    return Promise.resolve({ text: '', words: [] });
  }
  unload(): void {
    this.unloads += 1;
  }
}

const fakeHost = () => ({
  capture: { start: () => Promise.reject(new Error('no microphone')) },
  watchHidden: () => () => undefined,
  setTimeout: () => 0,
  clearTimeout: () => undefined,
  now: () => 0,
});

const AVAILABLE = { available: true } as const;

const build = (overrides: Partial<ParakeetVoiceOptions> = {}) => {
  const store = new FakeStore();
  const engine = new FakeEngine();
  const voice = new ParakeetVoice({
    support: AVAILABLE,
    store,
    engine,
    host: fakeHost(),
    ...overrides,
  });
  return { voice, store, engine };
};

const sessionOptions = (): BrowserRecognitionSessionOptions => ({
  onStart: () => undefined,
  onTranscript: () => undefined,
  onFailure: () => undefined,
  onAbort: () => undefined,
  onLimit: () => undefined,
});

const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
};

const refusal = (action: () => unknown): BrowserRecognitionError => {
  try {
    action();
  } catch (error) {
    if (error instanceof BrowserRecognitionError) return error;
    throw error;
  }
  throw new Error('expected a BrowserRecognitionError');
};

const INSTALLED: ParakeetStoreStatus = {
  state: 'installed',
  version: 'v3-int8',
  bytes: TOTAL,
  installedAt: '2026-10-16T00:00:00.000Z',
};

describe('ParakeetVoice snapshot and subscription', () => {
  it('starts checking when supported', () => {
    const { voice } = build();
    should(voice.getSnapshot()).eql({ phase: 'checking', totalBytes: TOTAL, downloadedBytes: 0 });
    should(voice.support).eql(AVAILABLE);
  });

  it('starts unsupported with the reason, and falls back to the default sentence and total', () => {
    const named = build({ support: { available: false, reason: 'No WebAssembly.' }, store: null }).voice;
    should(named.getSnapshot()).eql({
      phase: 'unsupported',
      totalBytes: PARAKEET_TOTAL_BYTES,
      downloadedBytes: 0,
      reason: 'No WebAssembly.',
    });
    const unnamed = build({ support: { available: false }, store: null }).voice;
    should(unnamed.getSnapshot().reason).equal('This browser cannot run Parakeet.');
  });

  it('notifies subscribers and stops after unsubscribe', async () => {
    const { voice, store } = build();
    let heard = 0;
    const unsubscribe = voice.subscribe(() => {
      heard += 1;
    });
    const running = voice.install();
    should(heard).equal(1);
    unsubscribe();
    store.installs[0]?.reject(new ParakeetInstallError('cancelled', 'stopped'));
    await running;
    should(heard).equal(1);
  });
});

describe('ParakeetVoice.refresh', () => {
  it('reads installed, partial and absent', async () => {
    const { voice, store } = build();
    store.status$ = () => Promise.resolve(INSTALLED);
    await voice.refresh();
    should(voice.getSnapshot()).eql({
      phase: 'installed',
      totalBytes: TOTAL,
      downloadedBytes: TOTAL,
      version: 'v3-int8',
      installedAt: '2026-10-16T00:00:00.000Z',
    });
    store.status$ = () => Promise.resolve({ state: 'partial', downloadedBytes: 250_000 });
    await voice.refresh();
    should(voice.getSnapshot()).eql({ phase: 'partial', totalBytes: TOTAL, downloadedBytes: 250_000 });
    store.status$ = () => Promise.resolve({ state: 'absent' });
    await voice.refresh();
    should(voice.getSnapshot()).eql({ phase: 'absent', totalBytes: TOTAL, downloadedBytes: 0 });
  });

  it('reads a store that cannot answer as absent', async () => {
    const { voice, store } = build();
    store.status$ = () => Promise.reject(new Error('storage gone'));
    await voice.refresh();
    should(voice.getSnapshot().phase).equal('absent');
  });

  it('does nothing without a store', async () => {
    const { voice } = build({ support: { available: false }, store: null, engine: null, host: null });
    await voice.refresh();
    should(voice.getSnapshot().phase).equal('unsupported');
  });

  it('leaves a download in progress alone', async () => {
    const { voice, store } = build();
    const running = voice.install();
    await voice.refresh();
    should(store.statusCalls).equal(0);
    store.installs[0]?.reject(new ParakeetInstallError('cancelled', 'stopped'));
    await running;
  });

  it('drops a stale answer when an install begins while it was reading', async () => {
    const { voice, store } = build();
    let answer: (status: ParakeetStoreStatus) => void = () => undefined;
    store.status$ = () => new Promise<ParakeetStoreStatus>(resolve => (answer = resolve));
    const reading = voice.refresh();
    const running = voice.install();
    answer(INSTALLED);
    await reading;
    should(voice.getSnapshot().phase).equal('installing');
    store.status$ = () => Promise.resolve({ state: 'absent' });
    store.installs[0]?.reject(new ParakeetInstallError('cancelled', 'stopped'));
    await running;
  });
});

describe('ParakeetVoice.install', () => {
  it('publishes installing, throttles progress, and refreshes to installed on success', async () => {
    const { voice, store } = build();
    const phases: ParakeetInstallSnapshot[] = [];
    voice.subscribe(() => phases.push(voice.getSnapshot()));
    const running = voice.install();
    should(voice.getSnapshot()).eql({ phase: 'installing', totalBytes: TOTAL, downloadedBytes: 0 });
    const progress = store.installs[0]?.onProgress;
    should(progress).be.a.Function();
    progress?.({ label: 'Encoder', downloadedBytes: 0, totalBytes: TOTAL });
    should(voice.getSnapshot().label).equal('Encoder');
    const published = phases.length;
    progress?.({ label: 'Encoder', downloadedBytes: 500, totalBytes: TOTAL });
    should(phases.length).equal(published);
    progress?.({ label: 'Encoder', downloadedBytes: 5_000, totalBytes: TOTAL });
    should(phases.length).equal(published + 1);
    should(voice.getSnapshot().downloadedBytes).equal(5_000);
    progress?.({ label: 'Decoder', downloadedBytes: 5_001, totalBytes: TOTAL });
    should(voice.getSnapshot().label).equal('Decoder');
    should(phases.length).equal(published + 2);

    store.status$ = () => Promise.resolve(INSTALLED);
    store.installs[0]?.resolve();
    await running;
    should(voice.getSnapshot().phase).equal('installed');
    should(voice.getSnapshot().error).be.undefined();
  });

  it('returns the same promise while one install runs', async () => {
    const { voice, store } = build();
    const first = voice.install();
    const second = voice.install();
    should(second).equal(first);
    should(store.installs.length).equal(1);
    store.installs[0]?.reject(new ParakeetInstallError('cancelled', 'stopped'));
    await first;
  });

  it('keeps the error code and message of a failed install', async () => {
    const { voice, store } = build();
    const running = voice.install();
    store.installs[0]?.reject(new ParakeetInstallError('quota', 'Not enough room.'));
    await running;
    should(voice.getSnapshot().phase).equal('absent');
    should(voice.getSnapshot().error).eql({ code: 'quota', message: 'Not enough room.' });
  });

  it('keeps an unknown code for a foreign error, with a fallback message for a non-Error', async () => {
    const { voice, store } = build();
    const foreign = voice.install();
    store.installs[0]?.reject(new Error('socket hang up'));
    await foreign;
    should(voice.getSnapshot().error).eql({ code: 'unknown', message: 'socket hang up' });
    const bare = voice.install();
    store.installs[1]?.reject('boom');
    await bare;
    should(voice.getSnapshot().error).eql({ code: 'unknown', message: 'Parakeet could not be installed.' });
  });

  it('records no error for a cancellation', async () => {
    const { voice, store } = build();
    const running = voice.install();
    store.installs[0]?.reject(new ParakeetInstallError('cancelled', 'Stopped.'));
    await running;
    should(voice.getSnapshot().phase).equal('absent');
    should(voice.getSnapshot().error).be.undefined();
  });

  it('drops the error once a later refresh finds it installed', async () => {
    const { voice, store } = build();
    const running = voice.install();
    store.installs[0]?.reject(new ParakeetInstallError('network', 'Offline.'));
    await running;
    should(voice.getSnapshot().error?.code).equal('network');
    store.status$ = () => Promise.resolve(INSTALLED);
    await voice.refresh();
    should(voice.getSnapshot().phase).equal('installed');
    should(voice.getSnapshot().error).be.undefined();
  });

  it('is a no-op without a store', async () => {
    const { voice } = build({ support: { available: false }, store: null, engine: null, host: null });
    await voice.install();
    should(voice.getSnapshot().phase).equal('unsupported');
  });
});

describe('ParakeetVoice.cancel', () => {
  it('aborts the signal handed to the store', async () => {
    const { voice, store } = build();
    const running = voice.install();
    const signal = store.installs[0]?.signal;
    should(signal?.aborted).equal(false);
    voice.cancel();
    should(signal?.aborted).equal(true);
    store.installs[0]?.reject(new ParakeetInstallError('cancelled', 'Stopped.'));
    await running;
  });

  it('does nothing when nothing is downloading', () => {
    const { voice } = build();
    voice.cancel();
    should(voice.getSnapshot().phase).equal('checking');
  });
});

describe('ParakeetVoice.remove', () => {
  it('cancels, waits, unloads, removes and ends absent', async () => {
    const { voice, store, engine } = build();
    const phases: string[] = [];
    voice.subscribe(() => phases.push(voice.getSnapshot().phase));
    const running = voice.install();
    const removing = voice.remove();
    should(store.installs[0]?.signal?.aborted).equal(true);
    should(engine.unloads).equal(0);
    store.installs[0]?.reject(new ParakeetInstallError('cancelled', 'Stopped.'));
    await running;
    await removing;
    should(engine.unloads).equal(1);
    should(store.removeCalls).equal(1);
    should(phases).containEql('removing');
    should(voice.getSnapshot().phase).equal('absent');
    should(voice.getSnapshot().downloadedBytes).equal(0);
  });

  it('swallows a store that refuses to remove', async () => {
    const { voice, store } = build();
    store.removeImpl = () => Promise.reject(new Error('locked'));
    await voice.remove();
    should(voice.getSnapshot().phase).equal('absent');
  });

  it('is a no-op without a store', async () => {
    const { voice, engine } = build({ support: { available: false }, store: null, engine: null, host: null });
    await voice.remove();
    should(engine.unloads).equal(0);
    should(voice.getSnapshot().phase).equal('unsupported');
  });

  it('copes with no engine', async () => {
    const { voice, store } = build({ engine: null });
    await voice.remove();
    should(store.removeCalls).equal(1);
  });
});

describe('ParakeetVoice.createSession', () => {
  it('refuses as unavailable when unsupported, with no engine, or with no host', () => {
    const unsupported = build({
      support: { available: false, reason: 'Nope.' },
      store: null,
      engine: null,
      host: null,
    }).voice;
    const refused = refusal(() => unsupported.createSession(sessionOptions()));
    should(refused.code).equal('recognition-unavailable');
    should(refused.message).equal('Nope.');
    const noEngine = refusal(() => build({ engine: null }).voice.createSession(sessionOptions()));
    should(noEngine.code).equal('recognition-unavailable');
    should(noEngine.message).equal('This browser cannot run Parakeet.');
    const noHost = refusal(() => build({ host: null }).voice.createSession(sessionOptions()));
    should(noHost.code).equal('recognition-unavailable');
  });

  it('names the progress while it is still downloading', () => {
    const { voice } = build();
    void voice.install();
    const refused = refusal(() => voice.createSession(sessionOptions()));
    should(refused.code).equal('model-not-installed');
    should(refused.message).containEql(`(${formatMegabytes(0)} of ${formatMegabytes(TOTAL)})`);
  });

  it('refuses while absent, partial or removing', async () => {
    const { voice, store } = build();
    await voice.refresh();
    should(refusal(() => voice.createSession(sessionOptions())).code).equal('model-not-installed');
    store.status$ = () => Promise.resolve({ state: 'partial', downloadedBytes: 10 });
    await voice.refresh();
    should(voice.getSnapshot().phase).equal('partial');
    should(refusal(() => voice.createSession(sessionOptions())).message).containEql('not installed on this device');
    let release: () => void = () => undefined;
    store.removeImpl = () => new Promise<void>(resolve => (release = resolve));
    const removing = voice.remove();
    await flush();
    should(voice.getSnapshot().phase).equal('removing');
    should(refusal(() => voice.createSession(sessionOptions())).code).equal('model-not-installed');
    release();
    await removing;
  });

  it('returns a session when installed, and while still checking', async () => {
    const { voice, store } = build();
    should(voice.createSession(sessionOptions())).be.instanceOf(ParakeetRecognitionSession);
    store.status$ = () => Promise.resolve(INSTALLED);
    await voice.refresh();
    should(voice.createSession(sessionOptions())).be.instanceOf(ParakeetRecognitionSession);
  });
});

describe('readParakeetSupport', () => {
  const ASSETS = { workerUrl: '/assets/parakeet-worker-abc123.js', runtimeUrl: '/assets/ort.wasm' };
  const supported = (): ParakeetGlobalLike => ({
    isSecureContext: true,
    WebAssembly: {},
    Worker: class {} as unknown as ParakeetGlobalLike['Worker'],
    caches: { open: () => Promise.reject(new Error('unused')), delete: () => Promise.resolve(false) },
    navigator: { mediaDevices: { getUserMedia: () => Promise.reject(new Error('unused')) } },
    MediaRecorder: class {} as unknown as ParakeetGlobalLike['MediaRecorder'],
    OfflineAudioContext: class {} as unknown as ParakeetGlobalLike['OfflineAudioContext'],
    setTimeout: () => 0,
    clearTimeout: () => undefined,
  });

  it('is available when everything is present', () => {
    should(readParakeetSupport(supported(), ASSETS)).eql({ available: true });
  });

  it('says why the build lacks the engine', () => {
    should(readParakeetSupport(supported(), null).reason).containEql('built without the on-device speech engine');
  });

  it('says why an insecure page cannot', () => {
    should(readParakeetSupport({ ...supported(), isSecureContext: false }, ASSETS).reason).containEql(
      'secure HTTPS page',
    );
  });

  it('says why a browser with no WebAssembly or no Worker cannot', () => {
    should(readParakeetSupport({ ...supported(), WebAssembly: undefined }, ASSETS).reason).containEql(
      'WebAssembly in a worker',
    );
    should(readParakeetSupport({ ...supported(), Worker: undefined }, ASSETS).reason).containEql(
      'WebAssembly in a worker',
    );
  });

  it('says why a browser with no Cache Storage cannot', () => {
    should(readParakeetSupport({ ...supported(), caches: undefined }, ASSETS).reason).containEql('Cache Storage');
  });

  it('says why a browser that cannot record cannot', () => {
    should(readParakeetSupport({ ...supported(), MediaRecorder: undefined }, ASSETS).reason).containEql('record audio');
  });
});

describe('browserParakeetVoice', () => {
  const ASSETS = { workerUrl: '/assets/parakeet-worker-abc123.js', runtimeUrl: '/assets/ort.wasm' };

  class FakeWorker {
    static readonly made: { url: string; options: { type: 'module'; name: string }; worker: FakeWorker }[] = [];
    readonly posted: unknown[] = [];
    terminated = false;
    constructor(url: string, options: { type: 'module'; name: string }) {
      FakeWorker.made.push({ url, options, worker: this });
    }
    postMessage(message: unknown): void {
      this.posted.push(message);
    }
    addEventListener(): void {}
    terminate(): void {
      this.terminated = true;
    }
  }

  class FakeRecorder {
    readonly mimeType = 'audio/webm';
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    start(): void {}
    stop(): void {
      this.onstop?.();
    }
    requestData(): void {
      this.ondataavailable?.({ data: new Blob([]) });
    }
  }

  interface PageDouble {
    readonly global: ParakeetGlobalLike;
    readonly listeners: Set<() => void>;
    readonly timers: { set: number; cleared: unknown[] };
    visibility: { state: string };
  }

  const page = (overrides: Partial<ParakeetGlobalLike> = {}, withDocument = true): PageDouble => {
    const listeners = new Set<() => void>();
    const timers = { set: 0, cleared: [] as unknown[] };
    const visibility = { state: 'visible' };
    const global: ParakeetGlobalLike = {
      isSecureContext: true,
      WebAssembly: {},
      Worker: FakeWorker as unknown as ParakeetGlobalLike['Worker'],
      caches: { open: () => Promise.reject(new Error('no cache')), delete: () => Promise.resolve(false) },
      navigator: {
        mediaDevices: { getUserMedia: () => Promise.resolve({ getTracks: () => [] }) },
        storage: { estimate: () => Promise.resolve({}) },
      },
      MediaRecorder: FakeRecorder as unknown as ParakeetGlobalLike['MediaRecorder'],
      OfflineAudioContext: class {} as unknown as ParakeetGlobalLike['OfflineAudioContext'],
      ...(withDocument
        ? {
            document: {
              get visibilityState() {
                return visibility.state;
              },
              addEventListener: (_type: 'visibilitychange', listener: () => void) => {
                listeners.add(listener);
              },
              removeEventListener: (_type: 'visibilitychange', listener: () => void) => {
                listeners.delete(listener);
              },
            },
          }
        : {}),
      setTimeout: () => {
        timers.set += 1;
        return timers.set;
      },
      clearTimeout: handle => {
        timers.cleared.push(handle);
      },
      ...overrides,
    };
    return { global, listeners, timers, visibility };
  };

  it('is unsupported when the page cannot run it', () => {
    const voice = browserParakeetVoice(page({ isSecureContext: false }).global, ASSETS);
    should(voice.getSnapshot().phase).equal('unsupported');
    should(voice.getSnapshot().reason).containEql('secure HTTPS page');
    should(browserParakeetVoice(page().global, null).getSnapshot().phase).equal('unsupported');
  });

  it('checks the store when supported and reads it as absent with no cache to open', async () => {
    const voice = browserParakeetVoice(page().global, ASSETS);
    should(voice.getSnapshot().phase).equal('checking');
    await voice.refresh();
    should(voice.getSnapshot().phase).equal('absent');
    should(refusal(() => voice.createSession(sessionOptions())).code).equal('model-not-installed');
  });

  it('starts the speech worker through Trusted Types with the module options, once a take is open', async () => {
    FakeWorker.made.length = 0;
    const double = page();
    const voice = browserParakeetVoice(double.global, ASSETS);
    const session = voice.createSession(sessionOptions());
    should(FakeWorker.made.length).equal(0);
    session.start();
    await flush();
    should(FakeWorker.made.length).equal(1);
    should(FakeWorker.made[0]?.url).equal('/assets/parakeet-worker-abc123.js');
    should(FakeWorker.made[0]?.options).eql({ type: 'module', name: 'fy-parakeet' });
    should(FakeWorker.made[0]?.worker.posted).eql([{ type: 'load' }]);
    should(await session.finish()).equal('');
  });

  it('passes the timers through to the page', async () => {
    const double = page();
    const session = browserParakeetVoice(double.global, ASSETS).createSession(sessionOptions());
    session.start();
    await flush();
    should(double.timers.set).equal(1);
    await session.finish();
    should(double.timers.cleared).eql([1]);
  });

  it('cancels a take when the page is hidden, and ignores a visibility change that is not hiding', async () => {
    const double = page();
    let aborted = 0;
    const session = browserParakeetVoice(double.global, ASSETS).createSession({
      ...sessionOptions(),
      onAbort: () => {
        aborted += 1;
      },
    });
    session.start();
    await flush();
    should(double.listeners.size).equal(1);
    for (const listener of [...double.listeners]) listener();
    should(aborted).equal(0);
    double.visibility.state = 'hidden';
    for (const listener of [...double.listeners]) listener();
    should(aborted).equal(1);
    should(double.listeners.size).equal(0);
  });

  it('stops watching the page once the take finishes', async () => {
    const double = page();
    const session = browserParakeetVoice(double.global, ASSETS).createSession(sessionOptions());
    session.start();
    await flush();
    should(double.listeners.size).equal(1);
    await session.finish();
    should(double.listeners.size).equal(0);
  });

  it('paces near-live words on the page clock, falling back to the wall clock', async () => {
    for (const performance of [{ now: () => 42 }, undefined]) {
      const callbacks: (() => void)[] = [];
      let read = 0;
      const double = page({
        ...(performance === undefined
          ? {}
          : {
              performance: {
                now: () => {
                  read += 1;
                  return performance.now();
                },
              },
            }),
        setTimeout: callback => callbacks.push(callback),
      });
      const session = browserParakeetVoice(double.global, ASSETS).createSession({
        ...sessionOptions(),
        liveWords: true,
      });
      session.start();
      await flush();
      // The duration limit, then the first near-live pass.
      should(callbacks).have.length(2);
      callbacks[1]?.();
      await flush();
      should(read).equal(performance === undefined ? 0 : 1);
      session.cancel();
    }
  });

  it('watches nothing when the page has no document', async () => {
    const double = page({}, false);
    const session = browserParakeetVoice(double.global, ASSETS).createSession(sessionOptions());
    session.start();
    await flush();
    should(await session.finish()).equal('');
  });
});
