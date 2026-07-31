import {
  FY_REQUEST_ID_HEADER,
  MAX_PIN_NOTE_LENGTH,
  MAX_PINS_PER_SESSION,
  type PinActionRequest,
  PinActionRequestSchema,
  type PinSnapshot,
  PinSnapshotSchema,
} from '@ferretry/protocol';
import type { DaemonConnection, DaemonId } from './daemon-connection.ts';
import { type DaemonSessionScope, daemonSessionKey } from './daemon-scope.ts';
import { daemonRequest } from './daemon-transport.ts';
import { type DaemonPinEcho, DaemonPinStore } from './pin-store.ts';
import { type DaemonFetch, DaemonResponseError } from './runtime-models.ts';

const assertScopeDaemon = (daemon: DaemonConnection, scope: DaemonSessionScope): void => {
  if (daemon.daemonId !== scope.daemonId) throw new Error('pin scope must belong to the requested daemon');
};

export const pinPath = (scope: DaemonSessionScope): string =>
  `/v1/sessions/${encodeURIComponent(scope.sessionId)}/pins`;

const responseError = async (response: Response): Promise<DaemonResponseError> => {
  const body = (await response.json().catch(() => ({}))) as { error?: unknown; code?: unknown };
  return new DaemonResponseError(
    response.status,
    typeof body.error === 'string' ? body.error : `HTTP ${response.status}`,
    typeof body.code === 'string' ? body.code : undefined,
  );
};

const parseSnapshot = (scope: DaemonSessionScope, value: unknown): PinSnapshot => {
  const snapshot = PinSnapshotSchema.parse(value);
  if (snapshot.sessionId !== scope.sessionId) throw new DaemonResponseError(502, 'daemon returned another session');
  return snapshot;
};

const fetchPins = async (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  init: RequestInit,
  fetcher: DaemonFetch,
): Promise<unknown> => {
  assertScopeDaemon(daemon, scope);
  const request = daemonRequest(daemon, pinPath(scope), init);
  const response = await fetcher(request.url, request.init);
  if (!response.ok) throw await responseError(response);
  return await response.json();
};

/** Reads one complete pin board from precisely the daemon that owns its scope. */
export const fetchPinSnapshot = async (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  fetcher: DaemonFetch = fetch,
): Promise<PinSnapshot> => parseSnapshot(scope, await fetchPins(daemon, scope, {}, fetcher));

/** Sends one validated pin action and returns the daemon's authoritative board. */
export const applyPinAction = async (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  action: PinActionRequest,
  fetcher: DaemonFetch = fetch,
): Promise<PinSnapshot> => {
  const body = PinActionRequestSchema.parse(action);
  return parseSnapshot(
    scope,
    await fetchPins(
      daemon,
      scope,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', [FY_REQUEST_ID_HEADER]: crypto.randomUUID() },
        body: JSON.stringify(body),
      },
      fetcher,
    ),
  );
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

const assertNoteLength = (text: string): void => {
  if (text.length > MAX_PIN_NOTE_LENGTH)
    throw new Error(`a pin note may not exceed ${MAX_PIN_NOTE_LENGTH} characters (got ${text.length})`);
};

const isNoteAction = (
  action: PinActionRequest,
): action is Extract<PinActionRequest, { action: 'edit' } | { kind: 'note' }> =>
  action.action === 'edit' || (action.action === 'add' && action.kind === 'note');

/**
 * Daemon-scoped coordinator for pin boards. Generations bind work to one
 * concrete pairing, and optimistic echoes bind mutation results to the exact
 * board value they wrote, so neither an old daemon nor a slow request wins.
 */
export class DaemonPinClient {
  readonly #inFlight = new Map<string, InFlight<void>>();
  readonly #bindings = new Map<DaemonId, ConnectionBinding>();
  readonly #generations = new Map<DaemonId, number>();
  readonly #revisions = new Map<string, number>();

  constructor(
    readonly store: DaemonPinStore = new DaemonPinStore(),
    private readonly fetcher: DaemonFetch = fetch,
  ) {}

