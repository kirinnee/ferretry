/**
 * EVERY ON-DEVICE SPEECH MODEL THIS DEVICE CAN RUN — one {@link OnDeviceVoice} per catalog entry
 * (`model-catalog.ts`), built once per document by the app store, like the dictation settings.
 *
 * The dictation hook asks it for the voice behind the chosen engine id; Settings lists every one with
 * its install. Each voice is built by its runtime's factory, so adding a runtime is adding a factory,
 * never a branch in the hook or the screen.
 */

import { ON_DEVICE_MODELS, type OnDeviceModel, type SpeechRuntimeId } from './model-catalog.ts';
import type { OnDeviceVoice } from './on-device-voice.ts';
import {
  browserParakeetVoice,
  type ParakeetAssets,
  type ParakeetGlobalLike,
  type ParakeetVoice,
} from './parakeet-voice.ts';

export class OnDeviceVoices {
  readonly #voices: readonly OnDeviceVoice[];

  constructor(voices: readonly OnDeviceVoice[]) {
    this.#voices = voices;
  }

  /** Every voice, in catalog order. */
  list(): readonly OnDeviceVoice[] {
    return this.#voices;
  }

  /** The voice behind an engine id, or `null` for `browser`, an unknown id, or a model not built here. */
  get(id: string | null): OnDeviceVoice | null {
    return this.#voices.find(voice => voice.model.id === id) ?? null;
  }

  /** Whether a model other than `except` is installed on `runtime`, so its shared binary must stay. */
  runtimeInUse(runtime: SpeechRuntimeId, except: string): boolean {
    return this.#voices.some(
      voice =>
        voice.model.id !== except && voice.model.runtime === runtime && voice.getSnapshot().phase === 'installed',
    );
  }

  /** Re-read every install. Never downloads. */
  async refresh(): Promise<void> {
    await Promise.all(this.#voices.map(voice => voice.refresh()));
  }
}

/** Where the build put every runtime's worker and binary (bound in `src/main.tsx`). */
export type SpeechAssets = ParakeetAssets;

/** Builds the voice for one model on its runtime. */
type VoiceFactory = (model: OnDeviceModel) => OnDeviceVoice;

/** The production registry, bound to this page. Parakeet's service is passed in so the store keeps one. */
export function browserOnDeviceVoices(
  global: ParakeetGlobalLike,
  assets: SpeechAssets | null,
  parakeet: ParakeetVoice = browserParakeetVoice(global, assets),
): OnDeviceVoices {
  const factories: Readonly<Record<SpeechRuntimeId, VoiceFactory>> = {
    'onnxruntime-web': () => parakeet,
  };
  return new OnDeviceVoices(ON_DEVICE_MODELS.map(model => factories[model.runtime](model)));
}
