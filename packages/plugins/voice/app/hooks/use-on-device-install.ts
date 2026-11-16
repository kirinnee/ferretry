/**
 * React binding for one on-device model's install (`lib/stt/on-device-voice.ts`): the live snapshot,
 * re-read from what is stored when a screen mounts. It never downloads.
 */

import { useEffect, useSyncExternalStore } from 'react';
import type { OnDeviceInstallSnapshot, OnDeviceVoice } from '../lib/stt/on-device-voice.ts';

export function useOnDeviceInstall(voice: OnDeviceVoice): OnDeviceInstallSnapshot {
  const snapshot = useSyncExternalStore(voice.subscribe, voice.getSnapshot, voice.getSnapshot);
  useEffect(() => {
    void voice.refresh();
  }, [voice]);
  return snapshot;
}
