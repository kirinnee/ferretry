/**
 * THE SESSIONS PAGE ACROSS EVERY PAIRED MACHINE (Settings › Behaviour › Sessions list: All machines).
 *
 * Needs you first — one container of #555's two-line rows, each naming its machine — then each machine
 * under its own heading with that machine's project groups, drawn by the very group components the
 * one-machine page uses. Each group is handed ITS machine's `DaemonId`, so every row links to its own
 * machine and focusing a folder opens that machine's page at that folder.
 *
 * Quota and the account roster are each machine's own: every read names the machine it is for, so a
 * full row on another machine shows that machine's quota and names its account from that machine's
 * roster. A machine whose roster is unread names no account — it never borrows the one on screen's.
 *
 * A MACHINE THAT IS DOWN IS SAID UNDER ITS OWN HEADING, never over the page: a compact status line
 * ("Asleep · retrying · as of 23:05", Retry now, Details) in that machine's section, its last-known rows
 * greyed and read-only beneath it. "Updating…" likewise belongs to the one machine being refreshed. No
 * machine's outage, error or pending read reaches another machine's section or the page's controls.
 */

import type { MachineRosters } from '../hooks/use-account-picker.ts';
import type { PickerAccount } from '../lib/account-picker-catalog.ts';
import { type AllMachinesView, machineReachLabel } from '../lib/all-machines.ts';
import type { DashboardView, Density } from '../lib/controls.ts';
import type { DaemonId } from '../lib/daemon-connection.ts';
import { readOnlyReason } from '../lib/machine-outage.ts';
import type { ClockEnvironment } from '../lib/message-clock.ts';
import type { SessionQuotaResolver } from '../lib/usage.ts';
import { MachineReachDot, MachineReachWords } from '../shell/machine-chip.tsx';
import { MachineStatusChip } from './machine-status.tsx';
import { FullDensityGroups, LeanDensityGroups } from './session-dashboard-groups.tsx';
import { LeanSessionCard } from './session-dashboard-rows.tsx';
import { Spinner } from './spinner.tsx';

export interface AllMachinesGroupsProps {
  readonly view: AllMachinesView;
  /** The machine on screen. */
  readonly daemonId: DaemonId;
  readonly density: Density;
  readonly mode: DashboardView;
  readonly now: number;
  /** Every read names its machine, so one resolver serves every machine's rows. */
  readonly usage: SessionQuotaResolver | null;
  /** The machine on screen's roster. */
  readonly accounts: readonly PickerAccount[] | null;
  /** Every listed machine's roster, by machine; one missing here names no account on its rows. */
  readonly machineAccounts?: MachineRosters;
  /** Focus one machine's folder. */
  readonly onFocus: (daemonId: DaemonId, path: string) => void;
  readonly onNavigate?: (path: string) => void;
  /** Retry now on one machine's status line: skip its backoff and read its list again. */
  readonly onRetryMachine?: (daemonId: DaemonId) => void;
  /** Pinned only by tests and captures. */
  readonly clock?: ClockEnvironment;
}

export function AllMachinesGroups({
  view,
  daemonId,
  density,
  mode,
  now,
  usage,
  accounts,
  machineAccounts,
  onFocus,
  onNavigate,
  onRetryMachine,
  clock,
}: AllMachinesGroupsProps) {
  // Needs you is a short list of things to answer, so it always uses the two-line rows.
  const pinnedDensity = density === 'full' ? 'compact' : density;
  return (
    <div className="fy-session-groups" data-all-machines="">
      {view.needsYou.length === 0 ? null : (
        <section aria-label="Needs you" className="fy-session-group" data-needs-you-group="">
          <h2 className="fy-session-group__head fy-needs-you__head">
            <span className="min-w-0 truncate text-ui font-semibold">Needs you</span>
            <span className="mono shrink-0 text-meta text-faint">{view.needsYou.length}</span>
          </h2>
          <div className="kt-panel fy-session-group__list">
            {view.needsYou.map(entry => (
              <LeanSessionCard
                daemonId={entry.daemonId}
                density={pinnedDensity}
                key={`${entry.daemonId}:${entry.view.config.id}`}
                machine={entry.machineName}
                now={now}
                onNavigate={onNavigate}
                view={entry.view}
              />
            ))}
          </div>
        </section>
      )}
      {view.machines.map(machine => {
        // An outage says itself in the status line below, so the heading's own words would repeat it.
        const reach = machine.outage === null ? machineReachLabel(machine, now) : '';
        const own = machine.daemonId === daemonId;
        const { outage } = machine;
        return (
          <section
            aria-label={machine.name}
            className="fy-machine-section"
            data-machine-reach={machine.reach}
            data-machine-section={machine.daemonId}
            key={machine.daemonId}
          >
            <h2 className="fy-machine-section__head">
              <MachineReachDot reach={machine.reach} />
              <span className="min-w-0 truncate">{machine.name}</span>
              {outage === null ? (
                <MachineReachWords className="min-w-0 truncate text-meta font-normal text-muted" label={reach} />
              ) : (
                <span className="sr-only">offline</span>
              )}
              {machine.cachedAt === null ? null : (
                <span className="fy-machine-section__updating" data-machine-updating="" role="status">
                  <Spinner size={10} />
                  Updating…
                </span>
              )}
              <span className="mono ml-auto shrink-0 text-meta font-normal text-faint">{machine.total}</span>
            </h2>
            {outage === null ? null : (
              <MachineStatusChip
                outage={outage}
                now={now}
                {...(onRetryMachine === undefined ? {} : { onRetry: () => onRetryMachine(machine.daemonId) })}
                {...(clock === undefined ? {} : { clock })}
              />
            )}
            {machine.groups.length === 0 ? (
              <p className="fy-machine-section__empty">
                {machine.needsYou > 0 ? 'Everything on this machine is in Needs you.' : 'No sessions on this machine.'}
              </p>
            ) : (
              <div
                className="fy-machine-groups"
                {...(outage === null ? {} : { 'data-machine-read-only': '', title: readOnlyReason(outage) })}
              >
                {density === 'full' ? (
                  <FullDensityGroups
                    accounts={machineAccounts?.get(machine.daemonId) ?? (own ? accounts : null)}
                    daemonId={machine.daemonId}
                    groups={machine.groups}
                    mode={mode}
                    now={now}
                    onFocus={path => onFocus(machine.daemonId, path)}
                    onNavigate={onNavigate}
                    scoped={false}
                    usage={usage}
                  />
                ) : (
                  <LeanDensityGroups
                    daemonId={machine.daemonId}
                    density={density}
                    groups={machine.groups}
                    mode={mode}
                    now={now}
                    onFocus={path => onFocus(machine.daemonId, path)}
                    onNavigate={onNavigate}
                    scoped={false}
                  />
                )}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
