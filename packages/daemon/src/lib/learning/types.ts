import { z } from 'zod';
import {
  ObservationKindSchema,
  ObservationSourceSchema,
  ProposalCategorySchema,
  ProposalHistoryEntrySchema,
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
});
export type Observation = z.infer<typeof ObservationSchema>;

/**
 * A proposal as the daemon stores it.
 *
 * Its counters and evidence list are recomputed from whatever evidence still exists, so a stored
 * proposal may legitimately hold fewer than the wire contract's one-or-more — reading it back with
 * `ProposalSchema` would drop, and the next save would then delete, a proposal the daemon wrote
 * itself. Everything else is the protocol's own schema.
 */
export const StoredProposalSchema = z.object({
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
}) satisfies z.ZodType<Proposal>;

/** A rejected identity must never be proposed again. */
export const TombstoneSchema = z.object({
  identity: z.string(),
  titleHash: z.string(),
  ruleGist: z.string(),
  rejectedAt: z.string(),
  note: z.string().optional(),
});
export type Tombstone = z.infer<typeof TombstoneSchema>;

export const LearningStateSchema = z.object({
  watermarkAt: z.string().optional(),
  watermarkId: z.string().optional(),
  lastRunAt: z.string().optional(),
  lastRunId: z.string().optional(),
  lastSpawnAt: z.string().optional(),
  runningRunId: z.string().optional(),
});
export type LearningState = z.infer<typeof LearningStateSchema>;
