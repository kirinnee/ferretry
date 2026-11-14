/**
 * THE INTERVALS A LIVE CREDENTIAL WAS ON THE MACHINE, kept where no page script can reach them.
 *
 * A pairing code or a catalog share link is a credential for exactly as long as the daemon that minted it still honours
 * it: from the instant it was minted until it is redeemed, revoked, replaced, spent or past its own deadline. The daemon
 * knows all of that, in its own memory, and a browser page cannot write it — so it is the evidence the agent browser
 * trusts when it must decide whether what a page showed may be handed to an agent (docs/pairing.md, "Never show it to an
 * agent"). A marker in the page's DOM is only a hint on top.
 *
 * ONE OWNER of the idea, used by Access (the pairing code) and Catalogs (a share invite): each keeps its own ledger and
 * offers {@link LiveWindowView} through its own contract port. NO VALUE EVER CROSSES IT: a key is the credential's
 * non-secret handle (a pairing id, a share id), never the credential, and a view answers only yes or no.
 *
 * A LEDGER FORGETS NOTHING IT CANNOT SAY SO. Closed intervals are kept up to a bound; past it the oldest are dropped and
 * the ledger remembers only the latest instant it dropped, after which it answers "yes" to every question it can no
 * longer prove — a refusal costs one read, a forgotten interval costs a credential.
 */

/** What another subsystem may ask: yes or no, never a value and never an interval's key. */
export interface LiveWindowView {
  /** Whether a credential of this kind is live this instant. */
  live(): boolean;
  /**
   * Whether one was live at ANY instant from `sinceMs` (epoch milliseconds) until now, both ends included. An instant
   * in the future, or one the history can no longer prove, answers yes.
   */
  liveSince(sinceMs: number): boolean;
}

interface OpenInterval {
  readonly start: number;
  readonly deadline: number;
}

interface ClosedInterval {
  readonly start: number;
  readonly end: number;
}

/** How many closed intervals are kept before the oldest are folded into "forgotten until". */
export const LIVE_WINDOW_HISTORY = 256;

export class LiveWindowLedger implements LiveWindowView {
  readonly #open = new Map<string, OpenInterval>();
  #closed: ClosedInterval[] = [];
  /** The latest end among intervals dropped for space: anything at or before it cannot be disproved. */
  #forgottenUntil = Number.NEGATIVE_INFINITY;

  readonly #now: () => number;
  readonly #capacity: number;

  constructor(now: () => number, capacity: number = LIVE_WINDOW_HISTORY) {
    this.#now = now;
    this.#capacity = capacity;
  }

  /**
   * A credential became live, with the instant it stops being honoured whatever anyone does. Synchronous, and called
   * BEFORE the answer that carries the credential can leave the process. Opening a key already open keeps its start.
   */
  open(key: string, deadlineMs: number): void {
    if (this.#open.has(key)) return;
    this.#open.set(key, { start: this.#now(), deadline: deadlineMs });
  }

  /** The credential stopped being honoured now (redeemed, revoked, replaced, spent, ended). An unknown key is a no-op. */
  close(key: string): void {
    const held = this.#open.get(key);
    if (held === undefined) return;
    this.#open.delete(key);
    this.#keep({ start: held.start, end: Math.min(this.#now(), held.deadline) });
  }

  live(): boolean {
    const now = this.#now();
    this.#settle(now);
    for (const held of this.#open.values()) if (held.start <= now && now <= held.deadline) return true;
    return false;
  }

  liveSince(sinceMs: number): boolean {
    const now = this.#now();
    if (!Number.isFinite(sinceMs) || sinceMs > now) return true;
    this.#settle(now);
    if (sinceMs <= this.#forgottenUntil) return true;
    for (const held of this.#open.values()) if (held.start <= now && held.deadline >= sinceMs) return true;
    return this.#closed.some(span => span.end >= sinceMs);
  }

  /** Moves every interval whose deadline has passed into the closed history: no request has to ask first. */
  #settle(now: number): void {
    for (const [key, held] of this.#open)
      if (now > held.deadline) {
        this.#open.delete(key);
        this.#keep({ start: held.start, end: held.deadline });
      }
  }

  #keep(span: ClosedInterval): void {
    this.#closed.push(span);
    if (this.#closed.length <= this.#capacity) return;
    this.#closed.sort((left, right) => left.end - right.end);
    const dropped = this.#closed.splice(0, this.#closed.length - this.#capacity);
    for (const gone of dropped) this.#forgottenUntil = Math.max(this.#forgottenUntil, gone.end);
  }
}
