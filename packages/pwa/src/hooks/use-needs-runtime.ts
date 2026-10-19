/**
 * WHETHER THIS MACHINE HAS NO RUNTIME, so the empty Sessions list can say what to do about it.
 *
 * It claims nothing until the machine has answered: an unread or unreachable machine is "unknown",
 * never "needs one". It reads again whenever the machine's runtimes or default move, so creating one
 * (here or from another device) clears the prompt without a reload.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { readFleetRuntimes } from '../features/fleet/catalog-api.ts';
import type { FleetClientFactory } from '../features/fleet/fleet-client.ts';
import type { DaemonConnection } from '../lib/daemon-connection.ts';
import { useConfigChangeEffect } from '../lib/store.tsx';

export function useNeedsRuntime(connection: DaemonConnection, createClient: FleetClientFactory | undefined): boolean {
  const [needs, setNeeds] = useState(false);
  const live = useRef(true);
  const current = useRef(connection.daemonId);
  current.current = connection.daemonId;

  const read = useCallback(() => {
    if (createClient === undefined) return;
    const asked = connection.daemonId;
    void createClient(connection)
      .then(async client => await readFleetRuntimes(client))
      .then(catalog => {
        if (live.current && current.current === asked) setNeeds(catalog.runtimes.length === 0);
      })
      .catch(() => undefined);
  }, [connection, createClient]);

  useEffect(() => {
    live.current = true;
    setNeeds(false);
    read();
    return () => {
      live.current = false;
    };
  }, [read]);

  useConfigChangeEffect(connection.daemonId, ['machine', 'runtimes'], read);
  return needs;
}
