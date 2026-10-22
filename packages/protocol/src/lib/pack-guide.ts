/**
 * THE MODELS-GUIDE GENERATOR (docs/pack-mode.md § Suggesting a guide): a short-lived, hidden ferret is shown
 * every model the fleet knows — with the owner's description of each, which runtimes here run it, whether
 * each is ready and how much quota each login has left — plus the owner's routing preferences and current
 * guide, and drafts a whole guide: a routing prompt and the use cases. A person reviews it as a diff and
 * accepts it whole, in part, or not at all; nothing is ever applied unasked. Pack mode then routes with
 * whatever is saved, generated or hand-written.
 *
 * - `GET /v1/pack/inventory` — what the builder is shown ({@link PackInventory}).
 * - `POST /v1/pack/guide/suggest` — start the builder ferret; only when a person asks.
 * - `GET /v1/pack/guide/jobs/:jobId` — the run, and its checked draft once it is written.
 * - `POST /v1/pack/guide/accept` — write the reviewed guide, keeping the one it replaces.
 * - `POST /v1/pack/guide/undo` — put the replaced guide back.
 * - `POST /v1/pack/guide/describe` — set or clear the owner's description of one model.
 *
 * The diff and the per-use-case merge are here, pure, so `fy guide suggest` and the app review a draft with
 * the same decisions.
 *
 * Data only: model ids, runtime and login NAMES, readiness and quota — never a credential or a value.
 */
import { z } from 'zod';
import { InstantSchema } from './common.ts';
import {
  type GuideCandidate,
  type GuideRouting,
  GuideRoutingSchema,
  GuideSuggestedSchema,
  type GuideUseCase,
  GuideUseCaseSchema,
  MAX_GUIDE_TEXT_CHARS,
  MAX_GUIDE_USE_CASES,
  ModelsGuideSchema,
  PackFleetModelSchema,
  PackGuideJobSchema,
  PackQuotaSchema,
  PackRefusalSchema,
  RoutingPreferencesSchema,
} from './pack.ts';
import { HarnessSchema } from './session.ts';

const NonEmpty = z.string().min(1);

export const PACK_INVENTORY_PATH = '/v1/pack/inventory';
export const PACK_GUIDE_SUGGEST_PATH = '/v1/pack/guide/suggest';
export const PACK_GUIDE_JOBS_PATH = '/v1/pack/guide/jobs';
export const PACK_GUIDE_ACCEPT_PATH = '/v1/pack/guide/accept';
export const PACK_GUIDE_UNDO_PATH = '/v1/pack/guide/undo';
export const PACK_GUIDE_DESCRIBE_PATH = '/v1/pack/guide/describe';

/** The path of one builder run. */
export const packGuideJobPath = (jobId: string): string => `${PACK_GUIDE_JOBS_PATH}/${encodeURIComponent(jobId)}`;

/** The label a builder ferret's session carries, so every surface can hide it from the normal list. */
export const PACK_GUIDE_BUILDER_LABEL = 'ferretry-guide-builder';

// ── The inventory ───────────────────────────────────────────────────────────────────────────────

/** One runtime on this machine: its CLI, the catalog its login reads, whether it can start now, its quota. */
export const PackInventoryRuntimeSchema = z.strictObject({
  name: NonEmpty,
  harness: HarnessSchema,
  /** The model catalog its login reads, when it reads one. */
  provider: NonEmpty.optional(),
  /** Its login's id — a name, never a credential. */
  login: NonEmpty,
  ready: z.boolean(),
  /** Why it cannot start a ferret now, exactly as `fy recommend` would refuse it. */
  refusal: PackRefusalSchema.optional(),
  quota: PackQuotaSchema,
});
export type PackInventoryRuntime = z.infer<typeof PackInventoryRuntimeSchema>;

/** List price, USD per million tokens, when the catalog states one. */
export const PackInventoryPriceSchema = z.strictObject({
  input: z.number().finite().min(0),
  output: z.number().finite().min(0),
});
export type PackInventoryPrice = z.infer<typeof PackInventoryPriceSchema>;

/** A model's headroom across every runtime here that runs it. */
export const PackModelHeadroomSchema = z.strictObject({
  runtimes: z.number().int().min(0),
  ready: z.number().int().min(0),
  /** The ready runtime with the most quota left. */
  best: z.strictObject({ runtime: NonEmpty, quota: PackQuotaSchema }).optional(),
  /** "3 runtimes, 2 ready; best claude-work: 5h 2% · wk 46% used". */
  summary: NonEmpty,
});
export type PackModelHeadroom = z.infer<typeof PackModelHeadroomSchema>;

