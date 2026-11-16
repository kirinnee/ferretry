import { defineState } from '@ferretry/kernel/contract';
import { z } from 'zod';
import {
  ObservationKindSchema,
  ObservationSourceSchema,
  ProposalAppliedSchema,
  ProposalCategorySchema,
  ProposalHistoryEntrySchema,
  ProposalSourceSchema,
  ProposalStateSchema,
  ProposalTargetSchema,
  type Proposal,
  RunManifestSchema,
} from './wire.ts';

/** Verified, append-only evidence retained by the daemon. */
export const ObservationSchema = z.object({
  id: z.string().min(1),
  ferretId: z.string().min(1),
  teammate: z.string().optional(),
  mode: z.enum(['interactive', 'auto']),
  cwd: z.string(),
  repo: z.string(),
  at: z.string(),
  kind: ObservationKindSchema,
  gist: z.string(),
  quote: z.string(),
  source: ObservationSourceSchema,
  verified: z.literal(true),
  runId: z.string().min(1),
  /** The ferret's turn when a passive suggestion was filed. */
  turn: z.number().int().nonnegative().optional(),
});
export type Observation = z.infer<typeof ObservationSchema>;

/**
 * A proposal as the daemon stores it.
 *
 * Its counters and evidence list are recomputed from whatever evidence still exists, so a stored proposal may
 * legitimately hold fewer than the wire contract's one-or-more: reading it back with `ProposalSchema` would drop, and
 * the next save would then delete, a proposal the daemon wrote itself. Everything else is the wire schema.
 */
export const StoredProposalSchema = z
  .object({
    id: z.string().min(1),
    category: ProposalCategorySchema,
    state: ProposalStateSchema,
    title: z.string(),
    ruleText: z.string(),
    target: ProposalTargetSchema,
    observationIds: z.array(z.string()),
    occurrences: z.number().int().nonnegative(),
    crossRepoCount: z.number().int().nonnegative(),
    firstSeen: z.string(),
    lastSeen: z.string(),
    identity: z.string(),
    history: z.array(ProposalHistoryEntrySchema),
    source: ProposalSourceSchema,
    project: z.string().min(1).optional(),
    suggestedCategory: ProposalCategorySchema.optional(),
    count: z.number().int().positive(),
    applied: ProposalAppliedSchema.optional(),
  })
  .pipe(z.custom<Proposal>());

/** A rejected identity must never be proposed again. */
export const TombstoneSchema = z.object({
  identity: z.string(),
  titleHash: z.string(),
  ruleGist: z.string(),
  rejectedAt: z.string(),
  note: z.string().optional(),
});
export type Tombstone = z.infer<typeof TombstoneSchema>;

/** One scan as the daemon remembers it, beside the run manifest the miner writes. */
export const ScanRecordSchema = z.object({
  runId: z.string().min(1),
  state: z.enum(['running', 'finished', 'cancelled', 'failed']),
  ferretIds: z.array(z.string()),
  batches: z.array(z.object({ minerFerretId: z.string().optional(), ferretIds: z.array(z.string()) })),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  done: z.number().int().nonnegative(),
  added: z.number().int().nonnegative(),
  merged: z.number().int().nonnegative(),
  message: z.string().optional(),
});
export type ScanRecord = z.infer<typeof ScanRecordSchema>;

/** Whether one ferret is instructed to learn, as the daemon stores it. */
export const StoredFerretLessonsSchema = z.object({
  ferretId: z.string().min(1),
  passive: z.boolean(),
  since: z.string(),
  setBy: z.enum(['default', 'owner']),
});
export type StoredFerretLessons = z.infer<typeof StoredFerretLessonsSchema>;

export const LessonsStateSchema = z.object({
  watermarkAt: z.string().optional(),
  watermarkId: z.string().optional(),
  lastRunAt: z.string().optional(),
  lastRunId: z.string().optional(),
  lastSpawnAt: z.string().optional(),
  runningRunId: z.string().optional(),
  /** The newest scan; a second one is refused while it runs. */
  scan: ScanRecordSchema.optional(),
});
export type LessonsState = z.infer<typeof LessonsStateSchema>;

