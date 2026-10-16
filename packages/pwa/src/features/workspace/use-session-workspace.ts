/**
 * THE SESSION PAGE'S WORKSPACE CONTROLLER: one agent's remembered layout, and every way something
 * outside the workspace opens a tab in it.
 *
 * A reference chip in the transcript, a Docs row in the context rail, a file picked in the Files
 * picker and the session search all open a file the same way, through `openFile` here — which is
 * `jumpToWorkspaceReference` on the stored layout plus the line range the click carried. That is why
 * this is a hook the page owns rather than state inside the workspace view: the reference surface is
 * built above the view, and it must reach the same layout the view draws.
 */

import { useCallback, useMemo, useState } from 'react';
import type { DaemonSessionScope } from '../../lib/daemon-scope.ts';
import {
  activateWorkspaceTab,
  jumpToWorkspaceReference,
  openWorkspaceTab,
  type WorkspaceLayout,
  type WorkspaceTabId,
  workspaceTab,
} from '../../lib/workspace-layout.ts';
import type { WorkspaceLayoutStore } from '../../lib/workspace-layout-store.ts';
import type {
  SidePaneFileSelection,
  SidePaneInstanceKind,
  SidePaneTabInstance,
} from '../../shell/side-pane-tab-model.ts';
import { useWorkspaceLayout } from './use-workspace-layout.ts';

/**
 * The key of the one Files tab that is a PICKER rather than a file: `file:.` is the agent's own
 * folder, so the tab reads as what it is, and ＋ › Open file has a real browser to open into.
 */
export const WORKSPACE_FILES_PICKER_KEY = '.';

interface FileDelivery {
  readonly selection?: SidePaneFileSelection;
  readonly revision: number;
}

export interface SessionWorkspaceController {
  readonly scope: DaemonSessionScope;
  readonly layout: WorkspaceLayout;
  readonly setLayout: (next: WorkspaceLayout) => void;
  /** Opens (or focuses) a file's tab, scrolled to `selection` when one was delivered. */
  readonly openFile: (path: string, selection?: SidePaneFileSelection) => void;
  /** Opens (or focuses) a terminal or browser tab — a `%terminal:` / `%browser:` chip's target. */
  readonly openSurface: (kind: Exclude<SidePaneInstanceKind, 'file'>, key: string, label?: string) => void;
  /** ＋ › Open file: the agent's folder, browsable, in a Files tab. */
  readonly openFilePicker: () => void;
  /** Selects Chat or Console in the agent pane. */
  readonly showAgentTab: (tabId: WorkspaceTabId) => void;
  /** What a file tab's body needs: its path and the latest line range delivered to it. */
  readonly fileInstance: (path: string) => SidePaneTabInstance;
}

const basename = (path: string): string => path.split('/').filter(Boolean).pop() ?? path;

export function useSessionWorkspace(
  store: WorkspaceLayoutStore,
  scope: DaemonSessionScope,
): SessionWorkspaceController {
  const { layout, setLayout } = useWorkspaceLayout(store, scope);
  // Keyed by the scope as well as the path: a delivery for one agent's file must never scroll another
  // agent's tab of the same name, and nothing here outlives the page that holds it.
  const [deliveries, setDeliveries] = useState<Readonly<Record<string, FileDelivery>>>({});
  const scopeKey = `${scope.daemonId}\u0000${scope.sessionId}`;
  const update = useCallback(
    (operation: (current: WorkspaceLayout) => WorkspaceLayout): void => {
      store.update(scope, operation);
    },
    [store, scope],
  );

  const openFile = useCallback(
    (path: string, selection?: SidePaneFileSelection): void => {
      setDeliveries(current => {
        const key = `${scopeKey}\u0000${path}`;
        const revision = (current[key]?.revision ?? 0) + 1;
        return { ...current, [key]: selection === undefined ? { revision } : { selection, revision } };
      });
      update(current => jumpToWorkspaceReference(current, { kind: 'file', key: path }));
    },
    [scopeKey, update],
  );

  const openSurface = useCallback(
    (kind: Exclude<SidePaneInstanceKind, 'file'>, key: string, label?: string): void => {
      update(current => jumpToWorkspaceReference(current, { kind, key, ...(label === undefined ? {} : { label }) }));
    },
    [update],
  );

  const openFilePicker = useCallback((): void => {
    update(current =>
      openWorkspaceTab(
        current,
        workspaceTab('file', WORKSPACE_FILES_PICKER_KEY, { label: 'Files', title: "Browse the agent's folder" }),
      ),
    );
  }, [update]);

  const showAgentTab = useCallback(
    (tabId: WorkspaceTabId): void => update(current => activateWorkspaceTab(current, tabId)),
    [update],
  );

  const fileInstance = useCallback(
    (path: string): SidePaneTabInstance => {
      const delivery = deliveries[`${scopeKey}\u0000${path}`];
      return {
        id: `file:${path}`,
        kind: 'file',
        key: path,
        label: basename(path),
        title: path,
        order: 0,
        revision: delivery?.revision ?? 0,
        ...(delivery?.selection === undefined ? {} : { selection: delivery.selection }),
      };
    },
    [deliveries, scopeKey],
  );

  return useMemo(
    () => ({ scope, layout, setLayout, openFile, openSurface, openFilePicker, showAgentTab, fileInstance }),
    [scope, layout, setLayout, openFile, openSurface, openFilePicker, showAgentTab, fileInstance],
  );
}
