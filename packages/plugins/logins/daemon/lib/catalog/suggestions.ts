/**
 * SUGGESTIONS (docs/model-catalog.md § Suggestions): a trimmed snapshot of models.dev — the public model
 * database — limited to the providers Ferretry has presets for, with LiteLLM's retirement dates added
 * where an id matches. The Pages build makes it and signs it inside `catalog/models.json`; an owner's
 * machine NEVER contacts models.dev or LiteLLM.
 *
 * A suggestion is information, never configuration. The curated YAML stays the source of truth for tiers,
 * defaults and efforts; a suggestion only ADDS a row a picker may show as "new / not reviewed"
 * ({@link suggestedModels}). Nothing here reaches a default, a tier slot or an effort.
 *
 * BOTH FETCHED DOCUMENTS ARE UNTRUSTED: {@link trimModelsDev} reads only the fields named below, caps every
 * string and count, drops every row that does not check and NAMES it, and keeps the rest.
 *
 * Pure.
 */
import { z } from 'zod';
import type { ModelCatalog } from './schema.ts';

/** The two external field names the trim reads, spelled as those databases spell them (allowed by name in no-compat). */
const MODELS_DEV_RETIRING_STATUS = 'deprecated';
const LITELLM_RETIRES_FIELD = 'deprecation_date';

/** The one models.dev document, and LiteLLM's, the build reads. Constants: no environment overrides a source. */
export const MODELS_DEV_URL = 'https://models.dev/api.json';
export const LITELLM_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

/** The models.dev providers kept: the ones Ferretry has a preset or a catalog for (and where a harness reads them). */
export const SUGGESTION_PROVIDERS = [
  'alibaba',
  'alibaba-coding-plan',
  'amazon-bedrock',
  'anthropic',
  'azure',
  'deepseek',
  'github-copilot',
  'google',
  'google-vertex',
  'kimi-code-plan-global',
  'minimax',
  'minimax-coding-plan',
  'mistral',
  'moonshotai',
  'openai',
  'opencode',
  'opencode-go',
  'openrouter',
  'vercel',
  'xai',
  'zai',
  'zai-coding-plan',
] as const;

/** The curated catalog each kept provider describes, so a picker can show what the catalog has not reviewed. */
const SUGGESTION_PROVIDER_OF_CATALOG: Readonly<Record<string, string>> = {
  anthropic: 'anthropic',
  openai: 'openai',
  'amazon-bedrock': 'amazon-bedrock',
  'azure-openai': 'azure',
  'google-vertex': 'google-vertex',
  'google-gemini': 'google',
  'github-copilot': 'github-copilot',
  deepseek: 'deepseek',
  kimi: 'moonshotai',
  minimax: 'minimax',
  zai: 'zai',
  qwen: 'alibaba',
  openrouter: 'openrouter',
  'vercel-ai-gateway': 'vercel',
  xai: 'xai',
  mistral: 'mistral',
};

/** LiteLLM prefixes a model id with its own provider name; the prefixes each kept provider is known by there. */
const LITELLM_PREFIXES: Readonly<Record<string, readonly string[]>> = {
  google: ['gemini'],
  moonshotai: ['moonshot'],
  zai: ['zai'],
  alibaba: ['dashscope'],
  vercel: ['vercel_ai_gateway'],
  'google-vertex': ['vertex_ai'],
  'amazon-bedrock': ['bedrock'],
};

const MAX_PROVIDERS = 64;
const MAX_MODELS_PER_PROVIDER = 1_000;

