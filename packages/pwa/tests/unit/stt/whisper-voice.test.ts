/**
 * Proves the Whisper voice and its place in the registry: a page that cannot run it says why in
 * Whisper's own name, a supported page reads the install without downloading, a take starts the
 * model's own worker through Trusted Types and names its model, the session's timings name the model,
 * and the registry builds one Whisper voice per Whisper entry, which keeps the shared runtime on Remove
 * while the other Whisper model is installed.
 */

import { describe, it } from 'bun:test';
import should from 'should';
import {
  BrowserRecognitionError,
  type BrowserRecognitionSessionOptions,
} from '../../../src/lib/stt/browser-recognition.ts';
import { ON_DEVICE_MODEL_IDS } from '../../../src/lib/stt/model-catalog.ts';
import type { ModelInstaller, ModelStoreStatus } from '../../../src/lib/stt/model-store.ts';
import { browserOnDeviceVoices, type SpeechGlobalLike } from '../../../src/lib/stt/on-device-voices.ts';
import { WHISPER_BASE_EN_CATALOG_MODEL, WHISPER_TINY_EN_CATALOG_MODEL } from '../../../src/lib/stt/whisper-model.ts';
import { WhisperRecognitionSession } from '../../../src/lib/stt/whisper-session.ts';
import {
  browserWhisperVoice,
  readWhisperSupport,
  type WhisperGlobalLike,
  whisperVoice,
} from '../../../src/lib/stt/whisper-voice.ts';

const TINY = WHISPER_TINY_EN_CATALOG_MODEL;
const ASSETS = { workerUrl: '/assets/whisper-worker-abc123.js', runtimeUrl: '/assets/ort.asyncify.wasm' };
const INSTALLED: ModelStoreStatus = {
  state: 'installed',
  version: TINY.versionLabel,
  bytes: 10,
  installedAt: '2026-10-22T08:00:00.000Z',
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
  readonly global: WhisperGlobalLike;
  readonly listeners: Set<() => void>;
  visibility: { state: string };
}

const page = (overrides: Partial<WhisperGlobalLike> = {}, withDocument = true): PageDouble => {
  const listeners = new Set<() => void>();
  const visibility = { state: 'visible' };
  const global: WhisperGlobalLike = {
    isSecureContext: true,
    WebAssembly: {},
    Worker: FakeWorker as unknown as WhisperGlobalLike['Worker'],
    caches: { open: () => Promise.reject(new Error('no cache')), delete: () => Promise.resolve(false) },
    navigator: {
      mediaDevices: { getUserMedia: () => Promise.resolve({ getTracks: () => [] }) },
      storage: { estimate: () => Promise.resolve({}) },
    },
    MediaRecorder: FakeRecorder as unknown as WhisperGlobalLike['MediaRecorder'],
    OfflineAudioContext: class {} as unknown as WhisperGlobalLike['OfflineAudioContext'],
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
    setTimeout: () => 1,
    clearTimeout: () => undefined,
    ...overrides,
  };
  return { global, listeners, visibility };
};

describe('readWhisperSupport', () => {
  it('is available when everything is present', () => {
    should(readWhisperSupport(page().global, ASSETS, TINY)).eql({ available: true });
  });

  it('says, in the model’s own name, why this page cannot run it', () => {
    const reason = (global: WhisperGlobalLike, assets: typeof ASSETS | null | undefined = ASSETS): string =>
      readWhisperSupport(global, assets, TINY).reason ?? '';
    should(reason(page().global, null)).equal('This copy of Ferretry was built without Whisper tiny.');
    should(readWhisperSupport(page().global, undefined, TINY).reason).equal(
      'This copy of Ferretry was built without Whisper tiny.',
    );
    should(reason(page({ isSecureContext: false }).global)).equal(
      'Whisper tiny needs a secure HTTPS page in this browser.',
    );
    should(reason(page({ WebAssembly: undefined }).global)).containEql(
      'WebAssembly in a worker, which Whisper tiny needs',
    );
    should(reason(page({ Worker: undefined }).global)).containEql('WebAssembly in a worker');
    should(reason(page({ caches: undefined }).global)).containEql('Cache Storage');
    should(reason(page({ MediaRecorder: undefined }).global)).containEql('record audio');
  });
});

describe('whisperVoice', () => {
  class Store implements ModelInstaller {
    readonly totalBytes = 10;
    async status(): Promise<ModelStoreStatus> {
      return INSTALLED;
    }
    async install(): Promise<void> {}
    async remove(): Promise<void> {}
  }

  it('opens a Whisper session over the installed model, and unloads its engine', async () => {
    let unloads = 0;
    const voice = whisperVoice({
      model: TINY,
      support: { available: true },
      store: new Store(),
      engine: {
        preload: () => undefined,
        transcribe: async () => ({ text: 'x', backend: 'wasm' }),
        unload: () => {
          unloads += 1;
        },
      },
      host: {
        capture: { start: () => new Promise(() => undefined) },
        watchHidden: () => () => undefined,
        setTimeout: () => 0,
        clearTimeout: () => undefined,
        now: () => 0,
      },
    });
    await voice.refresh();
    should(voice.createSession(sessionOptions())).be.instanceOf(WhisperRecognitionSession);
    voice.unload();
    should(unloads).equal(1);
  });

  it('refuses a session, and unloads nothing, when the page cannot run it', () => {
    const voice = whisperVoice({
      model: TINY,
      support: { available: false, reason: 'No.' },
      store: null,
      engine: null,
      host: null,
    });
    should(refusal(() => voice.createSession(sessionOptions()))).have.properties({
      code: 'recognition-unavailable',
      message: 'No.',
    });
    voice.unload();
  });
});