  hydrate(daemon: DaemonConnection, scope: DaemonSessionScope): Promise<void> {
    assertScopeDaemon(daemon, scope);
    const generation = this.#bind(daemon);
    const key = daemonSessionKey(scope);
    const revision = this.#revision(scope);
    if (this.store.status(scope) === 'ready') return Promise.resolve();
    const existing = this.#inFlight.get(key);
    if (existing?.generation === generation) return existing.promise;

    this.store.beginLoad(scope);
    const promise = fetchPinSnapshot(daemon, scope, this.fetcher)
      .then(snapshot => {
        if (this.#current(daemon, generation) && this.#revision(scope) === revision)
          this.store.applySnapshot(scope, snapshot);
      })
      .catch(error => {
        if (this.#current(daemon, generation) && this.#revision(scope) === revision) this.store.fail(scope);
        throw error;
      })
      .finally(() => {
        if (this.#inFlight.get(key)?.promise === promise) this.#inFlight.delete(key);
      });
    this.#inFlight.set(key, { generation, promise });
    return promise;
  }

  add(
    daemon: DaemonConnection,
    scope: DaemonSessionScope,
    request: Extract<PinActionRequest, { action: 'add' }>,
  ): Promise<void> {
    return this.#mutate(daemon, scope, request);
  }

  remove(daemon: DaemonConnection, scope: DaemonSessionScope, id: string): Promise<void> {
    return this.#mutate(daemon, scope, { action: 'remove', id });
  }

  editNote(daemon: DaemonConnection, scope: DaemonSessionScope, id: string, text: string): Promise<void> {
    assertNoteLength(text);
    return this.#mutate(daemon, scope, { action: 'edit', id, text });
  }

  /** Unpair one daemon without perturbing cached boards from the others. */
  clearDaemon(daemonId: DaemonId): void {
    this.#generations.set(daemonId, (this.#generations.get(daemonId) ?? 0) + 1);
    this.#bindings.delete(daemonId);
    this.store.clearDaemon(daemonId);
    this.#clearInFlight(daemonId);
  }

  #mutate(daemon: DaemonConnection, scope: DaemonSessionScope, action: PinActionRequest): Promise<void> {
    assertScopeDaemon(daemon, scope);
    if (isNoteAction(action)) assertNoteLength(action.text);
    const parsed = PinActionRequestSchema.parse(action);
    const generation = this.#bind(daemon);
    this.#advanceRevision(scope);
    const echo = this.#writeEcho(scope, parsed);
    return applyPinAction(daemon, scope, parsed, this.fetcher)
      .then(snapshot => {
        if (this.#current(daemon, generation)) this.store.reconcileEcho(echo, snapshot);
      })
      .catch(error => {
        if (this.#current(daemon, generation)) this.store.restoreEcho(echo);
        throw error;
      });
  }

  #writeEcho(scope: DaemonSessionScope, action: PinActionRequest): DaemonPinEcho {
    const current = this.store.pins(scope);
    if (current === undefined) return this.store.applyEcho(scope, undefined);
    const pins =
      action.action === 'remove'
        ? current.pins.filter(pin => pin.id !== action.id)
        : action.action === 'edit'
          ? current.pins.map(pin => (pin.kind === 'note' && pin.id === action.id ? { ...pin, text: action.text } : pin))
          : action.kind === 'note'
            ? [
                {
                  id: crypto.randomUUID(),
                  at: Math.max(1, ...current.pins.map(pin => pin.at + 1)),
                  kind: 'note' as const,
                  text: action.text,
                  ...(action.source === undefined ? {} : { source: action.source }),
                  by: 'human' as const,
                  createdBy: null,
                  createdByName: null,
                },
                ...current.pins,
              ].slice(0, MAX_PINS_PER_SESSION)
            : [
                {
                  id: crypto.randomUUID(),
                  at: Math.max(1, ...current.pins.map(pin => pin.at + 1)),
                  kind: 'message' as const,
                  blockId: action.blockId,
                  blockKind: action.blockKind,
                  preview: action.preview,
                  ...(action.ts === undefined ? {} : { ts: action.ts }),
                  by: 'human' as const,
                  createdBy: null,
                  createdByName: null,
                },
                // mirror daemon deduplicatePins([pin, ...current]): the new pin wins,
                // so drop any existing message pinned to the same block id.
                ...current.pins.filter(pin => !(pin.kind === 'message' && pin.blockId === action.blockId)),
              ].slice(0, MAX_PINS_PER_SESSION);
    return this.store.applyEcho(scope, { ...current, pins });
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

  #current(daemon: DaemonConnection, generation: number): boolean {
    const binding = this.#bindings.get(daemon.daemonId);
    return (
      binding !== undefined &&
      binding.generation === generation &&
      binding.baseUrl === daemon.baseUrl &&
      binding.deviceToken === daemon.deviceToken
    );
  }

  #clearInFlight(daemonId: DaemonId): void {
    for (const key of this.#inFlight.keys()) {
      const [candidate] = JSON.parse(key) as [string, string];
      if (candidate === daemonId) this.#inFlight.delete(key);
    }
    for (const key of this.#revisions.keys()) {
      const [candidate] = JSON.parse(key) as [string, string];
      if (candidate === daemonId) this.#revisions.delete(key);
    }
  }

  #revision(scope: DaemonSessionScope): number {
    return this.#revisions.get(daemonSessionKey(scope)) ?? 0;
  }

  #advanceRevision(scope: DaemonSessionScope): void {
    const key = daemonSessionKey(scope);
    this.#revisions.set(key, this.#revision(scope) + 1);
  }
}
