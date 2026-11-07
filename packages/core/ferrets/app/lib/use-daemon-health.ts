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
import { useDaemonClient, useOptionalAppStore } from './store.tsx';

/**
 * @param refreshMs Read again on this period while the page is open, for a caller whose answer changes
 *   without anything on the page happening — the disk filling or draining. Omitted, only a machine change
 *   or the page returning to the foreground re-reads.
 */
export function useDaemonHealth(daemon: DaemonConnection | undefined, refreshMs?: number): DaemonHealthRead {
  const createClient = useDaemonClient();
  const store = useOptionalAppStore();
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

  useEffect(() => {
    if (refreshMs === undefined) return;
    const timer = setInterval(() => setReread(count => count + 1), refreshMs);
    return () => clearInterval(timer);
  }, [refreshMs]);

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
        // Every read teaches the agenda wire which spelling this machine speaks, mounted or not.
        store?.agendaWire.note(daemonId, read);
        if (live) setState({ daemonId, read });
      });
    return () => {
      live = false;
    };
  }, [createClient, store, daemonId, reread]);

  return daemonId !== undefined && state !== null && state.daemonId === daemonId ? state.read : { kind: 'loading' };
}
