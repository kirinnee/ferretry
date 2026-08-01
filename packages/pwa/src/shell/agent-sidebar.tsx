/**
 * THE PERSISTENT AGENT SIDEBAR — the fleet, always on screen. Ported from the
 * shell half of kteam `ui/src/components/AgentSidebar.tsx`.
 *
 * Before it existed, "which of my teammates is stuck?" was a question you could
 * only ask on the dashboard: you left the conversation you were reading, scanned
 * a ten-column table, and came back. The fleet is the context for every page, so
 * it lives at shell level — mounted once, never remounted by navigation, so its
 * scroll position and its filter state survive going into a session and back out.
 *
 * THREE SHAPES, TWO FACTS. `useLayoutMode` reports what the VIEWPORT allows; the
 * reader's `sidebarCollapsed` preference records what they asked for. They are
 * separate because a rail forced by a 900px window must not silently overwrite
 * the expanded preference — widening the window brings it back. Below the drawer
 * breakpoint the column becomes an overlay drawer with a scrim, an Escape
 * handler, a labelled close button and focus moved into it on open.
 *
 * SCROLLING. Exactly one scroller: the session list. It is a SIBLING of the main
 * pane's scroller, never nested inside it, so the one-scroll-region rule holds —
 * the filters above and the footer below stay put while the list moves.
 *
 * THE DRAWER MUST NOT SUMMON THE KEYBOARD. A touch reader lands on the dialog
 * container; a pointer reader keeps the search-first flow. `drawerFocusPolicy`
 * owns that split, and the value is LATCHED for the life of one opening:
 * `useDialogFocus` re-runs when `autoFocus` changes, and re-running it while the
 * drawer is open would overwrite the restore target with something inside the
 * drawer that is about to unmount. Modality can genuinely change mid-use (a
 * convertible, a mouse plugged in), so the value that OPENED the drawer governs
 * it. The ref is only written while the drawer is shut, which makes the write
 * idempotent under a double render.
 *
 * WHAT CHANGED — the single-daemon assumptions.
 *
 *   - kteam read `useFleet()`/`useUiControls()` module singletons. This takes a
 *     `DaemonConnection` and the already-derived `(daemonId, …)` scoped fleet
 *     view, so a column can never show one daemon's rows under another's filters.
 *   - Its destinations were `/warden` and `/new`. Both are per-daemon routes here.
 *   - The bulk-stop sweep runs through `bulk-stop-run.ts` against the same
 *     explicit connection, so the most destructive action in the app cannot
 *     reach a daemon other than the one whose fleet was named in the dialog.
 *
 * kteam's `SidebarDrawerTrigger` lived at the bottom of the same file; it is
 * already ported as `SidebarDrawerTrigger` in `app-bar.tsx`, which is where the
 * bar that renders it lives. A second copy is exactly the drift this port is
 * trying to avoid, so there is none here.
 *
 * NOT PORTED, and declared rather than faked: kteam's pull-down-to-search
 * gesture (`usePullToSearch` + the `search-focus` signal) and `useInputModality`
 * have no Ferretry equivalent yet, so `touchAffected` arrives as a prop and the
 * pull indicator is absent. The rest of the drawer contract — scrim, Escape,
 * focus latch, 44px folder headers — is here in full.
 */

import type { SessionView } from '@ferretry/protocol';
import { ChevronsLeft, Cpu, Plus, Settings, ShieldCheck, User, Users, X } from 'lucide-react';
import { type ReactNode, useRef } from 'react';
import { useDialogFocus } from '../hooks/use-dialog-focus.ts';
import { useLayoutMode } from '../hooks/use-layout-mode.ts';
import { cn } from '../lib/class-names.ts';
import type { ModeFilter } from '../lib/controls.ts';
import type { DaemonId } from '../lib/daemon-connection.ts';
import type { ModeCounts, SessionGroup } from '../lib/fleet-grouping.ts';
import type { LineageIndex } from '../lib/lineage.ts';
import { daemonNewSessionPath, daemonSettingsPath, daemonWardenPath } from '../lib/pages/routes.ts';
import { drawerFocusPolicy, pinScopedFirst } from './agent-sidebar-model.ts';
import { type AttentionCountFor, GroupBlock } from './agent-sidebar-rows.tsx';
import { FleetFilters, type FleetFilterValues } from './fleet-filters.tsx';
import { RouteLink } from './route-link.tsx';
import type { OpenSessionMenu } from './row-context-gesture.ts';

/** Expanded width. Wide enough for a task line and a teammate name, narrow
 *  enough that the transcript beside it still reads comfortably at 1280px. */
export const SIDEBAR_EXPANDED_WIDTH = 'w-[248px]';
/** Icon rail: one column of 28px controls plus padding. */
export const SIDEBAR_RAIL_WIDTH = 'w-[52px]';

