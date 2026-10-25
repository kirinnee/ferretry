/**
 * THE MACHINE'S HEALTH, read for the features it offers (`daemon-health.ts` decides what that means).
 *
 * Read when the machine changes and again whenever this page comes back to the foreground — an owner
 * who runs `fy daemon update` in another window should not have to reload to see the longer limit.
 */

import { HealthViewSchema } from '@ferretry/protocol';
import { useEffect, useRef, useState } from 'react';
import type { DaemonConnection } from './daemon-connection.ts';
import type { DaemonHealthRead } from './daemon-health.ts';
import { useDaemonClient } from './store.tsx';

export function useDaemonHealth(daemon: DaemonConnection | undefined): DaemonHealthRead {
  const createClient = useDaemonClient();
  const [state, setState] = useState<{ readonly daemonId: string; readonly read: DaemonHealthRead } | null>(null);
  const [reread, setReread] = useState(0);
  const latest = useRef(daemon);
  latest.current = daemon;
  const daemonId = daemon?.daemonId;

  useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') setReread(count => count + 1);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `reread` is the re-read trigger
  useEffect(() => {
    const target = latest.current;
    if (daemonId === undefined || target === undefined) return;
    let live = true;
    void createClient(target)
      .then(async client => await client.request('/v1/health', HealthViewSchema))
      .then(
        (health): DaemonHealthRead => ({ kind: 'read', health }),
        (): DaemonHealthRead => ({ kind: 'failed' }),
      )
      .then(read => {
        if (live) setState({ daemonId, read });
      });
    return () => {
      live = false;
    };
  }, [createClient, daemonId, reread]);

  return daemonId !== undefined && state !== null && state.daemonId === daemonId ? state.read : { kind: 'loading' };
}
