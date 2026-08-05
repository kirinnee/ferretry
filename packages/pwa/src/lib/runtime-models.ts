import type { DaemonConnection, DaemonId } from './daemon-connection.ts';
import { type DaemonSessionScope, daemonSessionKey } from './daemon-scope.ts';
import { daemonRequest } from './daemon-transport.ts';

export interface RuntimeReasoningChoice {
  readonly value: string;
  readonly description?: string;
}

export interface RuntimeModelChoice {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
  readonly isDefault?: boolean;
  readonly reasoningEfforts: readonly RuntimeReasoningChoice[];
  readonly defaultReasoningEffort?: string;
}

export interface RuntimeModelCatalog {
  readonly harness: 'claude' | 'codex';
  readonly source: 'wrapper-inventory' | 'codex-app-server';
  readonly choices: readonly RuntimeModelChoice[];
}

export class DaemonResponseError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'DaemonResponseError';
  }
}

export type DaemonFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * THE ONLY WAY THIS PACKAGE IS ALLOWED TO SPELL "the real network".
 *
 * `fetch` is a WebIDL operation on the global, and WebIDL rejects a call whose
 * receiver is neither the global nor absent. A bare builtin written as a parameter
 * default is therefore a value that works only until somebody stores it and calls
 * it as a member: `this.#network(url, init)` makes the
 * holder the receiver and the browser answers
 * `Failed to execute 'fetch' on 'Window': Illegal invocation`.
 *
 * That is not hypothetical. It shipped twice — once through a transport (PR #223)
 * and once through the carrier router — and both times it presented as every paired
 * daemon being unreachable, because the throw happens before a single byte leaves
 * the tab. An arrow wrapper keeps the builtin in its own realm no matter how the
 * value is stored or invoked afterwards.
 *
 * `scripts/validate/fetch-binding.sh` fails the commit that writes a bare builtin
 * anywhere in this package, so this is the one spelling rather than the preferred
 * one.
 */
export const browserFetch: DaemonFetch = (input, init) => globalThis.fetch(input, init);

const asObject = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const asNonEmptyString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

/** Treat daemon-provided model options as untrusted, ordered opaque values. */
export const parseRuntimeModelCatalog = (value: unknown): RuntimeModelCatalog => {
  const root = asObject(value);
  const harness = root?.harness;
  const source = root?.source;
  if (
    !root ||
    (harness !== 'claude' && harness !== 'codex') ||
    (source !== 'wrapper-inventory' && source !== 'codex-app-server') ||
    !Array.isArray(root.choices)
  )
    throw new DaemonResponseError(502, 'daemon returned an invalid runtime model catalog');

  const choices: RuntimeModelChoice[] = [];
  for (const rawChoice of root.choices) {
    const choice = asObject(rawChoice);
    const model = asNonEmptyString(choice?.value);
    const label = asNonEmptyString(choice?.label);
    if (!model || !label || !Array.isArray(choice?.reasoningEfforts))
      throw new DaemonResponseError(502, 'daemon returned an invalid runtime model choice');
    const reasoningEfforts: RuntimeReasoningChoice[] = [];
    for (const rawEffort of choice.reasoningEfforts) {
      const effort = asObject(rawEffort);
      const effortValue = asNonEmptyString(effort?.value);
      if (!effortValue) throw new DaemonResponseError(502, 'daemon returned an invalid runtime reasoning choice');
      const description = asNonEmptyString(effort?.description);
      reasoningEfforts.push(description ? { value: effortValue, description } : { value: effortValue });
    }
    const description = asNonEmptyString(choice.description);
    const defaultReasoningEffort = asNonEmptyString(choice.defaultReasoningEffort);
    choices.push({
      value: model,
      label,
      ...(description ? { description } : {}),
      ...(choice.isDefault === true ? { isDefault: true } : {}),
      reasoningEfforts,
      ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    });
  }
  return { harness, source, choices };
};

export const requireRuntimeModelCatalogHarness = (
  catalog: RuntimeModelCatalog,
  expected: RuntimeModelCatalog['harness'],
): RuntimeModelCatalog => {
  if (catalog.harness !== expected)
    throw new DaemonResponseError(502, `daemon returned a ${catalog.harness} model catalog for a ${expected} session`);
  return catalog;
};

export const runtimeModelCatalogErrorMessage = (error: unknown): string => {
  if (error instanceof DaemonResponseError && error.status === 404 && error.code === 'unknown_route')
    return 'This daemon does not provide the runtime model catalog endpoint. Restarting an unchanged daemon build will not add the missing route.';
  return error instanceof Error ? error.message : String(error);
};

const assertScopeDaemon = (daemon: DaemonConnection, scope: DaemonSessionScope): void => {
  if (daemon.daemonId !== scope.daemonId) throw new Error('runtime model scope must belong to the requested daemon');
};

/** Fetches one session's advertised model catalog from its explicitly paired daemon. */
export const fetchRuntimeModelCatalog = async (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  fetcher: DaemonFetch = browserFetch,
): Promise<RuntimeModelCatalog> => {
  assertScopeDaemon(daemon, scope);
  const request = daemonRequest(daemon, `/v1/sessions/${encodeURIComponent(scope.sessionId)}/runtime-models`);
  const response = await fetcher(request.url, request.init);
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: unknown; code?: unknown };
    throw new DaemonResponseError(
      response.status,
      typeof body.error === 'string' ? body.error : `HTTP ${response.status}`,
      typeof body.code === 'string' ? body.code : undefined,
    );
  }
  return parseRuntimeModelCatalog(await response.json());
};

