import type { FerretId } from '@ferretry/kernel/contract';
import { failureText } from '../../lib/cgroups/index.ts';
import {
  type RegisteredPaneObserver,
  type RegisteredTerminalPane,
  terminalPaneIdentityMatches,
} from '../../lib/session/attach/identity.ts';
import type { LivePaneSource } from './pane-session-memory.ts';

/** One live managed pane, from the panes the tmux runner recorded. */
export interface ManagedPane {
  readonly sessionId: string;
  readonly pid: number;
}

/** A pane the runner recorded whose live identity could NOT be established. */
export interface UnprovenPane {
  readonly sessionId: string;
  readonly failure: string;
}

/** What the ledger could and could not establish about this daemon's live panes. */
export interface LivePanes {
  readonly panes: readonly ManagedPane[];
  readonly unproven: readonly UnprovenPane[];
  readonly incomplete?: string;
}

/** The ferrets that are not stopped, and the pane the runner recorded for each. */
export interface RunnerPaneDirectory {
  live(): Promise<readonly FerretId[]>;
  paneOf(ferret: FerretId): Promise<RegisteredTerminalPane | undefined>;
}

/**
 * The live panes a limit change could reach, from the panes the tmux RUNNER recorded (today's
 * `RegisteredCgroupPaneLedger`, over the runner's record instead of the old registration files).
 *
 * NEVER MULTIPLEXER DISCOVERY. A pane this daemon did not start is not a pane it may reconfigure. A FERRET IS
 * LIVE UNTIL FERRETS SAYS IT STOPPED. A PID IS NOT AN IDENTITY: each recorded pane is re-observed and matched
 * through `terminalPaneIdentityMatches`. NOTHING IT CANNOT PROVE IS DROPPED: an unobservable pane or a disagreeing
 * incarnation is UNPROVEN rather than absent.
 */
export class RunnerCgroupPaneLedger implements LivePaneSource {
  constructor(
    private readonly directory: RunnerPaneDirectory,
    private readonly observer: RegisteredPaneObserver,
  ) {}

  async live(): Promise<LivePanes> {
    let candidates: { readonly sessionId: FerretId; readonly registration: RegisteredTerminalPane | undefined }[];
    try {
      const ferrets = await this.directory.live();
      candidates = await Promise.all(
        ferrets.map(async sessionId => ({ sessionId, registration: await this.directory.paneOf(sessionId) })),
      );
    } catch (error) {
      return {
        panes: [],
        unproven: [],
        incomplete: `the ferrets' panes could not be read (${failureText(error)}), so no running ferret's resource limits can be reported or changed`,
      };
    }
    const unproven: UnprovenPane[] = [];
    const panes: ManagedPane[] = [];
    for (const { sessionId, registration } of candidates) {
      if (registration === undefined) continue;
      const observation = await this.observer.observe(registration).catch(() => undefined);
      if (observation === undefined || !terminalPaneIdentityMatches(registration, observation)) {
        unproven.push({
          sessionId,
          failure: `the pane registered for ${sessionId} is no longer the incarnation this daemon launched (pid ${registration.pid}), so its resource limits are neither readable nor changeable; relaunch it`,
        });
        continue;
      }
      panes.push({ sessionId, pid: registration.pid });
    }
    return { panes, unproven };
  }
}
