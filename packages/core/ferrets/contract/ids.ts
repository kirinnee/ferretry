import type { FerretId } from '@ferretry/kernel/contract';
import { type Brand, InstantSchema, KEBAB_NAME } from '@ferretry/std';
import { z } from 'zod';
import {
  FerretProjectIdSchema,
  SessionProvenanceSchema,
  SessionTransferEdgeSchema,
  TranscriptProvenanceSchema,
  TranscriptViewSchema,
} from './records.ts';

/**
 * Ferret identity (§2.2): ids, names, parent/child, packs, the state machine. `FerretId` is the kernel's (it only
 * carries it); Ferrets mints it. Today's session id shape, unchanged.
 */
export type { FerretId };

export const FerretIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u, 'a ferret id is letters, digits, - and _')
  .transform(value => value as FerretId);

/** A ferret's name as the owner reads it (`:name` references it). */
export const FerretNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/u, 'a ferret name is letters, digits, spaces, . - and _');

export type PackId = Brand<string, 'PackId'>;
export const PackIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u)
  .transform(value => value as PackId);

/** A harness key under `harnesses`: `claude-code`, `codex`. */
export const HARNESS_KEYS = ['claude-code', 'codex'] as const;
export const HarnessKeySchema = z.enum(HARNESS_KEYS);
export type HarnessKey = z.infer<typeof HarnessKeySchema>;

/** A runner key under `runners`: `tmux`. */
export const RUNNER_KEYS = ['tmux'] as const;
export const RunnerKeySchema = z.enum(RUNNER_KEYS);
export type RunnerKey = z.infer<typeof RunnerKeySchema>;

/** A login kind key under `logins` (§4.4). */
export const LOGIN_KIND_KEYS = ['anthropic', 'openai', 'api-key', 'proxy', 'endpoint'] as const;
export const LoginKindKeySchema = z.enum(LOGIN_KIND_KEYS);
export type LoginKindKey = z.infer<typeof LoginKindKeySchema>;

/** A configured login's name (`config/logins/<name>.yaml`); Logins owns the files, this is only the name. */
export const LoginNameSchema = z.string().regex(KEBAB_NAME).max(40);
/** A runtime's name (`config/runtimes/<name>.yaml`). */
export const RuntimeNameSchema = z.string().regex(KEBAB_NAME).max(40);

/** The four states (§1 word table): starting, working, idle, stopped. A stopped ferret can resume. */
export const FERRET_STATES = ['starting', 'working', 'idle', 'stopped'] as const;
export const FerretStateSchema = z.enum(FERRET_STATES);
export type FerretState = z.infer<typeof FerretStateSchema>;

/** A lead started it, or its parent did (a helper); the owner's ferrets have no parent. */
export const FerretRoleSchema = z.enum(['lead', 'helper']);
export type FerretRole = z.infer<typeof FerretRoleSchema>;

/** `state/ferrets/<ferret>/ferret.json`: who a ferret is. Turn, usage and transcript facts are other owners'. */
export const FerretRecordSchema = z.strictObject({
  format: z.literal(1),
  id: FerretIdSchema,
  name: FerretNameSchema,
  parent: FerretIdSchema.optional(),
  pack: PackIdSchema.optional(),
  role: FerretRoleSchema,
  /** Whether this ferret works autonomously or is the person's interactive terminal. */
  mode: z.enum(['auto', 'interactive']).optional(),
  harness: HarnessKeySchema,
  runner: RunnerKeySchema,
  runtime: RuntimeNameSchema.optional(),
  login: LoginNameSchema.optional(),
  /** The folder it was started in: the one `WorkFolders` lets it work in. */
  folder: z.string().min(1).max(4_096),
  state: FerretStateSchema,
  /** The harness's own conversation id, for `resume`. */
  harnessConversation: z.string().min(1).max(256).optional(),
  /** The runner's handle while it runs (Terminals: the tmux pane id), for `attach` (spine D15). */
  handle: z.string().min(1).max(256).optional(),
  createdAt: InstantSchema,
  stateAt: InstantSchema,
  /** Who caused it to exist and whether it descends from a warden (today's `SessionConfig.provenance`). */
  provenance: SessionProvenanceSchema.optional(),
  /** Target-only lineage back to the transfer decision that created this fresh ferret (today's `transferredFrom`). */
  transferredFrom: SessionTransferEdgeSchema.optional(),
  /** The board it works on, resolved once at start (today's `projectId`). */
  projectId: FerretProjectIdSchema.optional(),
  /** Where its harness transcript lives: the agent home a resume needs, and the file (today's `transcript`). */
  transcript: TranscriptProvenanceSchema.optional(),
});
export type FerretRecord = z.infer<typeof FerretRecordSchema>;

