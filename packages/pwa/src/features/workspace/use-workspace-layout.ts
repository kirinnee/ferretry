/**
 * React bindings for the two workspace stores: the per-(daemon, session)
 * layout and the reader's rail widths. Both read through
 * `useSyncExternalStore`, so a commit re-renders exactly the subscribers whose
 * snapshot changed.
 */

import { useCallback, useSyncExternalStore } from 'react';
import type { DaemonSessionScope } from '../../lib/daemon-scope.ts';
import type { WorkspaceLayout } from '../../lib/workspace-layout.ts';
import type { WorkspaceLayoutStore } from '../../lib/workspace-layout-store.ts';
import type {
  WorkspaceRailPreferences,
  WorkspaceRailPreferenceStore,
  WorkspaceRailSide,
} from '../../lib/workspace-rail-preferences.ts';

export interface WorkspaceLayoutBinding {
  readonly layout: WorkspaceLayout;
  /** Persist a layout produced by a pure operation on the current one. */
  readonly setLayout: (next: WorkspaceLayout) => void;
}

export function useWorkspaceLayout(store: WorkspaceLayoutStore, scope: DaemonSessionScope): WorkspaceLayoutBinding {
  const { daemonId, sessionId } = scope;
  const getSnapshot = useCallback(() => store.snapshot({ daemonId, sessionId }), [store, daemonId, sessionId]);
  const layout = useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
  const setLayout = useCallback(
    (next: WorkspaceLayout) => {
      store.update({ daemonId, sessionId }, () => next);
    },
    [store, daemonId, sessionId],
  );
  return { layout, setLayout };
}

export interface WorkspaceRailsBinding {
  readonly rails: WorkspaceRailPreferences;
  readonly setRailWidth: (side: WorkspaceRailSide, width: number) => void;
}

export function useWorkspaceRails(store: WorkspaceRailPreferenceStore): WorkspaceRailsBinding {
  const rails = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  const setRailWidth = useCallback(
    (side: WorkspaceRailSide, width: number) => {
      store.setWidth(side, width);
    },
    [store],
  );
  return { rails, setRailWidth };
}
