import type { FerretId } from '@ferretry/kernel/contract';
import type { Instant } from '@ferretry/std';

// ─── sitrep ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** One line of a ferret's sitrep from a plugin (`sitrep.lines`). Blockers come from the Asks port, not from here. */
export interface SitrepLine {
  readonly kind: 'doing' | 'card' | 'turn' | 'note';
  readonly text: string;
  /** A reference the app renders (`&F12`, `!A3`). */
  readonly ref?: string;
  readonly at?: Instant;
  /** A `card` line only: the name of the lane the card sits in. */
  readonly lane?: string;
  /** A `card` line only: the card's PR as its board last read it (the open one when there are several, else the newest). */
  readonly pr?: SitrepPr;
}

/** A pull request as a sitrep line shows it (a `card` line's `pr`): GitHub's state and checks as the board cached them. */
export interface SitrepPr {
  readonly number: number;
  readonly url: string;
  readonly state: 'unknown' | 'open' | 'closed' | 'merged';
  readonly draft: boolean;
  readonly checks: 'none' | 'pending' | 'passing' | 'failing';
}

export interface SitrepLineSource {
  lines(ferret: FerretId): Promise<readonly SitrepLine[]>;
}
