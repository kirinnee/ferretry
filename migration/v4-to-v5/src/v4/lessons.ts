/**
 * v4's learning files (`state/learning/`, `config/learning.yaml`, the Global lessons document), as this tool reads
 * them. A LOCAL copy of v4.291.5's shapes on purpose: v5 has no v4 reader. Sources, at origin/main (v4.291.5):
 *
 * - `packages/daemon/src/lib/learning/types.ts` (`ObservationSchema`, `StoredProposalSchema`, `TombstoneSchema`,
 *   `ScanRecordSchema`, `StoredSessionLearningSchema`, `LearningStateSchema`)
 * - `packages/protocol/src/lib/learning.ts` (the enums, `ProposalTargetSchema`, `ProposalHistoryEntrySchema`,
 *   `ProposalAppliedSchema`, `RunManifestSchema`)
 * - `packages/daemon/src/adapters/learning/file-store.ts` (`createLearningPaths`, the run-id rule, lenient reads)
 * - `packages/daemon/src/lib/learning/extract.ts` (`SessionDigest`, read back unvalidated by `miner.ts:257-262`)
 * - `packages/daemon/src/lib/learning/suggest.ts` (`GLOBAL_LESSONS_COMPONENT`, `GLOBAL_LESSONS_FILE`)
 */
import { z } from 'zod';

export const V4_LEARNING_DIR = 'state/learning';
export const V4_LEARNING_STATE = `${V4_LEARNING_DIR}/state.json`;
export const V4_LEARNING_OBSERVATIONS = `${V4_LEARNING_DIR}/observations.jsonl`;
export const V4_LEARNING_PROPOSALS = `${V4_LEARNING_DIR}/proposals.json`;
export const V4_LEARNING_TOMBSTONES = `${V4_LEARNING_DIR}/tombstones.json`;
export const V4_LEARNING_SESSIONS = `${V4_LEARNING_DIR}/sessions.json`;
export const V4_LEARNING_RUNS = `${V4_LEARNING_DIR}/runs`;
export const V4_LEARNING_PATCHES = `${V4_LEARNING_DIR}/patches`;
export const V4_LEARNING_CONFIG = 'config/learning.yaml';
/** `config/components/instructions/<GLOBAL_LESSONS_COMPONENT>.yaml`: points at the Global lessons document. */
export const V4_LESSONS_COMPONENT = 'config/components/instructions/lessons.yaml';
/** `GLOBAL_LESSONS_FILE`, relative to `fleet/assets/`: the document when no component names another. */
export const V4_GLOBAL_LESSONS_FILE = 'instructions/lessons.md';

/** `runPath`'s rule: a run id is a path-safe segment, or v4 refused to read it. */
export const V4_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

const Instant = z.iso.datetime({ offset: true });
const NonNegative = z.number().int().nonnegative();
const Positive = z.number().int().positive();

const Kind = z.enum(['correction', 'roadblock', 'preference', 'recurring_task', 'tooling_failure', 'suggestion']);
const Source = z.enum(['human', 'teammate']);
const Category = z.enum(['global', 'repo']);

export const V4Observation = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  teammate: z.string().optional(),
  mode: z.enum(['interactive', 'auto']),
  cwd: z.string(),
  repo: z.string(),
  at: z.string(),
  kind: Kind,
  gist: z.string(),
  quote: z.string(),
  source: Source,
  verified: z.literal(true),
  runId: z.string().min(1),
  turn: z.number().int().nonnegative().optional(),
});
export type V4Observation = z.infer<typeof V4Observation>;

export const V4ProposalTarget = z.object({
  kind: z.enum(['global-agent-guidance', 'automation-guidance', 'global-instructions', 'repo-instructions']),
  path: z.string().min(1),
  anchor: z.string().optional(),
});

const HistoryEntry = z.object({
  at: Instant,
  event: z.string().min(1),
  by: z.enum(['miner', 'user', 'ferret']),
  note: z.string().optional(),
});

