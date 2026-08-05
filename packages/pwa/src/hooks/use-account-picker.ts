/** Hydrate and read exactly one daemon's pickable account catalog. */

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { DaemonAccountPickerSlice, DaemonAccountPickerStore } from '../lib/account-picker-store.ts';
import type { DaemonConnection } from '../lib/daemon-connection.ts';

export const useAccountPickerSlice = (
  store: DaemonAccountPickerStore,
  daemon: DaemonConnection,
): DaemonAccountPickerSlice => {
  const getSnapshot = useCallback(() => store.sliceFor(daemon), [store, daemon]);
  useEffect(() => {
    void store.hydrate(daemon).catch(() => {});
  }, [store, daemon]);
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
};
