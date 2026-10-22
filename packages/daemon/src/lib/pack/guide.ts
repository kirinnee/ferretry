/**
 * THE MODELS GUIDE IN EFFECT (docs/pack-mode.md): the owner's `models-guide.yaml` when it names use
 * cases, and otherwise one DERIVED from the model catalogs in effect — so a machine that never wrote a
 * guide still gets one, and it moves with the catalogs (a new Opus, a new GLM) without a release.
 *
 * Also the editor's vocabulary: every model any catalog lists, and which runtimes here can run it.
 *
 * Pure: catalogs and runtimes in, values out.
 */
import type {
  FleetRuntimeView,
  GuideCandidate,
  GuideRouting,
  GuideUseCase,
  ModelCatalogEntryView,
  ModelCatalogView,
  ModelDescription,
  ModelsGuide,
  ModelsGuideFile,
  PackFleetModel,
} from '@ferretry/protocol';
import { MAX_ROUTING_PROMPT_CHARS, MAX_ROUTING_SHORT_CHARS } from '@ferretry/protocol';

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
 * The order the derived guide prefers providers in: each provider's own catalog first, then the
 * gateways and clouds that resell the same models. A provider not named here comes after, in catalog
 * order. Only the ORDER of a derived guide comes from this list; nothing is ever excluded by it.
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

/** The most candidates a derived use case lists. */
export const DERIVED_CANDIDATES = 6;

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