export const PackInventoryModelSchema = PackFleetModelSchema.omit({
  runtimes: true,
  description: true,
  describedBy: true,
}).extend({
  description: NonEmpty,
  describedBy: z.enum(['owner', 'catalog']),
  /** The day the provider retires it, when the catalog says. */
  retires: NonEmpty.optional(),
  price: PackInventoryPriceSchema.optional(),
  /** Every runtime here that runs it, ready or not. */
  runtimes: z.array(z.strictObject({ name: NonEmpty, ready: z.boolean(), reason: NonEmpty.optional() })).readonly(),
  headroom: PackModelHeadroomSchema,
});
export type PackInventoryModel = z.infer<typeof PackInventoryModelSchema>;

/** `GET /v1/pack/inventory`: everything a guide may name, and the state of everything that could run it. */
export const PackInventorySchema = z.strictObject({
  at: InstantSchema,
  models: z.array(PackInventoryModelSchema).readonly(),
  runtimes: z.array(PackInventoryRuntimeSchema).readonly(),
  guide: ModelsGuideSchema,
  preferences: RoutingPreferencesSchema.optional(),
});
export type PackInventory = z.infer<typeof PackInventorySchema>;

// ── Suggest ─────────────────────────────────────────────────────────────────────────────────────

export const PackGuideSuggestRequestSchema = z.strictObject({
  /** The runtime the builder ferret runs on; absent: the ready one with the most headroom. */
  runtime: NonEmpty.max(128).optional(),
  /** The model it runs on; absent: the runtime's own default. */
  model: NonEmpty.max(128).optional(),
  /** This run's preferences; absent means `pack.yaml`'s `routingPreferences`. */
  preferences: RoutingPreferencesSchema.optional(),
});
export type PackGuideSuggestRequest = z.infer<typeof PackGuideSuggestRequestSchema>;

export const PackGuideSuggestStartSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('started'), job: PackGuideJobSchema }),
  /** Nothing was started: no runtime is ready, or the one named cannot run now. */
  z.strictObject({ outcome: z.literal('refused'), message: NonEmpty }),
]);
export type PackGuideSuggestStart = z.infer<typeof PackGuideSuggestStartSchema>;

/**
 * What the builder ferret writes, read leniently so a draft that is nearly right can be checked use case
 * by use case, candidate by candidate, rather than refused whole.
 */
export const PackGuideDraftSchema = z.looseObject({
  routing: z.unknown().optional(),
  useCases: z.array(z.unknown()),
});
export type PackGuideDraft = z.infer<typeof PackGuideDraftSchema>;

/** Something the check took out of, or changed in, the draft, and why. */
export const PackGuideNoteSchema = z.strictObject({
  useCase: NonEmpty.optional(),
  provider: NonEmpty.optional(),
  model: NonEmpty.optional(),
  message: NonEmpty,
});
export type PackGuideNote = z.infer<typeof PackGuideNoteSchema>;

/** A checked draft, ready to review against the guide in effect. */
export const PackGuideSuggestionSchema = z.strictObject({
  /** Who drafted it and when; the accept adds when it was accepted. */
  suggested: GuideSuggestedSchema.omit({ acceptedAt: true, partial: true }),
  routing: GuideRoutingSchema,
  useCases: z.array(GuideUseCaseSchema).readonly(),
  /** What the check took out: a model nothing lists, a use case of an unknown shape. */
  dropped: z.array(PackGuideNoteSchema).readonly(),
  /** What it changed and kept: a corrected provider, an effort the model does not take. */
  flagged: z.array(PackGuideNoteSchema).readonly(),
  /** The guide it would replace, as it was when the draft was checked. */
  current: ModelsGuideSchema,
});
export type PackGuideSuggestion = z.infer<typeof PackGuideSuggestionSchema>;

/** `GET /v1/pack/guide/jobs/:jobId`: the run, and its suggestion once it has one. */
export const PackGuideJobResultSchema = z.strictObject({
  job: PackGuideJobSchema,
  suggestion: PackGuideSuggestionSchema.optional(),
});
export type PackGuideJobResult = z.infer<typeof PackGuideJobResultSchema>;

// ── Accept, undo, describe ──────────────────────────────────────────────────────────────────────

export const PackGuideAcceptRequestSchema = z.strictObject({
  useCases: z.array(GuideUseCaseSchema).max(MAX_GUIDE_USE_CASES),
  /** Absent: the routing prompt in the file is left as it is. */
  routing: GuideRoutingSchema.optional(),
  suggested: GuideSuggestedSchema.omit({ acceptedAt: true, partial: true }),
  partial: z.boolean().optional(),
});
export type PackGuideAcceptRequest = z.infer<typeof PackGuideAcceptRequestSchema>;

export const PackGuideDescribeRequestSchema = z.strictObject({
  /** Absent: the one catalog that lists `model`, or the catalog whose label for it matches. */
  provider: NonEmpty.max(64).optional(),
  model: NonEmpty.max(128),
  /** `null` clears it, so the catalog's description is used again. */
  description: z.string().trim().min(1).max(MAX_GUIDE_TEXT_CHARS).nullable(),
});
export type PackGuideDescribeRequest = z.infer<typeof PackGuideDescribeRequestSchema>;

