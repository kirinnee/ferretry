/**
 * Whether every paired machine answers, read ONCE per Settings visit and shared by everything that
 * lists machines: the desktop sidebar, the phone's Machines card and the open machine's own header.
 *
 * Machines are listed by name with a status line on both layouts now, so a reach read can no longer
 * wait for somebody to open a switcher. Each machine is asked once when Settings opens — this page's
 * own machine first, because its tabs are waiting on the answer — and again when someone asks, or when
 * the machine on screen says its configuration moved.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DaemonConnectionRecord } from '../../../lib/connections.ts';
import type { DaemonId } from '../../../lib/daemon-connection.ts';
import { useConfigChangeEffect } from '../../../lib/store.tsx';
import type { FleetClientFactory } from '../fleet-client.ts';
import { type MachineReach, readMachineReach, type ShownReach } from './machine-reach.ts';

/** What a machine's own answer says: its settings, its runtimes, and whether its logins are set up. */
const MACHINE_VIEW_KINDS = ['machine', 'runtimes', 'credentials'] as const;

export interface MachineReachOptions {
  /** The machine this Settings page is for; asked first. */
  readonly daemonId: DaemonId;
  readonly connections: readonly DaemonConnectionRecord[];
  /** Absent: nothing is asked, and every machine stays "checking". */
  readonly createClient?: FleetClientFactory | undefined;
  /** Machines whose reads wait on an unlock: shown as locked rather than checking for ever. */
  readonly locked?: readonly DaemonId[];
  /** It answered with the name it goes by. A pairing made before that name was kept learns it here. */
  readonly onNamed?: (daemonId: DaemonId, name: string) => void;
}

export interface MachineReachState {
  readonly reachOf: (daemonId: DaemonId) => ShownReach;
  /** Ask one machine again. */
  readonly check: (daemonId: DaemonId) => void;
}

export function useMachineReach({
  daemonId,
  connections,
  createClient,
  locked = [],
  onNamed,
}: MachineReachOptions): MachineReachState {
  const [reach, setReach] = useState<ReadonlyMap<DaemonId, MachineReach>>(new Map());
  // Held in refs so learning a name — which republishes the connections — never restarts a read.
  const named = useRef(onNamed);
  named.current = onNamed;
  const latest = useRef(connections);
  latest.current = connections;

  const ask = useCallback(
    (connection: DaemonConnectionRecord, quietly = false): void => {
      if (createClient === undefined) return;
      // A quiet re-read keeps the answer on screen until the next one lands, so the machine's tabs do not
      // blink back to "checking" because its configuration moved.
      if (!quietly) setReach(current => new Map(current).set(connection.daemonId, { kind: 'checking' }));
      void readMachineReach(() => createClient(connection)).then(next => {
        setReach(current => new Map(current).set(connection.daemonId, next));
        if (next.kind === 'online') named.current?.(connection.daemonId, next.machine.name);
      });
    },
    [createClient],
  );

  // Keyed by the daemon, not by the record objects: a new connections array with the same pairings must
  // not start a second read of machines that are already being asked.
  const pairedIds = connections.map(connection => String(connection.daemonId)).join('\n');
  useEffect(() => {
    void pairedIds;
    const paired = latest.current;
    const own = paired.find(candidate => candidate.daemonId === daemonId);
    if (own) ask(own);
    for (const connection of paired) if (connection.daemonId !== daemonId) ask(connection);
  }, [ask, daemonId, pairedIds]);

  // This machine's own answer — agent permissions, What agents may control, the default runtime, how
  // many runtimes — is read again the moment the machine says it moved, from wherever it was changed.
  useConfigChangeEffect(daemonId, MACHINE_VIEW_KINDS, () => {
    const own = latest.current.find(candidate => candidate.daemonId === daemonId);
    if (own) ask(own, true);
  });

  const lockedNow = new Set(locked);
  const reachOf = (id: DaemonId): ShownReach =>
    lockedNow.has(id) ? { kind: 'locked' } : (reach.get(id) ?? { kind: 'checking' });
  const check = (id: DaemonId): void => {
    const connection = latest.current.find(candidate => candidate.daemonId === id);
    if (connection) ask(connection);
  };
  return { reachOf, check };
}
