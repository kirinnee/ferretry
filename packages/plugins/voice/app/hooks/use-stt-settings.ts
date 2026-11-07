/**
 * React binding for the dictation settings store.
 *
 * kteam's `useSttSettings` read a module-level singleton and installed its own
 * `window` listener from inside the subscribe callback. Here the store is
 * passed in, so a screen renders against whichever store its host composed and
 * a test needs no globals at all. The cross-tab bridge is a separate hook for
 * the same reason: `storage` is a window event, and a component tree that has
 * no window (a static render) must still be able to read settings.
 */

import { useCallback, useSyncExternalStore } from 'react';
import {
  DEFAULT_STT_SETTINGS,
  type SttSettings,
  type SttSettingsPatch,
  type SttSettingsStore,
} from '../lib/stt/stt-settings.ts';

export interface SttSettingsHandle {
  readonly settings: SttSettings;
  /** Partial update; unspecified fields keep their current value. */
  readonly update: (patch: SttSettingsPatch) => void;
  /**
   * `false` once a write has been refused by storage, so the settings screen
   * can say so instead of pretending the choice was saved.
   */
  readonly persisted: boolean;
}

/**
 * Subscribes to one store. SSR-safe: the server snapshot is the frozen
 * defaults, so a static render needs no storage access.
 */
export function useSttSettings(store: SttSettingsStore): SttSettingsHandle {
  const settings = useSyncExternalStore(store.subscribe, store.get, () => DEFAULT_STT_SETTINGS);
  const update = useCallback((patch: SttSettingsPatch) => void store.update(patch), [store]);
  return { settings, update, persisted: store.persisted };
}
