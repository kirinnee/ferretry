/**
 * LIVE'S QUESTION OUTLIVES ITS COMPOSER. A ferret's structured question replaces the composer with the question
 * form, and Live belongs to the composer: the runner is disposed with it, and the question Live was about to read
 * would never be spoken. This hook is the page's retained reader for that moment — one reading of the question and
 * its options, over the page's ONE read-aloud controller, that does not need the composer.
 *
 * It is a READER and nothing else. The microphone and the sends went with the runner, so while this speaks
 * nothing listens and nothing is sent: the question is read to the person and is never answerable by voice. It
 * ends when the speech does (finished, stopped from the row, failed), when the question is gone (answered), and
 * with the page. While it is active the page's own auto-read stays out of the way (`reading`).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { browserClock, type ClockGlobalLike } from '../lib/voice-chat/clock.ts';
import { createLiveReader, type LiveReadingSource } from '../lib/voice-chat/live-reader.ts';
import { DEFAULT_LIVE_VOICE_SETTINGS } from '../lib/voice-chat/live-settings.ts';
import type { ReaderPort } from '../lib/voice-chat/ports.ts';
import { documentVisibility } from '../lib/voice-chat/visibility.ts';
import { useDeviceVoiceSettingsStore } from './use-live-voice-settings.ts';
import { useReadAloudController } from './use-read-aloud.ts';

export interface LiveQuestionHandoff {
  /** The retained reader is waiting to speak or speaking. */
  readonly reading: boolean;
  /** Read the question now, unless this device cannot speak, the tab is hidden, or a reading is already under way. */
  begin(): void;
  /** End the reading, silently if it has not begun, and stop the voice if it has. */
  cancel(): void;
}

export function useLiveQuestionHandoff(source: LiveReadingSource): LiveQuestionHandoff {
  const controller = useReadAloudController();
  const voiceSettings = useDeviceVoiceSettingsStore();
  const [reading, setReading] = useState(false);
  const current = useRef<ReaderPort | null>(null);
  const latest = useRef({ controller, voiceSettings, source });
  latest.current = { controller, voiceSettings, source };

  const cancel = useCallback((): void => {
    const reader = current.current;
    current.current = null;
    reader?.stop();
    setReading(false);
  }, []);

  const begin = useCallback((): void => {
    const { controller: voice, voiceSettings: settings, source: rows } = latest.current;
    if (current.current !== null || !voice.supported || !documentVisibility(document).visible()) return;
    const reader = createLiveReader({
      controller: voice,
      source: rows,
      settings: () => settings?.get() ?? DEFAULT_LIVE_VOICE_SETTINGS,
      clock: browserClock(globalThis as unknown as ClockGlobalLike),
    });
    current.current = reader;
    setReading(true);
    reader.read('question', () => {
      if (current.current !== reader) return;
      current.current = null;
      setReading(false);
    });
  }, []);

  // The page going away silences the reading (the voice is the page's, and the conversation is left).
  useEffect(
    () => () => {
      const reader = current.current;
      current.current = null;
      reader?.stop();
    },
    [],
  );

  return { reading, begin, cancel };
}
