/**
 * Connected, one-daemon Sessions page. The dashboard stays a pure surface;
 * this page composes the paired stores and browser lifecycle without creating
 * an ambient daemon, a second grouping projection, or another usage poll.
 * Survey D rows 10/105/246: dashboard, static multi-daemon transport, and
 * the legacy single-daemon state seam this page must not recreate.
 */

import { useEffect } from 'react';

import type { WardenReportRequest } from '../features/warden/warden-verdicts.tsx';
import { useDensity } from '../hooks/use-density.ts';
import { useFleetView } from '../hooks/use-fleet-view.ts';
import { type LiveClockOptions, useLiveClock } from '../hooks/use-live-clock.ts';
import {
  browserScopeNavigation,
  enterProjectScope,
  exitProjectScope,
  type ScopeNavigation,
  useProjectScope,
} from '../hooks/use-project-scope.ts';
import { useProjects } from '../hooks/use-projects.ts';
import { useUsage } from '../hooks/use-usage.ts';
import { useWardenStatus, type WardenStatusReader } from '../hooks/use-warden-status.ts';
import type { DaemonControlsStore } from '../lib/controls.ts';
import type { DaemonConnection } from '../lib/daemon-connection.ts';
import { projectKeyFor } from '../lib/fleet-grouping.ts';
import type { DaemonFleetStore } from '../lib/fleet-store.ts';
import type { DaemonProjectsStore } from '../lib/projects-store.ts';
import type { DaemonUsageStore } from '../lib/usage-store.ts';
import { SessionDashboard, type SessionDashboardProps } from './session-dashboard.tsx';

export interface SessionsPageProps {
  readonly connection: DaemonConnection;
  readonly fleet: DaemonFleetStore;
  readonly controls: DaemonControlsStore;
  readonly projects: DaemonProjectsStore;
  readonly usage: DaemonUsageStore;
  readonly wardenStatus: WardenStatusReader;
  readonly onOpenWardenReport: (request: WardenReportRequest) => void;
  readonly onNavigate?: (path: string) => void;
  readonly scopeNavigation?: ScopeNavigation;
  readonly clock?: LiveClockOptions;
  readonly narrow?: boolean;
}

interface DashboardContentProps extends Omit<SessionsPageProps, 'scopeNavigation' | 'clock' | 'narrow'> {
  readonly now: number;
  readonly navigation: ScopeNavigation;
  readonly narrow?: boolean;
}

/** Owns the full-density usage subscription; lean views never mount this hook. */
function FullDensityDashboard({
  usageStore,
  ...props
}: Omit<SessionDashboardProps, 'usage'> & { usageStore: DaemonUsageStore }) {
  useUsage(usageStore, props.connection);
  return <SessionDashboard {...props} usage={usageStore} />;
}

function DashboardContent({
  connection,
  fleet,
  controls,
  projects,
  usage,
  wardenStatus,
  onOpenWardenReport,
  onNavigate,
  now,
  navigation,
  narrow,
}: DashboardContentProps) {
  const projectList = useProjects(projects, connection);
  const view = useFleetView({ fleet, controls, daemonId: connection.daemonId, projects: projectList });
  const { density } = useDensity(controls);
  const status = useWardenStatus(connection, wardenStatus);

  useProjectScope({
    controls,
    daemonId: connection.daemonId,
    navigation,
    scopeRecovered: view.scopeRecovered,
  });

  const dashboard = {
    connection,
    dashboardView: view.controls.dashboardView,
    density,
    error: view.slice.error,
    groups: view.groups,
    narrow,
    now,
    onEnterScope: (path: string) => enterProjectScope(controls, connection.daemonId, path, navigation),
    onExitScope: () => exitProjectScope(controls, connection.daemonId, navigation),
    onNavigate,
    onOpenWardenReport,
    onSetView: (next: 'cards' | 'table') => controls.setDeviceControls({ dashboardView: next }),
    scope: view.scope,
    scopeName: view.scope === null ? '' : projectKeyFor(view.scope, projectList).name,
    scopeRecovered: view.scopeRecovered,
    sessions: view.slice.sessions,
    wardenStatus: status,
    // Verdicts have no protocol schema/client feed yet; do not invent one here.
    wardenVerdicts: [],
  } as const;

  return density === 'full' ? (
    <FullDensityDashboard {...dashboard} usageStore={usage} />
  ) : (
    <SessionDashboard {...dashboard} usage={null} />
  );
}

/**
 * The production Sessions slot. Its only daemon read is the selected paired
 * connection; store generation fencing owns stale/re-paired completions.
 */
export function SessionsPage({ scopeNavigation, clock, ...props }: SessionsPageProps) {
  const navigation = scopeNavigation ?? browserScopeNavigation();
  const now = useLiveClock(clock);

  useEffect(() => {
    void props.fleet.hydrate(props.connection).catch(() => {});
  }, [props.connection, props.fleet]);

  return <DashboardContent {...props} navigation={navigation} now={now} />;
}
