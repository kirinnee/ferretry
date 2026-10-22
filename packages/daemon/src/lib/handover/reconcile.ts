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
 *
 * IT TICKS ONLY WHILE A HANDOVER IS OPEN (docs/design/housekeeping-worker.md §4 PR 4). The tick used to
 * read every session directory's receipt every fifteen seconds, on a fleet that almost never has a
 * handover in flight. The roster now REMEMBERS which receipts are open — the boot sweep found them, and
 * every receipt since was written through it — so the tick is armed when one opens and dropped once a
 * pass finds none. One slow backstop, {@link HANDOVER_RESCAN_INTERVAL_MS}, still reads every receipt
 * again, for a document that changed behind the daemon's back.
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

/** A roster kept in memory: what the receipts said when last read, and every write since. */
export interface RememberedHandoverRoster extends HandoverRoster {
  /** Whether a receipt is known to be open, from memory alone. */
  anyOpen(): boolean;
  /** Hear whenever a write opens a receipt. Answers the unsubscribe. */
  onOpened(listener: () => void): () => void;
  /** The next roster read reads every receipt again rather than trusting memory. */
  forget(): void;
}

/** One handover, driven as far as it can go. */
export interface HandoverAdvancer {
  advance(sourceSessionId: string): Promise<unknown>;
}

/** How often an open handover is advanced. A handover's own steps are effects, not polls, so this is slow. */
export const DEFAULT_HANDOVER_RECONCILE_INTERVAL_MS = 15_000;

/**
 * The backstop: how often every receipt is read again, whatever memory says. The daemon is the only
 * writer of a receipt, so this catches only a document edited or restored behind its back.
 */
export const HANDOVER_RESCAN_INTERVAL_MS = 15 * 60_000;

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
    private readonly roster: RememberedHandoverRoster,
    private readonly scheduler: HandoverScheduler,
    private readonly intervalMs: number = DEFAULT_HANDOVER_RECONCILE_INTERVAL_MS,
    private readonly rescanMs: number = HANDOVER_RESCAN_INTERVAL_MS,
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
   * Arm the boot sweep, the tick while a handover is open, and the backstop; return the disarm.
   *
   * After every pass, and whenever a write opens a receipt, the tick is armed if one is open and dropped
   * if none is. Errors from a background pass are swallowed. An unhandled rejection from a background
   * timer takes down a daemon whose fleet is fine, and a pass that could not run is already visible as a
   * receipt that has not advanced.
   */
  arm(): () => void {
    let disarmed = false;
    let ticking: (() => void) | undefined;
    const follow = (): void => {
      if (disarmed) return;
      const open = this.roster.anyOpen();
      if (open && ticking === undefined) ticking = this.scheduler.every(this.intervalMs, pass);
      else if (!open && ticking !== undefined) {
        ticking();
        ticking = undefined;
      }
    };
    const pass = (): void => {
      void this.run().then(follow, follow);
    };
    const unsubscribe = this.roster.onOpened(follow);
    const backstop = this.scheduler.every(this.rescanMs, () => {
      this.roster.forget();
      pass();
    });
    pass();
    return () => {
      disarmed = true;
      unsubscribe();
      backstop();
      ticking?.();
      ticking = undefined;
    };
  }
}
