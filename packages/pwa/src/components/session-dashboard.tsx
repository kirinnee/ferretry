/**
 * Responsive sessions dashboard assembled from daemon-scoped data.
 *
 * There is deliberately no fetch, store subscription, history singleton, or
 * page-origin fallback here. The future app root owns those lifecycles and
 * hands this screen one paired daemon's already-projected fleet.
 *
 * TranscriptResults/highlight is NOT PORTED: IFyApiClient has no
 * transcript-search route and this PWA has no results-panel owner. Keeping the
 * omission explicit prevents a search gesture from implying unavailable data.
 */

import type { SessionView, WardenStatusView } from '@ferretry/protocol';
import { FolderGit2, Folders, LayoutGrid, Plus, Rows3 } from 'lucide-react';
import { useId } from 'react';
import { WardenStrip } from '../features/warden/warden-strip.tsx';
import {
  type WardenReportRequest,
  WardenVerdicts,
  type WardenVerdictView,
} from '../features/warden/warden-verdicts.tsx';
import { useDashboardNarrow } from '../hooks/use-dashboard-view.ts';
import { PULL_TO_PALETTE_ATTR } from '../hooks/use-pull-to-palette.ts';
import type { PickerAccount } from '../lib/account-picker-catalog.ts';
import type { AllMachinesView } from '../lib/all-machines.ts';
import { cn } from '../lib/class-names.ts';
import type { DashboardView, Density } from '../lib/controls.ts';
import type { DaemonConnection, DaemonId } from '../lib/daemon-connection.ts';
import type { SessionGroup } from '../lib/fleet-grouping.ts';
import { daemonNewSessionPath, daemonSessionsPath } from '../lib/pages/routes.ts';
import type { SessionQuotaResolver } from '../lib/usage.ts';
import { type NewSessionMachine, NewSessionMenu } from '../shell/new-session-menu.tsx';
import { RouteLink } from '../shell/route-link.tsx';
import { ViewTabs } from '../shell/view-tabs.tsx';
import { FullDensityGroups, LeanDensityGroups } from './session-dashboard-groups.tsx';
import { AllMachinesGroups } from './session-dashboard-machines.tsx';
import {
  dashboardEmptyMessage,
  dashboardMode,
  SCOPE_RECOVERY_MESSAGE,
  sessionCountLabel,
} from './session-dashboard-model.ts';
import { SkeletonRows } from './session-dashboard-rows.tsx';

const DASHBOARD_TABS = [
  { id: 'table', label: 'table', icon: <Rows3 aria-hidden="true" size={12} /> },
  { id: 'cards', label: 'cards', icon: <LayoutGrid aria-hidden="true" size={12} /> },
] as const;

export interface SessionDashboardProps {
  readonly connection: DaemonConnection;
  /** null is the loading state; an empty array is an authoritative empty fleet. */
  readonly sessions: readonly SessionView[] | null;
  /** Already scoped, filtered, and grouped for `connection.daemonId`. */
  readonly groups: readonly SessionGroup[];
  readonly scope: string | null;
  readonly scopeName: string;
  readonly scopeRecovered: boolean;
  readonly error: string | null;
  readonly dashboardView: DashboardView | null;
  readonly density: Density;
  /**
   * Full density only: hosts must subscribe to and pass daemon usage for full
   * rows. Compact and minimal do not render quota data and must not subscribe
   * or join usage merely to supply this prop.
   */
  readonly usage: SessionQuotaResolver | null;
  /**
   * Full density only, like `usage`: the account roster the full rows name each
   * session's account from. Absent or `null` is an unread roster, and the rows
   * then name no account rather than print a wrapper id.
   */
  readonly accounts?: readonly PickerAccount[] | null;
  readonly wardenStatus: WardenStatusView | null;
  readonly wardenVerdicts: readonly WardenVerdictView[];
  readonly now: number;
  readonly onSetView: (view: DashboardView) => void;
  readonly onEnterScope: (path: string) => void;
  readonly onExitScope: () => void;
  readonly onOpenWardenReport: (request: WardenReportRequest) => void;
  readonly onNavigate?: (path: string) => void;
  /** Harness/test override; production follows the live 900px crossing. */
  readonly narrow?: boolean;
  /**
   * Every paired machine's sessions, when the Sessions list setting is All machines and no folder is
   * focused. The page then lists Needs you and every machine instead of `groups`.
   */
  readonly allMachines?: AllMachinesView;
  /** Focus a folder on another machine: that machine's page, at that folder. */
  readonly onFocusMachine?: (daemonId: DaemonId, path: string) => void;
  /** The machines "+ New" may start on. With more than one it asks which; the default is this one. */
  readonly newSessionMachines?: readonly NewSessionMachine[];
}

/** How many rows the all-machines list draws: Needs you, plus every machine's groups. */
const allMachinesShown = (view: AllMachinesView): number =>
  view.needsYou.length +
  view.machines.reduce(
    (count, machine) => count + machine.groups.reduce((rows, group) => rows + group.rows.length, 0),
    0,
  );

