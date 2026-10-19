/**
 * The model catalog FILE a Codex runtime on a third-party provider reads (docs/model-catalog.md §
 * Codex's own picker).
 *
 * Codex lists the models in its OWN catalog — the OpenAI models it ships, refreshed from OpenAI for a
 * ChatGPT sign-in — in `/model` and over its app-server, and it has no idea what DeepSeek, Kimi or
 * OpenRouter serve. `model_catalog_json` is the one setting that replaces that list, so a runtime on
 * such a provider is launched with `-c model_catalog_json="<this file>"` and its picker, Ferretry's
 * composer chip and the multi-agent tool's "available model overrides" all offer exactly the login's
 * catalog models: their names, their efforts, their context windows.
 *
 * WHAT AN ENTRY CARRIES, AND WHY IT IS NEUTRAL. Once a model has an entry Codex stops using its
 * fallback metadata for it, and the entry's `base_instructions` is the model's whole system prompt. So
 * every other field here repeats what Codex itself uses for a model it has no entry for (measured on
 * 0.145 and 0.156: the request sent is byte-identical to the fallback's, apart from the reasoning
 * effort now being sent and the sub-agent tool naming the right models), and the prompt is the one
 * Codex ships for that case (`codex/default-instructions.txt`, refreshed by
 * `scripts/local/refresh-codex-default-instructions.ts`). Borrowing a bundled OpenAI entry instead
 * would hand a DeepSeek model GPT's persona and code-mode-only tools.
 *
 * THE KEYS ARE THE UNION of what the Codex versions Ferretry has been measured against require, because
 * Codex refuses to START on a catalog it cannot parse — and tolerates keys it does not know. A key a
 * future Codex adds as required is the one way this file can stop a runtime from launching; the person's
 * escape is setting `model_catalog_json` in their own profile settings, which Ferretry then leaves alone.
 *
 * A CATALOG OF MODELS CODEX KNOWS (OpenAI's own, on an OpenAI key or Azure) IS NOT WRITTEN: its bundled
 * entries are richer than anything here — freeform `apply_patch`, code mode, the right prompt per model —
 * and replacing them would make those models worse. Their picker keeps Codex's list.
 *
 * Pure.
 */
import defaultInstructions from '../../../codex/default-instructions.txt' with { type: 'text' };
import type { RuntimeModelEntry, RuntimeModels } from './runtime.ts';

/**
 * The format of the file below. Bump it whenever `renderCodexModelCatalog` would write different text
 * for the same models: the manifest publishes it, which is how an already-running machine rewrites its
 * files (`tests/unit/codex-catalog.test.ts` pins the text and fails until this is bumped).
 */
export const CODEX_CATALOG_FORMAT = 1;

/** The file Codex reads, inside the runtime's Ferretry-owned state directory. */
export const CODEX_MODEL_CATALOG_FILE = 'codex-model-catalog.json';

/**
 * Catalogs whose model ids Codex already ships metadata for: a runtime on one keeps Codex's own list.
 * The one owner of that fact — a machine's own `config/models/<id>.yaml` for these ids changes the
 * chip's labels and tiers, never the in-chat list.
 */
export const CODEX_NATIVE_MODEL_CATALOGS: ReadonlySet<string> = new Set(['openai', 'azure-openai']);

/** What Codex shows beside a reasoning level. The words are Codex's own for the levels it ships. */
const EFFORT_WORDS: Readonly<Record<string, string>> = {
  none: 'No reasoning',
  minimal: 'Minimal reasoning',
  low: 'Fast responses with lighter reasoning',
  medium: 'Balances speed and reasoning depth for everyday tasks',
  high: 'Greater reasoning depth for complex problems',
  xhigh: 'Extra high reasoning depth for complex problems',
  max: 'Maximum reasoning depth for the hardest problems',
  ultra: 'Maximum reasoning with automatic task delegation',
};

const TIER_WORDS = { best: 'Best', balanced: 'Balanced', fast: 'Fast' } as const;

/** `1000000` → `1M`, `1050000` → `1.05M`, `128000` → `128K`. */
export function contextWords(tokens: number): string {
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(2))}M`;
  return `${Math.max(1, Math.round(tokens / 1_000))}K`;
}

/** The one line Codex shows under a model: its tier, its window, and the catalog's note. */
function describe(model: RuntimeModelEntry): string {
  return [
    model.tier === undefined ? undefined : TIER_WORDS[model.tier],
    model.context === undefined ? undefined : `${contextWords(model.context)} context`,
    model.note,
  ]
    .filter((part): part is string => part !== undefined)
    .join(' · ');
}

/** The level a picker starts on: the catalog's, else `medium` when the model takes it, else its first. */
function startingEffort(model: RuntimeModelEntry): string | undefined {
  if (model.efforts.length === 0) return undefined;
  if (model.defaultEffort !== undefined) return model.defaultEffort;
  return model.efforts.includes('medium') ? 'medium' : model.efforts[0];
}

/** One model as Codex's catalog spells it. */
function codexEntry(model: RuntimeModelEntry, priority: number): Readonly<Record<string, unknown>> {
  const starting = startingEffort(model);
  const description = describe(model);
  return {
    slug: model.id,
    display_name: model.label,
    ...(description === '' ? {} : { description }),
    ...(starting === undefined ? {} : { default_reasoning_level: starting }),
    supported_reasoning_levels: model.efforts.map(effort => ({
      effort,
      description: EFFORT_WORDS[effort] ?? effort,
    })),
    visibility: 'list',
    priority,
    supported_in_api: true,
    shell_type: 'default',
    base_instructions: defaultInstructions,
    supports_reasoning_summaries: false,
    default_reasoning_summary: 'auto',
    support_verbosity: false,
    supports_search_tool: false,
    web_search_tool_type: 'text',
    truncation_policy: { mode: 'bytes', limit: 10_000 },
    supports_parallel_tool_calls: false,
    supports_image_detail_original: false,
    ...(model.context === undefined ? {} : { context_window: model.context, max_context_window: model.context }),
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: ['text'],
  };
}

/**
 * The models Codex's own picker is to offer for this runtime, or `undefined` when it keeps Codex's list:
 * a login with no catalog, a catalog of models Codex knows, or one with nothing the login can use.
 */
export function codexCatalogModels(derived: RuntimeModels): readonly RuntimeModelEntry[] | undefined {
  if (derived.catalog === undefined || CODEX_NATIVE_MODEL_CATALOGS.has(derived.catalog.id)) return undefined;
  const usable = derived.models.filter(model => model.available);
  return usable.length === 0 ? undefined : usable;
}

/**
 * The catalog file's text. Codex lists by `priority` and calls the first model its default, so the model
 * the runtime launches with comes first and the rest follow in the catalog's own order.
 */
export function renderCodexModelCatalog(models: readonly RuntimeModelEntry[], launchesWith?: string): string {
  const ordered = [
    ...models.filter(model => model.id === launchesWith),
    ...models.filter(model => model.id !== launchesWith),
  ];
  return `${JSON.stringify({ models: ordered.map((model, index) => codexEntry(model, index + 1)) }, null, 2)}\n`;
}

/** The launch flag that points Codex at the file. A TOML basic string; JSON's escapes are a subset. */
export function codexCatalogArguments(path: string): readonly string[] {
  return ['-c', `model_catalog_json=${JSON.stringify(path)}`];
}