/** v4's stored proposal, with its read-time defaults (`source` → `scan`, `count` → evidence count, at least 1). */
export const V4StoredProposal = z
  .object({
    id: z.string().min(1),
    category: Category,
    state: z.enum(['pending', 'accepted', 'applied', 'rejected']),
    title: z.string(),
    ruleText: z.string(),
    target: V4ProposalTarget,
    observationIds: z.array(z.string()),
    occurrences: NonNegative,
    crossRepoCount: NonNegative,
    firstSeen: z.string(),
    lastSeen: z.string(),
    identity: z.string(),
    history: z.array(HistoryEntry),
    source: z.enum(['passive', 'scan']).default('scan'),
    project: z.string().min(1).optional(),
    suggestedCategory: Category.optional(),
    count: Positive.optional(),
    applied: z.object({ at: Instant, path: z.string().min(1) }).optional(),
  })
  .transform(value => ({ ...value, count: value.count ?? Math.max(1, value.observationIds.length) }));
export type V4StoredProposal = z.output<typeof V4StoredProposal>;

export const V4Tombstone = z.object({
  identity: z.string(),
  titleHash: z.string(),
  ruleGist: z.string(),
  rejectedAt: z.string(),
  note: z.string().optional(),
});

export const V4ScanRecord = z.object({
  runId: z.string().min(1),
  state: z.enum(['running', 'finished', 'cancelled', 'failed']),
  sessionIds: z.array(z.string()),
  batches: z.array(z.object({ minerSessionId: z.string().optional(), sessionIds: z.array(z.string()) })),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  done: NonNegative,
  added: NonNegative,
  merged: NonNegative,
  message: z.string().optional(),
});

export const V4LearningState = z.object({
  watermarkAt: z.string().optional(),
  watermarkId: z.string().optional(),
  lastRunAt: z.string().optional(),
  lastRunId: z.string().optional(),
  lastSpawnAt: z.string().optional(),
  runningRunId: z.string().optional(),
  scan: V4ScanRecord.optional(),
});
export type V4LearningState = z.infer<typeof V4LearningState>;

export const V4SessionLearning = z.object({
  sessionId: z.string().min(1),
  passive: z.boolean(),
  since: z.string(),
  setBy: z.enum(['default', 'owner']),
});

const Harness = z.enum(['claude', 'codex']);
export const V4RunManifest = z.object({
  runId: z.string().min(1),
  startedAt: Instant,
  finishedAt: Instant.optional(),
  sessionsScanned: NonNegative,
  sessionsWithSignal: NonNegative,
  minerSessions: z.array(z.string()),
  observationsProposed: NonNegative,
  observationsVerified: NonNegative,
  rejectedQuotes: NonNegative,
  malformedFiles: NonNegative,
  proposalsCreated: NonNegative,
  proposalsStrengthened: NonNegative,
  proposalsSuppressedByTombstone: NonNegative,
  perHarness: z.record(Harness, NonNegative),
  message: z.string().optional(),
});
export type V4RunManifest = z.infer<typeof V4RunManifest>;

/**
 * v4's `SessionDigest`. v4 read `digests.json` back with a bare cast (never validated), so this is only the shape the
 * v4 writer produced; a digest that does not have it is one v4's miner could not have used either.
 */
export const V4SessionDigest = z.object({
  sessionId: z.string().min(1),
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
  humanMessages: NonNegative,
  teammateSteers: NonNegative,
  interrupts: NonNegative,
  toolFailures: NonNegative,
});

/** `learning.yaml`'s keys (`LearningFileSchema = LearningConfigSchema.strict().partial()`). */
export const V4_LEARNING_KEYS = [
  'enabled',
  'agent',
  'model',
  'intervalMinutes',
  'batchSize',
  'maxMinersPerRun',
  'maxSessionsPerRun',
  'minSpawnGapMinutes',
  'passiveDefault',
] as const;
