/**
 * Leaf renderers for the sessions dashboard.
 *
 * These components intentionally do not know about grouping or stores. Their
 * caller owns the selected daemon, navigation effect, and usage index, keeping
 * each row safe to mount in isolation and preventing a paired daemon's usage
 * feed from leaking into another daemon's rows.
 */

import type { SessionView } from '@ferretry/protocol';
import { Activity, Bot, FolderGit2, Sparkles } from 'lucide-react';
import { memo, type ReactNode } from 'react';
import { TaskName } from '../features/tasks/task-name.tsx';
import { displayCallsign } from '../lib/callsign.ts';
import { cn } from '../lib/class-names.ts';
import type { Density } from '../lib/controls.ts';
import type { DaemonId } from '../lib/daemon-connection.ts';
import type { SessionGroup } from '../lib/fleet-grouping.ts';
import { daemonSessionPath } from '../lib/pages/routes.ts';
import { absoluteTime } from '../lib/session-screens.ts';
import type { DaemonUsageIndex } from '../lib/usage.ts';
import { ModeBadge } from '../shell/mode-badge.tsx';
import { Badge } from '../shell/primitives.tsx';
import { QuotaReadout } from '../shell/quota-readout.tsx';
import { RcBadge } from '../shell/rc-badge.tsx';
import { RouteLink } from '../shell/route-link.tsx';
import { nameToneClass, StatusMark } from '../shell/status-mark.tsx';
import { activityLine, dashboardTone, sessionAge, statusWord } from './session-dashboard-model.ts';

interface SessionNavigationProps {
  readonly daemonId: DaemonId;
  readonly onNavigate?: (path: string) => void;
}

interface FullSessionProps extends SessionNavigationProps {
  readonly view: SessionView;
  readonly usage: DaemonUsageIndex | null;
  /** Injected clock for deterministic age and quota-reset copy. */
  readonly now: number;
}

interface LeanSessionProps extends SessionNavigationProps {
  readonly view: SessionView;
  readonly density: Exclude<Density, 'full'>;
}

/** Semantic fixed-table column header; groups own the surrounding table. */
export function Th({ children, className = '' }: { readonly children: ReactNode; readonly className?: string }) {
  return (
    <th
      scope="col"
      className={cn('kt-label border-b border-border bg-surface-2 px-cell-x py-row-y text-left', className)}
    >
      {children}
    </th>
  );
}

/** The declared park and an explicit human escalation are independently meaningful. */
export function AttentionFlags({ view }: { readonly view: SessionView }) {
  return (
    <>
      {view.state.waiting && <Badge tone="warn">parked</Badge>}
      {view.state.needsHuman && (
        <Badge tone="err" title={view.state.needsHuman}>
          needs human
        </Badge>
      )}
    </>
  );
}

/** One-line activity: declared waits outrank stale pane activity in the shared projection. */
export function ActivityLine({ view, className = '' }: { readonly view: SessionView; readonly className?: string }) {
  const { text, live } = activityLine(view);
  return (
    <span className={cn('inline-flex min-w-0 max-w-full items-center gap-sm', className)}>
      <Activity size={11} className={live ? 'shrink-0 text-accent' : 'shrink-0 text-faint'} />
      <span className={live ? 'truncate shimmer' : 'truncate text-muted'} title={text}>
        {text}
      </span>
    </span>
  );
}

/** A bounded context-usage meter. Invalid injected values remain safe visual output. */
export function ContextMeter({ value }: { readonly value: number }) {
  const pct = Math.max(0, Math.min(100, value));
  const bar = pct >= 90 ? 'bg-err' : pct >= 75 ? 'bg-warn' : 'bg-ok';
  return (
    <div className="kt-meter" title={`context ${pct}% used`}>
      <div className="kt-meter__track">
        <div className={cn('kt-meter__fill', bar)} style={{ width: `${pct}%` }} />
      </div>
      <span className="mono text-meta text-fg-soft">{pct}%</span>
    </div>
  );
}

const sessionHref = (daemonId: DaemonId, view: SessionView): string => daemonSessionPath(daemonId, view.config.id);

