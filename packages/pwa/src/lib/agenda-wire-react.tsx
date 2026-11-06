/**
 * The agenda wire, in React: a probe that reads every paired machine's health, so what it offers is known
 * for machines that are not on screen.
 */

import type { DaemonConnection } from './daemon-connection.ts';
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
