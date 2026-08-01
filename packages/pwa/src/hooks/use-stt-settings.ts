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
  STT_SETTINGS_KEY,
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

/** The `storage` event surface, narrowed so a test does not need a window. */
export interface StorageEventTarget {
  addEventListener(type: 'storage', listener: (event: StorageEvent) => void): void;
  removeEventListener(type: 'storage', listener: (event: StorageEvent) => void): void;
}

/**
 * Bridges another tab's write into this one.
 *
 * `key === null` is a whole-storage clear, which affects us too. Anything else
 * that is not our key is somebody else's business.
 */
export function useSttSettingsSync(store: SttSettingsStore, target: StorageEventTarget | null): void {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (target === null) return () => undefined;
      const listener = (event: StorageEvent): void => {
        if (event.key === null || event.key === STT_SETTINGS_KEY) {
          store.reload();
          onChange();
        }
      };
      target.addEventListener('storage', listener);
      return () => target.removeEventListener('storage', listener);
    },
    [store, target],
  );
  useSyncExternalStore(subscribe, store.get, () => DEFAULT_STT_SETTINGS);
}