/**
 * A board card's id (`F21`, `B3`), copied from today's `protocol/src/lib/board-refs.ts` (`BOARD_TASK_ID_PATTERN`).
 * Ferrets is core and cannot import the Board's contract, so the shape is kept here: a start names the EXISTING card
 * the ferret works on, and the summary shows it.
 */
export const FERRET_CARD_ID_PATTERN = /^[BFIC][1-9][0-9]{0,8}$/u;
export const FerretCardIdSchema = z.string().regex(FERRET_CARD_ID_PATTERN);

/**
 * A ferret's task title (today's `start --name <title>`, `new --name <title>`, `rename --title`): free-form, kept
 * verbatim. Bounded as today's `PackNewRequestSchema.name` was (120 characters).
 */
export const FerretTitleSchema = z.string().trim().min(1).max(120);

// ─── quota (today's `protocol/src/lib/session.ts` QuotaSchema, unchanged) ──────────────────────────────────────────

const NonNegativeFiniteSchema = z.number().finite().nonnegative();
const AccountAvailabilitySchema = z.enum(['available', 'unavailable']);
const AccountUnavailableReasonSchema = z.enum(['cooldown', 'spend_limit', 'auth', 'provider', 'no_credentials']);

/**
 * The account headroom a ferret's summary shows (today's `SessionView.quota`). Ferrets keeps no source for it: the
 * login and usage owners do, so a core summary leaves it out until a provider fills it.
 */
export const FerretQuotaSchema = z.object({
  usageBased: z.boolean().optional(),
  availability: AccountAvailabilitySchema.optional(),
  unavailable: z.boolean().optional(),
  unavailableReason: AccountUnavailableReasonSchema.optional(),
  retryAt: NonNegativeFiniteSchema.optional(),
  atLimit: z.boolean().optional(),
  authOk: z.boolean().optional(),
  provider: z.string().optional(),
  fiveHourPercent: z.number().finite().min(0).max(100).optional(),
  weeklyPercent: z.number().finite().min(0).max(100).optional(),
  fiveHourResetAt: NonNegativeFiniteSchema.optional(),
  weeklyResetAt: NonNegativeFiniteSchema.optional(),
  resetAt: NonNegativeFiniteSchema.optional(),
  /** The harness's own words for the limit Ferretry read this session as `rate_limited` on (a pane dialog or a
   *  transcript record) — present exactly while that reading holds. */
  limitNotice: z.string().min(1).optional(),
});
export type FerretQuota = z.infer<typeof FerretQuotaSchema>;

/**
 * A wait a ferret declared with `signal waiting` (today's `SessionState.waiting`, field for field): it is parked on an
 * outside condition or on a peer's reply, not stuck, and the daemon holds it to the deadline. `peer` is always a
 * resolved ferret id, never the reference the ferret gave.
 */
export const FerretWaitingSchema = z.strictObject({
  since: InstantSchema,
  until: InstantSchema.optional(),
  condition: z.string().min(1).optional(),
  peer: FerretIdSchema.optional(),
  peerName: z.string().min(1).optional(),
});
export type FerretWaiting = z.infer<typeof FerretWaitingSchema>;

/**
 * What other subsystems and the app read about a ferret: its record without the format stamp and runner handle, and
 * today's view fields Ferrets keeps beside it — the model and card it was started with and its task title (from its
 * `details.json`), the instant the owner pinned it, and its quota (no core source; see {@link FerretQuotaSchema}).
 * Provenance, transfer lineage, project and transcript show as today's session view showed them: the transcript
 * without its launch-time `baseline`.
 */
export const FerretSummarySchema = FerretRecordSchema.omit({ format: true, handle: true }).extend({
  /** The ownership label given to start, independent of pack membership. */
  label: z.string().min(1).optional(),
  transcript: TranscriptViewSchema.optional(),
  model: z.string().min(1).optional(),
  card: FerretCardIdSchema.optional(),
  title: FerretTitleSchema.optional(),
  pinnedAt: InstantSchema.optional(),
  quota: FerretQuotaSchema.optional(),
  /** Present exactly while the ferret has a declared wait (`signal waiting`); `signal working` clears it. */
  waiting: FerretWaitingSchema.optional(),
  /**
   * When the ferret said `signal done`, present only while it is stopped on that word: a stopped ferret that did not
   * say it (the owner stopped it, a launch failed) has none, and a resumed one is no longer finished.
   */
  finishedAt: InstantSchema.optional(),
});
export type FerretSummary = z.infer<typeof FerretSummarySchema>;
