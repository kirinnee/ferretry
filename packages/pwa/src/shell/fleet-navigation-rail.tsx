/**
 * The compact, persistent fleet navigation rail. Ported from the `Rail` part
 * of kteam's `AgentSidebar.tsx`.
 *
 * This is deliberately a controlled shell component: kteam's original read a
 * process-wide store, which would leak the selected filters across paired
 * daemons here. The host owns the daemon-scoped filter state and every
 * destination is built from the supplied daemon id.
 */

import type { ReactNode } from 'react';
import { cn } from '../lib/class-names.ts';
import type { DaemonId } from '../lib/daemon-connection.ts';
import { daemonNewSessionPath, daemonSettingsPath, daemonWardenPath } from '../lib/pages/routes.ts';
import { useLayoutMode } from '../hooks/use-layout-mode.ts';
import { ChevronsRight, Cpu, Plus, Radio, Settings, ShieldCheck, SlidersHorizontal, User, Users } from 'lucide-react';
import { RouteLink } from './route-link.tsx';

export type FleetModeFilter = 'all' | 'auto' | 'interactive';

export const MODE_LABEL: Record<FleetModeFilter, string> = {
  all: 'All sessions',
  auto: 'Auto sessions',
  interactive: 'Interactive sessions',
};

/** Cycles in the same order as the source rail's one-button mode control. */
export const nextFleetMode = (mode: FleetModeFilter): FleetModeFilter =>
  mode === 'all' ? 'auto' : mode === 'auto' ? 'interactive' : 'all';

export interface FleetModeCounts {
  readonly all: number;
  readonly auto: number;
  readonly interactive: number;
}

export interface FleetNavigationRailProps {
  /** The daemon this rail navigates and filters. Never inferred globally. */
  readonly daemon: DaemonId;
  /** Count after every active fleet filter. */
  readonly sessionCount: number;
  readonly mode: FleetModeFilter;
  readonly modeCounts: FleetModeCounts;
  readonly rcOnly: boolean;
  readonly includeFinished: boolean;
  readonly onExpand: () => void;
  readonly onSetMode: (mode: FleetModeFilter) => void;
  readonly onSetRcOnly: (value: boolean) => void;
  readonly onSetIncludeFinished: (value: boolean) => void;
  readonly onNavigate?: (to: string) => void;
}

/** A count must sit beside the clipped themed button, never inside it. */
function RailButton({
  label,
  onClick,
  active = false,
  badge,
  children,
}: {
  readonly label: string;
  readonly onClick: () => void;
  readonly active?: boolean;
  readonly badge?: number;
  readonly children: ReactNode;
}) {
  return (
    <span className="relative inline-flex">
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        aria-pressed={active}
        title={label}
        className={cn(
          'kt-btn aspect-square justify-center !px-0',
          active && '!border-accent !bg-accent-soft !text-accent',
        )}
      >
        {children}
      </button>
      {badge !== undefined && badge > 0 && (
        <span
          aria-hidden="true"
          className="mono pointer-events-none absolute -bottom-1 -right-1 rounded-full border border-border bg-surface px-1 text-2xs leading-[1.3] text-muted"
        >
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </span>
  );
}

/**
 * Desktop's 52px rail. Phone navigation opens the labelled drawer trigger in
 * `AppBar` instead; rendering a second, cramped rail there would violate the
 * source's three-shape layout contract.
 */
export function FleetNavigationRail({
  daemon,
  sessionCount,
  mode,
  modeCounts,
  rcOnly,
  includeFinished,
  onExpand,
  onSetMode,
  onSetRcOnly,
  onSetIncludeFinished,
  onNavigate,
}: FleetNavigationRailProps) {
  const layout = useLayoutMode();
  const nextMode = nextFleetMode(mode);
  const ModeIcon = mode === 'auto' ? Cpu : mode === 'interactive' ? User : Users;

  // At drawer widths the AppBar's labelled trigger opens the full fleet
  // drawer. A 52px duplicate rail would steal touch width from that surface.
  if (layout === 'drawer') return null;

  return (
    <nav aria-label="Fleet navigation rail" className="flex w-[52px] shrink-0 flex-col items-center gap-sm py-2">
      <RailButton label="Expand the fleet sidebar" onClick={onExpand}>
        <ChevronsRight size={14} aria-hidden="true" />
      </RailButton>
      <RouteLink
        to={daemonNewSessionPath(daemon)}
        {...(onNavigate ? { onNavigate } : {})}
        aria-label="New session"
        title="New session"
        data-variant="primary"
        className="kt-btn aspect-square justify-center !px-0"
      >
        <Plus size={14} aria-hidden="true" />
      </RouteLink>
      <RouteLink
        to={daemonWardenPath(daemon)}
        {...(onNavigate ? { onNavigate } : {})}
        aria-label="Open Warden"
        title="Warden"
        className="kt-btn h-[44px] w-[44px] justify-center !px-0"
      >
        <ShieldCheck size={14} aria-hidden="true" />
      </RouteLink>
      <RouteLink
        to={daemonSettingsPath(daemon)}
        {...(onNavigate ? { onNavigate } : {})}
        aria-label="Open settings"
        title="Settings"
        className="kt-btn h-[44px] w-[44px] justify-center !px-0"
      >
        <Settings size={14} aria-hidden="true" />
      </RouteLink>
      <div className="my-0.5 h-px w-6 bg-border" aria-hidden="true" />
      <RailButton
        label={`Search and filter the fleet (${sessionCount} shown) — expands the sidebar`}
        onClick={onExpand}
        badge={sessionCount}
      >
        <SlidersHorizontal size={13} aria-hidden="true" />
      </RailButton>
      <RailButton
        label={`Mode filter: ${MODE_LABEL[mode]} (${modeCounts[mode]}) — click for ${MODE_LABEL[nextMode]}`}
        onClick={() => onSetMode(nextMode)}
        active={mode !== 'all'}
      >
        <ModeIcon size={13} aria-hidden="true" />
      </RailButton>
      <RailButton
        label={
          rcOnly ? 'Showing Remote Control sessions only — click to show all' : 'Show only Remote Control sessions'
        }
        onClick={() => onSetRcOnly(!rcOnly)}
        active={rcOnly}
      >
        <Radio size={13} aria-hidden="true" />
      </RailButton>
      <RailButton
        label={includeFinished ? 'Hide finished sessions' : 'Include finished sessions'}
        onClick={() => onSetIncludeFinished(!includeFinished)}
        active={includeFinished}
      >
        <Users size={13} aria-hidden="true" />
      </RailButton>
    </nav>
  );
}