/** The same model resold by another catalog is one candidate, not five: the first (preferred) one wins. */
function distinctByLabel(models: readonly CatalogModel[]): readonly CatalogModel[] {
  const seen = new Set<string>();
  return models.filter(model => {
    const key = model.entry.label.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const highestEffort = (entry: ModelCatalogEntryView): string | undefined => entry.efforts.at(-1);
const lowestEffort = (entry: ModelCatalogEntryView): string | undefined => entry.efforts[0];

const candidateOf = (model: CatalogModel, effort: string | undefined, why: string): GuideCandidate => ({
  provider: model.provider,
  model: model.entry.id,
  ...(model.harness === 'codex' ? { harness: 'codex' as const } : {}),
  ...(effort === undefined ? {} : { effort }),
  why,
});

const TIER_WORDS: Readonly<Record<Tier, string>> = {
  best: 'the strongest tier',
  balanced: 'the balanced tier',
  fast: 'the fast, cheap tier',
};

const tierWhy = (model: CatalogModel, extra: string): string =>
  `${model.entry.label} — ${TIER_WORDS[model.entry.tier]} on ${model.providerLabel}${extra}.`;

const ofTier = (models: readonly CatalogModel[], tier: Tier): readonly CatalogModel[] =>
  models.filter(model => model.entry.tier === tier);

/** The use cases a machine with no guide of its own gets, each filled from the catalogs in effect. */
export function deriveGuide(catalogs: readonly ModelCatalogView[]): readonly GuideUseCase[] {
  const models = distinctByLabel(catalogModels(catalogs));
  const take = (list: readonly CatalogModel[], candidate: (model: CatalogModel) => GuideCandidate) =>
    list.slice(0, DERIVED_CANDIDATES).map(candidate);
  const best = ofTier(models, 'best');
  const otherFamilies = best.filter(model => model.harness === 'codex' || model.provider !== 'anthropic');
  const longest = models
    .filter(model => model.entry.context !== undefined)
    .toSorted((left, right) => (right.entry.context ?? 0) - (left.entry.context ?? 0));
  return [
    {
      id: 'plan-review',
      title: 'Hard planning, review and critical code',
      description:
        'Designing an approach, reviewing a change, and the hardest or most critical code: security, data loss, concurrency, a migration.',
      keywords: [
        'plan',
        'design',
        'architecture',
        'review',
        'audit',
        'critical',
        'security',
        'hard',
        'tricky',
        'root cause',
        'migration',
      ],
      candidates: take(best, model => {
        const effort = highestEffort(model.entry);
        return candidateOf(model, effort, tierWhy(model, effort === undefined ? '' : `, at ${effort} effort`));
      }),
    },
    {
      id: 'everyday',
      title: 'Everyday coding',
      description: 'Ordinary features, fixes, tests and refactors with a clear brief.',
      keywords: ['implement', 'feature', 'fix', 'bug', 'add', 'update', 'refactor', 'test', 'code', 'build'],
      candidates: take([...ofTier(models, 'balanced'), ...best], model =>
        candidateOf(model, undefined, tierWhy(model, '')),
      ),
    },
    {
      id: 'bulk',
      title: 'Mechanical bulk edits',
      description:
        'Renames, formatting, find-and-replace sweeps and boilerplate across many files: one rule applied everywhere.',
      keywords: ['rename', 'bulk', 'mass', 'mechanical', 'format', 'replace', 'sweep', 'chore', 'boilerplate', 'lint'],
      candidates: take(ofTier(models, 'fast'), model => {
        const effort = lowestEffort(model.entry);
        return candidateOf(model, effort, tierWhy(model, effort === undefined ? '' : `, at ${effort} effort`));
      }),
    },
    {
      id: 'second-opinion',
      title: 'Second opinion',
      description: 'Checking a plan, a diff or a conclusion with a different model family from the one that made it.',
      keywords: ['second opinion', 'double-check', 'verify', 'cross-check', 'sanity', 'alternative', 'critique'],
      candidates: take(otherFamilies, model =>
        candidateOf(model, highestEffort(model.entry), tierWhy(model, ', a different family')),
      ),
    },
    {
      id: 'long-context',
      title: 'Long-context reading',
      description: 'Reading a large codebase, long logs or many documents and reporting what matters.',
      keywords: [
        'read',
        'summarize',
        'survey',
        'codebase',
        'large',
        'logs',
        'long',
        'document',
        'explore',
        'investigate',
      ],
      candidates: take(longest, model =>
        candidateOf(
          model,
          lowestEffort(model.entry),
          `${model.entry.label} — reads ${String(Math.round((model.entry.context ?? 0) / 1_000))}k tokens at once, on ${model.providerLabel}.`,
        ),
      ),
    },
  ];
}

/** How many candidates of each use case the rendered routing prompt names. */
export const ROUTING_CANDIDATES = 3;

/** A candidate as the routing prompt names it: its label (or id), its CLI when Codex, and its effort. */
const spoken = (candidate: GuideCandidate, labelOf: (candidate: GuideCandidate) => string | undefined): string => {
  const harness = candidate.harness === 'codex' ? ' (codex)' : '';
  const effort = candidate.effort === undefined ? '' : ` at ${candidate.effort} effort`;
  return `${labelOf(candidate) ?? candidate.model}${harness}${effort}`;
};

/** One line, with nothing that would need quoting in any harness's system prompt argument. */
const oneLine = (text: string): string =>
  text
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes
    .replaceAll(/["\\\u0000-\u001f\u007f]+/gu, ' ')
    .replaceAll(/\s+/gu, ' ')
    .trim();

/** The short line: `Routing: plan-review → claude-opus-5-5 max; …`, cut at a whole use case to fit. */
function shortRouting(useCases: readonly GuideUseCase[]): string {
  const parts = useCases.flatMap(useCase => {
    const top = useCase.candidates[0];
    return top === undefined ? [] : [`${useCase.id} → ${top.model}${top.effort === undefined ? '' : ` ${top.effort}`}`];
  });
  let line = 'Routing:';
  for (const part of parts) {
    const next = `${line}${line === 'Routing:' ? ' ' : '; '}${part}`;
    if (oneLine(`${next}.`).length > MAX_ROUTING_SHORT_CHARS) break;
    line = next;
  }
  return oneLine(line === 'Routing:' ? 'Routing: pick a model per job with recommend.' : `${line}.`);
}

/**
 * The routing prompt a guide with none of its own is given: each use case, what it covers and its first
 * candidates in order, and how to fall back. Rendered from the guide, so it says nothing the guide does not.
 */
export function renderRouting(
  useCases: readonly GuideUseCase[],
  labelOf: (candidate: GuideCandidate) => string | undefined,
  bin: string,
): GuideRouting {
  const lines = [
    "Pick a sub-ferret's model by the kind of work, best first:",
    ...useCases.map(useCase => {
      const named = useCase.candidates.slice(0, ROUTING_CANDIDATES).map(candidate => spoken(candidate, labelOf));
      return `- ${useCase.title} (${useCase.id}): ${named.length === 0 ? 'no model named' : named.join(', then ')}.`;
    }),
    `Prefer a login with quota left: \`${bin} recommend\` ranks by live quota and checks each model answers before starting it. When a candidate is refused, take the next.`,
  ];
  return { prompt: lines.join('\n').slice(0, MAX_ROUTING_PROMPT_CHARS), short: shortRouting(useCases) };
}

/** The label the catalogs give a candidate's model. */
const catalogLabel =
  (catalogs: readonly ModelCatalogView[]) =>
  (candidate: GuideCandidate): string | undefined => {
    const catalog = catalogs.find(entry => entry.id === candidate.provider);
    return [...(catalog?.claude ?? []), ...(catalog?.codex ?? [])].find(entry => entry.id === candidate.model)?.label;
  };

/**
 * The guide in effect: the owner's use cases when the file names any list, else the derived one; the
 * file's routing prompt when it has one, else one rendered from those use cases. `bin` is the shipped
 * command name the rendered prompt points at.
 */
export function effectiveGuide(file: ModelsGuideFile, catalogs: readonly ModelCatalogView[], bin = 'fy'): ModelsGuide {
  const useCases = file.useCases ?? deriveGuide(catalogs);
  const routing =
    file.routing === undefined
      ? { ...renderRouting(useCases, catalogLabel(catalogs), bin), source: 'derived' as const }
      : { ...file.routing, source: 'file' as const };
  return file.useCases === undefined
    ? { source: 'derived', useCases, routing }
    : { source: 'file', useCases, routing, ...(file.suggested === undefined ? {} : { suggested: file.suggested }) };
}

/** The runtimes here that offer `id` from `provider`'s catalog, by name. */
function runtimesOffering(runtimes: readonly FleetRuntimeView[], provider: string, id: string): readonly string[] {
  return runtimes
    .filter(
      runtime =>
        runtime.agent &&
        runtime.models?.catalog.id === provider &&
        runtime.models.choices.some(choice => choice.id === id),
    )
    .map(runtime => runtime.name);
}

/**
 * What a model is, in words, when its owner never described it: its tier, its context window and the
 * catalog's own sentence about it. The owner's description replaces it whole.
 */
export function catalogDescription(entry: ModelCatalogEntryView, providerLabel: string): string {
  const context = entry.context === undefined ? '' : `, reads ${String(Math.round(entry.context / 1_000))}k tokens`;
  const efforts = entry.efforts.length === 0 ? '' : `, efforts ${entry.efforts.join('/')}`;
  const note = entry.note === undefined ? '' : ` ${entry.note}`;
  return `${entry.label}: ${TIER_WORDS[entry.tier]} on ${providerLabel}${context}${efforts}.${note}`;
}

/** The owner's description of a model, when they wrote one. */
export const ownerDescription = (
  described: readonly ModelDescription[],
  provider: string,
  id: string,
): string | undefined => described.find(entry => entry.provider === provider && entry.model === id)?.description;

/** A model's description and whose words it is: the owner's, else the catalog's. */
export function describedAs(
  described: readonly ModelDescription[],
  provider: string,
  entry: ModelCatalogEntryView,
  providerLabel: string,
): { readonly description: string; readonly describedBy: 'owner' | 'catalog' } {
  const owner = ownerDescription(described, provider, entry.id);
  return owner === undefined
    ? { description: catalogDescription(entry, providerLabel), describedBy: 'catalog' }
    : { description: owner, describedBy: 'owner' };
}

/**
 * Every model the fleet knows, for the editor: one row per catalog, CLI and id, with the runtimes here and
 * what the guide builder is told about it — the owner's words in `described`, else the catalog's.
 */
export function fleetModels(
  catalogs: readonly ModelCatalogView[],
  runtimes: readonly FleetRuntimeView[],
  described: readonly ModelDescription[] = [],
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
    ...describedAs(described, provider, entry, providerLabel),
    runtimes: runtimesOffering(runtimes, provider, entry.id).filter(
      name => runtimes.find(runtime => runtime.name === name)?.harness === harness,
    ),
  }));
}
