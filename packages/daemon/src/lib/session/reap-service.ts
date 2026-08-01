import {
  planTerminalReap,
  type DurableTerminalSession,
  type ObservedTerminalPane,
  type RegisteredTerminalPane,
  type TerminalReapTarget,
} from './reap.ts';

/** Durable registrations belonging to one daemon. Listing tmux is intentionally not this port. */
export interface TerminalPaneRegistry {
  list(daemonId: string): Promise<readonly RegisteredTerminalPane[]>;
}

/** Durable terminal state, separately read from the process observation. */
export interface TerminalReapSessionDirectory {
  list(daemonId: string): Promise<readonly DurableTerminalSession[]>;
}

/** Reads only a pane that was supplied from the daemon's own registration ledger. */
export interface RegisteredPaneObserver {
  observe(registration: RegisteredTerminalPane): Promise<ObservedTerminalPane | undefined>;
}

/**
 * Kills the exact target after re-checking its complete identity at the process boundary.
 *
 * The repeated identity is important: inspection and action are separate operations, so a tmux
 * session recreated after inspection must be refused at the adapter rather than killed by name.
 */
export interface ExactTerminalReaper {
  reap(target: TerminalReapTarget): Promise<void>;
}

export interface TerminalReapSweepResult {
  readonly planned: number;
  readonly reaped: number;
}

/** One daemon-owned sweep. It never asks tmux to discover possible targets. */
export class TerminalReapService {
  constructor(
    private readonly daemonId: string,
    private readonly registry: TerminalPaneRegistry,
    private readonly sessions: TerminalReapSessionDirectory,
    private readonly observer: RegisteredPaneObserver,
    private readonly reaper: ExactTerminalReaper,
  ) {}

  async sweep(): Promise<TerminalReapSweepResult> {
    if (this.daemonId.length === 0) return { planned: 0, reaped: 0 };
    const [registrations, durableSessions] = await Promise.all([
      this.registry.list(this.daemonId),
      this.sessions.list(this.daemonId),
    ]);
    // Observation is only ever requested for a registered record. A broad `list-panes` call would
    // turn an unregistered human shell into a candidate and is therefore not part of this design.
    const ownRegistrations = registrations.filter(registration => registration.daemonId === this.daemonId);
    const observations = await Promise.all(ownRegistrations.map(registration => this.observer.observe(registration)));
    const plan = planTerminalReap({
      daemonId: this.daemonId,
      registrations: ownRegistrations,
      sessions: durableSessions,
      observations: observations.filter((value): value is ObservedTerminalPane => value !== undefined),
    });
    for (const target of plan.targets) await this.reaper.reap(target);
    return { planned: plan.targets.length, reaped: plan.targets.length };
  }
}
