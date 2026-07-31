import { PinSnapshotSchema, type PinSnapshot } from '@ferretry/protocol';
import type { DaemonId } from './daemon-connection.ts';
import { daemonSessionKey, type DaemonSessionScope } from './daemon-scope.ts';

export type PinLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * Immutable client read model for daemon-authoritative pin snapshots. Every
 * entry is addressed by the paired daemon as well as its session, so a reused
 * session ID can never expose another daemon's pins.
 */
export interface DaemonPinSnapshot {
  readonly snapshots: ReadonlyMap<string, PinSnapshot>;
  readonly statuses: ReadonlyMap<string, PinLoadStatus>;
}

const emptySnapshot = (): DaemonPinSnapshot => ({ snapshots: new Map(), statuses: new Map() });

type Listener = () => void;

/**
 * Holds validated pin snapshots for the document lifetime. Transport and
 * mutation policy deliberately remain separate: callers must provide the full
 * scope used for a daemon response before it can enter this cache.
 */
export class DaemonPinStore {
  #snapshot = emptySnapshot();
  readonly #listeners = new Set<Listener>();
  readonly #daemonIds = new Map<string, DaemonId>();

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  getSnapshot(): DaemonPinSnapshot {
    return this.#snapshot;
  }

  pins(scope: DaemonSessionScope): PinSnapshot | undefined {
    return this.#snapshot.snapshots.get(daemonSessionKey(scope));
  }

  status(scope: DaemonSessionScope): PinLoadStatus {
    return this.#snapshot.statuses.get(daemonSessionKey(scope)) ?? 'idle';
  }

  beginLoad(scope: DaemonSessionScope): void {
    this.#setStatus(scope, 'loading');
  }

  fail(scope: DaemonSessionScope): void {
    this.#setStatus(scope, 'error');
  }

  /** Applies only a complete, protocol-validated snapshot for this scope. */
  applySnapshot(scope: DaemonSessionScope, value: unknown): boolean {
    const parsed = PinSnapshotSchema.safeParse(value);
    if (!parsed.success || parsed.data.sessionId !== scope.sessionId) {
      this.fail(scope);
      return false;
    }
    const key = this.#remember(scope);
    const snapshots = new Map(this.#snapshot.snapshots).set(key, parsed.data);
    const statuses = new Map(this.#snapshot.statuses).set(key, 'ready');
    this.#publish({ snapshots, statuses });
    return true;
  }

  forget(scope: DaemonSessionScope): boolean {
    const key = daemonSessionKey(scope);
    if (!this.#daemonIds.has(key)) return false;
    const snapshots = new Map(this.#snapshot.snapshots);
    const statuses = new Map(this.#snapshot.statuses);
    snapshots.delete(key);
    statuses.delete(key);
    this.#daemonIds.delete(key);
    this.#publish({ snapshots, statuses });
    return true;
  }

  /** Removes all data belonging to one disconnected paired daemon only. */
  clearDaemon(daemonId: DaemonId): void {
    const keys = [...this.#daemonIds].filter(([, value]) => value === daemonId).map(([key]) => key);
    if (keys.length === 0) return;
    const snapshots = new Map(this.#snapshot.snapshots);
    const statuses = new Map(this.#snapshot.statuses);
    for (const key of keys) {
      snapshots.delete(key);
      statuses.delete(key);
      this.#daemonIds.delete(key);
    }
    this.#publish({ snapshots, statuses });
  }

  #remember(scope: DaemonSessionScope): string {
    const key = daemonSessionKey(scope);
    this.#daemonIds.set(key, scope.daemonId);
    return key;
  }

  #setStatus(scope: DaemonSessionScope, status: PinLoadStatus): void {
    const key = this.#remember(scope);
    if (this.#snapshot.statuses.get(key) === status) return;
    this.#publish({ ...this.#snapshot, statuses: new Map(this.#snapshot.statuses).set(key, status) });
  }

  #publish(snapshot: DaemonPinSnapshot): void {
    this.#snapshot = snapshot;
    for (const listener of this.#listeners) listener();
  }
}
