import { AgendaCountResponseSchema, type AgendaSnapshot, AgendaSnapshotSchema } from '@ferretry/protocol';
import type { DaemonId } from './daemon-connection.ts';
import { type DaemonSessionScope, daemonSessionKey } from './daemon-scope.ts';

export type AgendaLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * Immutable read model for attention data received from every paired daemon.
 * Keys are opaque daemon/session pairs: no session-only API is available.
 */
export interface DaemonAgendaSnapshot {
  readonly snapshots: ReadonlyMap<string, AgendaSnapshot>;
  readonly counts: ReadonlyMap<string, number>;
  readonly statuses: ReadonlyMap<string, AgendaLoadStatus>;
}

const emptySnapshot = (): DaemonAgendaSnapshot => ({
  snapshots: new Map(),
  counts: new Map(),
  statuses: new Map(),
});

type Listener = () => void;

/**
 * Holds daemon-authoritative agenda snapshots for the document lifetime.
 * Transport is deliberately separate; callers validate a response by applying
 * it through the full daemon/session scope that issued the request.
 */
export class DaemonAgendaStore {
  #snapshot = emptySnapshot();
  readonly #listeners = new Set<Listener>();
  readonly #daemonIds = new Map<string, DaemonId>();

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  getSnapshot(): DaemonAgendaSnapshot {
    return this.#snapshot;
  }

  agenda(scope: DaemonSessionScope): AgendaSnapshot | undefined {
    return this.#snapshot.snapshots.get(daemonSessionKey(scope));
  }

  count(scope: DaemonSessionScope): number | undefined {
    return this.#snapshot.counts.get(daemonSessionKey(scope));
  }

  status(scope: DaemonSessionScope): AgendaLoadStatus {
    return this.#snapshot.statuses.get(daemonSessionKey(scope)) ?? 'idle';
  }

  beginLoad(scope: DaemonSessionScope): void {
    this.#setStatus(scope, 'loading');
  }

  fail(scope: DaemonSessionScope): void {
    this.#setStatus(scope, 'error');
  }

  /** Applies a complete authoritative response, rejecting a mismatched scope. */
  applySnapshot(scope: DaemonSessionScope, value: unknown): boolean {
    const parsed = AgendaSnapshotSchema.safeParse(value);
    if (!parsed.success || parsed.data.sessionId !== scope.sessionId) {
      this.fail(scope);
      return false;
    }
    const key = this.#remember(scope);
    const snapshots = new Map(this.#snapshot.snapshots).set(key, parsed.data);
    const counts = new Map(this.#snapshot.counts).set(key, parsed.data.count);
    const statuses = new Map(this.#snapshot.statuses).set(key, 'ready');
    this.#publish({ snapshots, counts, statuses });
    return true;
  }

  /** Applies a cheap count response without treating it as a complete board. */
  applyCount(scope: DaemonSessionScope, value: unknown): boolean {
    const parsed = AgendaCountResponseSchema.safeParse(value);
    if (!parsed.success || parsed.data.sessionId !== scope.sessionId) return false;
    const key = this.#remember(scope);
    const counts = new Map(this.#snapshot.counts).set(key, parsed.data.count);
    // A badge response knows only the number. It must never turn an idle or
    // loading full board into ready, and it must not overwrite a prior status.
    this.#publish({ ...this.#snapshot, counts });
    return true;
  }

  forget(scope: DaemonSessionScope): boolean {
    const key = daemonSessionKey(scope);
    if (!this.#daemonIds.has(key)) return false;
    const snapshots = new Map(this.#snapshot.snapshots);
    const counts = new Map(this.#snapshot.counts);
    const statuses = new Map(this.#snapshot.statuses);
    snapshots.delete(key);
    counts.delete(key);
    statuses.delete(key);
    this.#daemonIds.delete(key);
    this.#publish({ snapshots, counts, statuses });
    return true;
  }

  /** Removes every cached query value from one disconnected daemon only. */
  clearDaemon(daemonId: DaemonId): void {
    const keys = [...this.#daemonIds].filter(([, value]) => value === daemonId).map(([key]) => key);
    if (keys.length === 0) return;
    const snapshots = new Map(this.#snapshot.snapshots);
    const counts = new Map(this.#snapshot.counts);
    const statuses = new Map(this.#snapshot.statuses);
    for (const key of keys) {
      snapshots.delete(key);
      counts.delete(key);
      statuses.delete(key);
      this.#daemonIds.delete(key);
    }
    this.#publish({ snapshots, counts, statuses });
  }

  #remember(scope: DaemonSessionScope): string {
    const key = daemonSessionKey(scope);
    this.#daemonIds.set(key, scope.daemonId);
    return key;
  }

  #setStatus(scope: DaemonSessionScope, status: AgendaLoadStatus): void {
    const key = this.#remember(scope);
    if (this.#snapshot.statuses.get(key) === status) return;
    this.#publish({ ...this.#snapshot, statuses: new Map(this.#snapshot.statuses).set(key, status) });
  }

  #publish(snapshot: DaemonAgendaSnapshot): void {
    this.#snapshot = snapshot;
    for (const listener of this.#listeners) listener();
  }
}
