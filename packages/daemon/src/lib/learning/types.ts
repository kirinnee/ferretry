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
  type ObservationKind,
  type ObservationSource,
  type Proposal,
  type ProposalState,
  type RunManifest,
} from '../../../../protocol/src/lib/learning.ts';

export type { ObservationKind, ObservationSource, Proposal, ProposalState, RunManifest };

/** Verified, append-only evidence retained by the daemon. */
export const ObservationSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
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
  /** The session's turn when a passive suggestion was filed. */
  turn: z.number().int().nonnegative().optional(),
});
export type Observation = z.infer<typeof ObservationSchema>;

/**
 * A proposal as the daemon stores it.
 *
 * Its counters and evidence list are recomputed from whatever evidence still exists, so a stored
 * proposal may legitimately hold fewer than the wire contract's one-or-more — reading it back with
 * `ProposalSchema` would drop, and the next save would then delete, a proposal the daemon wrote
 * itself. Everything else is the protocol's own schema.
 *
 * `source` and `count` were added with passive lessons: a board written before them reads as a scan's
 * proposal seen once per supporting observation, which is what the miner meant by it.
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
    source: ProposalSourceSchema.default('scan'),
    project: z.string().min(1).optional(),
    suggestedCategory: ProposalCategorySchema.optional(),
    count: z.number().int().positive().optional(),
    applied: ProposalAppliedSchema.optional(),
  })
  .transform(value => ({ ...value, count: value.count ?? Math.max(1, value.observationIds.length) }))
  .pipe(z.custom<Proposal>()) satisfies z.ZodType<Proposal>;

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
  sessionIds: z.array(z.string()),
  batches: z.array(z.object({ minerSessionId: z.string().optional(), sessionIds: z.array(z.string()) })),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  done: z.number().int().nonnegative(),
  added: z.number().int().nonnegative(),
  merged: z.number().int().nonnegative(),
  message: z.string().optional(),
});
export type ScanRecord = z.infer<typeof ScanRecordSchema>;

/** Whether one ferret is instructed to learn, as the daemon stores it. */
export const StoredSessionLearningSchema = z.object({
  sessionId: z.string().min(1),
  passive: z.boolean(),
  since: z.string(),
  setBy: z.enum(['default', 'owner']),
});
export type StoredSessionLearning = z.infer<typeof StoredSessionLearningSchema>;

export const LearningStateSchema = z.object({
  watermarkAt: z.string().optional(),
  watermarkId: z.string().optional(),
  lastRunAt: z.string().optional(),
  lastRunId: z.string().optional(),
  lastSpawnAt: z.string().optional(),
  runningRunId: z.string().optional(),
  /** The newest scan; a second one is refused while it runs. */
  scan: ScanRecordSchema.optional(),
});
export type LearningState = z.infer<typeof LearningStateSchema>;
