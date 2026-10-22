/**
 * Proves the generic on-device voice and the registry that holds one per catalog model: a voice names
 * its own model in every refusal and never opens a session for a model that is not installed, and the
 * registry finds a voice by engine id, answers whether a shared runtime is still needed, and builds
 * Parakeet's voice for production without downloading anything.
 */

import { describe, it } from 'bun:test';
import should from 'should';
import { ON_DEVICE_MODEL_IDS, type OnDeviceModel, PARAKEET_CATALOG_MODEL } from '../../../src/lib/stt/model-catalog.ts';
import type { ModelInstaller, ModelStoreStatus } from '../../../src/lib/stt/model-store.ts';
import {
  type OnDeviceSession,
  type OnDeviceSessionOptions,
  OnDeviceVoice,
} from '../../../src/lib/stt/on-device-voice.ts';
import { browserOnDeviceVoices, OnDeviceVoices } from '../../../src/lib/stt/on-device-voices.ts';
import { ParakeetVoice } from '../../../src/lib/stt/parakeet-voice.ts';
import { VoskVoice } from '../../../src/lib/stt/vosk-voice.ts';

const MOONSHINE = {
  ...PARAKEET_CATALOG_MODEL,
  id: 'moonshine-test',
  label: 'Moonshine Test',
  shortName: 'Moonshine',
  cache: 'fy-stt-moonshine-test-v1',
  keyRoot: '/fy-stt/moonshine-test',
} as unknown as OnDeviceModel;

class Store implements ModelInstaller {
  readonly totalBytes = 100;
  state: ModelStoreStatus = { state: 'absent' };
  status(): Promise<ModelStoreStatus> {
    return Promise.resolve(this.state);
  }
  install(): Promise<void> {
    this.state = { state: 'installed', version: 'Moonshine v1', bytes: 100, installedAt: '2026-10-22T00:00:00.000Z' };
    return Promise.resolve();
  }
  remove(): Promise<void> {
    this.state = { state: 'absent' };
    return Promise.resolve();
  }
}

const noopOptions: OnDeviceSessionOptions = {
  onStart: () => undefined,
  onTranscript: () => undefined,
  onFailure: () => undefined,
  onAbort: () => undefined,
  onLimit: () => undefined,
};

const session: OnDeviceSession = { start: () => undefined, finish: async () => 'words', cancel: () => undefined };

const voiceOf = (model: OnDeviceModel, opened: OnDeviceSessionOptions[] = [], unloads: number[] = []) =>
  new OnDeviceVoice({
    model,
    support: { available: true },
    store: new Store(),
    openSession: options => {
      opened.push(options);
      return session;
    },
    unload: () => unloads.push(1),
  });

describe('OnDeviceVoice', () => {
  it('names its own model when it cannot run, is not installed, or is still downloading', async () => {
    const unsupported = new OnDeviceVoice({
      model: MOONSHINE,
      support: { available: false },
      store: null,
      openSession: null,
    });
    should(unsupported.getSnapshot()).eql({
      phase: 'unsupported',
      totalBytes: MOONSHINE.files.reduce((total, file) => total + file.bytes, 0) + 12_297_086,
      downloadedBytes: 0,
      reason: 'This browser cannot run Moonshine.',
    });
    should(() => unsupported.createSession(noopOptions)).throw({
      code: 'recognition-unavailable',
      message: 'This browser cannot run Moonshine.',
    });
    unsupported.unload();

    const voice = voiceOf(MOONSHINE);
    await voice.refresh();
    should(() => voice.createSession(noopOptions)).throw({
      code: 'model-not-installed',
      message:
        'Moonshine is not installed on this device yet. Install it in Settings › Voice, or choose phone/browser voice there.',
    });
  });

  it('opens a session over an installed model, and unloads on request', async () => {
    const opened: OnDeviceSessionOptions[] = [];
    const unloads: number[] = [];
    const voice = voiceOf(MOONSHINE, opened, unloads);
    await voice.install();
    should(voice.getSnapshot().phase).equal('installed');
    should(voice.createSession(noopOptions)).equal(session);
    should(opened).eql([noopOptions]);
    voice.unload();
    should(unloads).eql([1]);
  });
});

