/**
 * Connected, one-daemon Sessions page. The dashboard stays a pure surface;
 * this page composes the paired stores and browser lifecycle without creating
 * an ambient daemon, a second grouping projection, or another usage poll.
 * Survey D rows 10/105/246: dashboard, static multi-daemon transport, and
 * the legacy single-daemon state seam this page must not recreate.
 *
 * Retry now on any machine's status line skips that machine's reconnect backoff and reads its list
 * again — through that machine's own pairing, so it never waits on, or for, any other machine.
 */

import { useCallback, useEffect, useMemo } from 'react';

import type { WardenReportRequest } from '../features/warden/warden-verdicts.tsx';
import { useAccountPickerSlice, useMachineRosters } from '../hooks/use-account-picker.ts';
import { useConnectionHealth } from '../hooks/use-connection-health.ts';
import { useDensity } from '../hooks/use-density.ts';
import { useFleetView } from '../hooks/use-fleet-view.ts';
import { type LiveClockOptions, useLiveClock } from '../hooks/use-live-clock.ts';
import {
  browserScopeNavigation,
  enterProjectScope,
  exitProjectScope,
  projectScopePath,
  type ScopeNavigation,
  useProjectScope,
} from '../hooks/use-project-scope.ts';
import { useProjects } from '../hooks/use-projects.ts';
import { useMachinesUsage, useUsage } from '../hooks/use-usage.ts';
import { useWardenStatus, type WardenStatusReader } from '../hooks/use-warden-status.ts';
import type { DaemonAccountPickerStore } from '../lib/account-picker-store.ts';
import { allMachinesView, type MachineSource } from '../lib/all-machines.ts';
import type { ConnectionHealth, ConnectionHealthState } from '../lib/connection-health.ts';
import type { DaemonControlsStore } from '../lib/controls.ts';
import type { DaemonConnection, DaemonId } from '../lib/daemon-connection.ts';
import { filterSessions, projectKeyFor } from '../lib/fleet-grouping.ts';
import type { DaemonFleetStore } from '../lib/fleet-store.ts';
import { machineOutage } from '../lib/machine-outage.ts';
import type { DaemonProjectsStore } from '../lib/projects-store.ts';
import type { DaemonUsageStore } from '../lib/usage-store.ts';
import type { NewSessionMachine } from '../shell/new-session-menu.tsx';
import { SessionDashboard, type SessionDashboardProps } from './session-dashboard.tsx';

export interface SessionsPageProps {
  readonly connection: DaemonConnection;
  readonly fleet: DaemonFleetStore;
  readonly controls: DaemonControlsStore;
  readonly projects: DaemonProjectsStore;
  readonly usage: DaemonUsageStore;
  /**
   * The same daemon-scoped roster the new-session page and migrate sheet read,
   * so a full-density row can name a session's account the way the pickers do.
   * Absent, the rows name no account.
   */
  readonly accountPicker?: DaemonAccountPickerStore;
  readonly wardenStatus: WardenStatusReader;
  readonly onOpenWardenReport: (request: WardenReportRequest) => void;
  readonly onNavigate?: (path: string) => void;
  readonly scopeNavigation?: ScopeNavigation;
  readonly clock?: LiveClockOptions;
  readonly narrow?: boolean;
  /**
   * Every paired machine, when Settings › Behaviour › Sessions list is All machines: the page then lists
   * Needs you and every machine. A focused folder is still one machine's page.
   */
  readonly machineSources?: readonly MachineSource[];
  /** The machines "+ New" may start on. */
  readonly newSessionMachines?: readonly NewSessionMachine[];
  /**
   * Every listed machine's pairing, with `machineSources`: a full row on any machine then reads that
   * machine's own quota and roster, through that machine's own pairing.
   */
  readonly machineConnections?: readonly DaemonConnection[];
  /**
   * How this browser reaches each machine: this machine's outage is then said with its cause, and Retry
   * now skips its backoff. Absent, only a failed list read is said, and Retry now only reads again.
   */
  readonly connectionHealth?: ConnectionHealth;
  /** The name this machine's outage sentence uses. */
  readonly machineName?: string;
}

const UNMEASURED: ConnectionHealthState = { kind: 'unknown' };

/** Health for a host that measures none: every machine unmeasured (one stable object), nothing to retry. */
const UNMEASURED_HEALTH: ConnectionHealth = {
  state: () => UNMEASURED,
  subscribe: () => () => {},
  retryNow: () => {},
  onRecovered: () => () => {},
};

