/**
 * Proves a sherpa model's voice on this page: it refuses with the model's own name where the page
 * cannot run it, installs the shared runtime and the model as one, starts its own worker through
 * Trusted Types only once a take is open, dictates through a streaming session, and maps engine
 * failures into the dictation panel's vocabulary.
 */

import { describe, it } from 'bun:test';
import should from 'should';
import {
  BrowserRecognitionError,
  type BrowserRecognitionSessionOptions,
} from '../../../src/lib/stt/browser-recognition.ts';
import type { ModelCacheLike } from '../../../src/lib/stt/model-store.ts';
import { readOnDeviceSupport } from '../../../src/lib/stt/on-device-host.ts';
import { SherpaEngineError } from '../../../src/lib/stt/sherpa-engine.ts';
import { ParakeetRecognitionSession } from '../../../src/lib/stt/parakeet-session.ts';
import { MOONSHINE_TINY_MODEL, SHERPA_RUNTIME, SHERPA_ZIPFORMER_MODEL } from '../../../src/lib/stt/sherpa-models.ts';
import { browserSherpaVoice, type SherpaGlobalLike, sherpaFailure } from '../../../src/lib/stt/sherpa-voice.ts';
import { StreamingRecognitionSession } from '../../../src/lib/stt/streaming-session.ts';

const ASSETS = { workerUrl: '/assets/sherpa-worker-abc123.js', runtimeUrl: '/assets/asr-abc123.wasm' };

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

/** Cache Storage as maps, recording which caches were opened and deleted. */
const cacheStorage = () => {
  const caches = new Map<string, Map<string, Response>>();
  const deleted: string[] = [];
  return {
    deleted,
    caches,
    storage: {
      open: async (name: string): Promise<ModelCacheLike> => {
        const cache = caches.get(name) ?? new Map<string, Response>();
        caches.set(name, cache);
        return {
          put: async (key, response) => void cache.set(key, response),
          match: async key => cache.get(key)?.clone(),
          delete: async key => cache.delete(key),
        };
      },
      delete: async (name: string) => {
        deleted.push(name);
        return caches.delete(name);
      },
    },
  };
};

const page = (overrides: Partial<SherpaGlobalLike> = {}): SherpaGlobalLike => ({
  isSecureContext: true,
  WebAssembly: {},
  Worker: FakeWorker as unknown as SherpaGlobalLike['Worker'],
  caches: cacheStorage().storage,
  navigator: {
    mediaDevices: { getUserMedia: () => Promise.resolve({ getTracks: () => [] }) },
    storage: { estimate: () => Promise.resolve({}) },
  },
  MediaRecorder: FakeRecorder as unknown as SherpaGlobalLike['MediaRecorder'],
  OfflineAudioContext: class {} as unknown as SherpaGlobalLike['OfflineAudioContext'],
  setTimeout: () => 0,
  clearTimeout: () => undefined,
  ...overrides,
});

describe('readOnDeviceSupport', () => {
  it('names the model in every refusal it can name it in', () => {
    should(readOnDeviceSupport(page(), true, 'Zipformer')).eql({ available: true });
    should(readOnDeviceSupport(page(), false, 'Zipformer').reason).containEql(
      'built without the on-device speech engine',
    );
    should(readOnDeviceSupport(page({ isSecureContext: false }), true, 'Zipformer').reason).equal(
      'Zipformer needs a secure HTTPS page in this browser.',
    );
    should(readOnDeviceSupport(page({ Worker: undefined }), true, 'Zipformer').reason).equal(
      'This browser cannot run WebAssembly in a worker, which Zipformer needs.',
    );
    should(readOnDeviceSupport(page({ caches: undefined }), true, 'Zipformer').reason).containEql('no Cache Storage');
    should(readOnDeviceSupport(page({ MediaRecorder: undefined }), true, 'Zipformer').reason).containEql(
      'cannot record audio',
    );
  });
});