export const PackGuideWriteResultSchema = z.strictObject({
  /** `nothing`: there was nothing to do (an undo with no replaced guide kept). */
  outcome: z.enum(['applied', 'nothing']),
  message: NonEmpty,
});
export type PackGuideWriteResult = z.infer<typeof PackGuideWriteResultSchema>;

// ── Diff and merge ──────────────────────────────────────────────────────────────────────────────

export type GuideChange = 'added' | 'removed' | 'changed' | 'same';

/** One use case, before and after, and what changed in words. */
export interface GuideUseCaseDiff {
  readonly id: string;
  readonly status: GuideChange;
  readonly before?: GuideUseCase;
  readonly after?: GuideUseCase;
  readonly changes: readonly string[];
}

const candidateLine = (candidate: GuideCandidate): string =>
  `${candidate.model}${candidate.harness === 'codex' ? ' (codex)' : ''}${candidate.effort === undefined ? '' : ` @${candidate.effort}`}`;

const sameList = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

/** What changed between two versions of one use case, in words; empty when nothing did. */
function useCaseChanges(before: GuideUseCase, after: GuideUseCase): readonly string[] {
  const changes: string[] = [];
  if (before.title !== after.title) changes.push(`title: "${before.title}" → "${after.title}"`);
  if (before.description !== after.description) changes.push('description reworded');
  const keywordsBefore = before.keywords ?? [];
  const keywordsAfter = after.keywords ?? [];
  if (!sameList(keywordsBefore, keywordsAfter)) {
    const added = keywordsAfter.filter(word => !keywordsBefore.includes(word)).map(word => `+${word}`);
    const removed = keywordsBefore.filter(word => !keywordsAfter.includes(word)).map(word => `-${word}`);
    changes.push(`keywords: ${[...added, ...removed].join(' ') || 'reordered'}`);
  }
  const linesBefore = before.candidates.map(candidateLine);
  const linesAfter = after.candidates.map(candidateLine);
  if (!sameList(linesBefore, linesAfter)) changes.push(`candidates: ${linesAfter.join(', ') || 'none'}`);
  else if (
    !sameList(
      before.candidates.map(candidate => candidate.why),
      after.candidates.map(candidate => candidate.why),
    )
  )
    changes.push('reasons reworded');
  return changes;
}

/**
 * A draft against the guide in effect, one row per use case id: the draft's in its order, then the ones
 * it leaves out (`removed`).
 */
export function diffGuide(
  before: readonly GuideUseCase[],
  after: readonly GuideUseCase[],
): readonly GuideUseCaseDiff[] {
  const old = new Map(before.map(useCase => [useCase.id, useCase]));
  const kept = new Set(after.map(useCase => useCase.id));
  const rows: GuideUseCaseDiff[] = after.map(useCase => {
    const previous = old.get(useCase.id);
    if (previous === undefined) return { id: useCase.id, status: 'added', after: useCase, changes: [] };
    const changes = useCaseChanges(previous, useCase);
    return {
      id: useCase.id,
      status: changes.length === 0 ? 'same' : 'changed',
      before: previous,
      after: useCase,
      changes,
    };
  });
  for (const useCase of before)
    if (!kept.has(useCase.id)) rows.push({ id: useCase.id, status: 'removed', before: useCase, changes: [] });
  return rows;
}

/** Whether two routing prompts differ (either half). */
export const routingChanged = (before: GuideRouting | undefined, after: GuideRouting): boolean =>
  before === undefined || before.prompt !== after.prompt || before.short !== after.short;

/** The ids of the rows that change something: what "Accept all" accepts. */
export const changingIds = (diff: readonly GuideUseCaseDiff[]): readonly string[] =>
  diff.filter(row => row.status !== 'same').map(row => row.id);

/**
 * The guide with only the accepted use cases (by id) taken from the draft. Accepting every row that changes
 * is the draft itself, in its order; otherwise the current guide keeps its order, an accepted change
 * replaces its use case in place, an accepted removal removes it, and an accepted addition is appended in
 * the draft's order.
 */
export function mergeGuide(
  before: readonly GuideUseCase[],
  after: readonly GuideUseCase[],
  accepted: ReadonlySet<string>,
): readonly GuideUseCase[] {
  const diff = diffGuide(before, after);
  if (changingIds(diff).every(id => accepted.has(id))) return after;
  const take = new Map(diff.filter(row => accepted.has(row.id)).map(row => [row.id, row]));
  const merged = before.flatMap(useCase => {
    const row = take.get(useCase.id);
    if (row === undefined) return [useCase];
    return row.after === undefined ? [] : [row.after];
  });
  const additions = diff.flatMap(row =>
    row.status === 'added' && accepted.has(row.id) && row.after ? [row.after] : [],
  );
  return [...merged, ...additions];
}
