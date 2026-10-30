/**
 * The agenda wire, in React: a probe that reads every paired machine's health (so the spelling is known
 * for machines that are not on screen) and a hook a surface uses to ask which spelling its machine speaks.
 */

import { useSyncExternalStore } from 'react';
import type { AgendaWire } from './agenda-wire.ts';
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

const noWires = { subscribe: () => () => undefined } as const;

/** The spelling this machine's daemon speaks: the older one outside the app store and until health is read. */
export function useAgendaWire(daemonId: DaemonId): AgendaWire {
  const directory = useOptionalAppStore()?.agendaWire;
  return useSyncExternalStore(
    directory?.subscribe ?? noWires.subscribe,
    () => directory?.wireOf(daemonId) ?? 'attention',
  );
}