/** Full-density fixed-table leaf. The parent supplies the six-column table only. */
export const SessionRow = memo(function SessionRow({ view, usage, daemonId, onNavigate, now }: FullSessionProps) {
  const cfg = view.config;
  const state = view.state;
  const quota = usage?.quotaFor(daemonId, view) ?? null;
  const href = sessionHref(daemonId, view);
  return (
    <tr className="kt-row group">
      <td>
        <RouteLink to={href} onNavigate={onNavigate} className="block min-w-0" title={cfg.id}>
          <div className="truncate text-row font-semibold text-fg group-hover:text-accent">
            {displayCallsign(cfg.teammate) || cfg.id}
          </div>
          <div className="kt-chrome mono flex min-w-0 items-baseline gap-xs">
            <span className="truncate">{cfg.id}</span>
            {cfg.label && (
              <>
                <span aria-hidden="true">·</span>
                <span className="truncate text-fg-soft" title={cfg.label}>
                  {cfg.label}
                </span>
              </>
            )}
          </div>
        </RouteLink>
      </td>
      <td>
        <TaskName name={cfg.name} size="md" className="max-w-full" />
      </td>
      <td>
        <Badge tone={dashboardTone(state.status)} className="max-w-full truncate">
          {state.status}
        </Badge>
      </td>
      <td>
        <div className="flex min-w-0 flex-col gap-xs">
          <div className="flex items-center gap-sm">
            <ModeBadge mode={cfg.mode} />
            <RcBadge remoteControl={cfg.remoteControl} url={state.remoteControlUrl} />
          </div>
          <span className="mono flex min-w-0 items-center gap-xs text-meta text-fg-soft" title={cfg.harness}>
            {cfg.harness === 'claude' ? (
              <Bot size={11} className="shrink-0 text-faint" />
            ) : (
              <Sparkles size={11} className="shrink-0 text-faint" />
            )}
            <span className="truncate">{cfg.model || cfg.modelHint || 'default'}</span>
          </span>
        </div>
      </td>
      <td>
        <ActivityLine view={view} className="mono text-cell" />
      </td>
      <td>
        <div className="flex min-w-0 flex-col gap-xs">
          {state.contextPercent != null ? (
            <ContextMeter value={state.contextPercent} />
          ) : (
            <span className="text-meta text-faint">no context</span>
          )}
          <div className="kt-chrome mono flex min-w-0 items-center gap-sm">
            <QuotaReadout quota={quota} now={now} className="min-w-0 truncate text-muted" showUnknown />
            <span className="ml-auto shrink-0 text-faint" title={absoluteTime(state.lastActivityAt)}>
              {sessionAge(state.lastActivityAt, now)}
            </span>
          </div>
        </div>
      </td>
    </tr>
  );
});

/** Compact and minimal tables deliberately build distinct DOM, rather than CSS-hiding full rows. */
export const LeanSessionRow = memo(function LeanSessionRow({ view, density, daemonId, onNavigate }: LeanSessionProps) {
  const cfg = view.config;
  return (
    <tr className="kt-row group">
      <td>
        <RouteLink
          to={sessionHref(daemonId, view)}
          onNavigate={onNavigate}
          className="flex min-w-0 items-center gap-sm text-row font-semibold"
        >
          <StatusMark view={view} />
          <span className={cn('min-w-0 truncate group-hover:text-accent', nameToneClass(view))}>
            {displayCallsign(cfg.teammate) || cfg.id}
          </span>
        </RouteLink>
      </td>
      <td>
        <TaskName name={cfg.name} teammate={cfg.teammate} size="md" className="max-w-full" />
      </td>
      {density === 'compact' && (
        <td>
          <div className="flex min-w-0 flex-wrap items-center gap-xs">
            {!view.state.waiting && (
              <Badge tone={dashboardTone(view.state.status)} title={view.state.status} className="max-w-full truncate">
                {statusWord(view.state.status)}
              </Badge>
            )}
            <AttentionFlags view={view} />
          </div>
        </td>
      )}
    </tr>
  );
});

