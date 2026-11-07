/**
/**
 * THE ROUTING PROMPT IN EFFECT (docs/pack-mode.md § The routing prompt): the owner's `packs.yaml` routing
 * `prompt` when it has one, and otherwise one RENDERED from the model catalogs in effect — the strongest tier
 * for planning and review, the balanced one for everyday work, the fast one for chores — so a machine that
 * never wrote one still has one, and it moves with the catalogs (a new Opus, a new GLM) without a release.
 *
 * Also: the editor's vocabulary (every model any catalog lists, with the runtimes here that run it) and the
 * prompt as ONE line for a ferret's system prompt.
 *
 * Pure: catalogs, runtimes and the file in, values out.
 */
import type { RuntimeView } from '@ferretry/plugin-runtimes/contract';
import {
  MAX_ROUTING_PROMPT_CHARS,
  type PackFleetModel,
  type RoutingFile,
  type RoutingPromptView,
} from '../../contract/index.ts';
import type { ModelCatalogEntryView, ModelCatalogView } from './catalog.ts';

type Harness = PackFleetModel['harness'];
type Tier = ModelCatalogEntryView['tier'];

/** One catalog entry with the catalog and CLI it belongs to. */
interface CatalogModel {
  readonly provider: string;
  readonly providerLabel: string;
  readonly harness: Harness;
  readonly entry: ModelCatalogEntryView;
}

/**
 * The order the rendered prompt prefers providers in: each provider's own catalog first, then the gateways
 * and clouds that resell the same models. A provider not named here comes after, in catalog order. Only the
 * ORDER comes from this list; nothing is ever excluded by it.
 */
export const PROVIDER_PREFERENCE: readonly string[] = [
  'anthropic',
  'openai',
  'zai',
  'deepseek',
  'kimi',
  'minimax',
  'qwen',
  'ollama',
];

const HARNESSES: readonly Harness[] = ['claude-code', 'codex'];

/** Every model every catalog lists, one row per catalog, CLI and id, in preference order. */
function catalogModels(catalogs: readonly ModelCatalogView[]): readonly CatalogModel[] {
  const rank = (provider: string): number => {
    const at = PROVIDER_PREFERENCE.indexOf(provider);
    return at === -1 ? PROVIDER_PREFERENCE.length : at;
  };
  return catalogs
    .map((catalog, index) => ({ catalog, index }))
    .toSorted((left, right) => rank(left.catalog.id) - rank(right.catalog.id) || left.index - right.index)
    .flatMap(({ catalog }) =>
      HARNESSES.flatMap(harness =>
        ((harness === 'claude-code' ? catalog.claude : catalog.codex) ?? []).map(entry => ({
          provider: catalog.id,
          providerLabel: catalog.label,
          harness,
          entry,
        })),
      ),
    );
}

/** The runtimes here that offer `id` from `provider`'s catalog on `harness`, by name. */
function runtimesOffering(
  runtimes: readonly RuntimeView[],
  provider: string,
  harness: Harness,
  id: string,
): readonly string[] {
  return runtimes
    .filter(
      runtime =>
        runtime.agent &&
        runtime.harness === harness &&
        runtime.models?.catalog.id === provider &&
        runtime.models.choices.some(choice => choice.id === id),
    )
    .map(runtime => runtime.name);
}

/**
 * Every model the fleet knows, for the editor's highlighting and autocomplete and for matching the models a
 * prompt names: one row per catalog, CLI and id, with the runtimes here that run it.
 */
export function fleetModels(
  catalogs: readonly ModelCatalogView[],
  runtimes: readonly RuntimeView[],
): readonly PackFleetModel[] {
  return catalogModels(catalogs).map(({ provider, providerLabel, harness, entry }) => ({
    provider,
    providerLabel,
    harness,
    id: entry.id,
    label: entry.label,
    tier: entry.tier,
    ...(entry.context === undefined ? {} : { context: entry.context }),
    efforts: [...entry.efforts],
    runtimes: runtimesOffering(runtimes, provider, harness, entry.id),
  }));
}

// ── The default prompt ──────────────────────────────────────────────────────────────────────────

/**
 * The models of one tier, a model a runtime here runs before one nothing here runs, each label once (the same
 * model resold by Bedrock or a gateway is one), in provider preference order.
 */
