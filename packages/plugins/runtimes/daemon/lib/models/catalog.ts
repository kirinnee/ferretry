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
import type { ProviderPreset } from '../presets/schema.ts';
import type { ModelCatalog } from './schema.ts';

/** The catalog a SIGN-IN login reads: its CLI's maker. */
export const SIGN_IN_MODEL_CATALOGS: Readonly<Record<HarnessKind, string>> = { claude: 'anthropic', codex: 'openai' };

/**
 * Which catalog a login reads: a sign-in login its CLI's maker's, an environment login its preset's.
 * `undefined` for an environment login made by hand or from a preset that names none — its runtimes
 * offer what their profile's model set says, as before catalogs.
 */
export function loginModelCatalogId(
  credential: Pick<Credential, 'store' | 'preset'>,
  harness: HarnessKind,
  presets: readonly Pick<ProviderPreset, 'id' | 'catalog'>[],
): string | undefined {
  if (credential.store !== 'environment') return SIGN_IN_MODEL_CATALOGS[harness];
  if (credential.preset === undefined) return undefined;
  return presets.find(preset => preset.id === credential.preset)?.catalog;
}

/** What a machine knows about catalogs when it decides a runtime's models. */
export interface ModelCatalogSources {
  readonly catalogs: Readonly<Record<string, ModelCatalog>>;
  readonly presets: readonly ProviderPreset[];
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
  const id = loginModelCatalogId(credential, harness, sources.presets);
  const catalog = id === undefined ? undefined : sources.catalogs[id];
  const preset =
    credential.store === 'environment' ? sources.presets.find(entry => entry.id === credential.preset) : undefined;
  const personOwned = new Set(Object.keys(preset?.halves[harness]?.env ?? {}));
  const local = catalog?.detect === undefined ? undefined : sources.local?.[catalog.detect];
  return { ...(catalog === undefined ? {} : { catalog }), personOwned, ...(local === undefined ? {} : { local }) };
}
