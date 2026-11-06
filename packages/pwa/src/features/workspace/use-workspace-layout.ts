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
