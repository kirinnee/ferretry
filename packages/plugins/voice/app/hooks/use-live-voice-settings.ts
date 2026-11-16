/**
 * React binding for this device's voice-chat settings (`lib/voice-chat/live-settings.ts`).
 *
 * A screen with no store behind it (a static render, a test that composes nothing) reads the frozen
 * defaults and its writes go nowhere — the same contract `use-stt-settings.ts` gives dictation. The
 * cross-tab bridge listens for the browser's `storage` event, so a second tab of the same browser sees
 * a choice made in the first.
 */

import {
  createContext,
  createElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useSyncExternalStore,
} from 'react';
import { useLiveVoiceSettingsStore as useAppLiveVoiceSettingsStore } from '../lib/voice-store.tsx';
import {
  DEFAULT_LIVE_VOICE_SETTINGS,
  LIVE_VOICE_SETTINGS_KEY,
  type LiveVoiceSettings,
  type LiveVoiceSettingsPatch,
  type LiveVoiceSettingsStore,
} from '../lib/voice-chat/live-settings.ts';

const LiveVoiceSettingsContext = createContext<LiveVoiceSettingsStore | null>(null);

/** Gives a subtree its own settings store (a test, a harness) instead of the app's. */
export function LiveVoiceSettingsProvider({
  store,
  children,
}: {
  readonly store: LiveVoiceSettingsStore | null;
  readonly children: ReactNode;
}) {
  return createElement(LiveVoiceSettingsContext.Provider, { value: store }, children);
}

/** This device's settings store: a provided one, else the app's, else `null` (defaults, writes go nowhere). */
export function useDeviceVoiceSettingsStore(): LiveVoiceSettingsStore | null {
  const provided = useContext(LiveVoiceSettingsContext);
  const app = useAppLiveVoiceSettingsStore();
  return provided ?? app;
}

export interface LiveVoiceSettingsHandle {
  readonly settings: LiveVoiceSettings;
  readonly update: (patch: LiveVoiceSettingsPatch) => void;
  /** `false` once storage refused a write: the choice will not survive a reload. */
  readonly persisted: boolean;
}

const NO_SUBSCRIPTION = (): (() => void) => () => undefined;
const DEFAULTS = (): LiveVoiceSettings => DEFAULT_LIVE_VOICE_SETTINGS;

export function useLiveVoiceSettings(store: LiveVoiceSettingsStore | null): LiveVoiceSettingsHandle {
  const settings = useSyncExternalStore(store?.subscribe ?? NO_SUBSCRIPTION, store?.get ?? DEFAULTS, DEFAULTS);
  const update = useCallback((patch: LiveVoiceSettingsPatch) => void store?.update(patch), [store]);
  useEffect(() => {
    if (store === null || typeof window === 'undefined') return;
    const onStorage = (event: StorageEvent): void => {
      if (event.key === null || event.key === LIVE_VOICE_SETTINGS_KEY) store.reload();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [store]);
  return { settings, update, persisted: store?.persisted ?? true };
}
