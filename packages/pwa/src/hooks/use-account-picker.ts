/** Hydrate and read exactly one daemon's pickable account catalog. */

import { useEffect, useSyncExternalStore } from 'react';
import type { DaemonAccountPickerSlice, DaemonAccountPickerStore } from '../lib/account-picker-store.ts';
import type { DaemonConnection } from '../lib/daemon-connection.ts';

export const useAccountPickerSlice = (
  store: DaemonAccountPickerStore,
  daemon: DaemonConnection,
): DaemonAccountPickerSlice => {
  // Re-pairing may keep the daemon id while replacing its credential. Reset
  // that generation during render so the previous roster is never painted for
  // even one frame under the new connection.
  store.sliceFor(daemon);
  useEffect(() => {
    void store.hydrate(daemon).catch(() => {});
  }, [store, daemon]);
  return useSyncExternalStore(
    store.subscribe,
    () => store.slice(daemon.daemonId),
    () => store.slice(daemon.daemonId),
  );
};