const Id = z.string().regex(/^[A-Za-z0-9@~][A-Za-z0-9._:~/@+-]{0,199}$/u);
const Short = z.string().min(1).max(200);
const Url = z
  .url()
  .max(300)
  .regex(/^https:\/\//u, { message: 'a suggestion URL is https' });
const Day = z.string().regex(/^\d{4}-\d{2}(?:-\d{2})?$/u);
const Tokens = z.number().int().nonnegative().max(1_000_000_000);
const Usd = z.number().nonnegative().max(100_000);
const Modality = z.string().regex(/^[a-z]{2,20}$/u);

/** What models.dev says a model costs, USD per million tokens. Only the flat fields; its tiers are left out. */
const SuggestionCostSchema = z.strictObject({
  input: Usd.optional(),
  output: Usd.optional(),
  cache_read: Usd.optional(),
  cache_write: Usd.optional(),
  reasoning: Usd.optional(),
});

/** One suggested model. Every field but the name is optional: a database row may lack any of them. */
const SuggestionModelSchema = z.strictObject({
  name: Short,
  reasoning: z.boolean().optional(),
  tool_call: z.boolean().optional(),
  modalities: z.strictObject({ input: z.array(Modality).max(12), output: z.array(Modality).max(12) }).optional(),
  limit: z.strictObject({ context: Tokens.optional(), input: Tokens.optional(), output: Tokens.optional() }).optional(),
  cost: SuggestionCostSchema.optional(),
  status: z.enum(['alpha', 'beta', 'retiring']).optional(),
  release_date: Day.optional(),
  /** The day LiteLLM says the model goes away, when an id matches (the catalog's own word for it: `retires`). */
  retires: Day.optional(),
});
type SuggestionModel = z.infer<typeof SuggestionModelSchema>;

/** One provider's suggested models, by model id. */
const SuggestionProviderSchema = z.strictObject({
  name: Short,
  /** The provider's API base URL, when models.dev has one. */
  api: Url.optional(),
  /** The environment variable NAMES its SDKs read (names only, never values). */
  env: z
    .array(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/u))
    .max(16)
    .optional(),
  models: z.record(Id, SuggestionModelSchema),
});
export type SuggestionProvider = z.infer<typeof SuggestionProviderSchema>;

/** The published `suggestions` value. */
const SuggestionsSchema = z.strictObject({
  /** The day the snapshot was taken. */
  generated: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  /** Where it came from. `litellm` is absent when no retirement dates were added. */
  sources: z.strictObject({ modelsDev: Url, litellm: Url.optional() }),
  providers: z.record(Id, SuggestionProviderSchema),
});
export type Suggestions = z.infer<typeof SuggestionsSchema>;

/** A row or provider that did not check, and why. */
export interface DroppedSuggestion {
  readonly where: string;
  readonly problem: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const sentence = (error: z.ZodError): string =>
  error.issues.map(issue => `${issue.path.map(String).join('.') || 'row'}: ${issue.message}`).join('; ');

/** `null` and absent are the same to a database; drop every `null` so a strict schema reads the rest. */
function withoutNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutNulls);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== null && entry !== undefined)
      .map(([key, entry]) => [key, withoutNulls(entry)]),
  );
}

/** Only the fields a suggestion carries, out of a models.dev model row. */
function modelsDevModel(row: Record<string, unknown>): unknown {
  const cost = isRecord(row.cost) ? row.cost : undefined;
  const limit = isRecord(row.limit) ? row.limit : undefined;
  const modalities = isRecord(row.modalities) ? row.modalities : undefined;
  return withoutNulls({
    name: row.name,
    reasoning: row.reasoning,
    tool_call: row.tool_call,
    modalities: modalities === undefined ? undefined : { input: modalities.input, output: modalities.output },
    limit: limit === undefined ? undefined : { context: limit.context, input: limit.input, output: limit.output },
    cost:
      cost === undefined
        ? undefined
        : {
            input: cost.input,
            output: cost.output,
            cache_read: cost.cache_read,
            cache_write: cost.cache_write,
            reasoning: cost.reasoning,
          },
    status: row.status === MODELS_DEV_RETIRING_STATUS ? 'retiring' : row.status,
    release_date: row.release_date,
  });
}

