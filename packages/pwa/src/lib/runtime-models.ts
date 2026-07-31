import type { DaemonConnection } from './daemon-connection.ts';
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
  fetcher: DaemonFetch = fetch,
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

/**
 * Session catalog cache. Its public API accepts the full scope, so matching
 * session IDs from different paired daemons can neither share data nor shares
 * in-flight work.
 */
export class DaemonRuntimeModelCatalogStore {
  readonly #catalogs = new Map<string, RuntimeModelCatalog>();
  readonly #inFlight = new Map<string, Promise<RuntimeModelCatalog>>();

  get(scope: DaemonSessionScope): RuntimeModelCatalog | undefined {
    return this.#catalogs.get(daemonSessionKey(scope));
  }

  async load(
    daemon: DaemonConnection,
    scope: DaemonSessionScope,
    fetcher: DaemonFetch = fetch,
  ): Promise<RuntimeModelCatalog> {
    assertScopeDaemon(daemon, scope);
    const key = daemonSessionKey(scope);
    const cached = this.#catalogs.get(key);
    if (cached) return cached;
    const pending = this.#inFlight.get(key);
    if (pending) return pending;
    const request = fetchRuntimeModelCatalog(daemon, scope, fetcher)
      .then(catalog => {
        this.#catalogs.set(key, catalog);
        return catalog;
      })
      .finally(() => this.#inFlight.delete(key));
    this.#inFlight.set(key, request);
    return request;
  }

  clearDaemon(daemon: DaemonConnection['daemonId']): void {
    for (const [key] of this.#catalogs) {
      const [cachedDaemonId] = JSON.parse(key) as [string, string];
      if (cachedDaemonId === daemon) this.#catalogs.delete(key);
    }
  }
}
