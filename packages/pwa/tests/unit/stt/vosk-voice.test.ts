/**
 * Proves Vosk's voice: it is the catalog's Vosk entry with the generic install, it reads whether this
 * page can run Vosk with each refusal reason, it opens a streaming session only over an installed
 * model, and its production wiring over a fake page starts the worker through Trusted Types with the
 * module options, only once a take is open, never downloading anything on the way.
 */

import { describe, it } from 'bun:test';
import should from 'should';
import type { BrowserRecognitionSessionOptions } from '../../../src/lib/stt/browser-recognition.ts';
import { modelDownloadBytes, VOSK_CATALOG_MODEL } from '../../../src/lib/stt/model-catalog.ts';
import type { ModelInstaller, ModelStoreStatus } from '../../../src/lib/stt/model-store.ts';
import { VoskRecognitionSession } from '../../../src/lib/stt/vosk-session.ts';
import { browserVoskVoice, readVoskSupport, type VoskGlobalLike, VoskVoice } from '../../../src/lib/stt/vosk-voice.ts';

const ASSETS = { workerUrl: '/assets/vosk-worker-abc123.js', runtimeUrl: '/assets/vosk-abc123.wasm' };

const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
};

const sessionOptions = (
  overrides: Partial<BrowserRecognitionSessionOptions> = {},
): BrowserRecognitionSessionOptions => ({
  onStart: () => undefined,
  onTranscript: () => undefined,
  onFailure: () => undefined,
  onAbort: () => undefined,
  onLimit: () => undefined,
  ...overrides,
});

class InstalledStore implements ModelInstaller {
  readonly totalBytes = 44_000_000;
  status(): Promise<ModelStoreStatus> {
    return Promise.resolve({
      state: 'installed',
      version: 'Vosk',
      bytes: 44_000_000,
      installedAt: '2026-10-22T00:00:00.000Z',
    });
  }
  install(): Promise<void> {
    return Promise.resolve();
  }
  remove(): Promise<void> {
    return Promise.resolve();
  }
}

describe('VoskVoice', () => {
  it('is the catalog’s Vosk entry, unsupported without a store, engine or page', () => {
    const voice = new VoskVoice({ support: { available: false }, store: null, engine: null, host: null });
    should(voice.model).equal(VOSK_CATALOG_MODEL);
    should(voice.getSnapshot()).eql({
      phase: 'unsupported',
      totalBytes: modelDownloadBytes(VOSK_CATALOG_MODEL),
      downloadedBytes: 0,
      reason: 'This browser cannot run Vosk.',
    });
    voice.unload();
  });

  it('opens a streaming session over an installed model, and unloads its engine', async () => {
    let unloads = 0;
    const voice = new VoskVoice({
      support: { available: true },
      store: new InstalledStore(),
      engine: {
        preload: () => undefined,
        open: () => ({ feed: () => undefined, finish: async () => '', cancel: () => undefined }),
        unload: () => {
          unloads += 1;
        },
      },
      host: {
        capture: { start: () => Promise.reject(new Error('no microphone')) },
        watchHidden: () => () => undefined,
        setTimeout: () => 0,
        clearTimeout: () => undefined,
        now: () => 0,
      },
    });
    await voice.refresh();
    should(voice.createSession(sessionOptions())).be.instanceOf(VoskRecognitionSession);
    voice.unload();
    should(unloads).equal(1);
  });
});

class FakeWorker {
  static readonly made: { url: string; options: WorkerOptions; worker: FakeWorker }[] = [];
  readonly posted: unknown[] = [];
  constructor(url: string, options: WorkerOptions) {
    FakeWorker.made.push({ url, options, worker: this });
  }
  postMessage(message: unknown): void {
    this.posted.push(message);
  }
  addEventListener(): void {}
  terminate(): void {}
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
  readonly global: VoskGlobalLike;
  readonly listeners: Set<() => void>;
  readonly timers: { callback: () => void; milliseconds: number }[];
  readonly cleared: unknown[];
  readonly visibility: { state: string };
}

