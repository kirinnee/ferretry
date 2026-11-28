/**
 * Which model catalog a login reads, and what a runtime knows about catalogs when it decides its models
 * (docs/model-catalog.md). The catalogs themselves (the built-in files, the published one, `config/models/`) are
 * Logins'; a runtime is handed them as {@link ModelCatalogSources}.
 *
 * GAP(logins): this is Logins' too (today's `models/catalog.ts`, less its built-in YAML); delete when Logins'
 * contract exports the derivation.
 *
 * Pure.
 */
import type { LocalModels } from '@ferretry/plugin-logins/contract';
import type { Credential } from '../account/schema.ts';
import type { HarnessKind } from '../manifest.ts';
import type { ModelCatalog } from './schema.ts';

/**
 * Which catalog a login reads: a sign-in login its CLI's maker's (its plugin's `kit.signInCatalog`), an environment login its preset's.
 * `undefined` for an environment login made by hand or from a preset that names none — its runtimes
 * offer what their profile's model set says, as before catalogs.
 */
function loginModelCatalogId(
  credential: Pick<Credential, 'store' | 'preset'>,
  harness: HarnessKind,
  sources: Pick<ModelCatalogSources, 'presets' | 'signIn'>,
): string | undefined {
  if (credential.store !== 'environment') return sources.signIn.get(harness);
  if (credential.preset === undefined) return undefined;
  return sources.presets.find(preset => preset.id === credential.preset)?.catalog;
}

/**
 * The slice of a preset a runtime reads to decide its models: the catalog a login made from it reads, and the variables
 * each half takes (the person's own, which a catalog pin never replaces). A full `ProviderPreset` is one.
 */
export interface ModelSourcePreset {
  readonly id: string;
  readonly catalog?: string;
  readonly halves: Readonly<Partial<Record<HarnessKind, { readonly env: Readonly<Record<string, unknown>> }>>>;
}

/** What a machine knows about catalogs when it decides a runtime's models. */
export interface ModelCatalogSources {
  readonly catalogs: Readonly<Record<string, ModelCatalog>>;
  readonly presets: readonly ModelSourcePreset[];
  /** The catalog each harness's sign-in reads (`kit.signInCatalog`): a harness whose plugin gives none reads none. */
  readonly signIn: ReadonlyMap<HarnessKind, string>;
  /** What the last read of each local server found, by the `detect` kind a catalog names. */
  readonly local?: { readonly ollama?: LocalModels };
}

/**
 * The catalog a login's runtime of `harness` reads, and the variables its preset declares as the
 * person's to fill in (`./runtime.ts`: a catalog pin never replaces those). No catalog when the login
 * names none, or names one this machine does not have.
 */
export function loginModelCatalog(
  credential: Pick<Credential, 'store' | 'preset'>,
  harness: HarnessKind,
  sources: ModelCatalogSources,
): {
  readonly catalog?: ModelCatalog;
  readonly personOwned: ReadonlySet<string>;
  readonly local?: LocalModels;
} {
  const id = loginModelCatalogId(credential, harness, sources);
  const catalog = id === undefined ? undefined : sources.catalogs[id];
  const preset =
    credential.store === 'environment' ? sources.presets.find(entry => entry.id === credential.preset) : undefined;
  const personOwned = new Set(Object.keys(preset?.halves[harness]?.env ?? {}));
  const local = catalog?.detect === undefined ? undefined : sources.local?.[catalog.detect];
  return { ...(catalog === undefined ? {} : { catalog }), personOwned, ...(local === undefined ? {} : { local }) };
}

/**
 * The model each harness STARTS with when nothing names another: the default model of the catalog its sign-in reads
 * (docs/model-catalog.md), never a model id written here. A harness whose catalog this machine does not hold (Logins could
 * not be read) has no entry: the starter is then absent, and the built-in profile of that harness holds no model set.
 */
export type StarterModels = Readonly<Partial<Record<HarnessKind, string>>>;

/** No starter for any harness: what a reader that only needs profile NAMES passes. */
export const NO_STARTERS: StarterModels = {};

export function starterModelsOf(sources: Pick<ModelCatalogSources, 'catalogs' | 'signIn'> | undefined): StarterModels {
  if (sources === undefined) return NO_STARTERS;
  const starters: Partial<Record<HarnessKind, string>> = {};
  for (const [harness, catalogId] of sources.signIn) {
    const half = sources.catalogs[catalogId]?.[harness];
    const model = half?.models.find(candidate => candidate.default);
    if (model !== undefined) starters[harness] = model.id;
  }
  return starters;
}
