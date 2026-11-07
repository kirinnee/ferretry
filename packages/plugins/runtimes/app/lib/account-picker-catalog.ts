/**
 * The pickable runtime roster of ONE daemon, and each login's health beside it.
 *
 * THE ROSTER IS THE MACHINE'S RUNTIMES (docs/design/account-model.md §4.1, §7): `GET /v1/runtimes`, one row per
 * runtime with its stable `id`, the `wrapper` a ferret is started with, its harness, its agent flag, whether it can
 * launch now and the models its model set offers. Nothing here derives a row from a wrapper's spelling.
 *
 * HEALTH IS THE LOGIN'S STATUS WORD, read from `GET /v1/logins` — `ready`, `refresh_due`, `needs_sign_in`,
 * `checking` — joined onto a runtime through the credential it uses. Reading it is a store read: the daemon calls no
 * provider to answer it, so hydrating it on mount costs nothing. **Check now** is `POST /v1/logins/:loginId/check`,
 * once per login the roster uses, and only on a person's explicit action.
 *
 * Missing evidence stays missing. A fulfilled read with `runtimes: []` is positively empty; a rejected read is
 * represented by the store's error slice and never converted into that empty array.
 */

import type { HarnessKey } from '@ferretry/core-ferrets/contract';
import { type LoginStatus, LoginListSchema, LoginViewSchema } from '@ferretry/plugin-logins/contract';
import { type LocalModels, RuntimeCatalogSchema, type RuntimeView } from '../../contract/index.ts';
import type { RuntimesClient } from './client.ts';
import type { PickerModel } from './picker-model.ts';

export type { PickerModel } from './picker-model.ts';

/** One runtime a ferret can be started on, as the picker reads it. */
export interface PickerAccount {
  /** The runtime's stable id. */
  readonly id: string;
  /** The value a caller types as `agent` when starting or moving a ferret. */
  readonly wrapper: string;
  /** The runtime's name, as the Runtimes tab shows it. */
  readonly displayName: string;
  readonly kind: HarnessKey;
  /** An agent runtime: the only kind the daemon starts a ferret on. */
  readonly agent: boolean;
  /** The login it uses, which is what its health is read from. */
  readonly credentialId: string;
  /** `null` = the harness's own default. */
  readonly defaultModel: string | null;
  readonly models: readonly PickerModel[];
  /** The login's model catalog, when it reads one; `customIds` means a picker also offers "Custom id…". */
  readonly modelCatalog?: {
    readonly id: string;
    readonly label: string;
    readonly customIds: boolean;
    /** Set when the catalog also reads the models a local server has installed (`ollama`). */
    readonly detect?: 'ollama';
    /** What the daemon last read from that server; absent until it has read once. */
    readonly local?: LocalModels;
  };
  readonly available: boolean;
  readonly unavailableReason: string | null;
}

export interface AccountPickerCatalog {
  /** A fulfilled read; an empty array is positive evidence. */
  readonly accounts: readonly PickerAccount[];
}

/** One login's status, keyed by its login id. */
export interface PickerAccountHealth extends LoginStatus {
  readonly credentialId: string;
}

export interface AccountPickerHealthCatalog {
  readonly health: ReadonlyMap<string, PickerAccountHealth>;
  /** A partial result can still carry the rows it did read. */
  readonly error: string | null;
}

export const PICKER_LOGINS_ROUTE = 'GET /v1/logins' as const;
export const PICKER_CHECK_ROUTE = 'POST /v1/logins/:loginId/check' as const;

/** One runtime as the picker reads it. A model set's models are offered; the harness default offers none. */
export const pickerAccount = (runtime: RuntimeView): PickerAccount => ({
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
          ...(choice.local === true ? { local: true as const } : {}),
        })),
        modelCatalog: {
          id: runtime.models.catalog.id,
          label: runtime.models.catalog.label,
          customIds: runtime.models.catalog.customIds,
          ...(runtime.models.catalog.detect === undefined ? {} : { detect: runtime.models.catalog.detect }),
          ...(runtime.models.local === undefined ? {} : { local: runtime.models.local }),
        },
      }),
  available: runtime.launch.available,
  unavailableReason: runtime.launch.available ? null : runtime.launch.reason,
});

/** Read this machine's runtimes through the client bound to it. */
export const readAccountPickerCatalog = async (client: RuntimesClient): Promise<AccountPickerCatalog> => ({
  accounts: RuntimeCatalogSchema.parse(await client.call('GET /v1/runtimes')).runtimes.map(pickerAccount),
});

const healthRow = (credentialId: string, status: LoginStatus): PickerAccountHealth => ({
  ...status,
  credentialId,
});

/** Every login's status word. A store read: the daemon calls no provider to answer it. */
export const readAccountPickerHealth = async (client: RuntimesClient): Promise<AccountPickerHealthCatalog> => {
  const list = LoginListSchema.parse(await client.call(PICKER_LOGINS_ROUTE));
  return {
    health: new Map(list.logins.map(row => [row.id, healthRow(row.id, row.status)] as const)),
    error: null,
  };
};

const failureMessage = (reason: unknown): string => (reason instanceof Error ? reason.message : String(reason));

/**
 * A person's **Check now**: every login this machine offers a check for, checked once, then the answers as one
 * health map.
 *
 * A login whose check failed keeps the status the list read, and the failure is reported beside the rows rather than
 * replacing them: one locked login must not blank every other row.
 */
export const checkAccountPickerHealth = async (client: RuntimesClient): Promise<AccountPickerHealthCatalog> => {
  const list = LoginListSchema.parse(await client.call(PICKER_LOGINS_ROUTE));
  const health = new Map(list.logins.map(row => [row.id, healthRow(row.id, row.status)] as const));
  const checkable = list.logins.filter(row => row.checkNow.available);
  const results = await Promise.allSettled(
    checkable.map(async row =>
      LoginViewSchema.parse(await client.call(PICKER_CHECK_ROUTE, { params: { loginId: row.id }, body: {} })),
    ),
  );
  const failures: string[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') health.set(result.value.id, healthRow(result.value.id, result.value.status));
    else failures.push(failureMessage(result.reason));
  }
  return { health, error: failures.length === 0 ? null : failures.join('; ') };
};