describe('browserWhisperVoice', () => {
  it('is unsupported, in Whisper’s words, when the page cannot run it', () => {
    const voice = browserWhisperVoice(page({ isSecureContext: false }).global, ASSETS, TINY, () => false);
    should(voice.getSnapshot()).have.properties({ phase: 'unsupported' });
    should(voice.getSnapshot().reason).containEql('Whisper tiny needs a secure HTTPS page');
    should(browserWhisperVoice(page().global, undefined, TINY, () => false).getSnapshot().phase).equal('unsupported');
  });

  it('reads the install as absent with no cache to open, and never downloads', async () => {
    const voice = browserWhisperVoice(page().global, ASSETS, TINY, () => false);
    should(voice.getSnapshot().phase).equal('checking');
    await voice.refresh();
    should(voice.getSnapshot().phase).equal('absent');
    should(refusal(() => voice.createSession(sessionOptions())).code).equal('model-not-installed');
  });

  it('starts the model’s own worker through Trusted Types, named for it, once a take is open', async () => {
    FakeWorker.made.length = 0;
    const double = page({ performance: { now: () => 5 } });
    const voice = browserWhisperVoice(double.global, ASSETS, WHISPER_BASE_EN_CATALOG_MODEL, () => false);
    const session = voice.createSession(sessionOptions());
    should(FakeWorker.made.length).equal(0);
    session.start();
    await flush();
    should(FakeWorker.made.map(made => [made.url, made.options])).eql([
      [ASSETS.workerUrl, { type: 'module', name: 'fy-whisper-base-en' }],
    ]);
    should(FakeWorker.made[0]?.worker.posted).eql([{ type: 'load', model: 'whisper-base-en' }]);
    should(await session.finish()).equal('');
    should((session as WhisperRecognitionSession).timings()?.model).equal(WHISPER_BASE_EN_CATALOG_MODEL.versionLabel);
    voice.unload();
    should(FakeWorker.made[0]?.worker.terminated).be.true();
  });

  it('cancels a take when the page is hidden, and stops watching once it ends', async () => {
    const double = page();
    let aborted = 0;
    const voice = browserWhisperVoice(double.global, ASSETS, TINY, () => false);
    const hidden = voice.createSession({ ...sessionOptions(), onAbort: () => (aborted += 1) });
    hidden.start();
    await flush();
    should(double.listeners.size).equal(1);
    for (const listener of [...double.listeners]) listener();
    should(aborted).equal(0);
    double.visibility.state = 'hidden';
    for (const listener of [...double.listeners]) listener();
    should(aborted).equal(1);
    should(double.listeners.size).equal(0);
  });

  it('runs on a page with no document and no performance clock', async () => {
    const session = browserWhisperVoice(page({}, false).global, ASSETS, TINY, () => false).createSession(
      sessionOptions(),
    );
    session.start();
    await flush();
    should(await session.finish()).equal('');
  });
});

describe('the registry’s Whisper voices', () => {
  it('builds one voice per Whisper entry, unavailable when the build has no Whisper assets', () => {
    const voices = browserOnDeviceVoices(page().global as SpeechGlobalLike, {
      workerUrl: '/p.js',
      runtimeUrl: '/p.wasm',
    });
    should(voices.list().map(voice => voice.model.id)).eql([...ON_DEVICE_MODEL_IDS]);
    should(voices.get('whisper-tiny-en')?.support.reason).equal(
      'This copy of Ferretry was built without Whisper tiny.',
    );
    should(voices.get('whisper-base-en')?.support.reason).equal(
      'This copy of Ferretry was built without Whisper base.',
    );
  });

  it('removes the shared runtime only once no other Whisper model is installed', async () => {
    const deleted: string[] = [];
    const installed = new Set<string>();
    // A cache per bundle: a model is "installed" when its cache holds the installed record, which
    // this double answers for any key ending in /installed.
    const caches = {
      open: async (name: string) => ({
        put: async () => undefined,
        delete: async () => true,
        match: async (key: string) =>
          installed.has(name) && (key.endsWith('/installed') || key.endsWith('/complete'))
            ? new Response(
                JSON.stringify(
                  key.endsWith('/installed')
                    ? { installedAt: '2026-10-22T08:00:00.000Z' }
                    : { sha256: completeHash(name, key) },
                ),
              )
            : undefined,
      }),
      delete: async (name: string) => {
        deleted.push(name);
        installed.delete(name);
        return true;
      },
    };
    const voices = browserOnDeviceVoices(page({ caches }).global as SpeechGlobalLike, {
      workerUrl: '/p.js',
      runtimeUrl: '/p.wasm',
      whisper: ASSETS,
    });
    for (const name of ['fy-stt-transformers-js-v1', TINY.cache, WHISPER_BASE_EN_CATALOG_MODEL.cache])
      installed.add(name);
    await voices.refresh();
    should(voices.get('whisper-tiny-en')?.getSnapshot().phase).equal('installed');
    should(voices.get('whisper-base-en')?.getSnapshot().phase).equal('installed');
    await voices.get('whisper-tiny-en')?.remove();
    should(deleted).eql([TINY.cache]);
    await voices.get('whisper-base-en')?.remove();
    should(deleted).eql([TINY.cache, WHISPER_BASE_EN_CATALOG_MODEL.cache, 'fy-stt-transformers-js-v1']);
  });
});

/** The pinned digest the store expects in a file's `complete` record, found from the key. */
function completeHash(cache: string, key: string): string {
  const role = key.split('/').at(-2) ?? '';
  if (cache === 'fy-stt-transformers-js-v1') return '79dfc1d756e2dba03ad015ad84ba804583853bb567fddb669487abb4ee1bf273';
  const model = cache === TINY.cache ? TINY : WHISPER_BASE_EN_CATALOG_MODEL;
  return model.files.find(file => file.role === role)?.sha256 ?? '';
}
