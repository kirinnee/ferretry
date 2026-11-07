/**
 * WHICH PAIRED MACHINES HAVE AN UPDATE — the small dot beside a machine in Settings' machine list.
 *
 * Read ONCE per Settings visit per machine, like the machine's reach (`use-machine-reach.ts`), through
 * the same client pool. It is a hint and never a decision: a machine that does not answer, one too old
 * to have the route (`404`), and one waiting on an unlock simply show no dot. A locked machine is not
 * asked at all, because a background read there would queue behind its passkey prompt for nothing.
 */

import { DaemonUpdateViewSchema, HarnessUpdateViewSchema } from '@ferretry/protocol';
import { useEffect, useRef, useState } from 'react';
import type { DaemonConnectionRecord } from '../../lib/connections.ts';
import type { DaemonId } from '../../lib/daemon-connection.ts';
import type { FleetClientFactory } from '../fleet/fleet-client.ts';

/** The route the dot reads; the same one Settings › Machine › About reads in full. */
export const DAEMON_UPDATE_PATH = '/v1/daemon/update';

/** The agent CLIs' view, read on the same visit: opening Settings is when npm is asked, never a timer. */
export const HARNESS_UPDATE_PATH = '/v1/harnesses/update';

export interface MachineUpdatesOptions {
  readonly connections: readonly DaemonConnectionRecord[];
  readonly createClient?: FleetClientFactory | undefined;
  readonly locked?: readonly DaemonId[];
}

/** The machines whose answer said a newer release of the daemon, or of an agent CLI it runs, exists. */
export function useMachineUpdates({
  connections,
  createClient,
  locked = [],
}: MachineUpdatesOptions): ReadonlySet<DaemonId> {
  const [available, setAvailable] = useState<ReadonlySet<DaemonId>>(new Set());
  const latest = useRef(connections);
  latest.current = connections;
  const skipped = useRef(locked);
  skipped.current = locked;

  // Keyed by the paired ids, so a republished list of the same pairings does not ask again.
  const pairedIds = connections.map(connection => String(connection.daemonId)).join('\n');
  useEffect(() => {
    void pairedIds;
    if (createClient === undefined) return;
    let current = true;
    const lockedNow = new Set(skipped.current);
    for (const connection of latest.current) {
      if (lockedNow.has(connection.daemonId)) continue;
      const mark = (): void => {
        if (current) setAvailable(previous => new Set(previous).add(connection.daemonId));
      };
      const client = createClient(connection);
      void client
        .then(async active => await active.request(DAEMON_UPDATE_PATH, DaemonUpdateViewSchema))
        .then(view => {
          if (view.available) mark();
        })
        .catch(() => undefined);
      // Separately, so a machine too old for this route (`404`) still shows its daemon's dot.
      void client
        .then(async active => await active.request(HARNESS_UPDATE_PATH, HarnessUpdateViewSchema))
        .then(view => {
          if (view.harnesses.some(harness => harness.available)) mark();
        })
        .catch(() => undefined);
    }
    return () => {
      current = false;
    };
  }, [createClient, pairedIds]);

  return available;
}
