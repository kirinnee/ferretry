/**
 * Which paired daemons the Warden page shows, as a pure decision.
 *
 * The page reads one daemon per section; this says which sections there are. Nothing is merged across
 * daemons: a section is one daemon's own status, so a flag, a revive or a total always belongs to the
 * daemon named on it.
 *
 * Under All every paired daemon is a section. A remembered choice that is no longer paired reads as All
 * rather than as an empty page, and one paired daemon needs no filter at all.
 */

import type { DaemonConnection, DaemonId } from '../../lib/daemon-connection.ts';

export interface WardenMachine {
  readonly connection: DaemonConnection;
  /** The name the sessions bar shows, told apart from a twin. */
  readonly name: string;
}

export interface WardenScope {
  /** The daemon the page is narrowed to; `null` = All. */
  readonly selected: DaemonId | null;
  readonly shown: readonly WardenMachine[];
  readonly offerFilter: boolean;
}

export const resolveWardenScope = (machines: readonly WardenMachine[], remembered: string | null): WardenScope => {
  if (machines.length < 2) return { selected: null, shown: machines, offerFilter: false };
  const chosen = machines.find(machine => machine.connection.daemonId === remembered);
  return chosen === undefined
    ? { selected: null, shown: machines, offerFilter: true }
    : { selected: chosen.connection.daemonId, shown: [chosen], offerFilter: true };
};
