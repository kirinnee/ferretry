/**
 * The logins a machine can run a Warden investigation on, and the models each offers: Runtimes' catalog
 * (`GET /v1/runtimes`), one row per runtime, projected to the fields the Warden's login and model fields read.
 * Missing evidence stays missing: a runtime with no model set offers no models and no default.
 */

import type { LocalModelsSnapshot, ModelChoice } from '@ferretry/app/ui';
import { z } from 'zod';

/** One model a login offers, as the model field lists it. */
export type PickerModel = ModelChoice;

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

const TierSchema = z.enum(['best', 'balanced', 'fast']);

const LocalModelsSchema = z.object({
  state: z.enum(['found', 'none-pulled', 'not-running', 'unreadable', 'refused', 'disabled']),
  message: z.string(),
  pullCommand: z.string(),
});

const RuntimeSchema = z.object({
  id: z.string(),
  name: z.string(),
  wrapper: z.string(),
  harness: z.string(),
  agent: z.boolean(),
  credential: z.object({ id: z.string() }),
  modelSet: z.discriminatedUnion('source', [
    z.object({ source: z.literal('harness-default') }),
    z.object({
      source: z.literal('model-set'),
      models: z.array(z.object({ id: z.string(), available: z.boolean() })),
      default: z.string().optional(),
    }),
  ]),
  models: z
    .object({
      default: z.string().optional(),
      catalog: z.object({ id: z.string(), label: z.string(), customIds: z.boolean() }),
      local: LocalModelsSchema.optional(),
      choices: z.array(
        z.object({
          id: z.string(),
          available: z.boolean(),
          label: z.string().optional(),
          tier: TierSchema.optional(),
          context: z.number().optional(),
          efforts: z.array(z.string()),
          defaultEffort: z.string().optional(),
          fast: z.boolean().optional(),
          local: z.literal(true).optional(),
        }),
      ),
    })
    .optional(),
  launch: z.discriminatedUnion('available', [
    z.object({ available: z.literal(true) }),
    z.object({ available: z.literal(false), reason: z.string() }),
  ]),
});
type Runtime = z.infer<typeof RuntimeSchema>;

const CatalogSchema = z.object({ runtimes: z.array(RuntimeSchema) });

const pickerAccount = (runtime: Runtime): PickerAccount => ({
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
          ...(choice.label === undefined ? {} : { label: choice.label }),
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

/** Runtimes' catalog, parsed and projected. Throws when the body is not one. */
export const parseAccountPickerCatalog = (body: unknown): { readonly accounts: readonly PickerAccount[] } => ({
  accounts: CatalogSchema.parse(body).runtimes.map(pickerAccount),
});

/**
 * GAP(plugin-edge): the read itself (`GET /v1/runtimes`, owned by Runtimes) waits for the Warden manifest to declare it
 * uses Runtimes; until then no route of another plugin is called and the model field is a plain text box. The swap is
 * this one function: call Runtimes' route through the client and `parseAccountPickerCatalog`.
 */
export const readAccountPickerCatalog = async (): Promise<{ readonly accounts: readonly PickerAccount[] }> => {
  throw new Error('The Warden does not read the runtime list yet.');
};
