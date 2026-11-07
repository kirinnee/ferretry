/** Hydrate and read exactly one daemon's pickable account catalog. */

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { PickerAccount } from '../lib/account-picker-catalog.ts';
import type { DaemonAccountPickerSlice, DaemonAccountPickerStore } from '../lib/account-picker-store.ts';
import type { DaemonConnection, DaemonId } from '../lib/daemon-connection.ts';
import { useConfigChangeEffect } from '../lib/store.tsx';
import { pairingKey } from './use-machines-poll.ts';

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

/** Every listed machine's roster, by machine; a machine whose roster is unread is absent. */
export type MachineRosters = ReadonlyMap<DaemonId, readonly PickerAccount[]>;

/**
 * EVERY listed machine's roster, for the list across machines: each read through its own pairing and kept
 * under its own id, so a full row on any machine names its account from THAT machine's roster — never
 * from the one on screen, whose wrapper ids mean something else.
 */
export const useMachineRosters = (
  store: DaemonAccountPickerStore,
  machines: readonly DaemonConnection[],
): MachineRosters => {
  const latest = useRef(machines);
  latest.current = machines;
  const key = pairingKey(machines);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the pairings' facts are the deliberate key
  useEffect(() => {
    for (const machine of latest.current) void store.hydrate(machine).catch(() => {});
  }, [store, key]);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the snapshot is the deliberate trigger
  return useMemo(() => {
    const rosters = new Map<DaemonId, readonly PickerAccount[]>();
    for (const machine of latest.current) {
      const accounts = store.sliceFor(machine).catalog?.accounts;
      if (accounts !== undefined) rosters.set(machine.daemonId, accounts);
    }
    return rosters;
  }, [store, snapshot, key]);
};
