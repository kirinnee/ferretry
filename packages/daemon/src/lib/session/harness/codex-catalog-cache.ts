/**
 * Holding one Codex account's advertised catalog for as long as Codex itself would.
 *
 * Reading the catalog costs a child, a handshake and a round trip, and the browser asks for it every
 * time a model sheet opens. Two properties matter and neither is an optimisation:
 *
 *   * SIMULTANEOUS OPENS COALESCE. Two readers arriving while a probe is in flight wait on the SAME
 *     probe rather than starting a second one, because two app-servers against one account is a
 *     second speaker to a live conversation.
 *   * A FAILURE IS NOT CACHED. The entry is dropped when the probe throws, so an account that was
 *     briefly unreachable is re-read on the next ask instead of reporting an outage for five
 *     minutes.
 *
 * The TTL mirrors the five minutes Codex's own on-disk model cache uses. A catalog held longer than
 * the harness holds it could offer a row the picker no longer renders.
 */

import type { RuntimeModelChoice } from '@ferretry/protocol';

/** Reads one account's live catalog. The probe itself, injected. */
export type CodexCatalogProbe = (binary: string, cwd: string) => Promise<readonly RuntimeModelChoice[]>;

/** Milliseconds since the epoch. Injected so an expiry can be reached without waiting for one. */
export type CatalogClock = () => number;

export const CODEX_CATALOG_TTL_MS = 300_000;

interface CacheEntry {
  readonly expiresAt: number;
  readonly value?: readonly RuntimeModelChoice[];
  readonly pending?: Promise<readonly RuntimeModelChoice[]>;
}

export class CodexRuntimeCatalogCache {
  readonly #entries = new Map<string, CacheEntry>();

  constructor(
    readonly probe: CodexCatalogProbe,
    private readonly ttlMs: number = CODEX_CATALOG_TTL_MS,
    private readonly clock: CatalogClock = () => Date.now(),
  ) {}

  /** The catalog for one `(executable, working directory)` pair, fresh or held. */
  async get(binary: string, cwd: string): Promise<readonly RuntimeModelChoice[]> {
    // NUL separates the two halves because neither may contain one, so no pair of distinct inputs
    // can produce the same key.
    const key = `${binary}\0${cwd}`;
    const cached = this.#entries.get(key);
    if (cached?.value !== undefined && cached.expiresAt > this.clock()) return cached.value;
    if (cached?.pending !== undefined) return await cached.pending;

    const pending = this.probe(binary, cwd);
    this.#entries.set(key, { expiresAt: 0, pending });
    try {
      const value = await pending;
      this.#entries.set(key, { value, expiresAt: this.clock() + this.ttlMs });
      return value;
    } catch (error) {
      // Only if this probe is still the one on record: a later reader may already have replaced it.
      if (this.#entries.get(key)?.pending === pending) this.#entries.delete(key);
      throw error;
    }
  }
}
