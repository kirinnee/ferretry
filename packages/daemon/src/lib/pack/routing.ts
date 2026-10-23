/**
 * THE ROUTING PROMPT IN EFFECT (docs/pack-mode.md § The routing prompt): the owner's `models-guide.yaml`
 * `prompt` when it has one, and otherwise one RENDERED from the model catalogs in effect — the strongest tier
 * for planning and review, the balanced one for everyday work, the fast one for chores — so a machine that
 * never wrote one still has one, and it moves with the catalogs (a new Opus, a new GLM) without a release.
 *
 * Also: the editor's vocabulary (every model any catalog lists, with the runtimes here that run it), the
 * prompt as ONE line for a ferret's system prompt, and the old use-case guide rendered into one prompt for
 * the one-time migration.
 *
 * Pure: catalogs, runtimes and the file in, values out.
 */
import type {
  FleetRuntimeView,
  ModelCatalogEntryView,
  ModelCatalogView,
  ModelsGuideFile,
  PackFleetModel,
  RoutingPromptView,
} from '@ferretry/protocol';
import { isLegacyModelsGuide, MAX_ROUTING_PROMPT_CHARS } from '@ferretry/protocol';

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

const HARNESSES: readonly Harness[] = ['claude', 'codex'];

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
        (catalog[harness] ?? []).map(entry => ({ provider: catalog.id, providerLabel: catalog.label, harness, entry })),
      ),
    );
}

/** The runtimes here that offer `id` from `provider`'s catalog on `harness`, by name. */
function runtimesOffering(
  runtimes: readonly FleetRuntimeView[],
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
  runtimes: readonly FleetRuntimeView[],
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

/**
 * The routing prompt in effect: the file's `prompt`; else, for a file the migration has not reached yet, its
 * old use cases rendered into one prompt (so nothing it said is lost meanwhile); else the default.
 */
export function effectiveRouting(
  file: ModelsGuideFile,
  catalogs: readonly ModelCatalogView[],
  runtimes: readonly FleetRuntimeView[],
  bin = 'fy',
): RoutingPromptView {
  const suggested = file.suggested === undefined ? {} : { suggested: file.suggested };
  if (file.prompt !== undefined) return { text: file.prompt, source: 'file', ...suggested };
  const base = defaultPrompt(fleetModels(catalogs, runtimes), bin);
  const legacy = isLegacyModelsGuide(file) ? legacyPrompt(file, undefined, base) : undefined;
  if (legacy !== undefined) return { text: legacy.text, source: 'file' };
  return { text: base, source: 'default' };
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

// ── The old guide, rendered once ────────────────────────────────────────────────────────────────

/** The old guide's pieces as the migration reads them: leniently, since nothing checks them any more. */
interface LegacyUseCase {
  readonly title: string;
  readonly candidates: readonly { readonly model: string; readonly effort?: string; readonly codex: boolean }[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

function legacyUseCases(raw: readonly unknown[] | undefined): readonly LegacyUseCase[] {
  return (raw ?? []).flatMap(entry => {
    if (!isRecord(entry)) return [];
    const title = text(entry.title) ?? text(entry.id);
    if (title === undefined) return [];
    const candidates = (Array.isArray(entry.candidates) ? entry.candidates : []).flatMap(candidate => {
      if (!isRecord(candidate)) return [];
      const model = text(candidate.model);
      const effort = text(candidate.effort);
      return model === undefined
        ? []
        : [{ model, ...(effort === undefined ? {} : { effort }), codex: candidate.harness === 'codex' }];
    });
    return [{ title, candidates }];
  });
}

/** How many of a use case's candidates the rendered line names. */
export const LEGACY_CANDIDATES = 3;

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

/** The old guide rendered as one prompt, and whether it had to be cut to fit. */
export interface LegacyRender {
  readonly text: string;
  readonly cut: boolean;
}

/**
 * The old guide as ONE routing prompt (docs/pack-mode.md § Migration): its use cases first — each title and
 * its first candidates, best first, so `--auto` tries them in the order the guide ranked them — then its own
 * routing prompt, then the owner's routing preferences from `pack.yaml`. A file that named no use cases ran on
 * the guide built from the catalogs, so `base` — the default prompt — stands in for them. When that is longer
 * than a prompt may be, the use cases are kept whole and the prose is cut at a sentence; the old file is kept
 * in full beside it. `undefined` when the file said nothing a prompt could carry (it only described models).
 */
export function legacyPrompt(
  file: ModelsGuideFile,
  preferences: string | undefined,
  base: string,
): LegacyRender | undefined {
  const useCases = legacyUseCases(file.useCases);
  const lines = useCases.map(useCase => {
    const named = useCase.candidates
      .slice(0, LEGACY_CANDIDATES)
      .map(
        candidate =>
          `${candidate.model}${candidate.codex ? ' (codex)' : ''}${candidate.effort === undefined ? '' : ` at ${candidate.effort}`}`,
      );
    return `- ${useCase.title}: ${named.length === 0 ? 'no model named' : named.join(', then ')}.`;
  });
  const prose = [
    isRecord(file.routing) ? text(file.routing.prompt) : undefined,
    text(preferences) === undefined ? undefined : `Preferences: ${text(preferences) ?? ''}`,
  ].filter((part): part is string => part !== undefined);
  if (lines.length === 0 && prose.length === 0) return undefined;
  const head = lines.length === 0 ? [base] : ["Pick each sub-task's model by the kind of work, best first:", ...lines];
  const structured = cut(head.join('\n'), MAX_ROUTING_PROMPT_CHARS);
  if (prose.length === 0) return structured;
  const room = MAX_ROUTING_PROMPT_CHARS - (structured.text.length === 0 ? 0 : structured.text.length + 1);
  if (room < 40) return { text: structured.text, cut: true };
  const tail = cut(prose.join('\n'), room);
  return {
    text: [structured.text, tail.text].filter(part => part !== '').join('\n'),
    cut: structured.cut || tail.cut,
  };
}
