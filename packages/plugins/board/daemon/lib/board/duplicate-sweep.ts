/**
 * THE SWEEP FOR DUPLICATE ASKS (docs/agenda.md § One ask per thing): closes the asks proven to be the same ask twice
 * ("duplicate of !A3") and keeps what it only suspects for `fy doctor`. Runs at boot and after every Warden sweep; one
 * run at a time, never rejects.
 *
 * What counts as a duplicate, and how an ask is closed, is where the asks live (Asks / Agenda): this is the single-flight
 * runner over that port, so a second caller during a run waits for the first and a failure is a warning, never a throw.
 */

/** An ask pair or group the sweep suspects but left open, as the health report words it. */
export interface DuplicateAsk {
  readonly kind: string;
  readonly members: readonly { readonly ferret: string; readonly id: string }[];
  readonly why: string;
}

/** What one pass over every ferret's asks came to. */
export interface DuplicatePass {
  /** How many proven duplicates it closed. */
  readonly closed: number;
  /** What it suspects but left open. */
  readonly possible: readonly DuplicateAsk[];
}

export interface DuplicateSweepDependencies {
  /** One pass over every ledger; throws when it cannot read. */
  readonly asks: { sweep(): Promise<DuplicatePass> };
  readonly diagnostics: { warn(message: string): void };
}

export class DuplicateSweep {
  private running: Promise<number> | undefined;
  private left: readonly DuplicateAsk[] = [];

  constructor(private readonly ports: DuplicateSweepDependencies) {}

  /** What the last run suspected but left open, as the health report words it. */
  possible(): readonly DuplicateAsk[] {
    return this.left;
  }

  /** One run, after the one already going; how many asks it closed. */
  async run(): Promise<number> {
    this.running ??= this.ports.asks
      .sweep()
      .then(pass => {
        this.left = pass.possible;
        return pass.closed;
      })
      .catch((error: unknown) => {
        this.ports.diagnostics.warn(
          `the sweep of duplicate asks failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return 0;
      })
      .finally(() => {
        this.running = undefined;
      });
    return await this.running;
  }
}
