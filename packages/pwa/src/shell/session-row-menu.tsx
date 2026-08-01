/**
 * THE SIDEBAR'S ONE HOSTED ROW MENU. Ported from `SessionRowMenuLayer` in
 * kteam `ui/src/components/AgentSidebar.tsx`.
 *
 * Hosted ONCE for the whole sidebar rather than per row: a fleet is hundreds of
 * rows, and a menu (with its own Escape layer and outside-click listener) per
 * row would be hundreds of listeners for a thing only ever open once. Rows ask
 * this to open through {@link OpenSessionMenu}; it rebuilds the entries for
 * whichever session was picked.
 *
 * WHAT IT OFFERS, and why the split matters: the per-session actions come from
 * `session-actions.ts` MINUS `stop`, which is replaced by the explicit
 * orphan/cascade/children/label scopes. kteam retired the one-session Stop
 * because it never said what happened to the sessions that session had spawned;
 * every entry here names its blast radius, and carries the target count as the
 * menu detail so the scope is legible BEFORE activation, not after.
 *
 * WHAT CHANGED — survey row #4. kteam gated the menu on `HAS_TOKEN`, a module
 * global captured once when `lib/api` evaluated, so one backend's authority
 * governed every row on the tab. Here a browser is paired with several daemons
 * at once, so `canMutate` is a property of the CONNECTION the row belongs to and
 * arrives as a prop. A read-only connection produces no items and the menu never
 * opens, so a tempting action that could only fail is never drawn.
 *
 * Rename and Migrate are entry points ONLY. This never performs them and never
 * bypasses their confirmations: it reports the choice and the owner renders the
 * sheet. Both sheets are now exported; a production owner still waits on the
 * repository-wide app-root/composition work, so this menu cannot mount them.
 */

import type { SessionView } from '@ferretry/protocol';
import { Pause, Pencil, Play, ServerCog, StopCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import { displayCallsign } from '../lib/callsign.ts';
import { bulkStopMenuActions, type RowMenuAction, rowMenuActionSpecs } from './agent-sidebar-model.ts';
import { ContextMenu, type ContextMenuItem } from './context-menu.tsx';
import type { StopScope } from './stop-actions.ts';

/** Where the sidebar's menu is currently open, and for whom. */
export interface SessionRowMenuState {
  readonly view: SessionView;
  readonly x: number;
  readonly y: number;
}

const ACTION_ICON: Record<RowMenuAction, ReactNode> = {
  interrupt: <Pause size={13} aria-hidden="true" />,
  resume: <Play size={13} aria-hidden="true" />,
  rename: <Pencil size={13} aria-hidden="true" />,
  migrate: <ServerCog size={13} aria-hidden="true" />,
};

/** A session named the way the fleet talks about it, for the menu's accessible name. */
export const sessionMenuLabel = (view: SessionView): string =>
  `Actions for ${displayCallsign(view.config.teammate) || view.config.name || view.config.id}`;

export interface SessionRowMenuCallbacks {
  /** A per-session action other than a stop — the owner runs or opens it. */
  readonly onRun: (view: SessionView, action: RowMenuAction) => void;
  /** A bulk stop scope was chosen; the owner opens the confirmation for it. */
  readonly onBulkStop: (selectedId: string, scope: StopScope) => void;
}

/**
 * The menu contents for one session. Exported separately from the component
 * because WHAT a destructive menu offers is the part worth asserting, and it can
 * be asserted without a pointer, a viewport or a layout pass.
 */
export const sessionRowMenuItems = (
  view: SessionView,
  sessions: readonly SessionView[],
  canMutate: boolean,
  { onRun, onBulkStop }: SessionRowMenuCallbacks,
): readonly ContextMenuItem[] => [
  ...rowMenuActionSpecs(view, canMutate).map(spec => ({
    key: spec.action,
    label: spec.label,
    danger: spec.danger,
    icon: ACTION_ICON[spec.action],
    onSelect: () => onRun(view, spec.action),
  })),
  ...bulkStopMenuActions(sessions, view.config.id, canMutate).map(({ scope, targets, label }) => ({
    key: `bulk-${scope}`,
    label,
    // The count is the whole point: "Stop cascade" and "Stop cascade · 12
    // sessions" are very different offers.
    detail: `${targets.length} ${targets.length === 1 ? 'session' : 'sessions'}`,
    danger: true,
    icon: <StopCircle size={13} aria-hidden="true" />,
    // A scope that would hit nothing is shown and disabled rather than hidden,
    // so the menu's shape does not shift under a finger between two rows.
    disabled: targets.length === 0,
    onSelect: () => onBulkStop(view.config.id, scope),
  })),
];

export interface SessionRowMenuProps extends SessionRowMenuCallbacks {
  readonly state: SessionRowMenuState | null;
  /** The fleet the bulk scopes reason over — already scoped to one daemon by the caller. */
  readonly sessions: readonly SessionView[];
  /** Whether this row's daemon connection may mutate at all. */
  readonly canMutate: boolean;
  readonly onClose: () => void;
  /** The row that opened it; a keyboard dismissal hands focus back there. */
  readonly triggerRef?: { current: HTMLElement | null };
  /** Coarse pointer: entries take the 44px touch floor. */
  readonly touch?: boolean;
}

export function SessionRowMenu({
  state,
  sessions,
  canMutate,
  onClose,
  triggerRef,
  touch,
  onRun,
  onBulkStop,
}: SessionRowMenuProps) {
  const items = state ? sessionRowMenuItems(state.view, sessions, canMutate, { onRun, onBulkStop }) : [];

  return (
    <ContextMenu
      // An empty menu must not open: a menu that appears and offers nothing
      // reads as a broken row rather than as a read-only one.
      open={state !== null && items.length > 0}
      anchor={state ? { x: state.x, y: state.y } : { x: 0, y: 0 }}
      items={items}
      onClose={onClose}
      ariaLabel={state ? sessionMenuLabel(state.view) : 'Session actions'}
      triggerRef={triggerRef}
      touch={touch}
    />
  );
}
