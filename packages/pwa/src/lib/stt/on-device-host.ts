/**
 * What every on-device engine needs from the page besides its model: whether the page can run one at
 * all, and the microphone, visibility and timers a dictation session uses. Shared by Parakeet
 * (`parakeet-voice.ts`) and the sherpa engines (`sherpa-voice.ts`) so their refusals read alike.
 */

import {
  type AudioCaptureGlobalLike,
  type AudioCapturePort,
  browserAudioCapture,
  canCaptureAudio,
} from './audio-capture.ts';
import type { OnDeviceSupport } from './on-device-voice.ts';

/** The parts a dictation session needs besides the model. */
export interface OnDeviceSessionHost {
  readonly capture: AudioCapturePort;
  watchHidden(onHidden: () => void): () => void;
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

/** The page's own globals an on-device engine reads. */
export interface OnDeviceHostGlobalLike extends AudioCaptureGlobalLike {
  readonly isSecureContext?: unknown;
  readonly caches?: unknown;
  readonly WebAssembly?: unknown;
  readonly Worker?: unknown;
  readonly document?: {
    readonly visibilityState?: string;
    addEventListener(type: 'visibilitychange', listener: () => void): void;
    removeEventListener(type: 'visibilitychange', listener: () => void): void;
  };
  readonly performance?: { now(): number };
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Whether this page can run an on-device engine called `name`, as data with the reason. */
export function readOnDeviceSupport(global: OnDeviceHostGlobalLike, built: boolean, name: string): OnDeviceSupport {
  if (!built)
    return { available: false, reason: 'This copy of Ferretry was built without the on-device speech engine.' };
  if (global.isSecureContext !== true)
    return { available: false, reason: `${name} needs a secure HTTPS page in this browser.` };
  if (global.WebAssembly === undefined || typeof global.Worker !== 'function')
    return { available: false, reason: `This browser cannot run WebAssembly in a worker, which ${name} needs.` };
  if (global.caches === undefined)
    return {
      available: false,
      reason: 'This browser will not keep the speech model on this device (no Cache Storage).',
    };
  if (!canCaptureAudio(global))
    return { available: false, reason: 'This browser cannot record audio for on-device dictation.' };
  return { available: true };
}

/** The microphone, visibility and clock of this page, for a dictation session. */
export function browserSessionHost(global: OnDeviceHostGlobalLike): OnDeviceSessionHost {
  return {
    capture: browserAudioCapture(global),
    watchHidden: onHidden => {
      const document = global.document;
      if (document === undefined) return () => undefined;
      const listener = (): void => {
        if (document.visibilityState === 'hidden') onHidden();
      };
      document.addEventListener('visibilitychange', listener);
      return () => document.removeEventListener('visibilitychange', listener);
    },
    setTimeout: (callback, milliseconds) => global.setTimeout(callback, milliseconds),
    clearTimeout: handle => global.clearTimeout(handle),
    now: () => global.performance?.now() ?? Date.now(),
  };
}
