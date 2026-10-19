/**
 * What a runtime offers and launches with, once its login's model catalog is known
 * (docs/model-catalog.md): the ONE derivation the published manifest, the wrappers and the runtime list
 * all read, so a picker, `--model` and Claude Code's tier slots can never disagree.
 *
 * - A login WITH a catalog offers exactly that catalog's models for the runtime's CLI. The profile's
 *   model set no longer chooses the list — a profile is shared by logins on different providers, and a
 *   Claude model id means nothing to GLM — but its default still wins when it names one of the catalog's
 *   models, by id or by a tier alias (`opus`).
 * - A login WITHOUT one (an environment login made by hand) offers its profile's model set, as before.
 *
 * WHO OWNS A TIER VARIABLE. A catalog pins Claude Code's tier slots (`ANTHROPIC_DEFAULT_OPUS_MODEL`…),
 * and the pin replaces whatever the login's file holds for that variable — that is how a login made
 * before a model changed picks the change up without anybody editing it. The one exception is a
 * variable the login's PRESET declares as the person's to fill in (Microsoft Foundry's deployment
 * names): the person's value stands. To pin a model on a machine, override the catalog in
 * `config/models/<id>.yaml`.
 *
 * Pure.
 */
import type { LocalModels } from '@ferretry/protocol';
import type { ResolvedModelSet } from '../account/layering.ts';
import type { HarnessKind } from '../manifest.ts';
import {
  type CatalogHalf,
  catalogDefault,
  catalogHalf,
  catalogModelFor,
  catalogModelValue,
  catalogTierEnvironment,
  type ModelCatalog,
  type ModelTier,
} from './schema.ts';

/** One model a runtime offers. `id` is the value the CLI is handed (with a context suffix). */
export interface RuntimeModelEntry {
  readonly id: string;
  readonly label: string;
  readonly tier?: ModelTier;
  readonly context?: number;
  readonly reasoning?: boolean;
  readonly efforts: readonly string[];
  readonly defaultEffort?: string;
  readonly note?: string;
  readonly available: boolean;
  /** Installed on this machine, as the local server reported it. */
  readonly local?: true;
}

/** The catalog a runtime's models came from, as a picker names it. */
export interface RuntimeModelCatalogSource {
  readonly id: string;
  readonly label: string;
  readonly origin: ModelCatalog['origin'];
  readonly customIds: boolean;
  readonly docs: string;
  readonly detect?: 'ollama';
}

export interface RuntimeModels {
  readonly catalog?: RuntimeModelCatalogSource;
  readonly models: readonly RuntimeModelEntry[];
  /** What the runtime launches with; `undefined` when it can use none of them. */
  readonly default: string | undefined;
  /** The variables the catalog pins for this runtime, to be laid over the login's. */
  readonly env: Readonly<Record<string, string>>;
  /** What the last read of the local server found, when this catalog detects one and it was read. */
  readonly local?: LocalModels;
}

export interface RuntimeModelsInput {
  readonly harness: HarnessKind;
  readonly modelSet: ResolvedModelSet | undefined;
  readonly catalog?: ModelCatalog;
  /** Variables the login's preset declares as the person's: a catalog pin never replaces them. */
  readonly personOwned?: ReadonlySet<string>;
  /** The model ids the login can use (E23); absent when nobody knows. */
  readonly availableModels?: readonly string[];
  /** What the local server the catalog detects reported (docs/model-catalog.md § Local models). */
  readonly local?: LocalModels;
}

const fromModelSet = (modelSet: ResolvedModelSet | undefined): RuntimeModels => {
  if (modelSet === undefined || modelSet.source === 'harness-default')
    return { models: [], default: undefined, env: {} };
  return {
    models: modelSet.models.map(model => ({ id: model.id, label: model.id, efforts: [], available: model.available })),
    default: modelSet.default,
    env: {},
  };
};

const entry = (model: CatalogHalf['models'][number], usable: ReadonlySet<string> | undefined): RuntimeModelEntry => {
  const value = catalogModelValue(model);
  return {
    id: value,
    label: model.label,
    tier: model.tier,
    ...(model.context === undefined ? {} : { context: model.context }),
    ...(model.reasoning === undefined && model.efforts.length === 0
      ? {}
      : { reasoning: model.reasoning ?? model.efforts.length > 0 }),
    efforts: [...model.efforts],
    ...(model.defaultEffort === undefined ? {} : { defaultEffort: model.defaultEffort }),
    ...(model.note === undefined ? {} : { note: model.note }),
    available: usable === undefined || usable.has(value) || usable.has(model.id),
  };
};

/**
 * A local server's installed models, in place of the catalog's list. The catalog still describes a model
 * it knows (tier, context, efforts) — a model the server has that the catalog does not is listed as it
 * is, by id — and a catalog model the server does not have is left out, because it could not launch.
 * Only a server that answered with models changes the list: every other state keeps the catalog's
 * suggestions, so a person can still pick one and read the sentence that says how to install it.
 */
function withLocalModels(
  half: CatalogHalf,
  models: readonly RuntimeModelEntry[],
  local: LocalModels | undefined,
): readonly RuntimeModelEntry[] {
  if (local === undefined || local.state !== 'found') return models;
  const installed = new Set(local.models.map(model => model.id));
  const known = new Set(half.models.map(model => catalogModelValue(model)));
  const fromCatalog = models
    .filter(model => installed.has(model.id))
    .map(model => ({ ...model, local: true as const }));
  const extra = local.models
    .filter(model => !known.has(model.id))
    .map(model => ({ id: model.id, label: model.label, efforts: [], available: true, local: true as const }));
  return [...fromCatalog, ...extra];
}

/** The runtime's models, default and pinned variables (module doc). */
export function runtimeModels(input: RuntimeModelsInput): RuntimeModels {
  const half = input.catalog === undefined ? undefined : catalogHalf(input.catalog, input.harness);
  if (input.catalog === undefined || half === undefined) return fromModelSet(input.modelSet);
  const usable = input.availableModels === undefined ? undefined : new Set(input.availableModels);
  const models = withLocalModels(
    half,
    half.models.map(model => entry(model, usable)),
    input.local,
  );
  const isAvailable = (value: string) => models.some(model => model.id === value && model.available);
  const declared =
    input.modelSet?.source === 'model-set' ? catalogModelFor(half, input.modelSet.declaredDefault) : undefined;
  const preferred = [declared, catalogDefault(half)].flatMap(model =>
    model === undefined ? [] : [catalogModelValue(model)],
  );
  const chosen = preferred.find(isAvailable) ?? models.find(model => model.available)?.id;
  const personOwned = input.personOwned ?? new Set<string>();
  const { catalog } = input;
  return {
    catalog: {
      id: catalog.id,
      label: catalog.label,
      origin: catalog.origin,
      customIds: catalog.customIds,
      docs: half.docs ?? catalog.docs,
      ...(catalog.detect === undefined ? {} : { detect: catalog.detect }),
    },
    models,
    default: chosen,
    env: Object.fromEntries(
      Object.entries(catalogTierEnvironment(half)).filter(([variable]) => !personOwned.has(variable)),
    ),
    ...(input.local === undefined ? {} : { local: input.local }),
  };
}
