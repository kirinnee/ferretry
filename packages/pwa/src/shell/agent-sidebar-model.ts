/**
 * THE PURE POLICY BEHIND THE PERSISTENT AGENT SIDEBAR. Ported from the
 * non-rendering half of kteam `ui/src/components/AgentSidebar.tsx`.
 *
 * The sidebar is the fleet, always on screen, and it is where the most
 * destructive action in the app lives. Everything here is the part of it that
 * decides rather than draws — gesture thresholds, which menu entries exist, what
 * a bulk stop will hit, which run is still current, and where focus goes when
 * the drawer opens. Kept separate so those contracts are asserted without a
 * browser and so the row and the confirmation cannot drift apart.
 *
 * Daemon scope: nothing here is stored or cached. Every function is given the
 * session list it should reason about, so one daemon's fleet can never leak into
 * another's menu or sweep.
 */

import type { SessionView } from '@ferretry/protocol';
import { sessionActionSpecs, type SessionAction, type SessionActionSpec } from './session-actions.ts';
import { selectStopTargets, stopScopeLabel, stopScopeReason, type StopScope } from './stop-actions.ts';

// ---------------------------------------------------------------------------
// Row gesture policy
//
// A session row is a nav link, NOT selectable prose, so a long-press here is
// free to open a menu — unlike the transcript, where long-press IS selection.
// Desktop opens on the native `contextmenu`; touch opens on a held press. That
// includes Android, which ALSO fires `contextmenu` on a long-press, so both
// paths share one opener and a suppression window stops the trailing tap from
// navigating into the session underneath the menu that just opened.
// ---------------------------------------------------------------------------

/** How long a finger must dwell before the row menu opens. */
export const LONG_PRESS_MS = 500;
/** A press that drifts more than this is a scroll, not a long-press — cancel. */
export const MOVE_CANCEL_PX = 10;
/** After the menu opens from a press, swallow the click the same gesture fires. */
export const CLICK_SUPPRESS_MS = 700;

export interface PressPoint {
  readonly x: number;
  readonly y: number;
}

/** True when a press has drifted far enough to be a scroll rather than a dwell. */
export const cancelsRowLongPress = (start: PressPoint, point: PressPoint): boolean =>
  Math.abs(point.x - start.x) > MOVE_CANCEL_PX || Math.abs(point.y - start.y) > MOVE_CANCEL_PX;

/** True while the click produced by the menu-opening gesture must be ignored. */
export const suppressesRowClick = (firedAt: number, now: number): boolean => now - firedAt < CLICK_SUPPRESS_MS;

// ---------------------------------------------------------------------------
// Row and bulk menu contents
// ---------------------------------------------------------------------------

/** Every row action except `stop`, which the explicit bulk scopes replace. */
export type RowMenuAction = Exclude<SessionAction, 'stop'>;

/**
 * The row menu replaces the formerly opaque one-session Stop with the explicit
 * orphan/cascade/children choices below, so stopping a lead always says what
 * happens to what it spawned.
 */
export const rowMenuActionSpecs = (
  view: SessionView,
  canMutate: boolean,
): readonly (SessionActionSpec & { readonly action: RowMenuAction })[] =>
  sessionActionSpecs(view, canMutate).filter(
    (spec): spec is SessionActionSpec & { readonly action: RowMenuAction } => spec.action !== 'stop',
  );

export interface BulkStopMenuAction {
  readonly scope: StopScope;
  readonly targets: readonly SessionView[];
  readonly label: string;
}

/**
 * Bulk actions follow the same mutation gate as the row actions. Keeping the
 * decision as pure menu data is what stops a read-only connection from rendering
 * a tempting action that would only fail once pressed.
 *
 * The label scope is offered only when the selected session actually carries a
 * label — a "Stop label" entry that could match nothing is worse than absent.
 */
export const bulkStopMenuActions = (
  sessions: readonly SessionView[],
  selectedId: string,
  canMutate: boolean,
): readonly BulkStopMenuAction[] => {
  if (!canMutate) return [];
  const selected = sessions.find(view => view.config.id === selectedId);
  const label = selected?.config.label?.trim();
  return (['orphan', 'cascade', 'children', 'label'] as const)
    .filter(scope => scope !== 'label' || Boolean(label))
    .map(scope => ({
      scope,
      targets: selectStopTargets(sessions, selectedId, scope),
      label: scope === 'label' ? `Stop label “${label!}”` : stopScopeLabel(scope),
    }));
};