interface ConnectionBinding {
  readonly baseUrl: string;
  readonly deviceToken: string;
  readonly generation: number;
}

interface InFlight {
  readonly generation: number;
  readonly promise: Promise<RuntimeModelCatalog>;
}

/**
 * Session catalog cache. Its public API accepts the full scope, so matching
 * session IDs from different paired daemons can neither share data nor share
 * in-flight work.
 *
 * Every continuation is fenced by the concrete paired connection: a slow result
 * that completes after `clearDaemon`, an unpair, or a same-id re-pair (rotated
 * base URL or device token) cannot publish into the fresh connection. Each
 * daemon carries its own generation; a connection whose base URL or token
 * differs from the recorded one is treated as a re-pair and resets that daemon.
 */
export class DaemonRuntimeModelCatalogStore {
  readonly #catalogs = new Map<string, RuntimeModelCatalog>();
  readonly #inFlight = new Map<string, InFlight>();
  readonly #bindings = new Map<DaemonId, ConnectionBinding>();
  readonly #generations = new Map<DaemonId, number>();

  get(scope: DaemonSessionScope): RuntimeModelCatalog | undefined {
    return this.#catalogs.get(daemonSessionKey(scope));
  }

  async load(
    daemon: DaemonConnection,
    scope: DaemonSessionScope,
    fetcher: DaemonFetch = browserFetch,
  ): Promise<RuntimeModelCatalog> {
    assertScopeDaemon(daemon, scope);
    const generation = this.#bind(daemon);
    const key = daemonSessionKey(scope);
    const cached = this.#catalogs.get(key);
    if (cached) return cached;
    // Coalesce only against work started under the same connection generation,
    // never against a prior token's still-running request.
    const existing = this.#inFlight.get(key);
    if (existing?.generation === generation) return existing.promise;

    const promise = fetchRuntimeModelCatalog(daemon, scope, fetcher)
      .then(catalog => {
        if (this.#current(daemon, generation)) this.#catalogs.set(key, catalog);
        return catalog;
      })
      .finally(() => {
        if (this.#inFlight.get(key)?.promise === promise) this.#inFlight.delete(key);
      });
    this.#inFlight.set(key, { generation, promise });
    return promise;
  }

  /** Unpair one daemon without perturbing any other daemon's cache or work. */
  clearDaemon(daemonId: DaemonId): void {
    this.#generations.set(daemonId, (this.#generations.get(daemonId) ?? 0) + 1);
    this.#bindings.delete(daemonId);
    for (const key of this.#catalogs.keys()) {
      const [cachedDaemonId] = JSON.parse(key) as [string, string];
      if (cachedDaemonId === daemonId) this.#catalogs.delete(key);
    }
    this.#clearInFlight(daemonId);
  }

  #bind(daemon: DaemonConnection): number {
    const existing = this.#bindings.get(daemon.daemonId);
    if (existing && existing.baseUrl === daemon.baseUrl && existing.deviceToken === daemon.deviceToken)
      return existing.generation;
    // A same-id re-pair (rotated URL or token) invalidates the prior generation.
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
      const [cachedDaemonId] = JSON.parse(key) as [string, string];
      if (cachedDaemonId === daemonId) this.#inFlight.delete(key);
    }
  }
}
