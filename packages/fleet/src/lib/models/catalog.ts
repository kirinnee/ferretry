/**
 * The model catalogs a machine reads (docs/model-catalog.md), and which one a login gets.
 *
 * THREE SOURCES, ONE SHAPE, THE NEWEST-OWNED WINS, BY ID:
 *
 * 1. `config/models/<id>.yaml` — the machine's own copy, hand-edited. Always wins: it is how the owner
 *    pins a model, or adds a catalog for a preset of their own.
 * 2. The PUBLISHED catalog — `packages/fleet/models/*.yaml` as Ferretry last published it, signed, fetched
 *    by the daemon (`./published.ts`). This is what lets a model list change without a release.
 * 3. The BUILT-IN catalog — the same files compiled into this build: what a machine that has never
 *    fetched one, or is offline, falls back to.
 *
 * The files are imported as TEXT, exactly as presets are, so the binary carries the bytes the
 * repository has and CI publishes the same bytes.
 *
 * Pure.
 */
import amazonBedrock from '../../../models/amazon-bedrock.yaml' with { type: 'text' };
import anthropic from '../../../models/anthropic.yaml' with { type: 'text' };
import azureOpenai from '../../../models/azure-openai.yaml' with { type: 'text' };
import bedrockMantle from '../../../models/bedrock-mantle.yaml' with { type: 'text' };
import deepseek from '../../../models/deepseek.yaml' with { type: 'text' };
import gateway from '../../../models/gateway.yaml' with { type: 'text' };
import googleVertex from '../../../models/google-vertex.yaml' with { type: 'text' };
import kimi from '../../../models/kimi.yaml' with { type: 'text' };
import microsoftFoundry from '../../../models/microsoft-foundry.yaml' with { type: 'text' };
import minimax from '../../../models/minimax.yaml' with { type: 'text' };
import ollama from '../../../models/ollama.yaml' with { type: 'text' };
import openai from '../../../models/openai.yaml' with { type: 'text' };
import openrouter from '../../../models/openrouter.yaml' with { type: 'text' };
import qwen from '../../../models/qwen.yaml' with { type: 'text' };
import vercelAiGateway from '../../../models/vercel-ai-gateway.yaml' with { type: 'text' };
import zai from '../../../models/zai.yaml' with { type: 'text' };
import type { LocalModels } from '@ferretry/protocol';
import type { Credential } from '../account/schema.ts';
import { readConfigText } from '../config-files/yaml-text.ts';
import type { HarnessKind } from '../manifest.ts';
import type { ProviderPreset } from '../presets/schema.ts';
import { type ModelCatalog, type ModelCatalogFile, ModelCatalogFileSchema } from './schema.ts';

/** Every built-in catalog's text, by id. */
export const BUILT_IN_MODEL_CATALOG_TEXTS: Readonly<Record<string, string>> = Object.freeze({
  anthropic,
  openai,
  'amazon-bedrock': amazonBedrock,
  'bedrock-mantle': bedrockMantle,
  'google-vertex': googleVertex,
  'microsoft-foundry': microsoftFoundry,
  zai,
  kimi,
  minimax,
  deepseek,
  qwen,
  openrouter,
  'vercel-ai-gateway': vercelAiGateway,
  gateway,
  'azure-openai': azureOpenai,
  ollama,
});

/** The catalog a SIGN-IN login reads: its CLI's maker. */
export const SIGN_IN_MODEL_CATALOGS: Readonly<Record<HarnessKind, string>> = { claude: 'anthropic', codex: 'openai' };

/** A built-in catalog that does not check: a defect in this repository, never a person's mistake. */
export class BuiltInModelCatalogError extends Error {
  constructor(id: string, problem: string) {
    super(`built-in model catalog ${id} does not check: ${problem}`);
    this.name = 'BuiltInModelCatalogError';
  }
}

type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problem: string };

const issuesSentence = (issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[]) =>
  issues.map(issue => `${issue.path.map(String).join('.') || 'file'}: ${issue.message}`).join('; ');

/** One catalog's plain value, checked. */
export function parseModelCatalog(id: string, value: unknown, origin: ModelCatalog['origin']): Parsed<ModelCatalog> {
  const parsed = ModelCatalogFileSchema.safeParse(value);
  if (!parsed.success) return { ok: false, problem: issuesSentence(parsed.error.issues) };
  return { ok: true, value: { ...parsed.data, id, origin } };
}

/** One catalog file's text, checked. */
export function parseModelCatalogText(id: string, text: string, origin: ModelCatalog['origin']): Parsed<ModelCatalog> {
  const read = readConfigText(text);
  if (!read.ok) return { ok: false, problem: read.errors.map(error => error.message).join('; ') };
  return parseModelCatalog(id, read.read.value, origin);
}

/** The built-in catalogs, checked, by id. Throws {@link BuiltInModelCatalogError} when a shipped file is broken. */
export function builtInModelCatalogs(): Readonly<Record<string, ModelCatalog>> {
  return Object.fromEntries(
    Object.entries(BUILT_IN_MODEL_CATALOG_TEXTS).map(([id, text]) => {
      const parsed = parseModelCatalogText(id, text, 'built-in');
      if (!parsed.ok) throw new BuiltInModelCatalogError(id, parsed.problem);
      return [id, parsed.value];
    }),
  );
}

/** The catalogs a machine reads: each id from the most owned source that has it (module doc). */
export function modelCatalogs(sources: {
  readonly builtIn: Readonly<Record<string, ModelCatalog>>;
  readonly published?: Readonly<Record<string, ModelCatalog>>;
  readonly files?: Readonly<Record<string, ModelCatalog>>;
}): Readonly<Record<string, ModelCatalog>> {
  return { ...sources.builtIn, ...sources.published, ...sources.files };
}

/** The plain value a catalog is written as: what `config/models/<id>.yaml` starts from. */
export function modelCatalogFileValue(catalog: ModelCatalog): ModelCatalogFile {
  const { id: _id, origin: _origin, ...file } = catalog;
  return file;
}

/** The text to start a machine's own copy of a built-in catalog from, or `undefined` for an unknown id. */
export function modelCatalogFileText(id: string): string | undefined {
  return BUILT_IN_MODEL_CATALOG_TEXTS[id];
}

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