const page = (overrides: Partial<VoskGlobalLike> = {}, withDocument = true): PageDouble => {
  const listeners = new Set<() => void>();
  const timers: PageDouble['timers'] = [];
  const cleared: unknown[] = [];
  const visibility = { state: 'visible' };
  const global: VoskGlobalLike = {
    isSecureContext: true,
    WebAssembly: {},
    Worker: FakeWorker as unknown as VoskGlobalLike['Worker'],
    caches: { open: () => Promise.reject(new Error('no cache')), delete: () => Promise.resolve(false) },
    navigator: {
      mediaDevices: { getUserMedia: () => Promise.resolve({ getTracks: () => [] }) },
      storage: { estimate: () => Promise.resolve({}) },
    },
    MediaRecorder: FakeRecorder as unknown as VoskGlobalLike['MediaRecorder'],
    OfflineAudioContext: class {} as unknown as VoskGlobalLike['OfflineAudioContext'],
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
    setTimeout: (callback, milliseconds) => {
      timers.push({ callback, milliseconds });
      return timers.length;
    },
    clearTimeout: handle => {
      cleared.push(handle);
    },
    ...overrides,
  };
  return { global, listeners, timers, cleared, visibility };
};

describe('readVoskSupport', () => {
  it('runs on a secure page with WebAssembly in a worker, Cache Storage and a microphone', () => {
    should(readVoskSupport(page().global, ASSETS)).eql({ available: true });
  });

  it('says why it cannot', () => {
    const reason = (global: VoskGlobalLike, assets: typeof ASSETS | null = ASSETS) =>
      readVoskSupport(global, assets).reason;
    should(reason(page().global, null)).equal('This copy of Ferretry was built without the Vosk speech engine.');
    should(reason(page({ isSecureContext: false }).global)).equal('Vosk needs a secure HTTPS page in this browser.');
    should(reason(page({ WebAssembly: undefined }).global)).equal(
      'This browser cannot run WebAssembly in a worker, which Vosk needs.',
    );
    should(reason(page({ Worker: undefined }).global)).equal(
      'This browser cannot run WebAssembly in a worker, which Vosk needs.',
    );
    should(reason(page({ caches: undefined }).global)).equal(
      'This browser will not keep the speech model on this device (no Cache Storage).',
    );
    should(reason(page({ MediaRecorder: undefined }).global)).equal(
      'This browser cannot record audio for on-device dictation.',
    );
  });
});

describe('browserVoskVoice', () => {
  it('is unsupported when the page cannot run it, or the build has no Vosk', () => {
    should(browserVoskVoice(page({ isSecureContext: false }).global, ASSETS).getSnapshot().phase).equal('unsupported');
    should(browserVoskVoice(page().global, null).getSnapshot().reason).equal(
      'This copy of Ferretry was built without the Vosk speech engine.',
    );
  });

  it('checks its pinned bundle when supported, reading it as absent with no cache to open', async () => {
    const voice = browserVoskVoice(page().global, ASSETS);
    should(voice.getSnapshot()).eql({
      phase: 'checking',
      totalBytes: modelDownloadBytes(VOSK_CATALOG_MODEL),
      downloadedBytes: 0,
    });
    await voice.refresh();
    should(voice.getSnapshot().phase).equal('absent');
  });

  it('starts the Vosk worker through Trusted Types with the module options, once a take is open', async () => {
    FakeWorker.made.length = 0;
    const double = page();
    const session = browserVoskVoice(double.global, ASSETS).createSession(sessionOptions());
    should(FakeWorker.made).have.length(0);
    session.start();
    await flush();
    should(FakeWorker.made).have.length(1);
    should(FakeWorker.made[0]?.url).equal(ASSETS.workerUrl);
    should(FakeWorker.made[0]?.options).eql({ type: 'module', name: 'fy-vosk' });
    should(FakeWorker.made[0]?.worker.posted).eql([{ type: 'load' }, { type: 'open', id: 1 }]);
    session.cancel();
  });

  it('passes the timers and the clock through to the page, falling back to the wall clock', async () => {
    for (const performance of [{ now: () => 42 }, undefined]) {
      const double = page(performance === undefined ? {} : { performance });
      const session = browserVoskVoice(double.global, ASSETS).createSession(sessionOptions());
      session.start();
      await flush();
      should(double.timers.map(timer => timer.milliseconds)).eql([120_000, 400]);
      await session.finish();
      should(double.cleared).eql([1, 2]);
    }
  });

  it('cancels a take when the page is hidden, ignores a change that is not hiding, and stops watching after', async () => {
    const double = page();
    let aborted = 0;
    const session = browserVoskVoice(double.global, ASSETS).createSession(
      sessionOptions({
        onAbort: () => {
          aborted += 1;
        },
      }),
    );
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

  it('watches nothing when the page has no document', async () => {
    const session = browserVoskVoice(page({}, false).global, ASSETS).createSession(sessionOptions());
    session.start();
    await flush();
    should(await session.finish()).equal('');
  });
});
