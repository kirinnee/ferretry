import type { DaemonId } from './daemon-connection.ts';
import type { DaemonSessionScope } from './daemon-scope.ts';

/** The full daemon-qualified identity of a cached attachment response. */
export interface DaemonAttachmentScope extends DaemonSessionScope {
  readonly attachmentId: string;
}

const requireAttachmentId = (value: string): string => {
  if (value.trim() === '') throw new Error('attachmentId must not be empty');
  return value;
};

/** Adds an attachment identity without dropping the daemon/session scope. */
export const daemonAttachmentScope = (scope: DaemonSessionScope, attachmentId: string): DaemonAttachmentScope => ({
  ...scope,
  attachmentId: requireAttachmentId(attachmentId),
});

/** Collision-safe cache key for a daemon-owned attachment blob. */
export const daemonAttachmentKey = (scope: DaemonAttachmentScope): string =>
  JSON.stringify([scope.daemonId, scope.sessionId, scope.attachmentId]);

/** Browser API seam: keeping it injected leaves cache policy independently testable. */
export interface AttachmentBlobUrlPort {
  create(blob: Blob): string;
  revoke(url: string): void;
}

interface CacheEntry {
  readonly daemonId: DaemonId;
  readonly promise: Promise<string>;
  url?: string;
  refs: number;
  touched: number;
}

/**
 * Bounded LRU cache for attachment object URLs. Every cache slot includes the
 * daemon fingerprint, so equal session and attachment IDs from two pairings
 * cannot share bytes, work, references, or URL revocation.
 */
export class DaemonAttachmentBlobCache {
  readonly #entries = new Map<string, CacheEntry>();
  readonly #capacity: number;
  readonly #urls: AttachmentBlobUrlPort;
  #clock = 0;

  constructor(urls: AttachmentBlobUrlPort, capacity = 24) {
    if (!Number.isInteger(capacity) || capacity < 1)
      throw new Error('attachment cache capacity must be a positive integer');
    this.#urls = urls;
    this.#capacity = capacity;
  }

  acquire(scope: DaemonAttachmentScope, load: () => Promise<Blob>): Promise<string> {
    const key = daemonAttachmentKey(scope);
    const present = this.#entries.get(key);
    if (present) {
      present.refs += 1;
      present.touched = ++this.#clock;
      return present.promise;
    }

    let entry!: CacheEntry;
    const promise = load()
      .then(blob => {
        const url = this.#urls.create(blob);
        // A disconnected daemon, disposed cache, or evicted in-flight request
        // has no remaining owner. Revoke immediately rather than leaking it.
        if (this.#entries.get(key) !== entry) {
          this.#urls.revoke(url);
          throw new Error('attachment request is no longer needed');
        }
        entry.url = url;
        return url;
      })
      .catch(error => {
        if (this.#entries.get(key) === entry) this.#entries.delete(key);
        throw error;
      });
    entry = {
      daemonId: scope.daemonId,
      refs: 1,
      touched: ++this.#clock,
      promise,
    };
    this.#entries.set(key, entry);
    this.#evict();
    return entry.promise;
  }

  release(scope: DaemonAttachmentScope): void {
    const entry = this.#entries.get(daemonAttachmentKey(scope));
    if (!entry) return;
    entry.refs = Math.max(0, entry.refs - 1);
    entry.touched = ++this.#clock;
    this.#evict();
  }

  /** Removes and revokes only values owned by the disconnected daemon. */
  clearDaemon(daemonId: DaemonId): void {
    for (const [key, entry] of this.#entries) {
      if (entry.daemonId !== daemonId) continue;
      this.#entries.delete(key);
      if (entry.url) this.#urls.revoke(entry.url);
    }
  }

  dispose(): void {
    for (const entry of this.#entries.values()) if (entry.url) this.#urls.revoke(entry.url);
    this.#entries.clear();
  }

  #evict(): void {
    while (this.#entries.size > this.#capacity) {
      let victim: [string, CacheEntry] | undefined;
      for (const candidate of this.#entries) {
        if (candidate[1].refs > 0) continue;
        if (!victim || candidate[1].touched < victim[1].touched) victim = candidate;
      }
      if (!victim) return;
      this.#entries.delete(victim[0]);
      if (victim[1].url) this.#urls.revoke(victim[1].url);
    }
  }
}
