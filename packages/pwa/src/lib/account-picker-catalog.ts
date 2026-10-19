/**
 * Daemon-owned choices for a session's runtime and recently used working directories.
 *
 * THE ROSTER IS THE MACHINE'S RUNTIMES (docs/design/account-model.md §4.1, §7): `GET /v1/fleet/runtimes`,
 * one row per runtime with its stable `id`, the `wrapper` a session is started with, its harness, its
 * agent flag, whether it can launch now and the models its model set offers. Nothing here derives a
 * row from a wrapper's spelling.
 *
 * HEALTH IS THE LOGIN'S STATUS WORD, read from `GET /v1/fleet/credentials` — `ready`, `refresh_due`,
 * `needs_sign_in`, `checking` — joined onto a runtime through the credential it uses. Reading it is a
 * store read: the daemon calls no provider to answer it, so hydrating it on mount costs nothing.
 * **Check now** is `POST /v1/fleet/credentials/:id/check`, once per login the roster uses, and only on
 * a person's explicit action.
 *
 * Missing evidence stays missing. A fulfilled read with `runtimes: []` is positively empty; a rejected
 * read is represented by the store's error slice and never converted into that empty array.
 */

import {
  FleetCredentialListSchema,
  type FleetCredentialStatus,
  FleetCredentialViewSchema,
  FleetRuntimeCatalogSchema,
  type FleetRuntimeView,
  type IFyApiClient,
  type SessionView,
} from '@ferretry/protocol';

import { normalizeProjectPath } from './fleet-grouping.ts';
import type { ModelTier } from './model-tiers.ts';

/**
 * One model a runtime offers, and whether its login can use it. A login that reads a model catalog
 * (docs/model-catalog.md) also says what the model is called, its tier and the efforts it takes.
 */
export interface PickerModel {
  readonly id: string;
  readonly available: boolean;
  readonly label?: string;
  readonly tier?: ModelTier;
  readonly context?: number;
  /** The reasoning efforts it takes; empty when it takes none. Absent when no catalog says. */
  readonly efforts?: readonly string[];
  readonly defaultEffort?: string;
  /** Whether the CLI offers fast mode on it; absent when the daemon did not say. */
  readonly fast?: boolean;
}

/** One runtime a session can be started on, as the picker reads it. */
export interface PickerAccount {
  /** The runtime's stable id. */
  readonly id: string;
  /** The value a caller types as `agent` when starting or migrating a session. */
  readonly wrapper: string;
  /** The runtime's name, as the Runtimes tab shows it. */
  readonly displayName: string;
  readonly kind: FleetRuntimeView['harness'];
  /** An agent runtime: the only kind the daemon starts a session on. */
  readonly agent: boolean;
  /** The login it uses, which is what its health is read from. */
  readonly credentialId: string;
  /** `null` = the harness's own default. */
  readonly defaultModel: string | null;
  readonly models: readonly PickerModel[];
  /** The login's model catalog, when it reads one; `customIds` means a picker also offers "Custom id…". */
  readonly modelCatalog?: { readonly id: string; readonly label: string; readonly customIds: boolean };
  readonly available: boolean;
  readonly unavailableReason: string | null;
}

export interface RecentProjectPath {
  readonly path: string;
  readonly lastActivity: string;
}

export interface AccountPickerCatalog {
  /** A fulfilled read; an empty array is positive evidence. */
  readonly accounts: readonly PickerAccount[];
}

/** One login's status, keyed by its credential id. */
export interface PickerAccountHealth extends FleetCredentialStatus {
  readonly credentialId: string;
}

export interface AccountPickerHealthCatalog {
  readonly health: ReadonlyMap<string, PickerAccountHealth>;
  /** A partial result can still carry the rows it did read. */
  readonly error: string | null;
}

export type PickerCatalogClient = Pick<IFyApiClient, 'request'>;

export const PICKER_RUNTIMES_PATH = '/v1/fleet/runtimes';
export const PICKER_CREDENTIALS_PATH = '/v1/fleet/credentials';

const activityInstant = (view: SessionView): string => view.state.lastActivityAt ?? view.config.updatedAt;

