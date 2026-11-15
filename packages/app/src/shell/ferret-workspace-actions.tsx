/**
 * WHAT A PANEL OF A FERRET'S PAGE MAY ASK ITS WORKSPACE FOR (v4's workspace `openFile` controller, which opens a file AND
 * focuses it): to bring another panel of the SAME ferret on screen. On a desktop every `ferret.side` panel is already beside
 * the chat, so showing one is nothing; on a phone the workspace shows one panel behind a chip row, so the request moves the
 * chip (`ferret-workspace.tsx`).
 *
 * It is scoped to one ferret on one daemon: the provider names both, and a panel acts only when the ferret it draws for is the
 * ferret the workspace shows, so a request can never bring up a panel of another ferret's page.
 */
import { createContext, type ReactNode, useContext, useMemo } from 'react';

export interface FerretWorkspaceActions {
  readonly daemon: string;
  /** The ferret this workspace is the page of. */
  readonly ferret: string;
  /**
   * Whether this connection may control that ferret. `ferret.side` panels are handed the ferret's id only
   * (`PanelProps.subject`), so a panel that offers a write (MCP's "Add…") reads it here, as the actions-row slot reads
   * `canControl` from its props. It only decides what is OFFERED: the daemon refuses the write all the same.
   */
  readonly canControl: boolean;
  /** Brings the panel with this id (`files`) on screen. A panel the layout does not place is ignored. */
  readonly showPanel: (panelId: string) => void;
}

const WorkspaceActions = createContext<FerretWorkspaceActions | null>(null);

export function FerretWorkspaceActionsProvider({
  daemon,
  ferret,
  canControl,
  showPanel,
  children,
}: FerretWorkspaceActions & { readonly children: ReactNode }) {
  const value = useMemo(() => ({ daemon, ferret, canControl, showPanel }), [daemon, ferret, canControl, showPanel]);
  return <WorkspaceActions.Provider value={value}>{children}</WorkspaceActions.Provider>;
}

/** The workspace around a panel, or null outside one (a suite, a detached box). */
export const useFerretWorkspace = (): FerretWorkspaceActions | null => useContext(WorkspaceActions);
