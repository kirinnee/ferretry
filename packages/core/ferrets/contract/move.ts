import { z } from 'zod';
import { RecordedHarnessSchema } from './records.ts';

const NonNegativeIntegerSchema = z.number().int().nonnegative();
const PositiveIntegerSchema = z.number().int().positive();

/** Error envelope returned by every JSON API failure (today's `ApiErrorResponseSchema`). */
const ApiErrorResponseSchema = z.looseObject({
  error: z.string(),
  code: z.string().optional(),
  method: z.string().optional(),
  path: z.string().optional(),
});

/**
 * The move wire (`POST /v1/ferrets/:ferretId/move`, `…/conversion-preview`, `…/move/ask-to-stop-jobs`): what a move
 * asks for, what a conversion would carry, and why a move was refused. Cut from today's `protocol/src/lib/session.ts`
 * (the move section) so the move's words live with the move.
 */

/**
 * What a Restart or a same-harness move does with the conversation the session is bound to.
 *
 *   * `resume` — the default, and what Restart means: the relaunched CLI continues the SAME harness
 *     conversation (Claude `--resume <id>`, Codex `resume <thread>`), its transcript carried into the
 *     target login's home when the login changes. When that cannot be done the daemon refuses with
 *     `409 conversation_unresumable` and changes nothing — it never quietly starts a new conversation.
 *   * `fresh` — the person chose to start a new conversation: the target's own transcript is captured
 *     as a start would, and the old conversation stays on disk untouched.
 *   * `previous` — the repair for a session a Restart already moved onto a new conversation: rebind to
 *     the newest OTHER transcript in the same harness home that mentions this session's directory, and
 *     resume that one. Refused like `resume` when there is none.
 *   * `convert` — move onto an account of the OTHER harness (Claude ↔ Codex): the conversation is
 *     rewritten in the target's own format under a fresh id the target owns, the target CLI is shown to
 *     accept it before anything is switched, and the session is rebound to it. The original transcript
 *     stays on disk; the session records where the converted one came from ({@link ConversationConversionSchema}).
 *     Refused with `409 conversation_unresumable` when it cannot be converted or the target rejects it.
 *     See `docs/migration-cross-harness.md`.
 */
export const MoveConversationSchema = z.enum(['resume', 'fresh', 'previous', 'convert']);
export type MoveConversation = z.infer<typeof MoveConversationSchema>;

export const MoveSessionRequestSchema = z.strictObject({
  agent: z.string().min(1),
  model: z.string().min(1).optional(),
  allowContextDowngrade: z.boolean().default(false),
  /** Proceed past a refusal the in-flight inventory raised. Only an explicit, human-confirmed Restart anyway sets it. */
  forceInflight: z.boolean().default(false),
  /**
   * What happens to the conversation the session is bound to; omitted means `resume`. See
   * {@link MoveConversationSchema}. Optional rather than defaulted so a client never sends it
   * unasked: a daemon that predates the field refuses an unknown key, and Restart must keep working there.
   */
  conversation: MoveConversationSchema.optional(),
});
export type MoveSessionRequest = z.infer<typeof MoveSessionRequestSchema>;
export type MoveSessionRequestInput = z.input<typeof MoveSessionRequestSchema>;

/** `POST /v1/ferrets/:ferretId/conversion-preview`: what converting onto `agent` would carry. */
export const ConversionPreviewRequestSchema = z.strictObject({
  agent: z.string().min(1),
  model: z.string().min(1).optional(),
});
export type ConversionPreviewRequest = z.infer<typeof ConversionPreviewRequestSchema>;

/** What a conversion dropped rather than carried. */
export const ConversionDroppedSchema = z.strictObject({
  /** Thinking or reasoning blocks — neither provider accepts the other's. */
  reasoning: NonNegativeIntegerSchema,
  /** Records of a subagent's own conversation. */
  sidechains: NonNegativeIntegerSchema,
  /** Harness-internal records: reminders, meta records, developer messages, delivery plumbing. */
  internal: NonNegativeIntegerSchema,
  /** Compactions the source harness had already made; only what followed the newest one is carried. */
  compactions: NonNegativeIntegerSchema,
});
export type ConversionDropped = z.infer<typeof ConversionDroppedSchema>;

/**
 * A conversion's account of itself — what a person confirms before "Move to Codex…" switches anything,
 * and what the session keeps afterwards.
 */
export const ConversionSummarySchema = z.strictObject({
  /** The converter's own version, bumped whenever what it produces changes. */
  converter: PositiveIntegerSchema,
  sourceHarness: RecordedHarnessSchema,
  sourceVersion: z.string().min(1).optional(),
  targetHarness: RecordedHarnessSchema,
  targetVersion: z.string().min(1),
  /** Turns in the source once harness-internal records are dropped: one per thing the person said. */
  turns: NonNegativeIntegerSchema,
  keptTurns: NonNegativeIntegerSchema,
  /** The oldest turns left out to fit the target's window; the target is told how many. */
  omittedTurns: NonNegativeIntegerSchema,
  /** Whether the newest turn itself was too long and was cut. */
  cutNewest: z.boolean(),
  /** Messages carried as messages: the person's and the agent's. */
  messages: NonNegativeIntegerSchema,
  /** Shell commands carried as the target's own shell tool calls, with their output. */
  nativeToolCalls: NonNegativeIntegerSchema,
  /** Other tool calls, carried as text lines inside the agent's turns. */
  toolCallsAsText: NonNegativeIntegerSchema,
  /** Attachments carried as references to files the target can open. */
  attachments: NonNegativeIntegerSchema,
  dropped: ConversionDroppedSchema,
  estimatedTokens: NonNegativeIntegerSchema,
  /** The share of the target's window the history was allowed. */
  budgetTokens: NonNegativeIntegerSchema,
  /** Set when a Codex version the converter was not tested on was let through because its format is the validated one. */
  formatNote: z.string().min(1).optional(),
});
export type ConversionSummary = z.infer<typeof ConversionSummarySchema>;