// ---------------------------------------------------------------------------
// Bulk stop run identity
// ---------------------------------------------------------------------------

export interface BulkStopOutcome {
  readonly id: string;
  readonly name: string;
  readonly ok: boolean;
  readonly detail?: string;
}

export interface BulkStopRequest {
  readonly token: number;
  readonly selectedId: string;
  readonly scope: StopScope;
  /**
   * The exact non-empty label captured when the confirmation was opened. It
   * stays the durable reason identity even if a fleet refresh changes the
   * selected row before the sweep executes.
   */
  readonly labelIdentity?: string;
  /**
   * The exact targets the person saw and confirmed. Sessions that start matching
   * later are reported after the sweep and need their own confirmation.
   */
  readonly targets: readonly SessionView[];
  /**
   * In orphan mode these are intentionally NOT targets: their parent is being
   * stopped while they are left alive, so the confirmation leads with them.
   */
  readonly orphanedDescendants?: readonly SessionView[];
  readonly running?: boolean;
  readonly outcomes?: readonly BulkStopOutcome[];
  readonly newTargets?: readonly SessionView[];
  readonly newOrphanedDescendants?: readonly SessionView[];
}

/**
 * A stale async completion must not replace a confirmation opened after the
 * original dialog closed. The monotonically increasing token is owned by the
 * sidebar and stays valid while the superseded requests finish.
 */
export const isCurrentBulkRun = (request: BulkStopRequest | null, token: number): request is BulkStopRequest =>
  request?.token === token;

/**
 * The reason belongs to the confirmation, not to a later refresh — in particular
 * a label sweep records the exact label the person saw.
 */
export const bulkStopReason = (request: Pick<BulkStopRequest, 'scope' | 'selectedId' | 'labelIdentity'>): string =>
  stopScopeReason(request.scope, request.scope === 'label' ? request.labelIdentity! : request.selectedId);

/**
 * Follow the viewed session's parent links without trusting the fleet to be
 * acyclic. These are the sessions that would stop an ancestor of what is
 * currently on screen; the active session itself is covered by the stronger
 * caller warning, so it is deliberately not in this set.
 */
export const activeSessionAncestorIds = (
  activeId: string | undefined,
  sessions: readonly SessionView[],
): ReadonlySet<string> => {
  if (!activeId) return new Set();
  const byId = new Map(sessions.map(view => [view.config.id, view]));
  const ancestors = new Set<string>();
  const visited = new Set([activeId]);
  let parentId = byId.get(activeId)?.config.parent?.trim();
  while (parentId && !visited.has(parentId)) {
    ancestors.add(parentId);
    visited.add(parentId);
    parentId = byId.get(parentId)?.config.parent?.trim();
  }
  return ancestors;
};

// ---------------------------------------------------------------------------
// Ordering and focus
// ---------------------------------------------------------------------------

/**
 * The scoped folder group is pinned to the top; everything else keeps its order.
 * A filtered-out scope is simply not present and nothing is pinned.
 *
 * Deliberately generic over "a group with a path" rather than importing the
 * fleet grouping model: the pin is an ORDERING rule and owes nothing to what a
 * group contains, so the sidebar does not take a dependency on a feature screen.
 */
export const pinScopedFirst = <Group extends { readonly path: string }>(
  groups: readonly Group[],
  scope: string | null,
): readonly Group[] => {
  if (scope === null) return groups;
  const index = groups.findIndex(group => group.path === scope);
  if (index <= 0) return groups;
  return [groups[index]!, ...groups.slice(0, index), ...groups.slice(index + 1)];
};

/**
 * Where focus lands when the drawer opens.
 *
 * A touch reader gets the DIALOG, because focusing the search field would raise
 * the on-screen keyboard over the very list they opened the drawer to read. A
 * pointer reader keeps the search-first flow the sidebar has always had.
 *
 * Kept as one small policy so both focus sites change together.
 */
export const drawerFocusPolicy = (
  touchAffected: boolean,
): { readonly dialogAutoFocus: boolean; readonly searchAutoFocus: boolean } => ({
  dialogAutoFocus: touchAffected,
  searchAutoFocus: !touchAffected,
});
