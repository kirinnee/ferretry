/**
 * The agenda wire, in React: a probe that reads every paired machine's health (so what it offers is known
 * for machines that are not on screen) and the hooks a surface uses to ask.
 */

import { useSyncExternalStore } from 'react';
import type { DaemonConnection, DaemonId } from './daemon-connection.ts';
import { useOptionalAppStore } from './store.tsx';
import { useDaemonHealth } from './use-daemon-health.ts';

function AgendaWireProbe({ daemon }: { readonly daemon: DaemonConnection }) {
  useDaemonHealth(daemon);
  return null;
}

/** Each probe is the ordinary {@link useDaemonHealth} read, which records what it learns into the store. */
export function AgendaWireProbes({ machines }: { readonly machines: readonly DaemonConnection[] }) {
  return (
    <>
      {machines.map(daemon => (
        <AgendaWireProbe key={daemon.daemonId} daemon={daemon} />
      ))}
    </>
  );
}

/**
 * Whether this machine searches work by words, from the health the app already reads (never a read of its own):
 * `undefined` outside the app store and until health answered.
 */
export function useWorkSearchOffered(daemonId: DaemonId | undefined): boolean | undefined {
  const directory = useOptionalAppStore()?.agendaWire;
  return useSyncExternalStore(directory?.subscribe ?? noWires.subscribe, () =>
    daemonId === undefined ? undefined : directory?.workSearchOf(daemonId),
  );
}

const noWires = { subscribe: () => () => undefined } as const;
