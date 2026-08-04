/**
 * ONE DAEMON'S FLEET, AS A SCREEN READS IT.
 *
 * Ports the read half of kteam's store hooks — `useFleet`, `useSessions` and
 * `useUiControls` (`ui/src/lib/store.tsx:709-805`) — onto the two external
 * stores Ferretry already has: `DaemonFleetStore` for the sessions and
 * `DaemonControlsStore` for the filters and the folder scope.
 *
 * WHAT CHANGED — survey rows 35-37 and 48.
 *
 * kteam's hooks read module singletons and returned "the" fleet. There was no
 * daemon to name because there was only ever one. Here the daemon is a REQUIRED
 * argument, and every value the hook returns is derived from that daemon's
 * slice and that daemon's controls. A component that has not decided which
 * daemon it is showing cannot call this hook at all, which is the failure we
 * want and the reason there is no "current daemon" default.
 *
 * NO DERIVED CACHE. Both stores are read through `useSyncExternalStore`, which
 * requires `getSnapshot` to return an identity-stable value — so the snapshots
 * come straight from the stores (both already cache and replace rather than
 * mutate), and the grouping is derived in a `useMemo` keyed on those
 * identities. Nothing is memoised across daemons: switching daemon changes the
 * slice identity and the controls identity together, so the previous daemon's
 * grouping cannot survive the switch. That is the whole point — a fleet view
 * that outlived its daemon would show one daemon's sessions under another's
 * folder scope.
 *
 * SCOPE RECOVERY IS AN EFFECT, NOT A RENDER. `fleetView` reports that a stored
 * scope named no folder this daemon knows; acting on it means writing to the
 * controls store, which is a side effect and belongs in `useEffect`. The render
 * already shows the recovered (unscoped) fleet, so the write is bookkeeping
 * that catches the persisted record up — never something the reader waits for.
 *
 * It is also guarded on `slice.sessions !== null`. A scope must never be
 * cleared on the strength of a list that has not arrived, or a reader's folder
 * choice evaporates on every reload; `fleetView` already reports
 * `scopeRecovered: false` while a read is in flight, and this hook does not
 * second-guess that.
 */

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { DaemonControlsStore, UiControls } from '../lib/controls.ts';
import type { DaemonId } from '../lib/daemon-connection.ts';
import { type FleetProject, type FleetView, fleetView } from '../lib/fleet-grouping.ts';
import type { DaemonFleetSlice, DaemonFleetStore, FleetSnapshot } from '../lib/fleet-store.ts';

const IDLE_SLICE: DaemonFleetSlice = Object.freeze({
  sessions: null,
  byId: new Map(),
  status: 'idle' as const,
  error: null,
});

/** A stable identity for callers that do not mount the daemon project registry. */
const NO_PROJECTS: readonly FleetProject[] = Object.freeze([]);

export interface FleetViewOptions {
  readonly fleet: DaemonFleetStore;
  readonly controls: DaemonControlsStore;
  /** Which paired daemon this screen is showing. Never optional. */
  readonly daemonId: DaemonId;
  /**
   * Folders this daemon has deliberately registered. Unregistered sessions
   * group by cwd basename without becoming projects.
   */
  readonly projects?: readonly FleetProject[];
  /** Most-recent-first inside each group: what the sidebar wants, not the table. */
  readonly sortRows?: boolean;
}

export interface FleetViewResult extends FleetView {
  /** This daemon's slice, for the loading and error states a screen renders. */
  readonly slice: DaemonFleetSlice;
  /** This daemon's merged controls, so a screen need not read the store twice. */
  readonly controls: UiControls;
}

/**
 * Subscribes to one daemon's fleet and controls, and returns everything a fleet
 * screen renders: the scoped-and-filtered sessions, their project groups, the
 * folder list, the mode-segment counts, and the scope actually in force.
 */
export const useFleetView = (options: FleetViewOptions): FleetViewResult => {
  const { fleet, controls, daemonId, projects = NO_PROJECTS, sortRows = false } = options;

  const snapshot: FleetSnapshot = useSyncExternalStore(
    listener => fleet.subscribe(listener),
    () => fleet.getSnapshot(),
    () => fleet.getSnapshot(),
  );
  const record = useSyncExternalStore(
    listener => controls.subscribe(listener),
    () => controls.snapshot(),
    () => controls.snapshot(),
  );

  // `record` is the subscription's identity token; the merged per-daemon value
  // is what the grouping actually reads, and the store caches it per daemon.
  const merged = useMemo(() => {
    void record;
    return controls.controls(daemonId);
  }, [controls, daemonId, record]);

  const slice = snapshot.daemons.get(daemonId) ?? IDLE_SLICE;
  const view = useMemo(() => fleetView(slice, projects, merged, sortRows), [slice, projects, merged, sortRows]);

  useEffect(() => {
    if (view.scopeRecovered) controls.setControls(daemonId, { projectScope: null });
  }, [controls, daemonId, view.scopeRecovered]);

  return useMemo(() => ({ ...view, slice, controls: merged }), [view, slice, merged]);
};
