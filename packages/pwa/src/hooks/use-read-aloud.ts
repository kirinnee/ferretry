/**
 * READ ALOUD, FOR A ROW. The composition point (three-layer architecture): it reaches the browser's
 * `speechSynthesis` through `browserSpeaker()` once per page, and hands a row only the words it needs.
 *
 * A test or another surface supplies its own controller through `ReadAloudProvider`; without one, the
 * page shares a single lazily-made controller over the real browser voice, so two rows can never talk
 * at once. Nothing here touches the reply text beyond passing it to the controller.
 */

import { createContext, createElement, type ReactNode, useContext, useEffect, useSyncExternalStore } from 'react';
import { readOptionsOf } from '../lib/voice-chat/live-settings.ts';
import { createReadAloud, IDLE, type ReadAloudController, type ReadAloudState } from '../lib/voice-chat/read-aloud.ts';
import { browserSpeaker } from '../lib/voice-chat/speech-synthesis.ts';
import { useDeviceVoiceSettingsStore } from './use-live-voice-settings.ts';

let shared: ReadAloudController | null = null;

const browserReadAloud = (): ReadAloudController => {
  shared ??= createReadAloud({
    speaker: browserSpeaker(),
    language: () => (typeof navigator === 'undefined' ? 'en-US' : navigator.language || 'en-US'),
  });
  return shared;
};

const ReadAloudContext = createContext<ReadAloudController | null>(null);

export function ReadAloudProvider({
  controller,
  children,
}: {
  readonly controller: ReadAloudController;
  readonly children: ReactNode;
}) {
  return createElement(ReadAloudContext.Provider, { value: controller }, children);
}

/** The page's one controller: the provided one, else the shared one over the device's own voice. */
export function useReadAloudController(): ReadAloudController {
  return useContext(ReadAloudContext) ?? browserReadAloud();
}

export interface RowReadAloud {
  readonly supported: boolean;
  /** This row's own reading state; `idle` while another message is being read. */
  readonly state: ReadAloudState;
  /** True while THIS row's message is the one being spoken. */
  readonly reading: boolean;
  /** Where the text goes if it is read now (named in words for a voice that sends it away), or null for a device voice. */
  readonly voiceNote: () => string | null;
  readonly read: (markdown: string) => void;
  readonly stop: () => void;
}

export function useReadAloud(key: string): RowReadAloud {
  const controller = useReadAloudController();
  const settings = useDeviceVoiceSettingsStore();
  const state = useSyncExternalStore(controller.subscribe, controller.getState, () => IDLE);
  const mine = state.key === key ? state : IDLE;
  return {
    supported: controller.supported,
    state: mine,
    reading: mine.status === 'reading',
    // While reading, the voice in use; before, the voice a reading would use: said BEFORE Read aloud is pressed.
    voiceNote: () =>
      mine.status === 'reading'
        ? mine.voiceNote
        : controller.previewVoiceNote(settings === null ? undefined : settings.get().voiceId),
    // The voice, speed and length are read at the tap, so a change in Settings applies to the next reading.
    read: markdown => controller.read(key, markdown, settings === null ? {} : readOptionsOf(settings.get())),
    stop: () => controller.stop(),
  };
}

/** Silence the page's reading when the surface that started it goes away. */
export function useStopReadingOnLeave(scope: string): void {
  const controller = useReadAloudController();
  // biome-ignore lint/correctness/useExhaustiveDependencies: `scope` is the cleanup's trigger: leaving one conversation silences it.
  useEffect(() => () => controller.dismiss(), [controller, scope]);
}
