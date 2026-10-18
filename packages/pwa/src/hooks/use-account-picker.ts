/** Hydrate and read exactly one daemon's pickable account catalog. */

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { DaemonAccountPickerSlice, DaemonAccountPickerStore } from '../lib/account-picker-store.ts';
import type { DaemonConnection } from '../lib/daemon-connection.ts';
import { useConfigChangeEffect } from '../lib/store.tsx';

/** The roster is the machine's runtimes; its health is each login's state. */
const PICKER_KINDS = ['credentials', 'runtimes'] as const;

export const useAccountPickerSlice = (
  store: DaemonAccountPickerStore,
  daemon: DaemonConnection,
): DaemonAccountPickerSlice => {
  const getSnapshot = useCallback(() => store.sliceFor(daemon), [store, daemon]);
  useEffect(() => {
    void store.hydrate(daemon).catch(() => {});
  }, [store, daemon]);
  // The roster was read once per pairing, so a runtime added anywhere else never reached the picker
  // until the app was reloaded. It is read again the moment the machine says it moved.
  useConfigChangeEffect(daemon.daemonId, PICKER_KINDS, () => store.reread(daemon));
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
};