/** The mode-segment glyphs, kept next to the segment that draws them. */
const modeIcon = (mode: ModeFilter): ReactNode => {
  if (mode === 'auto') return <Cpu className="shrink-0" size={10} />;
  if (mode === 'interactive') return <User className="shrink-0" size={10} />;
  return null;
};

/** The two destinations a narrow drawer cannot reach through the rail. */
export function NarrowDestinations({
  daemonId,
  onNavigate,
}: {
  readonly daemonId: DaemonId;
  readonly onNavigate: () => void;
}) {
  return (
    <nav
      aria-label="Destinations"
      className="grid shrink-0 grid-cols-2 gap-sm border-border-soft border-b px-cell-x pb-2"
    >
      <RouteLink
        className="kt-btn min-h-[44px] justify-center gap-xs"
        onNavigate={onNavigate}
        to={daemonWardenPath(daemonId)}
      >
        <ShieldCheck aria-hidden="true" size={14} />
        Warden
      </RouteLink>
      <RouteLink
        className="kt-btn min-h-[44px] justify-center gap-xs"
        onNavigate={onNavigate}
        to={daemonSettingsPath(daemonId)}
      >
        <Settings aria-hidden="true" size={14} />
        Settings
      </RouteLink>
    </nav>
  );
}

/** Everything about one daemon's fleet the sidebar draws, already derived. */
export interface SidebarFleet {
  readonly groups: readonly SessionGroup[];
  readonly lineage: LineageIndex;
  readonly byId: ReadonlyMap<string, SessionView>;
  readonly counts: ModeCounts;
  /** Survivors of the current filters. */
  readonly shown: number;
  /** Everything this daemon reported, filters ignored. */
  readonly total: number;
  /** The active folder scope key, or null. */
  readonly scope: string | null;
}

export interface SidebarBodyProps {
  readonly daemonId: DaemonId;
  readonly fleet: SidebarFleet;
  readonly filters: FleetFilterValues;
  readonly canMutate: boolean;
  readonly onFilterChange: (patch: Partial<FleetFilterValues>) => void;
  readonly onSearchSubmit?: (query: string) => void;
  readonly onSearchClear?: () => void;
  readonly onFocusFolder: (path: string) => void;
  readonly activeId?: string;
  readonly attentionCountFor?: AttentionCountFor;
  /** Drawer/touch context: folder headers take the 44px touch floor. */
  readonly coarse?: boolean;
  readonly autoFocusSearch?: boolean;
  readonly onNavigate?: () => void;
  readonly onOpenSessionMenu?: OpenSessionMenu;
}

