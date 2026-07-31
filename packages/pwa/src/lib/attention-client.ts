import {
  type AttentionActionRequest,
  AttentionActionRequestSchema,
  type AttentionCountResponse,
  type AttentionResponse,
  type AttentionSnapshot,
  AttentionSnapshotSchema,
  FY_REQUEST_ID_HEADER,
} from '@ferretry/protocol';
import { DaemonAttentionStore } from './attention-store.ts';
import type { DaemonConnection, DaemonId } from './daemon-connection.ts';
import { type DaemonSessionScope, daemonSessionKey } from './daemon-scope.ts';
import { daemonRequest } from './daemon-transport.ts';
import { type DaemonFetch, DaemonResponseError } from './runtime-models.ts';

const assertScopeDaemon = (daemon: DaemonConnection, scope: DaemonSessionScope): void => {
  if (daemon.daemonId !== scope.daemonId) throw new Error('attention scope must belong to the requested daemon');
};

export const attentionPath = (scope: DaemonSessionScope): string =>
  `/v1/sessions/${encodeURIComponent(scope.sessionId)}/attention`;

const responseError = async (response: Response): Promise<DaemonResponseError> => {
  const body = (await response.json().catch(() => ({}))) as { error?: unknown; code?: unknown };
  return new DaemonResponseError(
    response.status,
    typeof body.error === 'string' ? body.error : `HTTP ${response.status}`,
    typeof body.code === 'string' ? body.code : undefined,
  );
};

const parseSnapshot = (scope: DaemonSessionScope, value: unknown): AttentionSnapshot => {
  const snapshot = AttentionSnapshotSchema.parse(value);
  if (snapshot.sessionId !== scope.sessionId) throw new DaemonResponseError(502, 'daemon returned another session');
  return snapshot;
};

const fetchAttention = async (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  path: string,
  init: RequestInit,
  fetcher: DaemonFetch,
): Promise<unknown> => {
  assertScopeDaemon(daemon, scope);
  const request = daemonRequest(daemon, path, init);
  const response = await fetcher(request.url, request.init);
  if (!response.ok) throw await responseError(response);
  return await response.json();
};

/** Reads the complete attention board from exactly the daemon that owns the scope. */
export const fetchAttentionSnapshot = async (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  fetcher: DaemonFetch = fetch,
): Promise<AttentionSnapshot> =>
  parseSnapshot(scope, await fetchAttention(daemon, scope, attentionPath(scope), {}, fetcher));

/**
 * Reads the mounted full snapshot route and derives its count for a badge
 * without implying that the complete board was loaded into the store.
 */
export const fetchAttentionCount = async (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  fetcher: DaemonFetch = fetch,
): Promise<AttentionCountResponse> => {
  const snapshot = await fetchAttentionSnapshot(daemon, scope, fetcher);
  return { sessionId: snapshot.sessionId, count: snapshot.count };
};

/** Applies one protocol-validated board mutation and returns the daemon's authoritative snapshot. */
export const applyAttentionAction = async (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  action: AttentionActionRequest,
  fetcher: DaemonFetch = fetch,
): Promise<AttentionSnapshot> => {
  const body = AttentionActionRequestSchema.parse(action);
  const value = await fetchAttention(
    daemon,
    scope,
    attentionPath(scope),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', [FY_REQUEST_ID_HEADER]: crypto.randomUUID() },
      body: JSON.stringify(body),
    },
    fetcher,
  );
  return parseSnapshot(scope, value);
};

interface ConnectionBinding {
  readonly baseUrl: string;
  readonly deviceToken: string;
  readonly generation: number;
}

interface InFlight<Value> {
  readonly generation: number;
  readonly promise: Promise<Value>;
}

/**
 * Daemon-scoped attention coordinator. It keeps request coalescing out of the
 * immutable store and fences every continuation by the concrete paired
 * connection: a same-id re-pair or unpair cannot publish stale daemon data.
 */
export class DaemonAttentionClient {
  readonly #fullInFlight = new Map<string, InFlight<void>>();
  readonly #countInFlight = new Map<string, InFlight<void>>();
  readonly #bindings = new Map<DaemonId, ConnectionBinding>();
  readonly #generations = new Map<DaemonId, number>();
  /** Board freshness only: badge reads observe it but may never advance it. */
  readonly #boardRevisions = new Map<string, number>();

  constructor(
    readonly store: DaemonAttentionStore = new DaemonAttentionStore(),
    private readonly fetcher: DaemonFetch = fetch,
  ) {}