interface DashboardContentProps extends Omit<SessionsPageProps, 'scopeNavigation' | 'clock' | 'narrow'> {
  readonly now: number;
  readonly navigation: ScopeNavigation;
  readonly narrow?: boolean;
}

type FullDensityProps = Omit<SessionDashboardProps, 'usage' | 'accounts' | 'machineAccounts'> & {
  usageStore: DaemonUsageStore;
  accountPicker?: DaemonAccountPickerStore;
  machineConnections: readonly DaemonConnection[];
};

/**
 * Owns the full-density usage and roster subscriptions; lean views never mount
 * either hook, because they render neither quota nor an account name.
 */
function FullDensityDashboard({ usageStore, accountPicker, machineConnections, ...props }: FullDensityProps) {
  useUsage(usageStore, props.connection);
  useMachinesUsage(usageStore, machineConnections);
  return accountPicker === undefined ? (
    <SessionDashboard {...props} usage={usageStore} />
  ) : (
    <RosterDashboard
      {...props}
      accountPicker={accountPicker}
      machineConnections={machineConnections}
      usage={usageStore}
    />
  );
}

/** No other machine is listed: the one on screen's own reads are all there is. */
const NO_MACHINES: readonly DaemonConnection[] = [];

/** A separate component only so the roster hook is never called conditionally. */
function RosterDashboard({
  accountPicker,
  machineConnections,
  ...props
}: Omit<SessionDashboardProps, 'accounts' | 'machineAccounts'> & {
  accountPicker: DaemonAccountPickerStore;
  machineConnections: readonly DaemonConnection[];
}) {
  const slice = useAccountPickerSlice(accountPicker, props.connection);
  const machineAccounts = useMachineRosters(accountPicker, machineConnections);
  return <SessionDashboard {...props} accounts={slice.catalog?.accounts ?? null} machineAccounts={machineAccounts} />;
}

function DashboardContent({
  connection,
  fleet,
  controls,
  projects,
  usage,
  accountPicker,
  wardenStatus,
  onOpenWardenReport,
  onNavigate,
  now,
  navigation,
  narrow,
  machineSources,
  newSessionMachines,
  machineConnections,
  connectionHealth,
  machineName,
}: DashboardContentProps) {
  const projectList = useProjects(projects, connection);
  const health = connectionHealth ?? UNMEASURED_HEALTH;
  const healthState = useConnectionHealth(health, connection.daemonId);
  const view = useFleetView({ fleet, controls, daemonId: connection.daemonId, projects: projectList });
  const { density } = useDensity(controls);
  const status = useWardenStatus(connection, wardenStatus);
  // The page's own search and mode filters narrow every machine's list alike.
  const allMachines = useMemo(
    () =>
      machineSources === undefined || view.scope !== null
        ? undefined
        : allMachinesView(machineSources, { select: sessions => filterSessions(sessions, view.controls) }),
    [machineSources, view.scope, view.controls],
  );

  useProjectScope({
    controls,
    daemonId: connection.daemonId,
    navigation,
    scopeRecovered: view.scopeRecovered,
  });

  const name = machineName ?? 'This machine';
  const outage = useMemo(() => machineOutage(name, healthState, view.slice), [name, healthState, view.slice]);
  const retryMachine = useCallback(
    (daemonId: DaemonId) => {
      health.retryNow(daemonId);
      const target =
        daemonId === connection.daemonId
          ? connection
          : machineConnections?.find(candidate => candidate.daemonId === daemonId);
      if (target !== undefined) void fleet.hydrate(target).catch(() => undefined);
    },
    [health, connection, machineConnections, fleet],
  );

  const dashboard = {
    connection,
    dashboardView: view.controls.dashboardView,
    density,
    error: view.slice.error,
    outage,
    machineName: name,
    onRetryMachine: retryMachine,
    updating: view.slice.cachedAt !== undefined,
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
    ...(allMachines === undefined ? {} : { allMachines }),
    ...(newSessionMachines === undefined ? {} : { newSessionMachines }),
    // Another machine's folder is that machine's page, at that folder.
    onFocusMachine: (daemonId: DaemonId, path: string) => onNavigate?.(projectScopePath(daemonId, path)),
  } as const;

  return density === 'full' ? (
    <FullDensityDashboard
      {...dashboard}
      {...(accountPicker === undefined ? {} : { accountPicker })}
      machineConnections={allMachines === undefined ? NO_MACHINES : (machineConnections ?? NO_MACHINES)}
      usageStore={usage}
    />
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
