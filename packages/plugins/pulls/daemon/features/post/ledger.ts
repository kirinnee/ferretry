/**
 * The exactly-once ledger: a request id the person's tap minted maps to the FIRST answer for ten minutes, so a double
 * tap, a retry by the carrier or a second device never posts twice. In memory and bounded; a restart forgets it (declared:
 * the app mints a new id per draft, so a repeat after a restart is a new tap the person made).
 *
 * Only an answer that says something HAPPENED is kept (`posted`, `unknown`). A refusal that certainly sent nothing is
 * dropped at once, so the person can fix the text or the account and try again under the same id.
 */
export const LEDGER_WINDOW_MS = 10 * 60_000;
export const LEDGER_MAX_ENTRIES = 500;

export type Settled<Done, Refusal> =
  | { readonly kind: 'done'; readonly value: Done }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'refused'; readonly refusal: Refusal };

interface Entry<Done, Refusal> {
  readonly fingerprint: string;
  readonly at: number;
  readonly result: Promise<Settled<Done, Refusal>>;
  settled: boolean;
}

export type Ran<Done, Refusal> =
  | { readonly kind: 'ran'; readonly settled: Settled<Done, Refusal>; readonly replayed: boolean }
  /** The id was used for a different post. */
  | { readonly kind: 'mismatch' };

export class PostLedger<Done, Refusal> {
  readonly #entries = new Map<string, Entry<Done, Refusal>>();

  constructor(
    private readonly nowMs: () => number,
    private readonly windowMs = LEDGER_WINDOW_MS,
    private readonly max = LEDGER_MAX_ENTRIES,
  ) {}

  /**
   * Runs `work` once per request id. A repeat while the first is still in flight waits for the same answer; a repeat after
   * it settled gets it again. `work` is never called twice for a kept id.
   */
  async run(
    requestId: string,
    fingerprint: string,
    work: () => Promise<Settled<Done, Refusal>>,
  ): Promise<Ran<Done, Refusal>> {
    this.#sweep();
    const held = this.#entries.get(requestId);
    if (held !== undefined) {
      if (held.fingerprint !== fingerprint) return { kind: 'mismatch' };
      return { kind: 'ran', settled: await held.result, replayed: true };
    }
    const entry: Entry<Done, Refusal> = {
      fingerprint,
      at: this.nowMs(),
      settled: false,
      // A throw is a failure nobody can classify: it is read as "unknown", never as "did not post".
      result: work().catch((): Settled<Done, Refusal> => ({ kind: 'unknown' })),
    };
    this.#entries.set(requestId, entry);
    const settled = await entry.result;
    entry.settled = true;
    if (settled.kind === 'refused') this.#entries.delete(requestId);
    return { kind: 'ran', settled, replayed: false };
  }

  get size(): number {
    return this.#entries.size;
  }

  /** Expired entries go; past the bound the oldest SETTLED ones go (an in-flight one is never dropped). */
  #sweep(): void {
    const now = this.nowMs();
    for (const [id, entry] of this.#entries)
      if (entry.settled && now - entry.at > this.windowMs) this.#entries.delete(id);
    for (const [id, entry] of this.#entries) {
      if (this.#entries.size < this.max) break;
      if (entry.settled) this.#entries.delete(id);
    }
  }
}
