import type { DaemonConnection, DaemonId } from './daemon-connection.ts';

export interface DaemonSessionScope {
  readonly daemonId: DaemonId;
  readonly sessionId: string;
}

const requireSessionId = (value: string): string => {
  if (value.trim() === '') throw new Error('sessionId must not be empty');
  return value;
};

/** Creates the required `(daemonId, sessionId)` identity for UI state. */
export const daemonSessionScope = (
  daemon: Pick<DaemonConnection, 'daemonId'>,
  sessionId: string,
): DaemonSessionScope => ({
  daemonId: daemon.daemonId,
  sessionId: requireSessionId(sessionId),
});

/** A collision-safe key for persisted or in-memory session state. */
export const daemonSessionKey = (scope: DaemonSessionScope): string =>
  JSON.stringify([scope.daemonId, scope.sessionId]);

/**
 * Cache and store primitive for every daemon-derived session value.  Its API
 * deliberately has no session-only overload, making cross-daemon cache reuse
 * impossible at the shared seam.
 */
export class DaemonSessionCache<Value> {
  readonly #values = new Map<string, Value>();

  get(scope: DaemonSessionScope): Value | undefined {
    return this.#values.get(daemonSessionKey(scope));
  }

  set(scope: DaemonSessionScope, value: Value): void {
    this.#values.set(daemonSessionKey(scope), value);
  }

  delete(scope: DaemonSessionScope): boolean {
    return this.#values.delete(daemonSessionKey(scope));
  }

  clearDaemon(daemonId: DaemonId): void {
    for (const key of this.#values.keys()) {
      const [cachedDaemonId] = JSON.parse(key) as [string, string];
      if (cachedDaemonId === daemonId) this.#values.delete(key);
    }
  }
}
