/**
 * One paired daemon's registered folders, hydrated once and read as a slice.
 *
 * This is the missing input to `useFleetView({ projects })`, which until now
 * always received the shared empty because no daemon served `/v1/projects`.
 * With a real list the registered-path branch of `projectKeyFor` starts
 * deciding which of two NESTED folders a worktree belongs to, and
 * `useProjectScope`'s missing-folder recovery can tell "that folder is gone"
 * from "that folder currently has no sessions".
 *
 * The daemon is a required argument for the same reason it is everywhere else:
 * `/home/k/ferretry` on a laptop and on a workstation are different checkouts,
 * so there is no daemon-free read to reach past.
 */

import { useEffect, useSyncExternalStore } from 'react';
import type { DaemonConnection, DaemonId } from '../lib/daemon-connection.ts';
import type { FleetProject } from '../lib/fleet-grouping.ts';
import type { DaemonProjectsSlice, DaemonProjectsStore } from '../lib/projects-store.ts';

/** Hydrates this daemon's catalog and returns its slice. */
export const useProjectsSlice = (store: DaemonProjectsStore, daemon: DaemonConnection): DaemonProjectsSlice => {
  useEffect(() => {
    // A failed catalog read is a slice status, not something a mount rethrows.
    void store.hydrate(daemon).catch(() => {});
  }, [store, daemon]);
  return useSyncExternalStore(
    store.subscribe,
    () => store.slice(daemon.daemonId),
    () => store.slice(daemon.daemonId),
  );
};

/**
 * The rows `useFleetView` consumes. Identity-stable while unread, so passing
 * this straight into the fleet view cannot re-group on every render.
 */
export const useProjects = (store: DaemonProjectsStore, daemon: DaemonConnection): readonly FleetProject[] => {
  useProjectsSlice(store, daemon);
  return store.projects(daemon.daemonId);
};

/** Reads what is already known without hydrating anything. */
export const useKnownProjects = (store: DaemonProjectsStore, daemonId: DaemonId): readonly FleetProject[] => {
  useSyncExternalStore(
    store.subscribe,
    () => store.slice(daemonId),
    () => store.slice(daemonId),
  );
  return store.projects(daemonId);
};
