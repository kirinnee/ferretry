import { useCallback, useSyncExternalStore } from 'react';
import type { PairedDaemon } from '../daemons/daemon-list.ts';
import { useOptionalShell } from './context.tsx';

/**
 * WHICH OTHER DAEMONS THIS BROWSER IS PAIRED WITH (§5.1, §9.6). A page that names several machines (the Warden page,
 * Catalogs' install targets) reads the list here; the calling plugin's own client on each one comes from
 * `useEveryDaemon` (`every-daemon.ts`, S2), which knows the caller from its plugin identity — no hook takes a package id.
 */

const NONE: readonly PairedDaemon[] = [];
const noSubscription = (): (() => void) => () => {};

/** Every paired daemon, in the list's order, live; empty outside a shell (a harness, a test, a daemon-less screen). */
export function usePairedDaemons(): readonly PairedDaemon[] {
  const runtime = useOptionalShell()?.runtime;
  const subscribe = runtime?.daemons.subscribe ?? noSubscription;
  const snapshot = useCallback(() => runtime?.daemons.snapshot().daemons ?? NONE, [runtime]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
