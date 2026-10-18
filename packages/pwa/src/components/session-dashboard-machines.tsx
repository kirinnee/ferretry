/**
 * THE SESSIONS PAGE ACROSS EVERY PAIRED MACHINE (Settings › Behaviour › Sessions list: All machines).
 *
 * Needs you first — one container of #555's two-line rows, each naming its machine — then each machine
 * under its own heading with that machine's project groups, drawn by the very group components the
 * one-machine page uses. Each group is handed ITS machine's `DaemonId`, so every row links to its own
 * machine and focusing a folder opens that machine's page at that folder.
 *
 * Quota and the account roster are only read for the machine on screen, so another machine's full
 * rows name no account and show no quota rather than borrow this one's.
 */

import type { PickerAccount } from '../lib/account-picker-catalog.ts';
import { type AllMachinesView, machineReachLabel } from '../lib/all-machines.ts';
import type { DashboardView, Density } from '../lib/controls.ts';
import type { DaemonId } from '../lib/daemon-connection.ts';
import type { SessionQuotaResolver } from '../lib/usage.ts';
import { MachineReachDot, MachineReachWords } from '../shell/machine-chip.tsx';
import { FullDensityGroups, LeanDensityGroups } from './session-dashboard-groups.tsx';
import { LeanSessionCard } from './session-dashboard-rows.tsx';

export interface AllMachinesGroupsProps {
  readonly view: AllMachinesView;
  /** The machine on screen: the only one whose quota and roster were read. */
  readonly daemonId: DaemonId;
  readonly density: Density;
  readonly mode: DashboardView;
  readonly now: number;
  readonly usage: SessionQuotaResolver | null;
  readonly accounts: readonly PickerAccount[] | null;
  /** Focus one machine's folder. */
  readonly onFocus: (daemonId: DaemonId, path: string) => void;
  readonly onNavigate?: (path: string) => void;
}

export function AllMachinesGroups({
  view,
  daemonId,
  density,
  mode,
  now,
  usage,
  accounts,
  onFocus,
  onNavigate,
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
        const reach = machineReachLabel(machine, now);
        const own = machine.daemonId === daemonId;
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
              <MachineReachWords className="min-w-0 truncate text-meta font-normal text-muted" label={reach} />
              <span className="mono ml-auto shrink-0 text-meta font-normal text-faint">{machine.total}</span>
            </h2>
            {machine.groups.length === 0 ? (
              <p className="fy-machine-section__empty">
                {machine.needsYou > 0 ? 'Everything on this machine is in Needs you.' : 'No sessions on this machine.'}
              </p>
            ) : (
              <div className="fy-machine-groups">
                {density === 'full' ? (
                  <FullDensityGroups
                    accounts={own ? accounts : null}
                    daemonId={machine.daemonId}
                    groups={machine.groups}
                    mode={mode}
                    now={now}
                    onFocus={path => onFocus(machine.daemonId, path)}
                    onNavigate={onNavigate}
                    scoped={false}
                    usage={own ? usage : null}
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