/** One session digest as a miner reads it (kept beside its run so the miner's quotes can be verified later). */
export const DigestSchema = z.object({
  ferretId: z.string().min(1),
  teammate: z.string().optional(),
  mode: z.enum(['interactive', 'auto']),
  cwd: z.string(),
  repo: z.string(),
  harness: z.string(),
  at: z.string(),
  hasSignal: z.boolean(),
  signalReasons: z.array(z.string()),
  corpus: z.string(),
  digest: z.string(),
  humanMessages: z.number().int().nonnegative(),
  teammateSteers: z.number().int().nonnegative(),
  interrupts: z.number().int().nonnegative(),
  toolFailures: z.number().int().nonnegative(),
});

// ─── the files (§9.2): state/lessons/ ───────────────────────────────────────────────────────────────────────────────

/** `state.json`: the mining watermark, the newest scan, and which ferrets are instructed to learn. */
export const LessonsStateFileSchema = LessonsStateSchema.extend({
  ferrets: z.array(StoredFerretLessonsSchema),
});
export type LessonsStateFile = z.infer<typeof LessonsStateFileSchema>;
export const STATE_FILE = defineState({
  name: 'state',
  path: 'state.json',
  store: 'json',
  format: 1,
  schema: LessonsStateFileSchema,
});

/** `observations.jsonl`: verified evidence, one line each, never rewritten. */
export const OBSERVATIONS_FILE = defineState({
  name: 'observations',
  path: 'observations.jsonl',
  store: 'jsonl',
  format: 1,
  schema: ObservationSchema,
});

/** `suggested.json`: the lessons waiting for, or past, the owner's verdict. */
export const SuggestedFileSchema = z.object({ proposals: z.array(StoredProposalSchema) });
export const SUGGESTED_FILE = defineState({
  name: 'suggested',
  path: 'suggested.json',
  store: 'json',
  format: 1,
  schema: SuggestedFileSchema,
});

/** `dismissed.json`: a rejected rule's headstone, so it is never suggested again. */
export const DismissedFileSchema = z.object({ tombstones: z.array(TombstoneSchema) });
export const DISMISSED_FILE = defineState({
  name: 'dismissed',
  path: 'dismissed.json',
  store: 'json',
  format: 1,
  schema: DismissedFileSchema,
});

/** `runs/<run>.json`: one mining run's manifest. */
export const RUN_FILE = defineState({
  name: 'runs',
  path: 'runs/*.json',
  store: 'json',
  format: 1,
  schema: RunManifestSchema,
});

/** `runs/<run>.digests.json` is a sibling collection: the digests that run's miner was handed. */
export const DigestsFileSchema = z.object({ digests: z.array(DigestSchema) });
export const DIGESTS_FILE = defineState({
  name: 'digests',
  path: 'digests/*.json',
  store: 'json',
  format: 1,
  schema: DigestsFileSchema,
});

/** `patches/<id>.json`: the rule an Accept rendered as a document, what the owner agreed to and when. */
export const PatchFileSchema = z.object({ contents: z.string() });
export const PATCH_FILE = defineState({
  name: 'patches',
  path: 'patches/*.json',
  store: 'json',
  format: 1,
  schema: PatchFileSchema,
});

/**
 * `global.json`: the Global lessons document, Apply's target for a Global lesson. Read by every launch (`launch.parts`).
 * Applying writes it only after the route asked `fleet.configure`.
 */
export const GlobalDocumentSchema = z.object({ text: z.string() });
export const GLOBAL_FILE = defineState({
  name: 'global',
  path: 'global.json',
  store: 'json',
  format: 1,
  schema: GlobalDocumentSchema,
});

export const LESSONS_STATE = [
  STATE_FILE,
  OBSERVATIONS_FILE,
  SUGGESTED_FILE,
  DISMISSED_FILE,
  RUN_FILE,
  DIGESTS_FILE,
  PATCH_FILE,
  GLOBAL_FILE,
] as const;