export function SessionDashboard({
  connection,
  sessions,
  groups,
  scope,
  scopeName,
  scopeRecovered,
  error,
  dashboardView,
  density,
  usage,
  accounts = null,
  wardenStatus,
  wardenVerdicts,
  now,
  onSetView,
  onEnterScope,
  onExitScope,
  onOpenWardenReport,
  onNavigate,
  narrow: narrowOverride,
  allMachines,
  onFocusMachine,
  newSessionMachines,
}: SessionDashboardProps) {
  const headingId = useId();
  const viewportNarrow = useDashboardNarrow();
  const narrow = narrowOverride ?? viewportNarrow;
  const mode = dashboardMode(dashboardView, narrow);
  const visibleCount =
    allMachines === undefined
      ? groups.reduce((count, group) => count + group.rows.length, 0)
      : allMachinesShown(allMachines);
  const totalCount = allMachines?.total ?? sessions?.length ?? 0;
  // Across machines the list is "read" once any machine has answered; one machine at a time, once it has.
  const read = allMachines === undefined ? sessions !== null : allMachines.loaded;
  const pullMarker = { [PULL_TO_PALETTE_ATTR]: '' };

  const leaveScope = (path: string): void => {
    onExitScope();
    onNavigate?.(path);
  };

  return (
    <main
      aria-labelledby={headingId}
      className="flex h-full min-h-0 w-full flex-col px-3 pb-2 sm:px-0"
      data-density={density}
    >
      <div className={cn('fy-sessions-head flex items-center justify-between gap-2', scope === null && 'flex-wrap')}>
        {scope === null ? (
          <h1
            className="sr-only m-0 font-display text-display font-bold tracking-display sm:not-sr-only"
            id={headingId}
          >
            Sessions
          </h1>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-sm">
            <RouteLink
              aria-label="Show all folders"
              className="kt-btn min-h-[44px] shrink-0"
              onNavigate={leaveScope}
              title="Show all folders"
              to={daemonSessionsPath(connection.daemonId)}
            >
              <Folders aria-hidden="true" size={13} />
              <span className="hidden sm:inline">All folders</span>
            </RouteLink>
            <FolderGit2 aria-hidden="true" className="shrink-0 text-faint" size={15} />
            <h1
              className="m-0 min-w-0 truncate font-display text-display font-bold tracking-display"
              id={headingId}
              title={scopeName}
            >
              {scopeName}
            </h1>
            <span aria-live="polite" className="mono shrink-0 text-meta text-faint">
              {sessionCountLabel(visibleCount)}
            </span>
          </div>
        )}

        {read && scope === null ? (
          <span className="mono text-meta text-faint sm:hidden" title="visible / total sessions">
            {visibleCount}/{totalCount}
          </span>
        ) : null}

        <div className="ml-auto flex shrink-0 items-center gap-sm">
          {read && scope === null ? (
            <span className="mono hidden text-meta text-faint sm:inline" title="visible / total sessions">
              {visibleCount}/{totalCount}
            </span>
          ) : null}
          {!narrow ? (
            <ViewTabs
              className="bg-surface"
              current={mode}
              label="Sessions view"
              onChange={onSetView}
              tabs={DASHBOARD_TABS}
            />
          ) : null}
          {/* A compact "+ New" pill on a phone, on the count's line — never a filled 44px square — and the
              full "New session" from `sm` up. The pill keeps its 44px tap height through its hit area. */}
          {newSessionMachines !== undefined && newSessionMachines.length > 1 && onNavigate !== undefined ? (
            <NewSessionMenu
              className="kt-btn kt-btn--sm fy-new-session"
              current={connection.daemonId}
              machines={newSessionMachines}
              onNavigate={onNavigate}
              variant="primary"
            >
              <Plus aria-hidden="true" size={13} />
              <span className="sm:hidden">New</span>
              <span className="hidden sm:inline">New session</span>
            </NewSessionMenu>
          ) : (
            <RouteLink
              aria-label="New session"
              className="kt-btn kt-btn--sm fy-new-session"
              data-variant="primary"
              onNavigate={onNavigate}
              to={daemonNewSessionPath(connection.daemonId)}
            >
              <Plus aria-hidden="true" size={13} />
              <span className="sm:hidden">New</span>
              <span className="hidden sm:inline">New session</span>
            </RouteLink>
          )}
        </div>
      </div>

      <WardenStrip now={now} status={wardenStatus} />
      <WardenVerdicts connection={connection} now={now} onOpenReport={onOpenWardenReport} verdicts={wardenVerdicts} />

      {scopeRecovered ? (
        <p
          className="mb-3 rounded-panel border border-warn-border bg-warn-bg px-panel py-row-y text-row text-warn"
          role="status"
        >
          {SCOPE_RECOVERY_MESSAGE}
        </p>
      ) : null}

      {error ? (
        <p
          className="mb-3 rounded-panel border border-err-border bg-err-bg px-panel py-row-y text-row text-err"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      <div
        {...pullMarker}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain scroll-thin"
        data-density-region="dashboard-scroller"
      >
        {read ? null : <SkeletonRows />}
        {allMachines !== undefined && read ? (
          <AllMachinesGroups
            accounts={accounts}
            daemonId={connection.daemonId}
            density={density}
            mode={mode}
            now={now}
            onFocus={(daemon, path) =>
              daemon === connection.daemonId ? onEnterScope(path) : onFocusMachine?.(daemon, path)
            }
            onNavigate={onNavigate}
            usage={usage}
            view={allMachines}
          />
        ) : null}
        {allMachines === undefined && sessions !== null && visibleCount === 0 ? (
          <div className="rounded-panel border border-dashed border-border bg-surface-2 px-4 py-10 text-center text-muted">
            {dashboardEmptyMessage(scope)}
          </div>
        ) : null}
        {allMachines === undefined && sessions !== null && visibleCount > 0 ? (
          density === 'full' ? (
            <FullDensityGroups
              daemonId={connection.daemonId}
              groups={groups}
              mode={mode}
              now={now}
              onFocus={onEnterScope}
              onNavigate={onNavigate}
              scoped={scope !== null}
              usage={usage}
              accounts={accounts}
            />
          ) : (
            <LeanDensityGroups
              daemonId={connection.daemonId}
              density={density}
              groups={groups}
              mode={mode}
              now={now}
              onFocus={onEnterScope}
              onNavigate={onNavigate}
              scoped={scope !== null}
            />
          )
        ) : null}
      </div>
    </main>
  );
}