/** Filters, the one scroller, and the footer — shared by the column and drawer. */
export function SidebarBody({
  activeId,
  attentionCountFor,
  autoFocusSearch,
  canMutate,
  coarse,
  daemonId,
  filters,
  fleet,
  onFilterChange,
  onFocusFolder,
  onNavigate,
  onOpenSessionMenu,
  onSearchClear,
  onSearchSubmit,
}: SidebarBodyProps) {
  const groups = pinScopedFirst(fleet.groups, fleet.scope);
  return (
    <>
      <div className="shrink-0 border-border-soft border-b px-cell-x pb-2">
        <FleetFilters
          autoFocusSearch={autoFocusSearch}
          counts={fleet.counts}
          iconFor={modeIcon}
          onChange={onFilterChange}
          onSearchClear={onSearchClear}
          onSearchSubmit={onSearchSubmit}
          values={filters}
        />
      </div>
      {/* THE ONE SCROLLER. A sibling of the main pane's scroller, never nested in
          it. `overscroll-contain`: a pull at the top must not chain to the page
          and trigger the browser's own pull-to-refresh. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 scroll-thin overflow-y-auto overscroll-contain">
          {groups.length === 0 ? (
            <p className="px-cell-x py-4 text-cell text-muted">
              {fleet.total === 0 ? 'No sessions yet.' : 'No sessions match these filters.'}
            </p>
          ) : (
            <div className="space-y-1 py-1">
              {groups.map(group => (
                <GroupBlock
                  activeId={activeId}
                  attentionCountFor={attentionCountFor}
                  byId={fleet.byId}
                  canMutate={canMutate}
                  coarse={coarse}
                  daemonId={daemonId}
                  group={group}
                  key={group.path || group.name}
                  lineage={fleet.lineage}
                  onFocus={onFocusFolder}
                  onNavigate={onNavigate}
                  onOpenSessionMenu={onOpenSessionMenu}
                  scoped={fleet.scope !== null && group.path === fleet.scope}
                />
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-sm border-border-soft border-t px-cell-x py-row-y">
        <RouteLink
          className="kt-btn"
          data-variant="primary"
          onNavigate={onNavigate}
          to={daemonNewSessionPath(daemonId)}
        >
          <Plus size={12} /> New session
        </RouteLink>
        <span className="mono ml-auto shrink-0 text-2xs text-faint" title="shown / total sessions">
          {fleet.shown}/{fleet.total}
        </span>
      </div>
    </>
  );
}

export interface AgentSidebarProps extends Omit<SidebarBodyProps, 'coarse' | 'autoFocusSearch' | 'onNavigate'> {
  /** Drawer visibility. Owned by the shell, so the app bar's trigger and the
   *  drawer's own close button drive one piece of state. */
  readonly drawerOpen: boolean;
  readonly onCloseDrawer: () => void;
  /** The reader ASKED for a rail. Honoured only where a full column would fit. */
  readonly collapsed: boolean;
  readonly onCollapsedChange: (collapsed: boolean) => void;
  /** Coarse pointer without hover. Supplied by the host — see the file header. */
  readonly touchAffected?: boolean;
  /** The rail body, rendered by the host so this file takes no route dependency
   *  beyond its own destinations. */
  readonly rail?: ReactNode;
  /** Hosted once by the caller, not per row: the menu and the stop confirmation. */
  readonly layers?: ReactNode;
}

export function AgentSidebar({
  collapsed,
  drawerOpen,
  layers,
  onCloseDrawer,
  onCollapsedChange,
  rail,
  touchAffected = false,
  ...body
}: AgentSidebarProps) {
  const layout = useLayoutMode();
  const drawerRef = useRef<HTMLDivElement | null>(null);
  const drawerIsOpen = layout === 'drawer' && drawerOpen;

  // Latched for the life of one opening — see the file header.
  const latchedTouch = useRef(touchAffected);
  if (!drawerIsOpen) latchedTouch.current = touchAffected;
  const focusPolicy = drawerFocusPolicy(latchedTouch.current);

  const { onKeyDown: onDrawerKeyDown } = useDialogFocus(drawerIsOpen, drawerRef, onCloseDrawer, {
    autoFocus: focusPolicy.dialogAutoFocus,
  });

  // MOBILE: an overlay drawer. Nothing is rendered in the layout flow at all, so
  // the main pane keeps the full width while the drawer is shut.
  if (layout === 'drawer') {
    if (!drawerOpen) return null;
    return (
      <div
        aria-label="Fleet sessions"
        aria-modal="true"
        className="kt-overlay fixed inset-0 z-40 md:hidden"
        onKeyDown={onDrawerKeyDown}
        ref={drawerRef}
        role="dialog"
        tabIndex={-1}
      >
        <button
          aria-label="Close the fleet sidebar"
          className="absolute inset-0 bg-scrim"
          onClick={onCloseDrawer}
          type="button"
        />
        <aside
          className={cn(
            'absolute inset-y-0 left-0 flex w-[min(88vw,300px)] flex-col',
            // `shadow-popover`, not `shadow-lg`: the drawer is one of the three
            // popover surfaces in the contract, so Neo gets a 6px hard offset and
            // High Contrast a 2px ring instead of a blur.
            'border-border border-r bg-bg py-2 shadow-popover',
          )}
        >
          <div className="mb-1.5 flex shrink-0 items-center gap-sm px-cell-x">
            <Users className="shrink-0 text-faint" size={13} />
            <span className="font-semibold text-ui">Fleet</span>
            <button
              aria-label="Close the fleet sidebar"
              className="ml-auto rounded-control p-1 text-muted hover:bg-surface-2 hover:text-fg"
              onClick={onCloseDrawer}
              type="button"
            >
              <X size={14} />
            </button>
          </div>
          <NarrowDestinations daemonId={body.daemonId} onNavigate={onCloseDrawer} />
          <SidebarBody {...body} autoFocusSearch={focusPolicy.searchAutoFocus} coarse onNavigate={onCloseDrawer} />
        </aside>
        {layers}
      </div>
    );
  }

  // A rail is FORCED below the rail breakpoint and CHOSEN above it. The
  // preference is only read in `full`, so a narrow window never overwrites it.
  if (layout === 'rail' || collapsed) {
    return (
      <nav
        aria-label="Fleet sessions"
        className={cn('flex shrink-0 flex-col border-border border-r bg-bg', SIDEBAR_RAIL_WIDTH)}
      >
        {rail}
        {layers}
      </nav>
    );
  }

  return (
    <nav
      aria-label="Fleet sessions"
      className={cn('flex min-h-0 shrink-0 flex-col border-border border-r bg-bg pt-2', SIDEBAR_EXPANDED_WIDTH)}
    >
      <div className="mb-1.5 flex shrink-0 items-center gap-sm px-cell-x">
        <Users className="shrink-0 text-faint" size={13} />
        <span className="font-semibold text-ui">Fleet</span>
        <button
          aria-label="Collapse the fleet sidebar to an icon rail"
          className="ml-auto rounded-control p-1 text-muted hover:bg-surface-2 hover:text-fg"
          onClick={() => onCollapsedChange(true)}
          title="Collapse to an icon rail"
          type="button"
        >
          <ChevronsLeft size={14} />
        </button>
      </div>
      <SidebarBody {...body} />
      {layers}
    </nav>
  );
}