/** What a trim made of models.dev's document. */
export interface TrimmedModelsDev {
  readonly providers: Readonly<Record<string, SuggestionProvider>>;
  readonly dropped: readonly DroppedSuggestion[];
}

/**
 * models.dev's `api.json` trimmed to {@link SUGGESTION_PROVIDERS} and the fields a suggestion carries.
 * Untrusted input: a provider or model that does not check is dropped and named, never repaired.
 */
export function trimModelsDev(raw: unknown): TrimmedModelsDev {
  const dropped: DroppedSuggestion[] = [];
  if (!isRecord(raw))
    return { providers: {}, dropped: [{ where: '*', problem: 'models.dev is not a map of providers' }] };
  const providers: Record<string, SuggestionProvider> = {};
  for (const id of SUGGESTION_PROVIDERS) {
    const provider = raw[id];
    if (provider === undefined) {
      dropped.push({ where: id, problem: 'models.dev has no such provider' });
      continue;
    }
    if (!isRecord(provider) || !isRecord(provider.models)) {
      dropped.push({ where: id, problem: 'the provider is not a map with models' });
      continue;
    }
    const models: Record<string, SuggestionModel> = {};
    for (const [modelId, row] of Object.entries(provider.models).slice(0, MAX_MODELS_PER_PROVIDER)) {
      const checked = isRecord(row) ? SuggestionModelSchema.safeParse(modelsDevModel(row)) : undefined;
      const idChecked = Id.safeParse(modelId);
      if (checked?.success === true && idChecked.success) models[modelId] = checked.data;
      else
        dropped.push({
          where: `${id}/${modelId.slice(0, 80)}`,
          problem:
            checked === undefined
              ? 'the row is not a map'
              : checked.success
                ? 'the id is not an id'
                : sentence(checked.error),
        });
    }
    const head = SuggestionProviderSchema.safeParse(
      withoutNulls({
        name: provider.name,
        api: provider.api,
        env: provider.env,
        models,
      }),
    );
    if (head.success) providers[id] = head.data;
    else dropped.push({ where: id, problem: sentence(head.error) });
  }
  return { providers, dropped };
}

/** The dates LiteLLM states (its `deprecation_date` field), by its own key (`gemini/gemini-2.5-pro`, `gpt-5`). */
function litellmDates(raw: unknown): ReadonlyMap<string, string> {
  const dates = new Map<string, string>();
  if (!isRecord(raw)) return dates;
  for (const [key, entry] of Object.entries(raw)) {
    if (!isRecord(entry)) continue;
    const date = Day.safeParse(entry[LITELLM_RETIRES_FIELD]);
    if (date.success) dates.set(key, date.data);
  }
  return dates;
}

/**
 * Add LiteLLM's date as `retires` to every suggested model whose id it also lists: under the bare id, or
 * under `<litellm prefix>/<id>` for the prefixes that provider is known by there. A document that is not a
 * map adds nothing. Returns the number of dates added.
 */
export function withRetirementDates(
  providers: Readonly<Record<string, SuggestionProvider>>,
  litellm: unknown,
): { readonly providers: Readonly<Record<string, SuggestionProvider>>; readonly added: number } {
  const dates = litellmDates(litellm);
  let added = 0;
  const result = Object.fromEntries(
    Object.entries(providers).map(([providerId, provider]) => {
      const prefixes = [providerId, ...(LITELLM_PREFIXES[providerId] ?? [])];
      const models = Object.fromEntries(
        Object.entries(provider.models).map(([id, model]) => {
          const date = [id, ...prefixes.map(prefix => `${prefix}/${id}`)].map(key => dates.get(key)).find(Boolean);
          if (date === undefined) return [id, model];
          added += 1;
          return [id, { ...model, retires: date }];
        }),
      );
      return [providerId, { ...provider, models }];
    }),
  );
  return { providers: result, added };
}

