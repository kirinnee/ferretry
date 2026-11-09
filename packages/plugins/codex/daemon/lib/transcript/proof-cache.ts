/**
 * What was proved about a key (which rollout is a ferret's), kept only while it may still be reused: an entry older than
 * `reuseMs` is proved again before it is used, so it is dead weight and goes the next time anything is remembered.
 * One small entry per key, never answered stale, and never more than the keys looked at inside one reuse window. Pure
 * over the instants it is told.
 */
export class ProofCache<K, V> {
  readonly #entries = new Map<K, { readonly value: V; readonly atMs: number }>();

  constructor(private readonly reuseMs: number) {}

  /** The proof for `key`, if one was made less than `reuseMs` before `nowMs`; a stale one is never answered. */
  fresh(key: K, nowMs: number): V | undefined {
    const entry = this.#entries.get(key);
    return entry !== undefined && nowMs - entry.atMs < this.reuseMs ? entry.value : undefined;
  }

  /** Keeps `value` for `key`, and drops every entry that is no longer reusable (for any key). */
  remember(key: K, value: V, nowMs: number): void {
    for (const [other, entry] of this.#entries) if (nowMs - entry.atMs >= this.reuseMs) this.#entries.delete(other);
    this.#entries.set(key, { value, atMs: nowMs });
  }

  /** Forgets what was proved for `key` (a relaunch, a stop). */
  forget(key: K): void {
    this.#entries.delete(key);
  }

  /** How many proofs are held now (for tests). */
  get size(): number {
    return this.#entries.size;
  }
}
