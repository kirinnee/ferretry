/**
 * Proves the generic on-device voice and the registry that holds one per catalog model: a voice names
 * its own model in every refusal and never opens a session for a model that is not installed, and the
 * registry finds a voice by engine id, answers whether a shared runtime is still needed, and builds
 * Parakeet's voice for production without downloading anything.
 */

import { describe, it } from 'bun:test';
import should from 'should';
import { type OnDeviceModel, PARAKEET_CATALOG_MODEL } from '../../../src/lib/stt/model-catalog.ts';
import type { ModelInstaller, ModelStoreStatus } from '../../../src/lib/stt/model-store.ts';
import {
  type OnDeviceSession,
  type OnDeviceSessionOptions,
  OnDeviceVoice,
} from '../../../src/lib/stt/on-device-voice.ts';
import { browserOnDeviceVoices, OnDeviceVoices } from '../../../src/lib/stt/on-device-voices.ts';
import { ParakeetVoice } from '../../../src/lib/stt/parakeet-voice.ts';

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

  it('builds Parakeet’s voice for this page, unavailable without the build’s assets, and never downloads', () => {
    const voices = browserOnDeviceVoices({ setTimeout: () => 0, clearTimeout: () => undefined }, null);
    const [voice] = voices.list();
    should(voices.list()).have.length(1);
    should(voice).be.instanceOf(ParakeetVoice);
    should(voice?.support).eql({
      available: false,
      reason: 'This copy of Ferretry was built without the on-device speech engine.',
    });
    const given = new ParakeetVoice({ support: { available: false }, store: null, engine: null, host: null });
    should(
      browserOnDeviceVoices({ setTimeout: () => 0, clearTimeout: () => undefined }, null, given).get('parakeet'),
    ).equal(given);
  });
});