describe('OnDeviceVoices', () => {
  it('finds a voice by engine id, and nothing for browser voice or an unknown id', () => {
    const parakeet = voiceOf(PARAKEET_CATALOG_MODEL);
    const moonshine = voiceOf(MOONSHINE);
    const voices = new OnDeviceVoices([parakeet, moonshine]);
    should(voices.list()).eql([parakeet, moonshine]);
    should(voices.get('parakeet')).equal(parakeet);
    should(voices.get('moonshine-test')).equal(moonshine);
    should(voices.get('browser')).be.null();
    should(voices.get(null)).be.null();
  });

  it('keeps a shared runtime while another installed model on it needs it', async () => {
    const parakeet = voiceOf(PARAKEET_CATALOG_MODEL);
    const moonshine = voiceOf(MOONSHINE);
    const voices = new OnDeviceVoices([parakeet, moonshine]);
    await voices.refresh();
    should(voices.runtimeInUse('onnxruntime-web', 'parakeet')).be.false();
    await moonshine.install();
    should(voices.runtimeInUse('onnxruntime-web', 'parakeet')).be.true();
    should(voices.runtimeInUse('onnxruntime-web', 'moonshine-test')).be.false();
  });

  it('builds Vosk’s voice from its own assets, unavailable in a build without them', () => {
    const page = { setTimeout: () => 0, clearTimeout: () => undefined };
    const vosk = browserOnDeviceVoices(page, null).get('vosk-small-en');
    should(vosk).be.instanceOf(VoskVoice);
    should(vosk?.support).eql({
      available: false,
      reason: 'This copy of Ferretry was built without the Vosk speech engine.',
    });
    const parakeetOnly = { workerUrl: '/assets/parakeet-worker-a.js', runtimeUrl: '/assets/ort.wasm' };
    should(browserOnDeviceVoices(page, parakeetOnly).get('vosk-small-en')?.support.reason).equal(
      'This copy of Ferretry was built without the Vosk speech engine.',
    );
    const withVosk = {
      ...parakeetOnly,
      vosk: { workerUrl: '/assets/vosk-worker-a.js', runtimeUrl: '/assets/vosk-a.wasm' },
    };
    // This fake page is not a secure one: the assets reached the voice, which now judges the page.
    should(browserOnDeviceVoices(page, withVosk).get('vosk-small-en')?.support.reason).equal(
      'Vosk needs a secure HTTPS page in this browser.',
    );
  });

  it('builds every catalog model’s voice for this page, unavailable without the build’s assets, and never downloads', () => {
    const voices = browserOnDeviceVoices({ setTimeout: () => 0, clearTimeout: () => undefined }, null);
    should(voices.list().map(voice => voice.model.id)).eql([...ON_DEVICE_MODEL_IDS]);
    const voice = voices.get('parakeet');
    should(voice).be.instanceOf(ParakeetVoice);
    for (const each of voices.list()) should(each.support.available).be.false();
    should(voice?.support).eql({
      available: false,
      reason: 'This copy of Ferretry was built without the on-device speech engine.',
    });
    const given = new ParakeetVoice({ support: { available: false }, store: null, engine: null, host: null });
    should(
      browserOnDeviceVoices({ setTimeout: () => 0, clearTimeout: () => undefined }, null, given).get('parakeet'),
    ).equal(given);
  });

  it('removes a sherpa model’s shared runtime only when no other installed sherpa model needs it', async () => {
    const deleted: string[] = [];
    const caches = {
      open: async () => ({ put: async () => undefined, match: async () => undefined, delete: async () => false }),
      delete: async (name: string) => {
        deleted.push(name);
        return true;
      },
    };
    const page = {
      isSecureContext: true,
      WebAssembly: {},
      Worker: class {} as never,
      caches,
      navigator: { mediaDevices: { getUserMedia: () => Promise.reject(new Error('unused')) } },
      MediaRecorder: class {} as never,
      OfflineAudioContext: class {} as never,
      setTimeout: () => 0,
      clearTimeout: () => undefined,
    };
    const voices = browserOnDeviceVoices(page, {
      workerUrl: '/assets/parakeet-worker-a.js',
      runtimeUrl: '/assets/ort.wasm',
      sherpa: { workerUrl: '/assets/sherpa-worker-a.js', runtimeUrl: '/assets/asr-a.wasm' },
    });
    await voices.get('sherpa-zipformer-en-20m')?.remove();
    should(deleted).eql(['fy-stt-runtime-sherpa-v1', 'fy-stt-sherpa-zipformer-en-20m-v1']);
  });
});