function ofTier(models: readonly PackFleetModel[], tier: Tier): readonly PackFleetModel[] {
  const seen = new Set<string>();
  return models
    .filter(model => model.tier === tier)
    .map((model, index) => ({ model, index }))
    .toSorted(
      (left, right) =>
        Number(right.model.runtimes.length > 0) - Number(left.model.runtimes.length > 0) || left.index - right.index,
    )
    .map(({ model }) => model)
    .filter(model => {
      const key = model.label.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

const at = (model: PackFleetModel, effort: string | undefined): string =>
  effort === undefined ? model.id : `${model.id} at ${effort}`;

/**
 * The prompt a machine with none of its own is given, from the models in effect: planning, review and the
 * hardest code on the strongest tier at its highest effort (another family for a second opinion), everyday
 * work on the balanced tier, chores on the fast tier at its lowest effort, then how to fall back. It names
 * models by id, so `--auto` and a ferret can use each word as it stands.
 */
export function defaultPrompt(models: readonly PackFleetModel[], bin: string): string {
  const best = ofTier(models, 'best');
  const balanced = ofTier(models, 'balanced');
  const fast = ofTier(models, 'fast');
  const strongest = best[0];
  const other = best.find(
    model => strongest !== undefined && model.provider !== strongest.provider && model.label !== strongest.label,
  );
  const lines = [
    "Pick each sub-task's model by the kind of work:",
    ...(strongest === undefined
      ? []
      : [
          `- Planning, review and the hardest or most critical code: ${at(strongest, strongest.efforts.at(-1))}${other === undefined ? '' : `; for a second opinion from another family, ${at(other, other.efforts.at(-1))}`}.`,
        ]),
    ...(balanced.length === 0
      ? []
      : [
          `- Everyday coding: ${balanced
            .slice(0, 2)
            .map(model => model.id)
            .join(', then ')}.`,
        ]),
    ...(fast[0] === undefined ? [] : [`- Mechanical chores and bulk edits: ${at(fast[0], fast[0].efforts[0])}.`]),
    ...(strongest === undefined && balanced.length === 0 && fast.length === 0
      ? [`No model catalog lists a model yet; \`${bin} recommend\` shows what can run.`]
      : []),
    'Prefer a login with quota left. When a model is refused, take the next one named here.',
  ];
  return cut(lines.join('\n'), MAX_ROUTING_PROMPT_CHARS).text;
}

/** The routing prompt in effect: the file's `prompt`, else the default rendered from the catalogs. */
export function effectiveRouting(
  file: RoutingFile,
  catalogs: readonly ModelCatalogView[],
  runtimes: readonly RuntimeView[],
  bin = 'fy',
): RoutingPromptView {
  const suggested = file.suggested === undefined ? {} : { suggested: file.suggested };
  if (file.prompt !== undefined) return { text: file.prompt, source: 'file', ...suggested };
  return { text: defaultPrompt(fleetModels(catalogs, runtimes), bin), source: 'default' };
}

// ── The prompt as one line of a system prompt ───────────────────────────────────────────────────

/** What the line is introduced by in the Pack section. */
export const ROUTING_LINE_PREFIX = 'Routing: ';

/**
 * The prompt as ONE line for the Pack section of a ferret's system prompt (`FY_PACK_ROUTING`): each line
 * trimmed and its bullet dropped, joined with a space after a sentence's end and "; " otherwise; a double
 * quote becomes a single one and a backslash or control character is deleted, so the value sits inside
 * Claude's argument and Codex's TOML string unchanged — the wrapper deletes them again in case.
 */
export function routingLine(text: string): string {
  const parts = text
    .split(/\r?\n/u)
    .map(line => line.trim().replace(/^(?:[-*•]|\d+[.)])\s+/u, ''))
    .filter(line => line !== '');
  const joined = parts.reduce(
    (line, part) => (line === '' ? part : `${line}${/[.;:!?]$/u.test(line) ? ' ' : '; '}${part}`),
    '',
  );
  const clean = joined
    .replaceAll('"', "'")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes
    .replaceAll(/[\\\u0000-\u001f\u007f]+/gu, ' ')
    .replaceAll(/\s+/gu, ' ')
    .trim();
  return `${ROUTING_LINE_PREFIX}${clean}`;
}

/**
 * Text cut to `limit` characters at the last sentence or line end that fits, with "…" after it; whole when it
 * fits. `cut` says whether anything was lost.
 */
export function cut(value: string, limit: number): { readonly text: string; readonly cut: boolean } {
  if (value.length <= limit) return { text: value, cut: false };
  const head = value.slice(0, Math.max(0, limit - 1));
  const end = Math.max(head.lastIndexOf('. '), head.lastIndexOf('.\n'), head.lastIndexOf('\n'));
  const kept = (end > limit / 2 ? head.slice(0, end + 1) : head).trimEnd();
  return { text: `${kept}…`, cut: true };
}
