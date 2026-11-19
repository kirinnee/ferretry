/**
 * The browser entry for the engine cards, over fixed fake engines. No daemon, no network, no real model: every voice is a
 * fake whose install state this file sets. Every name below is made up.
 *
 *   ?view=short       the first-run Voice step: the short list, Zipformer chosen and installed
 *   ?view=all         the same step with every engine open
 *   ?view=downloading the short list with one engine mid-download
 *   ?view=before      today's Settings › Voice engine list (the "before" shot)
 *   ?theme=<family>-<mode>
 */

import { createRoot } from 'react-dom/client';
import { EngineCatalogList } from '../../../../app/features/settings/engine-catalog-list.tsx';
import { VoiceStep } from '../../../../app/features/onboarding/voice-step.tsx';
import { browserRecognitionProvider } from '../../../../app/lib/stt/browser-recognition.ts';
import { ON_DEVICE_MODELS } from '../../../../app/lib/stt/model-catalog.ts';
import type { ModelInstaller, ModelInstallOptions, ModelStoreStatus } from '../../../../app/lib/stt/model-store.ts';
import { OnDeviceVoice } from '../../../../app/lib/stt/on-device-voice.ts';
import { OnDeviceVoices } from '../../../../app/lib/stt/on-device-voices.ts';
import { DEFAULT_STT_SETTINGS } from '../../../../app/lib/stt/stt-settings.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const view = params.get('view') ?? 'short';

class FakeStore implements ModelInstaller {
  readonly totalBytes: number;
  readonly #state: ModelStoreStatus;
  readonly #hang: boolean;
  constructor(totalBytes: number, state: ModelStoreStatus, hang = false) {
    this.totalBytes = totalBytes;
    this.#state = state;
    this.#hang = hang;
  }
  status(): Promise<ModelStoreStatus> {
    return Promise.resolve(this.#state);
  }
  install(options: ModelInstallOptions = {}): Promise<void> {
    options.onProgress?.({ label: 'Encoder', downloadedBytes: this.totalBytes * 0.42, totalBytes: this.totalBytes });
    return this.#hang ? new Promise(() => undefined) : Promise.resolve();
  }
  remove(): Promise<void> {
    return Promise.resolve();
  }
}

const voices = new OnDeviceVoices(
  ON_DEVICE_MODELS.map(model => {
    const bytes = model.files.reduce((sum, file) => sum + file.bytes, 0);
    const installed = model.id === 'sherpa-zipformer-en';
    const status: ModelStoreStatus = installed
      ? { state: 'installed', version: 'fake', bytes, installedAt: '2026-10-22T00:00:00.000Z' }
      : { state: 'absent' };
    return new OnDeviceVoice({
      model,
      support: { available: true },
      store: new FakeStore(bytes, status, model.id === 'moonshine-base-en'),
      openSession: () => {
        throw new Error('no microphone in a shot');
      },
    });
  }),
);
await voices.refresh();

if (view === 'downloading') {
  const moonshine = voices.get('moonshine-base-en');
  void moonshine?.install();
}

const provider = browserRecognitionProvider();
const settings = { ...DEFAULT_STT_SETTINGS, engine: 'sherpa-zipformer-en' as const };

const root = document.getElementById('root') as HTMLElement;
root.className = 'mx-auto max-w-[880px] p-4';
root.dataset['scene'] = 'ready';
createRoot(root).render(
  view === 'before' ? (
    <EngineCatalogList
      value="sherpa-zipformer-en"
      onChange={() => undefined}
      voices={voices}
      browserSupport={{ available: true, availability: 'available', implementation: 'standard' }}
      browserProvider={provider}
      deviceClass="computer"
    />
  ) : (
    <VoiceStep
      settings={settings}
      update={() => undefined}
      voices={voices}
      browserSupport={{ available: true, availability: 'available', implementation: 'standard' }}
      deviceClass="computer"
    />
  ),
);
