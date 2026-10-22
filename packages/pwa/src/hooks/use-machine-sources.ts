/**
 * EVERY PAIRED MACHINE, AS THE ALL-MACHINES LIST READS IT: each one's session slice, its project
 * registry and how it is reached, in display order.
 *
 * Three per-machine stores already hold all of it — the fleet cache, the project registry and the
 * connection health model (#553) — each keyed by `DaemonId`, so this only reads them together. It
 * hydrates each machine's projects once (the same coalesced read the sessions bar makes for one), and
 * every read goes through that machine's own pairing.
 *
 * The health read is one subscription per machine, folded into one snapshot that keeps its identity
 * while no machine's fact changed — `useSyncExternalStore` re-renders on every new identity.
 */

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { type MachineSource, machineReach } from '../lib/all-machines.ts';
import type { ConnectionHealth, ConnectionHealthState } from '../lib/connection-health.ts';
import type { DaemonConnection, DaemonId } from '../lib/daemon-connection.ts';
import type { DaemonFleetSlice, DaemonFleetStore } from '../lib/fleet-store.ts';
import type { DaemonProjectsStore } from '../lib/projects-store.ts';

/** One machine to list: its pairing and the name the reader knows it by. */
export interface ListedMachine {
  readonly connection: DaemonConnection;
  readonly name: string;
}

export interface MachineSourceStores {
  readonly fleet: DaemonFleetStore;
  readonly projects: DaemonProjectsStore;
  readonly connectionHealth: ConnectionHealth;
}

const UNREAD: DaemonFleetSlice = Object.freeze({
  sessions: null,
  byId: new Map(),
  status: 'idle' as const,
  error: null,
});

const UNMEASURED: ConnectionHealthState = { kind: 'unknown' };

/**
 * Every listed machine's health fact, as one identity-stable array in the same order. The shell's
 * connection notice reads every paired machine through it too, so one machine's outage is counted
 * wherever it is said.
 */
export const useHealthStates = (
  health: ConnectionHealth,
  ids: readonly DaemonId[],
): readonly ConnectionHealthState[] => {
  const key = ids.join('\u0001');
  const cached = useRef<readonly ConnectionHealthState[]>([]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the joined ids are the deliberate key
  const subscribe = useCallback(
    (listener: () => void) => {
      const releases = ids.map(id => health.subscribe(id, listener));
      return () => {
        for (const release of releases) release();
      };
    },
    [health, key],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: the joined ids are the deliberate key
  const snapshot = useCallback(() => {
    const next = ids.map(id => health.state(id));
    const previous = cached.current;
    if (previous.length === next.length && next.every((state, index) => state === previous[index])) return previous;
    cached.current = next;
    return next;
  }, [health, key]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
};

export function useMachineSources(
  stores: MachineSourceStores,
  machines: readonly ListedMachine[],
  locked: readonly DaemonId[] = [],
): readonly MachineSource[] {
  const { fleet, projects, connectionHealth } = stores;
  const fleetSnapshot = useSyncExternalStore(
    useCallback(listener => fleet.subscribe(listener), [fleet]),
    useCallback(() => fleet.getSnapshot(), [fleet]),
  );
  const projectsSnapshot = useSyncExternalStore(projects.subscribe, projects.getSnapshot, projects.getSnapshot);
  const ids = machines.map(machine => machine.connection.daemonId);
  const health = useHealthStates(connectionHealth, ids);
  const pairings = machines
    .map(({ connection }) => `${connection.daemonId}\u0000${connection.baseUrl}\u0000${connection.deviceId}`)
    .join('\u0001');
  const latest = useRef(machines);
  latest.current = machines;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the pairings' facts are the deliberate key
  useEffect(() => {
    // A failed registry read is that machine's own slice status; its sessions group by folder instead.
    for (const { connection } of latest.current) void projects.hydrate(connection).catch(() => undefined);
  }, [projects, pairings]);
  const lockedKey = locked.join('\u0001');
  const names = machines.map(machine => machine.name).join('\u0001');
  // biome-ignore lint/correctness/useExhaustiveDependencies: the snapshots and joined keys are the deliberate inputs
  return useMemo(
    () =>
      latest.current.map((machine, index): MachineSource => {
        const { daemonId } = machine.connection;
        const slice = fleetSnapshot.daemons.get(daemonId) ?? UNREAD;
        const state = health[index] ?? UNMEASURED;
        return {
          daemonId,
          name: machine.name,
          slice,
          projects: projects.projects(daemonId),
          reach: machineReach(state, slice, locked.includes(daemonId)),
          health: state,
        };
      }),
    [fleetSnapshot, projectsSnapshot, health, lockedKey, names, pairings, projects],
  );
}
