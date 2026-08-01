/**
 * Responsive sessions dashboard assembled from daemon-scoped data.
 *
 * There is deliberately no fetch, store subscription, history singleton, or
 * page-origin fallback here. The future app root owns those lifecycles and
 * hands this screen one paired daemon's already-projected fleet.
 */

import type { SessionView, WardenStatusView } from '@ferretry/protocol';
import { FolderGit2, Folders, LayoutGrid, Plus, Rows3 } from 'lucide-react';
import { useId } from 'react';
import {
  WardenVerdicts,
  type WardenReportRequest,
  type WardenVerdictView,
} from '../features/warden/warden-verdicts.tsx';
import { WardenStrip } from '../features/warden/warden-strip.tsx';
import { PULL_TO_PALETTE_ATTR } from '../hooks/use-pull-to-palette.ts';
import { useDashboardNarrow } from '../hooks/use-dashboard-view.ts';
import { cn } from '../lib/class-names.ts';
import type { DaemonConnection } from '../lib/daemon-connection.ts';
import type { DashboardView, Density, UiControls } from '../lib/controls.ts';
import type { SessionGroup } from '../lib/fleet-grouping.ts';
import { daemonNewSessionPath, daemonSessionsPath } from '../lib/pages/routes.ts';
import type { DaemonUsageIndex } from '../lib/usage.ts';
import { RouteLink } from '../shell/route-link.tsx';
import { ViewTabs } from '../shell/view-tabs.tsx';
import { FullDensityGroups, LeanDensityGroups } from './session-dashboard-groups.tsx';
import {
  SCOPE_RECOVERY_MESSAGE,
  dashboardEmptyMessage,
  dashboardMode,
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
  readonly controls: UiControls;
  readonly density: Density;
  readonly usage: DaemonUsageIndex | null;
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
}

export function SessionDashboard({
  connection,
  sessions,
  groups,
  scope,
  scopeName,
  scopeRecovered,
  error,
  controls,
  density,
  usage,
  wardenStatus,
  wardenVerdicts,
  now,
  onSetView,
  onEnterScope,
  onExitScope,
  onOpenWardenReport,
  onNavigate,
  narrow: narrowOverride,
}: SessionDashboardProps) {
  const headingId = useId();
  const viewportNarrow = useDashboardNarrow();
  const narrow = narrowOverride ?? viewportNarrow;
  const mode = dashboardMode(controls.dashboardView, narrow);
  const visibleCount = groups.reduce((count, group) => count + group.rows.length, 0);
  const totalCount = sessions?.length ?? 0;
  const pullMarker = { [PULL_TO_PALETTE_ATTR]: '' };

  const leaveScope = (path: string): void => {
    onExitScope();
    onNavigate?.(path);
  };

  return (
    <main aria-labelledby={headingId} className="flex h-full min-h-0 w-full flex-col pb-2" data-density={density}>
      <div
        className={cn(
          'mt-0.5 mb-1 flex items-center justify-between gap-2 sm:mt-2 sm:mb-2',
          scope === null && 'flex-wrap',
        )}
      >
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
              <Folders aria-hidden="true" size={13} /> All folders
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

        {sessions !== null && scope === null ? (
          <span className="mono text-meta text-faint sm:hidden" title="visible / total sessions">
            {visibleCount}/{totalCount}
          </span>
        ) : null}

        <div className="ml-auto flex shrink-0 items-center gap-sm">
          {sessions !== null && scope === null ? (
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
          <RouteLink
            className="kt-btn"
            data-variant="primary"
            onNavigate={onNavigate}
            to={daemonNewSessionPath(connection.daemonId)}
          >
            <Plus aria-hidden="true" size={13} /> New session
          </RouteLink>
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
        {sessions === null ? <SkeletonRows /> : null}
        {sessions !== null && visibleCount === 0 ? (
          <div className="rounded-panel border border-dashed border-border bg-surface-2 px-4 py-10 text-center text-muted">
            {dashboardEmptyMessage(scope)}
          </div>
        ) : null}
        {sessions !== null && visibleCount > 0 ? (
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
            />
          ) : (
            <LeanDensityGroups
              daemonId={connection.daemonId}
              density={density}
              groups={groups}
              mode={mode}
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
