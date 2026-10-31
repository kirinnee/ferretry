import type { MemberSessionCloser } from './ports.ts';

interface Live {
  readonly memberId: string;
  readonly keyId: string;
  readonly end: () => void;
}

/**
 * EVERY LIVE MEMBER SESSION, so a revoke can close what it revokes (the {@link MemberSessionCloser} 2b-1 left a
 * no-op for this).
 *
 * The order is the service's, not this registry's: it writes the revoke first, drops the in-memory grants, and
 * only then asks this to close. A request already running when a session closes is refused at the request boundary,
 * which re-reads the member's grants on every request; closing the session here only stops the NEXT one arriving.
 */
export class LiveMemberSessions implements MemberSessionCloser {
  readonly #live = new Set<Live>();

  /** A member session opened. Returns the call for when it ends; the end is idempotent. */
  track(memberId: string, keyId: string, end: () => void): () => void {
    const entry: Live = { memberId, keyId, end };
    this.#live.add(entry);
    return () => {
      this.#live.delete(entry);
    };
  }

  get size(): number {
    return this.#live.size;
  }

  async closeMember(memberId: string): Promise<void> {
    this.#close(entry => entry.memberId === memberId);
  }

  async closeKey(memberId: string, keyId: string): Promise<void> {
    this.#close(entry => entry.memberId === memberId && entry.keyId === keyId);
  }

  /** Ended from a copy: ending a session releases its entry, which must not disturb this walk. */
  #close(which: (entry: Live) => boolean): void {
    for (const entry of [...this.#live].filter(which)) {
      this.#live.delete(entry);
      entry.end();
    }
  }
}
