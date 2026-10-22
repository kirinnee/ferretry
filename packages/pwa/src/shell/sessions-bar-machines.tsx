/**
 * THE SESSIONS BAR'S LIST, ACROSS EVERY PAIRED MACHINE (Settings › Behaviour › Sessions list: All
 * machines). The decisions are `allMachinesView`'s; this only draws them:
 *
 *   NEEDS YOU          — pinned, each row naming its machine;
 *   ● machine name     — a reach dot, the name, "offline · last seen 5m" when it stopped answering;
 *     project · count  — that machine's project groups, with the bar's ordinary rows.
 *
 * Every row links to its OWN machine's route, so opening one makes the whole page — header, Info,
 * Actions, composer — that machine's. A machine that is not answering keeps its last rows, greyed.
 */

import type { SessionView } from '@ferretry/protocol';
import type { ReactNode } from 'react';
import type { MachineLearners } from '../features/learning/passive-learning.tsx';
import { type AllMachinesView, machineReachLabel } from '../lib/all-machines.ts';
import { displayCallsign } from '../lib/callsign.ts';
import type { DaemonId } from '../lib/daemon-connection.ts';
import { readOnlyReason } from '../lib/machine-outage.ts';
import { daemonSessionPath } from '../lib/pages/routes.ts';
import { MachineReachDot, MachineReachWords } from './machine-chip.tsx';
import { MachineHeadControls, type MoveMachine, useMachineReorder } from './machine-reorder.tsx';
import { RouteLink } from './route-link.tsx';
import { SessionMenuContext } from './session-menu-context.ts';
import { sessionsBarSubline } from './sessions-bar-model.ts';
import { SessionsBarRow } from './sessions-bar-row.tsx';
import { sessionTree } from './sessions-bar-tree.ts';
import { SessionsBarTree } from './sessions-bar-tree.tsx';
import { StatusMark } from './status-mark.tsx';

const NO_MOVE: MoveMachine = () => undefined;

export interface SessionsBarMachinesProps {
  readonly view: AllMachinesView;
  /** The machine the page belongs to: its rows alone may carry this page's open session. */
  readonly daemonId: DaemonId;
  readonly activeSessionId: string | null;
  /** The machine on screen's passive learners. Session ids collide across machines, so only its rows read it. */
  readonly learningPassive?: ReadonlySet<string>;
  /**
   * Every listed machine's passive learners, by machine: each machine's rows read their own set, so a
   * learner is marked whichever machine it runs on. A machine missing here falls back to nothing — never
   * to another machine's set — except the one on screen, which still reads `learningPassive`.
   */
  readonly machineLearners?: MachineLearners;
  /** Reorders the machine headings; absent, or with a single machine, the headings carry no grip. */
  readonly onMoveMachine?: MoveMachine;
  readonly now: number;
  readonly onNavigate: (to: string) => void;
}