  hydrate(daemon: DaemonConnection, scope: DaemonSessionScope): Promise<void> {
    assertScopeDaemon(daemon, scope);
    const generation = this.#bind(daemon);
    const key = daemonSessionKey(scope);
    if (this.store.status(scope) === 'ready') return Promise.resolve();
    const existing = this.#fullInFlight.get(key);
    if (existing?.generation === generation) return existing.promise;

    const revision = this.#advanceBoardRevision(key);
    this.store.beginLoad(scope);
    const promise = fetchAttentionSnapshot(daemon, scope, this.fetcher)
      .then(snapshot => {
        if (this.#current(daemon, generation, key, revision)) {
          this.#advanceBoardRevision(key);
          this.store.applySnapshot(scope, snapshot);
        }
      })
      .catch(error => {
        if (this.#current(daemon, generation, key, revision)) this.store.fail(scope);
        throw error;
      })
      .finally(() => {
        if (this.#fullInFlight.get(key)?.promise === promise) this.#fullInFlight.delete(key);
      });
    this.#fullInFlight.set(key, { generation, promise });
    return promise;
  }

  hydrateCount(daemon: DaemonConnection, scope: DaemonSessionScope): Promise<void> {
    assertScopeDaemon(daemon, scope);
    const generation = this.#bind(daemon);
    const key = daemonSessionKey(scope);
    if (this.store.count(scope) !== undefined) return Promise.resolve();
    const existing = this.#countInFlight.get(key);
    if (existing?.generation === generation) return existing.promise;

    const revision = this.#boardRevisions.get(key) ?? 0;
    const promise = fetchAttentionCount(daemon, scope, this.fetcher)
      .then(count => {
        if (this.#current(daemon, generation, key, revision)) this.store.applyCount(scope, count);
      })
      .finally(() => {
        if (this.#countInFlight.get(key)?.promise === promise) this.#countInFlight.delete(key);
      });
    this.#countInFlight.set(key, { generation, promise });
    return promise;
  }

  resolve(daemon: DaemonConnection, scope: DaemonSessionScope, id: string, note?: string): Promise<void> {
    return this.#mutate(daemon, scope, { action: 'resolve', id, ...(note === undefined ? {} : { note }) });
  }

  respond(daemon: DaemonConnection, scope: DaemonSessionScope, id: string, response: AttentionResponse): Promise<void> {
    return this.#mutate(daemon, scope, { action: 'resolve', id, response });
  }

  dismiss(daemon: DaemonConnection, scope: DaemonSessionScope, id: string, note?: string): Promise<void> {
    return this.#mutate(daemon, scope, { action: 'dismiss', id, ...(note === undefined ? {} : { note }) });
  }

  /** Unpair one daemon without perturbing any other daemon's cache or work. */
  clearDaemon(daemonId: DaemonId): void {
    this.#generations.set(daemonId, (this.#generations.get(daemonId) ?? 0) + 1);
    this.#bindings.delete(daemonId);
    this.store.clearDaemon(daemonId);
    this.#clearInFlight(this.#fullInFlight, daemonId);
    this.#clearInFlight(this.#countInFlight, daemonId);
    this.#clearBoardRevisions(daemonId);
  }

  #mutate(daemon: DaemonConnection, scope: DaemonSessionScope, action: AttentionActionRequest): Promise<void> {
    assertScopeDaemon(daemon, scope);
    const generation = this.#bind(daemon);
    const key = daemonSessionKey(scope);
    const revision = this.#advanceBoardRevision(key);
    return applyAttentionAction(daemon, scope, action, this.fetcher)
      .then(snapshot => {
        if (this.#current(daemon, generation, key, revision)) {
          this.#advanceBoardRevision(key);
          this.store.applySnapshot(scope, snapshot);
        }
      })
      .catch(error => {
        if (this.#current(daemon, generation, key, revision)) this.store.fail(scope);
        throw error;
      });
  }

  #bind(daemon: DaemonConnection): number {
    const existing = this.#bindings.get(daemon.daemonId);
    if (existing && existing.baseUrl === daemon.baseUrl && existing.deviceToken === daemon.deviceToken)
      return existing.generation;
    if (existing) this.clearDaemon(daemon.daemonId);
    const generation = this.#generations.get(daemon.daemonId) ?? 0;
    this.#bindings.set(daemon.daemonId, { baseUrl: daemon.baseUrl, deviceToken: daemon.deviceToken, generation });
    return generation;
  }

  #advanceBoardRevision(key: string): number {
    const revision = (this.#boardRevisions.get(key) ?? 0) + 1;
    this.#boardRevisions.set(key, revision);
    return revision;
  }

  #current(daemon: DaemonConnection, generation: number, key: string, revision: number): boolean {
    const binding = this.#bindings.get(daemon.daemonId);
    return (
      binding !== undefined &&
      binding.generation === generation &&
      binding.baseUrl === daemon.baseUrl &&
      binding.deviceToken === daemon.deviceToken &&
      (this.#boardRevisions.get(key) ?? 0) === revision
    );
  }

  #clearInFlight<Value>(inFlight: Map<string, InFlight<Value>>, daemonId: DaemonId): void {
    for (const key of inFlight.keys()) {
      const [candidate] = JSON.parse(key) as [string, string];
      if (candidate === daemonId) inFlight.delete(key);
    }
  }

  #clearBoardRevisions(daemonId: DaemonId): void {
    for (const key of this.#boardRevisions.keys()) {
      const [candidate] = JSON.parse(key) as [string, string];
      if (candidate === daemonId) this.#boardRevisions.delete(key);
    }
  }
}
