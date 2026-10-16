/**
 * WHO IS DRIVING A WORKSPACE TAB — the one seam the AGENT marker and Take over / Hand back read.
 *
 * STUB UNTIL STREAM T'S DRIVING API. The daemon does not yet say which terminal or browser an agent is
 * typing into, so this answers "nobody, nothing taken over" for every tab and its two intents do
 * nothing. Everything downstream — the AGENT badge on a tab, the "‹name› is typing here" pill, the
 * phone chip's badge — is already wired to it, so the real answer replaces this one hook and no
 * caller changes. It takes the scope it will need then, so that change is a body, not a signature.
 */

import type { DaemonSessionScope } from '../../lib/daemon-scope.ts';
import type { WorkspaceTabId } from '../../lib/workspace-layout.ts';
import type { AgentControlDriver } from './agent-control-marker.tsx';

export interface SurfaceDriving {
  /** Tabs an agent is driving right now: the strip badges these AGENT. */
  readonly drivenTabIds: ReadonlySet<WorkspaceTabId>;
  readonly driverFor: (tabId: WorkspaceTabId) => AgentControlDriver | null;
  readonly takenOver: (tabId: WorkspaceTabId) => boolean;
  readonly takeOver: (tabId: WorkspaceTabId) => void;
  readonly handBack: (tabId: WorkspaceTabId) => void;
}

/** Nobody drives anything: the only true answer while the daemon reports no driving. */
export const NO_SURFACE_DRIVING: SurfaceDriving = Object.freeze({
  drivenTabIds: new Set<WorkspaceTabId>(),
  driverFor: () => null,
  takenOver: () => false,
  takeOver: () => undefined,
  handBack: () => undefined,
});

/** Stub until stream T's driving API: see the module comment. */
export function useSurfaceDriving(_scope: DaemonSessionScope): SurfaceDriving {
  return NO_SURFACE_DRIVING;
}
