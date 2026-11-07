import { HARNESS_KEYS, type HarnessKey } from '@ferretry/core-ferrets/contract';
import type { RuntimesClient } from './client.ts';
import { asModelTier, type ModelTier } from '@ferretry/app/ui';

interface RuntimeReasoningChoice {
  readonly value: string;
  readonly description?: string;
}

export interface RuntimeModelChoice {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
  /** Where the login's model catalog puts it (docs/model-catalog.md). */
  readonly tier?: ModelTier;
  /** The context window, in tokens. */
  readonly context?: number;
  readonly isDefault?: boolean;
  readonly reasoningEfforts: readonly RuntimeReasoningChoice[];
  readonly defaultReasoningEffort?: string;
  /** Whether the harness offers fast mode on this model: absent when the daemon did not say. */
  readonly fast?: boolean;
  /** The model runs in fast mode unless told otherwise. */
  readonly fastDefault?: true;
}

// GAP(ferrets): the per-ferret runtime catalog wire (`RuntimeModelCatalog`) is not in Ferrets' contract yet; this
// is the app's own parse of it, kept until Ferrets publishes the schema.
export interface RuntimeModelCatalog {
  readonly harness: HarnessKey;
  readonly source: 'wrapper-inventory' | 'codex-app-server';
  readonly choices: readonly RuntimeModelChoice[];
  /**
   * The login's model catalog, when it reads one: each choice's `reasoningEfforts` is then what that
   * model takes (empty means none), and `customIds` lets the picker offer "Custom id…".
   */
  readonly catalog?: { readonly id: string; readonly label: string; readonly customIds: boolean };
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

const isHarness = (value: unknown): value is HarnessKey => (HARNESS_KEYS as readonly unknown[]).includes(value);

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
    !isHarness(harness) ||
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
    const tier = asModelTier(choice.tier);
    const context = typeof choice.context === 'number' && choice.context > 0 ? choice.context : undefined;
    choices.push({
      value: model,
      label,
      ...(description ? { description } : {}),
      ...(tier ? { tier } : {}),
      ...(context ? { context } : {}),
      ...(choice.isDefault === true ? { isDefault: true } : {}),
      reasoningEfforts,
      ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
      ...(typeof choice.fast === 'boolean' ? { fast: choice.fast } : {}),
      ...(choice.fastDefault === true ? { fastDefault: true as const } : {}),
    });
  }
  const rawCatalog = asObject(root.catalog);
  const catalogId = asNonEmptyString(rawCatalog?.id);
  const catalogLabel = asNonEmptyString(rawCatalog?.label);
  return {
    harness,
    source,
    choices,
    ...(catalogId && catalogLabel
      ? { catalog: { id: catalogId, label: catalogLabel, customIds: rawCatalog?.customIds === true } }
      : {}),
  };
};

export const requireRuntimeModelCatalogHarness = (
  catalog: RuntimeModelCatalog,
  expected: RuntimeModelCatalog['harness'],
): RuntimeModelCatalog => {
  if (catalog.harness !== expected)
    throw new DaemonResponseError(502, `daemon returned a ${catalog.harness} model catalog for a ${expected} session`);
  return catalog;
};

export const runtimeModelCatalogErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// Runtimes owns the per-ferret model catalog route.
export const RUNTIME_MODELS_ROUTE = 'GET /v1/ferrets/:id/runtime-models' as const;

/** Fetches one session's advertised model catalog from the daemon the client is bound to. */
export const fetchRuntimeModelCatalog = async (
  client: RuntimesClient,
  sessionId: string,
): Promise<RuntimeModelCatalog> =>
  parseRuntimeModelCatalog(await client.call(RUNTIME_MODELS_ROUTE, { params: { id: sessionId } }));

interface InFlight {
  readonly generation: number;
  readonly promise: Promise<RuntimeModelCatalog>;
}

/**
 * Session catalog cache for ONE daemon. The client the shell hands over is already bound to a single pairing, so
 * matching session ids from different daemons live in different stores and can neither share data nor share
 * in-flight work.
 *
 * Every continuation is fenced by the connection generation: a slow result that completes after `clear`, an unpair,
 * or a re-pair (the shell hands a NEW client when the base URL or device token rotated) cannot publish into the
 * fresh connection. A load made through a client other than the one the store is bound to is a re-pair and resets it.
 */
export class DaemonRuntimeModelCatalogStore {
  readonly #catalogs = new Map<string, RuntimeModelCatalog>();
  readonly #inFlight = new Map<string, InFlight>();
  #bound: RuntimesClient | undefined;
  #generation = 0;

  get(sessionId: string): RuntimeModelCatalog | undefined {
    return this.#catalogs.get(sessionId);
  }

  async load(client: RuntimesClient, sessionId: string): Promise<RuntimeModelCatalog> {
    const generation = this.#bind(client);
    const cached = this.#catalogs.get(sessionId);
    if (cached) return cached;
    // Coalesce only against work started under the same connection generation,
    // never against a prior connection's still-running request.
    const existing = this.#inFlight.get(sessionId);
    if (existing?.generation === generation) return existing.promise;

    const promise = fetchRuntimeModelCatalog(client, sessionId)
      .then(catalog => {
        if (this.#generation === generation && this.#bound === client) this.#catalogs.set(sessionId, catalog);
        return catalog;
      })
      .finally(() => {
        if (this.#inFlight.get(sessionId)?.promise === promise) this.#inFlight.delete(sessionId);
      });
    this.#inFlight.set(sessionId, { generation, promise });
    return promise;
  }

  /** Unpair the daemon: drop every catalog and orphan every request still in flight. */
  clear(): void {
    this.#generation += 1;
    this.#bound = undefined;
    this.#catalogs.clear();
    this.#inFlight.clear();
  }

  #bind(client: RuntimesClient): number {
    if (this.#bound === client) return this.#generation;
    // A different client is a re-pair (rotated URL or token): the prior generation is over.
    this.clear();
    this.#bound = client;
    return this.#generation;
  }
}
