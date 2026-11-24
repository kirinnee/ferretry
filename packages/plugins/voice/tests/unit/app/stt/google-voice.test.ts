/**
 * Proves the Google transcriber's voice on this page: it refuses with the engine's own name where the page cannot run it,
 * installs the MediaPipe runtime and the model as one, starts its own worker through Trusted Types only once a take is
 * open — speaking the sherpa worker's protocol with the Google model's id — dictates through a streaming session so words
 * appear while the person speaks, and keeps the shared runtime on Remove only while another model needs it.
 */

import { describe, it } from 'bun:test';
import should from 'should';
import type { BrowserRecognitionSessionOptions } from '../../../../app/lib/stt/browser-recognition.ts';
import { GOOGLE_TRANSCRIBER_MODEL, MEDIAPIPE_AUDIO_RUNTIME } from '../../../../app/lib/stt/google-transcriber-model.ts';
import { browserGoogleVoice } from '../../../../app/lib/stt/google-voice.ts';
import type { ModelCacheLike } from '../../../../app/lib/stt/model-store.ts';
import type { SherpaGlobalLike } from '../../../../app/lib/stt/sherpa-voice.ts';
import { StreamingRecognitionSession } from '../../../../app/lib/stt/streaming-session.ts';

const ASSETS = {
  workerUrl: '/assets/google-worker-abc123.js',
  runtimeUrl: '/assets/audio_wasm_module_internal-abc123.wasm',
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

describe('browserGoogleVoice', () => {
  it('is unsupported, with the engine’s name, where the page cannot run it or the build has no worker', () => {
    const refused = browserGoogleVoice(page({ isSecureContext: false }), ASSETS, () => false);
    should(refused.getSnapshot()).containEql({
      phase: 'unsupported',
      reason: 'Google live words needs a secure HTTPS page in this browser.',
    });
    should(browserGoogleVoice(page(), null, () => false).getSnapshot().phase).equal('unsupported');
    should(() => browserGoogleVoice(page(), null, () => false).createSession(sessionOptions())).throw();
  });

  it('installs the MediaPipe runtime and the model as one download of 636.6 MB, each under its own cache', async () => {
    const caches = cacheStorage();
    const voice = browserGoogleVoice(page({ caches: caches.storage }), ASSETS, () => false);
    await voice.refresh();
    const snapshot = voice.getSnapshot();
    should(snapshot.phase).equal('absent');
    should(snapshot.totalBytes).equal(MEDIAPIPE_AUDIO_RUNTIME.file.bytes + GOOGLE_TRANSCRIBER_MODEL.files[0]!.bytes);
    should([...caches.caches.keys()].sort()).eql([GOOGLE_TRANSCRIBER_MODEL.cache, 'fy:voice:runtime-mediapipe'].sort());
    await voice.remove();
    should(caches.deleted.sort()).eql([GOOGLE_TRANSCRIBER_MODEL.cache, 'fy:voice:runtime-mediapipe'].sort());
  });

  it('keeps the shared runtime on Remove while another installed model needs it', async () => {
    const caches = cacheStorage();
    const voice = browserGoogleVoice(page({ caches: caches.storage }), ASSETS, () => true);
    await voice.remove();
    should(caches.deleted).eql([GOOGLE_TRANSCRIBER_MODEL.cache]);
  });

  it('refuses a dictation before anything is installed, never downloading', async () => {
    FakeWorker.made.length = 0;
    const voice = browserGoogleVoice(page(), ASSETS, () => false);
    await voice.refresh();
    should(() => voice.createSession(sessionOptions())).throw(/not installed/u);
    should(FakeWorker.made).have.length(0);
  });

  it('dictates through a streaming session, starting its own worker through Trusted Types once a take is open', async () => {
    FakeWorker.made.length = 0;
    const voice = browserGoogleVoice(page(), ASSETS, () => false);
    const session = voice.createSession(sessionOptions());
    should(session).be.instanceOf(StreamingRecognitionSession);
    should(FakeWorker.made).have.length(0);
    session.start();
    await flush();
    should(FakeWorker.made[0]?.url).equal(ASSETS.workerUrl);
    should(FakeWorker.made[0]?.options).eql({ type: 'module', name: 'fy-google-audio-transcriber' });
    should(FakeWorker.made[0]?.worker.posted.slice(0, 2)).eql([
      { type: 'load', model: 'google-audio-transcriber' },
      { type: 'stream-open', id: 1 },
    ]);
    session.cancel();
    voice.unload();
    should(FakeWorker.made[0]?.worker.terminated).be.true();
  });
});