/** Recently used daemon-canonical cwds, newest first and deduplicated by path. */
export const recentProjectPaths = (sessions: readonly SessionView[]): readonly RecentProjectPath[] => {
  const newest = new Map<string, string>();
  for (const session of sessions) {
    const path = normalizeProjectPath(session.config.cwd.trim());
    if (path === '') continue;
    const activity = activityInstant(session);
    const previous = newest.get(path);
    if (previous === undefined || Date.parse(activity) > Date.parse(previous)) newest.set(path, activity);
  }
  return [...newest.entries()]
    .map(([path, lastActivity]) => ({ path, lastActivity }))
    .sort((left, right) => {
      const recency = Date.parse(right.lastActivity) - Date.parse(left.lastActivity);
      return recency === 0 ? left.path.localeCompare(right.path) : recency;
    });
};

/** One runtime as the picker reads it. A model set's models are offered; the harness default offers none. */
export const pickerAccount = (runtime: FleetRuntimeView): PickerAccount => ({
  id: runtime.id,
  wrapper: runtime.wrapper,
  displayName: runtime.name,
  kind: runtime.harness,
  agent: runtime.agent,
  credentialId: runtime.credential.id,
  ...(runtime.models === undefined
    ? {
        defaultModel: runtime.modelSet.source === 'model-set' ? (runtime.modelSet.default ?? null) : null,
        models: runtime.modelSet.source === 'model-set' ? runtime.modelSet.models : [],
      }
    : {
        defaultModel: runtime.models.default ?? null,
        models: runtime.models.choices.map(choice => ({
          id: choice.id,
          available: choice.available,
          label: choice.label,
          ...(choice.tier === undefined ? {} : { tier: choice.tier }),
          ...(choice.context === undefined ? {} : { context: choice.context }),
          efforts: choice.efforts,
          ...(choice.defaultEffort === undefined ? {} : { defaultEffort: choice.defaultEffort }),
          ...(choice.fast === undefined ? {} : { fast: choice.fast }),
        })),
        modelCatalog: {
          id: runtime.models.catalog.id,
          label: runtime.models.catalog.label,
          customIds: runtime.models.catalog.customIds,
        },
      }),
  available: runtime.launch.available,
  unavailableReason: runtime.launch.available ? null : runtime.launch.reason,
});

/** Read this machine's runtimes through one already daemon-bound client. */
export const readAccountPickerCatalog = async (client: PickerCatalogClient): Promise<AccountPickerCatalog> => ({
  accounts: (await client.request(PICKER_RUNTIMES_PATH, FleetRuntimeCatalogSchema)).runtimes.map(pickerAccount),
});

const healthRow = (credentialId: string, status: FleetCredentialStatus): PickerAccountHealth => ({
  ...status,
  credentialId,
});

/** Every login's status word. A store read: the daemon calls no provider to answer it. */
export const readAccountPickerHealth = async (client: PickerCatalogClient): Promise<AccountPickerHealthCatalog> => {
  const list = await client.request(PICKER_CREDENTIALS_PATH, FleetCredentialListSchema);
  return {
    health: new Map(list.credentials.map(row => [row.id, healthRow(row.id, row.status)] as const)),
    error: null,
  };
};

const failureMessage = (reason: unknown): string => (reason instanceof Error ? reason.message : String(reason));

/**
 * A person's **Check now**: every login this machine offers a check for, checked once, then the
 * answers as one health map.
 *
 * A login whose check failed keeps the status the list read, and the failure is reported beside the
 * rows rather than replacing them: one locked login must not blank every other row.
 */
export const checkAccountPickerHealth = async (client: PickerCatalogClient): Promise<AccountPickerHealthCatalog> => {
  const list = await client.request(PICKER_CREDENTIALS_PATH, FleetCredentialListSchema);
  const health = new Map(list.credentials.map(row => [row.id, healthRow(row.id, row.status)] as const));
  const checkable = list.credentials.filter(row => row.checkNow.available);
  const results = await Promise.allSettled(
    checkable.map(row =>
      client.request(`${PICKER_CREDENTIALS_PATH}/${encodeURIComponent(row.id)}/check`, FleetCredentialViewSchema, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    ),
  );
  const failures: string[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') health.set(result.value.id, healthRow(result.value.id, result.value.status));
    else failures.push(failureMessage(result.reason));
  }
  return { health, error: failures.length === 0 ? null : failures.join('; ') };
};