export function SessionsBarMachines({
  view,
  daemonId,
  activeSessionId,
  learningPassive,
  machineLearners,
  now,
  onNavigate,
  onMoveMachine,
}: SessionsBarMachinesProps) {
  const reorder = useMachineReorder(
    view.machines.map(machine => machine.daemonId),
    new Map(view.machines.map(machine => [machine.daemonId, machine.name])),
    onMoveMachine ?? NO_MOVE,
  );
  const reorderable = onMoveMachine !== undefined && view.machines.length > 1;
  const byId = new Map(view.machines.map(machine => [machine.daemonId, machine]));
  const active = (machine: DaemonId, session: SessionView): boolean =>
    machine === daemonId && session.config.id === activeSessionId;
  const learns = (machine: DaemonId, session: SessionView): boolean =>
    (machineLearners?.get(machine) ?? (machine === daemonId ? learningPassive : undefined))?.has(session.config.id) ===
    true;
  return (
    <>
      {view.needsYou.length === 0 ? null : (
        <section aria-label="Needs you" className="fy-sbar__group fy-sbar__needs" data-sbar-needs-you-group="">
          <h2 className="fy-sbar__project">
            <span className="truncate">Needs you</span>
            <span className="fy-sbar__count">{view.needsYou.length}</span>
          </h2>
          <ul>
            {view.needsYou.map(entry => (
              <SessionsBarRow
                active={active(entry.daemonId, entry.view)}
                daemonId={entry.daemonId}
                key={`${entry.daemonId}:${entry.view.config.id}`}
                learningPassive={false}
                machine={entry.machineName}
                onNavigate={onNavigate}
                view={entry.view}
              />
            ))}
          </ul>
        </section>
      )}
      {reorder.drawn
        .flatMap(id => byId.get(id) ?? [])
        .map(machine => {
          const reach = machineReachLabel(machine, now);
          return (
            <section
              aria-label={machine.name}
              className="fy-sbar__machine-group"
              key={machine.daemonId}
              data-machine-reach={machine.reach}
              data-sbar-machine-group={machine.daemonId}
              {...(reorder.dragging === machine.daemonId ? { 'data-dragging': '' } : {})}
              {...(reorder.over?.id === machine.daemonId ? { 'data-drop-edge': reorder.over.edge } : {})}
            >
              <h2
                className="fy-sbar__machine-head"
                {...(machine.outage === null ? {} : { title: readOnlyReason(machine.outage) })}
              >
                {reorderable ? (
                  <MachineHeadControls id={machine.daemonId} name={machine.name} reorder={reorder} />
                ) : null}
                <MachineReachDot reach={machine.reach} />
                <span className="fy-sbar__machine-label truncate">{machine.name}</span>
                <MachineReachWords className="fy-sbar__machine-reach truncate" label={reach} />
                <span className="fy-sbar__count">{machine.total}</span>
              </h2>
              {machine.groups.length === 0 ? (
                <p className="fy-sbar__empty">
                  {machine.needsYou > 0 ? 'Everything here is in Needs you.' : 'No sessions.'}
                </p>
              ) : (
                // A machine that is down keeps its last rows, openable but READ-ONLY: no row menu, because
                // Stop, Rename or Migrate would only fail on a machine nobody can reach — and the title says why.
                <OfflineRows offline={machine.outage !== null}>
                  {machine.groups.map(group => (
                    <div className="fy-sbar__group" key={group.path || group.name}>
                      <h3 className="fy-sbar__project">
                        <span className="truncate">{group.name}</span>
                        <span className="fy-sbar__count">{group.rows.length}</span>
                      </h3>
                      <SessionsBarTree
                        activeSessionId={machine.daemonId === daemonId ? activeSessionId : null}
                        daemonId={machine.daemonId}
                        entries={sessionTree(group.rows, machine.sessions)}
                        isActive={row => active(machine.daemonId, row)}
                        learns={row => learns(machine.daemonId, row)}
                        onNavigate={onNavigate}
                      />
                    </div>
                  ))}
                </OfflineRows>
              )}
            </section>
          );
        })}
      <div className="relative">
        <div aria-live="assertive" className="sr-only" role="status">
          {reorder.announcement}
        </div>
      </div>
    </>
  );
}

/**
 * Rows of a machine that is down: the row menu withheld (its heading's title says why). No wrapper
 * element, so the rows keep exactly the layout every other machine's rows have.
 */
function OfflineRows({ offline, children }: { readonly offline: boolean; readonly children: ReactNode }) {
  return offline ? <SessionMenuContext.Provider value={undefined}>{children}</SessionMenuContext.Provider> : children;
}

/** The collapsed rail's dots across every machine: Needs you first, then each machine's sessions. */
export function SessionsRailMachineDots({
  view,
  daemonId,
  activeSessionId,
  onNavigate,
}: Omit<SessionsBarMachinesProps, 'learningPassive' | 'machineLearners' | 'now'>) {
  const rows = [
    ...view.needsYou.map(entry => ({ daemonId: entry.daemonId, machine: entry.machineName, view: entry.view })),
    ...view.machines.flatMap(machine =>
      machine.groups.flatMap(group =>
        group.rows.map(row => ({ daemonId: machine.daemonId, machine: machine.name, view: row })),
      ),
    ),
  ];
  return (
    <>
      {rows.map(row => {
        const name = displayCallsign(row.view.config.teammate) || row.view.config.label || row.view.config.id;
        return (
          <li key={`${row.daemonId}:${row.view.config.id}`}>
            <RouteLink
              aria-current={row.daemonId === daemonId && row.view.config.id === activeSessionId ? 'page' : undefined}
              aria-label={`${name} on ${row.machine}`}
              className="fy-sbar__dot"
              onNavigate={onNavigate}
              title={`${name} on ${row.machine} — ${sessionsBarSubline(row.view)}`}
              to={daemonSessionPath(row.daemonId, row.view.config.id)}
            >
              <StatusMark view={row.view} />
            </RouteLink>
          </li>
        );
      })}
    </>
  );
}
