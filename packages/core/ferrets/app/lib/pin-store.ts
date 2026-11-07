import { type PinSnapshot, PinSnapshotSchema } from '@ferretry/protocol';
import type { DaemonId } from './daemon-connection.ts';
import { type DaemonSessionScope, daemonSessionKey } from './daemon-scope.ts';

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

/**
 * An optimistic board write, tied to the exact daemon/session entry it
 * replaced. A later response may reconcile only while this object is still
 * current; reference identity makes superseded writes unambiguous.
 */
export interface DaemonPinEcho {
  readonly scope: DaemonSessionScope;
  readonly snapshot: PinSnapshot | undefined;
  readonly previousSnapshot: PinSnapshot | undefined;
  readonly previousStatus: PinLoadStatus | undefined;
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
  readonly #echoes = new Map<string, DaemonPinEcho>();

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
    this.#echoes.delete(key);
    const snapshots = new Map(this.#snapshot.snapshots).set(key, parsed.data);
    const statuses = new Map(this.#snapshot.statuses).set(key, 'ready');
    this.#publish({ snapshots, statuses });
    return true;
  }

  /**
   * Writes a predicted board and returns the token that owns that write. An
   * unloaded board still gets a token, so its request cannot later overwrite a
   * snapshot that arrived while it was in flight.
   */
  applyEcho(scope: DaemonSessionScope, value: PinSnapshot | undefined): DaemonPinEcho {
    if (value !== undefined) {
      const parsed = PinSnapshotSchema.parse(value);
      if (parsed.sessionId !== scope.sessionId) throw new Error('pin echo must describe its requested session');
      value = parsed;
    }
    const key = this.#remember(scope);
    const echo: DaemonPinEcho = {
      scope,
      snapshot: value,
      previousSnapshot: this.#snapshot.snapshots.get(key),
      previousStatus: this.#snapshot.statuses.get(key),
    };
    this.#echoes.set(key, echo);
    if (value !== undefined) {
      const snapshots = new Map(this.#snapshot.snapshots).set(key, value);
      const statuses = new Map(this.#snapshot.statuses).set(key, 'ready');
      this.#publish({ snapshots, statuses });
    }
    return echo;
  }

  /** Replaces an optimistic value only while it is the exact current value. */
  reconcileEcho(echo: DaemonPinEcho, value: unknown): boolean {
    const key = daemonSessionKey(echo.scope);
    if (this.#echoes.get(key) !== echo || this.#snapshot.snapshots.get(key) !== echo.snapshot) return false;
    return this.applySnapshot(echo.scope, value);
  }

  /** Rolls an optimistic value back only when no newer writer has replaced it. */
  restoreEcho(echo: DaemonPinEcho): boolean {
    const key = daemonSessionKey(echo.scope);
    if (this.#echoes.get(key) !== echo || this.#snapshot.snapshots.get(key) !== echo.snapshot) return false;
    this.#echoes.delete(key);
    const snapshots = new Map(this.#snapshot.snapshots);
    const statuses = new Map(this.#snapshot.statuses);
    if (echo.previousSnapshot === undefined) snapshots.delete(key);
    else snapshots.set(key, echo.previousSnapshot);
    if (echo.previousStatus === undefined) statuses.delete(key);
    else statuses.set(key, echo.previousStatus);
    if (echo.previousSnapshot === undefined) this.#daemonIds.delete(key);
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
    this.#echoes.delete(key);
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
      this.#echoes.delete(key);
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
    this.#echoes.delete(key);
    this.#publish({ ...this.#snapshot, statuses: new Map(this.#snapshot.statuses).set(key, status) });
  }

  #publish(snapshot: DaemonPinSnapshot): void {
    this.#snapshot = snapshot;
    for (const listener of this.#listeners) listener();
  }
}