/** Phone-first full-density card. It is a RouteLink so normal browser link affordances remain available. */
export const SessionCard = memo(function SessionCard({ view, usage, daemonId, onNavigate, now }: FullSessionProps) {
  const cfg = view.config;
  const state = view.state;
  const quota = usage?.quotaFor(daemonId, view) ?? null;
  return (
    <RouteLink
      to={sessionHref(daemonId, view)}
      onNavigate={onNavigate}
      className="kt-panel group block p-panel transition-colors hover:border-accent active:bg-surface-2"
    >
      <div className="flex items-center gap-sm">
        <span className="min-w-0 truncate text-row font-semibold text-fg group-hover:text-accent">
          {displayCallsign(cfg.teammate) || cfg.id}
        </span>
        <span className="ml-auto" />
        <Badge tone={dashboardTone(state.status)} className="shrink-0">
          {state.status}
        </Badge>
      </div>
      <div className="mt-1">
        <TaskName name={cfg.name} size="md" className="max-w-full" />
      </div>
      <div className="kt-chrome mono mt-0.5 flex flex-wrap items-center gap-x-sm gap-y-0.5">
        <span className="truncate">{cfg.id}</span>
        <span className="text-border">·</span>
        <span className="inline-flex items-center gap-1 text-fg-soft">
          {cfg.harness === 'claude' ? <Bot size={11} /> : <Sparkles size={11} />}
          {cfg.model || cfg.modelHint || 'default'}
        </span>
        {cfg.label && (
          <>
            <span className="text-border">·</span>
            <span className="text-fg-soft">{cfg.label}</span>
          </>
        )}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-sm">
        <ModeBadge mode={cfg.mode} />
        <RcBadge remoteControl={cfg.remoteControl} url={state.remoteControlUrl} />
      </div>
      <div className="mt-1.5">
        <ActivityLine view={view} className="w-full text-cell" />
      </div>
      <div className="mt-1.5 flex items-center gap-sm">
        {state.contextPercent != null && <ContextMeter value={state.contextPercent} />}
        <QuotaReadout quota={quota} now={now} className="text-meta text-faint" showUnknown />
        <span className="mono ml-auto shrink-0 text-meta text-faint" title={absoluteTime(state.lastActivityAt)}>
          {sessionAge(state.lastActivityAt, now)}
        </span>
      </div>
    </RouteLink>
  );
});

/** A 44px reduced-density row for its group's panel. */
export const LeanSessionCard = memo(function LeanSessionCard({
  view,
  density,
  daemonId,
  onNavigate,
  statusHoisted = false,
}: LeanSessionProps & { readonly statusHoisted?: boolean }) {
  const cfg = view.config;
  return (
    <RouteLink
      to={sessionHref(daemonId, view)}
      onNavigate={onNavigate}
      className="group flex min-h-[44px] min-w-0 items-center gap-sm px-panel py-1.5 transition-colors hover:bg-surface-2 active:bg-surface-2"
    >
      <StatusMark view={view} />
      <span
        className={cn(
          'min-w-16 max-w-[45%] shrink-[8] truncate text-row font-semibold group-hover:text-accent',
          nameToneClass(view),
        )}
      >
        {displayCallsign(cfg.teammate) || cfg.id}
      </span>
      <TaskName name={cfg.name} teammate={cfg.teammate} size="md" className="min-w-0 grow" />
      {density === 'compact' && (
        <span className="ml-auto flex shrink-0 items-center gap-xs">
          {!statusHoisted && !view.state.waiting && (
            <Badge tone={dashboardTone(view.state.status)} title={view.state.status} className="max-w-full truncate">
              {statusWord(view.state.status)}
            </Badge>
          )}
          <AttentionFlags view={view} />
        </span>
      )}
    </RouteLink>
  );
});

/** A focus-folder control; the group parent decides when scoped mode suppresses it. */
export function ProjectHeading({
  group,
  onFocus,
}: {
  readonly group: SessionGroup;
  readonly onFocus: (path: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onFocus(group.path)}
      aria-label={`Focus folder ${group.name}`}
      title={`Focus folder ${group.name}`}
      className="mb-1 flex min-h-[44px] w-full min-w-0 items-center gap-sm overflow-hidden rounded-control px-0.5 py-1 text-left hover:bg-surface-2"
    >
      <FolderGit2 size={13} className="shrink-0 translate-y-0.5 text-faint" />
      <span className="min-w-0 truncate text-ui font-semibold text-fg">{group.name}</span>
      {group.path && <span className="mono min-w-0 truncate text-meta text-faint">{group.path}</span>}
      <span className="mono ml-auto shrink-0 pr-1 text-meta text-faint">{group.rows.length}</span>
    </button>
  );
}

/** Loading placeholders use the same themed row floor as the incoming list. */
const SKELETON_KEYS = ['one', 'two', 'three', 'four', 'five', 'six'] as const;

export function SkeletonRows() {
  return (
    <div className="grid gap-2">
      {SKELETON_KEYS.map(key => (
        <div key={key} className="h-row animate-pulse rounded-panel border border-border-soft bg-surface-2" />
      ))}
    </div>
  );
}
