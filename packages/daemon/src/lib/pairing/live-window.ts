/**
 * WHEN A PAIRING CODE IS LIVE, kept where no page can touch it (docs/pairing.md, "Never show it to an agent").
 *
 * The daemon mints a code, and it alone knows when that code is redeemed, expires or is cancelled. This is that
 * knowledge as a small piece of memory the browser guard reads: whether a code is live now, and a count of every code
 * ever minted. The count only goes up and goes up BEFORE the mint answers, so a guard that read the same number before
 * and after an operation knows no code was minted in between — a code that came and went inside one read or one script
 * still moves it. A page cannot write to it, reset it by navigating, or outlive it by being closed, which is the
 * difference from the marker the app leaves in its own DOM (kept as a hint only).
 */
export interface PairingLiveClock {
  now(): number;
}

/** What the guard reads: a code live now, and how many codes have been minted since the daemon started. */
export interface PairingLiveLook {
  readonly live: boolean;
  readonly minted: number;
}

/** What the browser guard needs of the window: the look, and nothing that could change it. */
export interface PairingLiveSource {
  look(): PairingLiveLook;
}

/** What the pairing service tells the window: a code was minted, and the code ended (any way it can). */
export interface PairingLiveSink {
  opened(expiresAtMs: number): void;
  closed(): void;
}

export class PairingLiveWindow implements PairingLiveSource, PairingLiveSink {
  private minted = 0;
  private liveUntilMs: number | undefined;

  constructor(private clock: PairingLiveClock = { now: () => Date.now() }) {}

  /** Reads time from the clock pairing itself runs on, so a code's last instant is the same one for both. */
  useClock(clock: PairingLiveClock): void {
    this.clock = clock;
  }

  /** A code was minted and lives until `expiresAtMs`. Counted first: the answer that carries the code comes after. */
  opened(expiresAtMs: number): void {
    this.minted += 1;
    this.liveUntilMs = expiresAtMs;
  }

  /** The code was redeemed, cancelled, replaced or spent: it can open nothing now. */
  closed(): void {
    this.liveUntilMs = undefined;
  }

  look(): PairingLiveLook {
    return { live: this.liveUntilMs !== undefined && this.clock.now() < this.liveUntilMs, minted: this.minted };
  }
}
