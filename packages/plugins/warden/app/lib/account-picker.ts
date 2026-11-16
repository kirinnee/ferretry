/**
 * The logins a machine can run a Warden investigation on, and the models each offers: Runtimes' catalog
 * (`GET /v1/runtimes`), one row per runtime, parsed with Runtimes' own schema and projected to the fields the Warden's
 * login and model fields read. Missing evidence stays missing: a runtime with no model set offers no models and no
 * default. Runtimes is an optional use of the Warden: with Runtimes off the read answers `off` and the model field
 * is a plain text box.
 */

import type { LocalModelsSnapshot, ModelChoice } from '@ferretry/app/ui';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { RuntimeCatalogSchema, type RuntimeView } from '@ferretry/plugin-runtimes/contract';
import { isPluginOff } from './plugin-off.ts';

/** One model a login offers, as the model field lists it. */
type PickerModel = ModelChoice;

/** One runtime the Warden can investigate on, as the settings form reads it. */
export interface PickerAccount {
  readonly id: string;
  /** The value the Warden's settings name as `agent`. */
  readonly wrapper: string;
  readonly displayName: string;
  readonly kind: string;
  /** An agent runtime: the only kind the daemon starts a ferret on. */
  readonly agent: boolean;
  readonly credentialId: string;
  /** `null` = the harness's own default. */
  readonly defaultModel: string | null;
  readonly models: readonly PickerModel[];
  /** The login's model catalog, when it reads one; `customIds` means the field also offers "Custom id…". */
  readonly modelCatalog?: {
    readonly id: string;
    readonly label: string;
    readonly customIds: boolean;
    readonly local?: LocalModelsSnapshot;
  };
  readonly available: boolean;
  readonly unavailableReason: string | null;
}

/** One runtime as the picker reads it. A model set's models are offered; the harness default offers none. */
const pickerAccount = (runtime: RuntimeView): PickerAccount => ({
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
          ...(runtime.models.local === undefined ? {} : { local: runtime.models.local }),
        },
      }),
  available: runtime.launch.available,
  unavailableReason: runtime.launch.available ? null : runtime.launch.reason,
});

/** This machine's runtimes, or `off` when Runtimes is not running on it. */
export const readAccountPickerCatalog = async (
  client: Pick<PluginClient, 'call'>,
): Promise<{ readonly accounts: readonly PickerAccount[] } | 'off'> => {
  try {
    return {
      accounts: RuntimeCatalogSchema.parse(await client.call<unknown>('GET /v1/runtimes')).runtimes.map(pickerAccount),
    };
  } catch (cause) {
    if (isPluginOff(cause)) return 'off';
    throw cause;
  }
};