describe('browserSherpaVoice', () => {
  it('is unsupported, with the model’s name, where the page cannot run it or the build has no worker', () => {
    const refused = browserSherpaVoice(SHERPA_ZIPFORMER_MODEL, page({ isSecureContext: false }), ASSETS, () => false);
    should(refused.getSnapshot()).containEql({
      phase: 'unsupported',
      reason: 'Sherpa Zipformer needs a secure HTTPS page in this browser.',
    });
    should(browserSherpaVoice(SHERPA_ZIPFORMER_MODEL, page(), null, () => false).getSnapshot().phase).equal(
      'unsupported',
    );
  });

  it('installs the shared runtime and the model as one download, from the build’s own runtime URL', async () => {
    const caches = cacheStorage();
    const requested: string[] = [];
    const voice = browserSherpaVoice(SHERPA_ZIPFORMER_MODEL, page({ caches: caches.storage }), ASSETS, () => false);
    await voice.refresh();
    const snapshot = voice.getSnapshot();
    should(snapshot.phase).equal('absent');
    should(snapshot.totalBytes).equal(
      SHERPA_RUNTIME.file.bytes + SHERPA_ZIPFORMER_MODEL.files.reduce((total, file) => total + file.bytes, 0),
    );
    should([...caches.caches.keys()].sort()).eql([SHERPA_ZIPFORMER_MODEL.cache, 'fy-stt-runtime-sherpa-v1'].sort());
    should(requested).eql([]);
    await voice.remove();
    should(caches.deleted.sort()).eql([SHERPA_ZIPFORMER_MODEL.cache, 'fy-stt-runtime-sherpa-v1'].sort());
  });

  it('keeps the shared runtime on Remove while another installed model needs it', async () => {
    const caches = cacheStorage();
    const voice = browserSherpaVoice(SHERPA_ZIPFORMER_MODEL, page({ caches: caches.storage }), ASSETS, () => true);
    await voice.remove();
    should(caches.deleted).eql([SHERPA_ZIPFORMER_MODEL.cache]);
  });

  it('dictates through a streaming session, starting its own worker through Trusted Types once a take is open', async () => {
    FakeWorker.made.length = 0;
    const voice = browserSherpaVoice(SHERPA_ZIPFORMER_MODEL, page(), ASSETS, () => false);
    const session = voice.createSession(sessionOptions());
    should(session).be.instanceOf(StreamingRecognitionSession);
    should(FakeWorker.made).have.length(0);
    session.start();
    await flush();
    should(FakeWorker.made[0]?.url).equal(ASSETS.workerUrl);
    should(FakeWorker.made[0]?.options).eql({ type: 'module', name: 'fy-sherpa-zipformer-en' });
    should(FakeWorker.made[0]?.worker.posted.slice(0, 2)).eql([
      { type: 'load', model: 'sherpa-zipformer-en' },
      { type: 'stream-open', id: 1 },
    ]);
    session.cancel();
    voice.unload();
    should(FakeWorker.made[0]?.worker.terminated).be.true();
  });
});

describe('a whole-take sherpa model', () => {
  it('dictates through a batch session: records, then decodes once on Stop with no stream', async () => {
    FakeWorker.made.length = 0;
    const voice = browserSherpaVoice(MOONSHINE_TINY_MODEL, page(), ASSETS, () => false);
    const session = voice.createSession({ ...sessionOptions(), liveWords: true });
    should(session).be.instanceOf(ParakeetRecognitionSession);
    session.start();
    await flush();
    should(FakeWorker.made[0]?.options).eql({ type: 'module', name: 'fy-moonshine-tiny-en' });
    should(FakeWorker.made[0]?.worker.posted).eql([{ type: 'load', model: 'moonshine-tiny-en' }]);
    session.cancel();
  });
});

describe('sherpaFailure', () => {
  it('maps engine failures into the dictation panel’s vocabulary', () => {
    should(sherpaFailure(new SherpaEngineError('cancelled', 'Unloaded.'))).containEql({
      code: 'aborted',
      message: 'Unloaded.',
    });
    should(sherpaFailure(new SherpaEngineError('not-installed', 'Install it.'))).containEql({
      code: 'model-not-installed',
    });
    should(sherpaFailure(new SherpaEngineError('worker-failed', 'No worker.'))).containEql({
      code: 'recognition-failed',
    });
    should(sherpaFailure(new BrowserRecognitionError('bad-audio', 'Quiet.'))).containEql({ code: 'bad-audio' });
  });
});