/** JSON with every object's keys sorted and two-space indentation: a snapshot refresh diffs line by line. */
export function stableJson(value: unknown, indent = 2): string {
  const sort = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(sort);
    if (!isRecord(node)) return node;
    return Object.fromEntries(
      Object.keys(node)
        .sort()
        .map(key => [key, sort(node[key])]),
    );
  };
  return `${JSON.stringify(sort(value), null, indent)}\n`;
}

/** What reading a published `suggestions` value made of it. */
export interface ReadSuggestions {
  readonly suggestions: Suggestions | undefined;
  readonly dropped: readonly DroppedSuggestion[];
}

/**
 * A published `suggestions` value, read leniently: a provider or model that does not check is left out and
 * named, so one bad row never takes the rest. `undefined` when it is not a suggestions document at all.
 */
export function readSuggestions(value: unknown): ReadSuggestions {
  if (value === undefined) return { suggestions: undefined, dropped: [] };
  if (!isRecord(value) || !isRecord(value.providers)) {
    return { suggestions: undefined, dropped: [{ where: 'suggestions', problem: 'not a suggestions document' }] };
  }
  const head = SuggestionsSchema.pick({ generated: true, sources: true }).safeParse({
    generated: value.generated,
    sources: value.sources,
  });
  if (!head.success)
    return { suggestions: undefined, dropped: [{ where: 'suggestions', problem: sentence(head.error) }] };
  const dropped: DroppedSuggestion[] = [];
  const providers: Record<string, SuggestionProvider> = {};
  for (const [id, provider] of Object.entries(value.providers).slice(0, MAX_PROVIDERS)) {
    if (!Id.safeParse(id).success || !isRecord(provider) || !isRecord(provider.models)) {
      dropped.push({ where: id.slice(0, 80), problem: 'not a provider with models' });
      continue;
    }
    const models: Record<string, SuggestionModel> = {};
    for (const [modelId, row] of Object.entries(provider.models).slice(0, MAX_MODELS_PER_PROVIDER)) {
      const checked = Id.safeParse(modelId).success ? SuggestionModelSchema.safeParse(row) : undefined;
      if (checked?.success === true) models[modelId] = checked.data;
      else
        dropped.push({
          where: `${id}/${modelId.slice(0, 80)}`,
          problem: checked === undefined ? 'not an id' : sentence(checked.error),
        });
    }
    const read = SuggestionProviderSchema.safeParse({ ...provider, models });
    if (read.success) providers[id] = read.data;
    else dropped.push({ where: id, problem: sentence(read.error) });
  }
  return { suggestions: { ...head.data, providers }, dropped };
}

/** A model a catalog has not reviewed, as a picker shows it: "new / not reviewed". */
export interface SuggestedModel {
  readonly id: string;
  readonly provider: string;
  readonly model: SuggestionModel;
  readonly review: 'new / not reviewed';
}

/**
 * The models a provider's suggestions list that the curated catalog does not: every id in no half of the
 * catalog, in id order, leaving out those their database marks as going away. Rows only — never a default, a
 * tier or an effort, which stay the catalog's.
 */
export function suggestedModels(
  catalog: Pick<ModelCatalog, 'id' | 'claude' | 'codex' | 'gemini' | 'copilot' | 'opencode'>,
  suggestions: Suggestions | undefined,
): readonly SuggestedModel[] {
  const provider = SUGGESTION_PROVIDER_OF_CATALOG[catalog.id];
  const listed = provider === undefined ? undefined : suggestions?.providers[provider];
  if (provider === undefined || listed === undefined) return [];
  const known = new Set(
    [catalog.claude, catalog.codex, catalog.gemini, catalog.copilot, catalog.opencode].flatMap(half =>
      (half?.models ?? []).map(model => model.id),
    ),
  );
  return Object.keys(listed.models)
    .sort()
    .flatMap(id => {
      const model = listed.models[id];
      if (model === undefined || known.has(id) || model.status === 'retiring') return [];
      return [{ id, provider, model, review: 'new / not reviewed' as const }];
    });
}
