/**
 * React binding for Parakeet's install on this device (`lib/stt/parakeet-voice.ts`).
 *
 * `null` — no voice service, as in a static render — reads as unsupported with a sentence, so a screen
 * never has to special-case it.
 */

import { useEffect, useSyncExternalStore } from 'react';
import { PARAKEET_TOTAL_BYTES } from '../lib/stt/parakeet-model.ts';
import type { ParakeetInstallSnapshot, ParakeetVoice } from '../lib/stt/parakeet-voice.ts';

const UNAVAILABLE: ParakeetInstallSnapshot = Object.freeze({
  phase: 'unsupported',
  totalBytes: PARAKEET_TOTAL_BYTES,
  downloadedBytes: 0,
  reason: 'Parakeet is not available in this copy of Ferretry.',
});

const noSubscription = (): (() => void) => () => undefined;
const unavailable = (): ParakeetInstallSnapshot => UNAVAILABLE;

/** The live install snapshot. Re-reads what is stored when a screen mounts, never downloads. */
export function useParakeetInstall(voice: ParakeetVoice | null): ParakeetInstallSnapshot {
  const snapshot = useSyncExternalStore(
    voice?.subscribe ?? noSubscription,
    voice?.getSnapshot ?? unavailable,
    voice?.getSnapshot ?? unavailable,
  );
  useEffect(() => {
    void voice?.refresh();
  }, [voice]);
  return snapshot;
}