/**
 * The preview's answer: what the conversion would carry, or why it cannot be made. A refusal is an
 * answer rather than an error status, because the sheet shows it in place of the confirm button.
 */
export const ConversionPreviewSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('ready'),
    targetAgent: z.string().min(1),
    targetModel: z.string().min(1),
    summary: ConversionSummarySchema,
  }),
  z.strictObject({ kind: z.literal('refused'), targetAgent: z.string().min(1), reason: z.string().min(1) }),
]);
export type ConversionPreview = z.infer<typeof ConversionPreviewSchema>;

/**
 * One thing the in-flight inventory saw while a Restart was being checked, in words a person reads.
 *
 * `title` is a plain sentence ("A program Ferretry doesn't recognise is running"), `detail` the command
 * or tool input behind it, trimmed to one line. `blocks` is whether THIS item is what made the daemon
 * refuse; the rest are listed so the confirmation shows the whole picture rather than one culprit.
 */
export const InflightItemSchema = z.strictObject({
  kind: z.enum(['process', 'tool', 'terminal', 'unreadable']),
  verdict: z.enum(['safe_to_kill', 're_armable', 'destructive_to_interrupt', 'unknown']),
  title: z.string().min(1),
  detail: z.string().optional(),
  age: z.string().optional(),
  blocks: z.boolean(),
  /**
   * Set on a process the agent started from its own tool shell and left running — a background job of
   * the agent's, which the agent can be asked to stop (`askToStopJobs`). Absent on everything else,
   * and on every item from a daemon that predates it.
   */
  backgroundJob: z.literal(true).optional(),
  /** The process id, carried on a background job so the agent can be told which one. */
  pid: PositiveIntegerSchema.optional(),
});
export type InflightItem = z.infer<typeof InflightItemSchema>;

/** The ask names nothing: the daemon looks again and asks about what it finds. */
export const AskToStopJobsRequestSchema = z.strictObject({});
export type AskToStopJobsRequest = z.infer<typeof AskToStopJobsRequestSchema>;

/** One of the agent's background jobs a refused move asked it to stop. */
export const AgentJobSchema = z.strictObject({
  pid: PositiveIntegerSchema,
  /** The command line, trimmed to one line. */
  command: z.string().min(1),
  age: z.string().optional(),
});
export type AgentJob = z.infer<typeof AgentJobSchema>;

/**
 * `POST /v1/ferrets/:ferretId/move/ask-to-stop-jobs`: the daemon looked again, found the agent's
 * own background jobs that block a move, and queued ONE message asking the agent to stop them
 * (or say why not). It stops nothing itself. `alreadyAsked` means the same jobs were asked about before
 * and that message is the one answered with, so a second press never asks twice.
 */
export const AskToStopJobsResultSchema = z.strictObject({
  messageId: z.string().min(1),
  jobs: z.array(AgentJobSchema).min(1),
  alreadyAsked: z.boolean(),
});
export type AskToStopJobsResult = z.infer<typeof AskToStopJobsResultSchema>;

/**
 * Why a Restart (a move) was refused, as data. `restartsWithCli` counts the processes the
 * inventory recognised as the agent's own — the Ferretry tools server, the harness's helpers, servers
 * from its configuration — which a restart relaunches and which therefore never block it.
 */
export const MoveRefusalSchema = z.strictObject({
  status: z.string().min(1),
  turn: NonNegativeIntegerSchema,
  blockedBy: z.enum(['unknown', 'destructive', 'unreadable']),
  items: z.array(InflightItemSchema),
  restartsWithCli: NonNegativeIntegerSchema,
});
export type MoveRefusal = z.infer<typeof MoveRefusalSchema>;

/** The `409 move_refused` body. `inflight` is absent from a daemon that predates it. */
export const MoveRefusedBodySchema = ApiErrorResponseSchema.extend({
  code: z.literal('move_refused'),
  inflight: MoveRefusalSchema.optional(),
});
export type MoveRefusedBody = z.infer<typeof MoveRefusedBodySchema>;

/** A smaller window the target would give the conversation, as the numbers rather than a sentence. */
export const ContextDowngradeSchema = z.strictObject({
  model: z.string().min(1),
  targetWindow: PositiveIntegerSchema,
  currentWindow: PositiveIntegerSchema,
});
export type ContextDowngrade = z.infer<typeof ContextDowngradeSchema>;

/** The `409 context_downgrade_refused` body. `downgrade` is absent from a daemon that predates it. */
export const ContextDowngradeRefusedBodySchema = ApiErrorResponseSchema.extend({
  code: z.literal('context_downgrade_refused'),
  downgrade: ContextDowngradeSchema.optional(),
});
export type ContextDowngradeRefusedBody = z.infer<typeof ContextDowngradeRefusedBodySchema>;

/**
 * The `409 conversation_unresumable` body: the session's conversation could not be carried into the
 * relaunch, so nothing was restarted. `error` says why in plain words; the only ways past are a
 * request with `conversation: 'fresh'`, which the person must choose, or `'previous'`.
 */
export const ConversationUnresumableBodySchema = ApiErrorResponseSchema.extend({
  code: z.literal('conversation_unresumable'),
});
export type ConversationUnresumableBody = z.infer<typeof ConversationUnresumableBodySchema>;
