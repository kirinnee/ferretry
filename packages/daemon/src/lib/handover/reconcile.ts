/**
 * The loop that finishes handovers nobody is watching.
 *
 * WHY A RECONCILER AND NOT A CALLBACK. The state machine's middle is a WAIT: the daemon drives up to
 * the launch and then waits for an inbound verification only the replacement's own pane can make. A
 * hook on that route would be lost across a daemon restart, and the receipt would sit half-applied
 * with two active roots on a board and nothing left to advance it. Re-reading the durable receipt on
 * a tick has no such window — the document IS the mechanism, and this is the thing that reads it.
 *
 * IT ALSO CLOSES THE CRASH WINDOWS. Every phase is written before the effect it authorizes, so a
 * daemon that died mid-handover restarts holding a document naming exactly what it was about to do;
 * this loop is what then does it. The one that matters most is between the relinquish and the stop,
 * where a crash leaves a running predecessor with no membership — nothing else in the daemon would
 * ever go back for it.
 *
 * SERIALIZATION AND A SWEEP AT BOOT are the same two decisions the warden's loop makes, for the same
 * two reasons: overlapping sweeps would each read a document before the other wrote, and a fleet with
 * a stranded handover must not have to wait a whole interval after every restart before anything
 * looks at it. The boot sweep is fired and NOT awaited — a daemon must not hold its own startup on a
 * scan of every session.
 */

/** The scheduling the loop needs, injected so a test drives it without waiting real minutes. */
export interface HandoverScheduler {
  /** Calls `tick` every `intervalMs`, returning the cancel. */
  every(intervalMs: number, tick: () => void): () => void;
}

/** The roster: which sessions still have a handover to finish. */
export interface HandoverRoster {
  pendingSourceSessionIds(): Promise<readonly string[]>;
}

/** One handover, driven as far as it can go. */
export interface HandoverAdvancer {
  advance(sourceSessionId: string): Promise<unknown>;
}

/** How often the roster is re-read. A handover's own steps are effects, not polls, so this is slow. */
export const DEFAULT_HANDOVER_RECONCILE_INTERVAL_MS = 15_000;

/** What one pass did, so an operator surface can say whether supervision is actually running. */
export interface HandoverReconcilePass {
  readonly considered: number;
  readonly advanced: number;
  /** Sessions whose advance threw, with the reason. A pass reports its blind spots rather than hiding them. */
  readonly failures: readonly { readonly sessionId: string; readonly reason: string }[];
}

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class HandoverReconcileLoop {
  /** The tail of the pass chain. Always settled, never rejected. */
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly advancer: HandoverAdvancer,
    private readonly roster: HandoverRoster,
    private readonly scheduler: HandoverScheduler,
    private readonly intervalMs: number = DEFAULT_HANDOVER_RECONCILE_INTERVAL_MS,
  ) {}

  /**
   * One pass, after every pass already queued.
   *
   * The chain is advanced with a swallowing continuation rather than the pass's own promise, so a
   * rejected pass leaves the chain settled and the NEXT pass still happens. The rejection is still
   * delivered to this caller, because an operator who asked for a pass must be told it failed.
   */
  async run(): Promise<HandoverReconcilePass> {
    const queued = this.chain.then(async () => await this.pass());
    this.chain = queued.then(
      () => undefined,
      () => undefined,
    );
    return await queued;
  }

  /**
   * One handover's failure is not the sweep's.
   *
   * A session whose advance throws is recorded and the pass carries on to the next: a fleet with one
   * wedged handover must not be a fleet where no other handover ever finishes. Reading the roster
   * itself is a different matter — if that fails there is nothing to iterate, and the caller is told.
   */
  private async pass(): Promise<HandoverReconcilePass> {
    const pending = await this.roster.pendingSourceSessionIds();
    const failures: { readonly sessionId: string; readonly reason: string }[] = [];
    let advanced = 0;
    for (const sessionId of pending) {
      try {
        await this.advancer.advance(sessionId);
        advanced += 1;
      } catch (error) {
        failures.push({ sessionId, reason: detail(error) });
      }
    }
    return { considered: pending.length, advanced, failures };
  }

  /**
   * Arm the periodic pass and return the disarm.
   *
   * Errors from the periodic pass are swallowed. An unhandled rejection from a background timer takes
   * down a daemon whose fleet is fine, and a pass that could not run is already visible as a receipt
   * that has not advanced.
   */
  arm(): () => void {
    const cancel = this.scheduler.every(this.intervalMs, () => {
      void this.run().catch(() => undefined);
    });
    void this.run().catch(() => undefined);
    return cancel;
  }
}
