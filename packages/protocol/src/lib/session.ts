import { z } from 'zod';
import {
  ApiErrorResponseSchema,
  InstantSchema,
  NonNegativeFiniteSchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
} from './common.ts';
import { ProviderQuotaBalanceSchema } from './fleet-credentials.ts';
import { HarnessSchema } from './session-base.ts';
import { HarnessDialogSchema } from './session-dialog.ts';
import { SessionLiveActivitySchema } from './session-live.ts';
import { PermissionRequestSchema } from './session-permission.ts';
import { SessionProvenanceSchema } from './session-provenance.ts';
import { SessionTransferEdgeSchema } from './session-transfer-edge.ts';

export type { Harness } from './session-base.ts';
export { HarnessSchema } from './session-base.ts';
/**
 * Re-exported here rather than added to the package barrel separately, because the stamp is a FIELD
 * of the session config below: a reader that has `SessionConfig` should reach its provenance shape
 * through the same module, not hunt for a second import path.
 */
export type { SessionProvenance, SessionSpawnOrigin, WardenLineageSource } from './session-provenance.ts';
export { SessionProvenanceSchema, SessionSpawnOriginSchema, WardenLineageSourceSchema } from './session-provenance.ts';

export const InteractionModeSchema = z.enum(['auto', 'interactive']);
export type InteractionMode = z.infer<typeof InteractionModeSchema>;

/**
 * What the daemon KNOWS about one send, and never more.
 *
 *   * `accepted`   — a durable record exists; nothing has proved where the message is yet.
 *   * `queued`     — PROVEN held by the harness's own input queue (a Claude queue record, or the pane
 *                    still showing the payload held after the queue key). Never inferred from a busy pane.
 *   * `delivered`  — the message appears as a user turn in the harness transcript (`evidence` cites it).
 *   * `unaccounted`— the daemon could not prove it either way (`reason` says why); it MAY have landed.
 *   * `timed_out`  — PROVEN absent after every attempt: not in the transcript, not in the harness queue,
 *                    not in the composer. Safe to retry under the same id.
 *   * `cancelled`  — a person took it back before it was proven delivered. `cancelEffect` says what
 *                    that did to the agent's screen, because only some of it can be undone there.
 */
export const SendFateSchema = z.enum(['accepted', 'queued', 'delivered', 'unaccounted', 'timed_out', 'cancelled']);
export type SendFate = z.infer<typeof SendFateSchema>;

export const SendPathSchema = z.enum(['direct', 'turn-file', 'native-inline', 'native-file', 'revive', 'revive-queue']);
export type SendPath = z.infer<typeof SendPathSchema>;

/** Why a send settled without proof of delivery. */
export const SendUnaccountedReasonSchema = z.enum([
  /** Still not proven after the final deadline, with the harness never proving it absent either. */
  'timeout',
  /** The session ended before the message was proven delivered. */
  'session_ended',
  /** The harness took the message out of its queue without it ever reaching the conversation. */
  'composer_discarded',
  /** The transcript could not be read, so absence could not be proven. */
  'transcript_unreadable',
  /**
   * The session has no transcript this daemon can prove is its own, so nothing it typed can ever be
   * confirmed — not a timing problem, and re-sending cannot fix it. Restarting the CLI can.
   */
  'transcript_unbound',
  /** The pane could not be read, so absence could not be proven. */
  'pane_unreadable',
  /** A dialog on the agent's screen was waiting for an answer, so the message could not be typed. */
  'blocked_by_prompt',
  /** Proven absent after every attempt. */
  'not_delivered',
]);
export type SendUnaccountedReason = z.infer<typeof SendUnaccountedReasonSchema>;

/** Who asked for the message: a person, another agent, or the daemon itself (a failure notice). */
export const SendSenderKindSchema = z.enum(['human', 'agent', 'daemon']);
export type SendSenderKind = z.infer<typeof SendSenderKindSchema>;

/** How a `queued` fate was proven. */
export const SendQueueProofSchema = z.enum(['transcript', 'pane']);
export type SendQueueProof = z.infer<typeof SendQueueProofSchema>;

export const SendEvidenceSchema = z.object({
  key: z.string().min(1),
  harness: HarnessSchema,
  kind: z.enum(['chat.user', 'queued_command', 'response_item']),
  proof: z.enum(['normal-user-record', 'native-queue-drain']),
  observedAt: InstantSchema,
  originatedAt: InstantSchema.optional(),
  shapeVersion: PositiveIntegerSchema,
  matchedTurn: NonNegativeIntegerSchema,
  /**
   * `merged-text`: the harness submitted this message JOINED to the sends either side of it — what a
   * TUI does when a second message is typed onto one still sitting in its composer — so one user record
   * proves several sends, in order.
   */
  tier: z.enum(['queue-file-id', 'turn-instruction', 'exact-text', 'merged-text']),
});
export type SendEvidence = z.infer<typeof SendEvidenceSchema>;

/**
 * What cancelling a send did on the agent's screen.
 *
 *   * `cleared`        — it was typed in the composer and has been erased from it.
 *   * `not_in_pane`    — it was in neither the composer nor the harness's queue; only the record moved.
 *   * `left_in_queue`  — the harness is holding it in its own queue, which Ferretry cannot edit: the
 *                        agent may still read it at its next turn boundary.
 *   * `left_in_composer` — the composer holds it beside other text, or could not be proven clear, so
 *                        it was left alone rather than erasing somebody's draft.
 */
export const SendCancelEffectSchema = z.enum(['cleared', 'not_in_pane', 'left_in_queue', 'left_in_composer']);
export type SendCancelEffect = z.infer<typeof SendCancelEffectSchema>;

/** Public send-ledger row. Private payload paths never cross the API boundary. */
export const SendRecordSchema = z.object({
  v: z.literal(1),
  sendId: z.string().min(1),
  acceptedAt: InstantSchema,
  acceptedTurn: NonNegativeIntegerSchema,
  path: SendPathSchema,
  message: z.string(),
  turn: NonNegativeIntegerSchema.optional(),
  attachmentIds: z.array(z.string()),
  from: z.string().optional(),
  fromName: z.string().optional(),
  /** Who asked for it. A person retries by hand; an agent's sends are retried by the daemon. */
  senderKind: SendSenderKindSchema.optional(),
  replyExpected: z.boolean().optional(),
  held: z.boolean().optional(),
  withdrawn: z.boolean().optional(),
  fate: SendFateSchema,
  fateAt: InstantSchema.optional(),
  evidence: SendEvidenceSchema.optional(),
  /** Why an `unaccounted` or `timed_out` send settled where it did. */
  unaccountedReason: SendUnaccountedReasonSchema.optional(),
  /** When and how a `queued` fate was proven. */
  queuedAt: InstantSchema.optional(),
  queueProof: SendQueueProofSchema.optional(),
  /** 1 for the first transport; each re-attempt under the same id adds one. */
  attempt: PositiveIntegerSchema.optional(),
  attemptAt: InstantSchema.optional(),
  /** When the daemon next re-checks an open send. */
  deadlineAt: InstantSchema.optional(),
  /**
   * The daemon may re-attempt under the SAME id: true only while the message is proven absent
   * (`timed_out`). An `unaccounted` send may still be re-sent, but only as a deliberate "send again
   * anyway", because the original may have landed.
   */
  retryable: z.boolean().optional(),
  /**
   * The message is sitting TYPED in the agent's composer and was not submitted. A harness never sends
   * composer text on its own, so it waits there until somebody presses Enter or clears it.
   */
  typedNotSent: z.boolean().optional(),
  /** What a `cancelled` fate did to the agent's screen. */
  cancelEffect: SendCancelEffectSchema.optional(),
  opportunityAt: InstantSchema.optional(),
  unaccountedDeadline: InstantSchema.optional(),
  hardDeadline: InstantSchema.optional(),
  timeoutFrozenAt: InstantSchema.optional(),
});
export type SendRecord = z.infer<typeof SendRecordSchema>;

export const SendListResponseSchema = z.object({ sends: z.array(SendRecordSchema) });
export type SendListResponse = z.infer<typeof SendListResponseSchema>;

/**
 * Re-attempting one send under its ORIGINAL id.
 *
 * `force` is the "send again anyway" path for an `unaccounted` send, whose original may have landed;
 * without it the daemon only re-attempts a send it has proven absent.
 */
export const SendRetryRequestSchema = z.strictObject({ force: z.boolean().optional() });
export type SendRetryRequest = z.infer<typeof SendRetryRequestSchema>;

/**
 * Taking back one send that was not proven delivered: the record leaves the open queue, and a copy
 * sitting typed in the agent's composer is erased. Nothing else is accepted, so a body is refused.
 */
export const SendCancelRequestSchema = z.strictObject({});
export type SendCancelRequest = z.infer<typeof SendCancelRequestSchema>;

/**
 * Pressing Enter ONCE for a send that is sitting typed in the agent's composer. Refused unless the
 * composer holds exactly that message, so it can never submit somebody else's draft.
 */
export const SendSubmitRequestSchema = z.strictObject({});
export type SendSubmitRequest = z.infer<typeof SendSubmitRequestSchema>;

/**
 * The code a send answers with when the agent's composer already holds a PERSON's unsent text.
 *
 * A pointer Ferretry typed itself and never submitted is finished by the daemon rather than refused;
 * this is what is left — text only the person can decide about. The body carries that `draft` exactly
 * as the composer reads, so the app can offer "Send it" and "Clear it" for exactly that text.
 */
export const COMPOSER_OCCUPIED_CODE = 'composer_occupied';

/** Longest draft the composer routes will act on; a composer holding more is not a draft to tap away. */
export const COMPOSER_DRAFT_MAX_CHARS = 20_000;

const ComposerOccupiedBodySchema = z.object({
  code: z.literal(COMPOSER_OCCUPIED_CODE),
  draft: z.string().min(1).max(COMPOSER_DRAFT_MAX_CHARS),
});

/** The draft a `composer_occupied` refusal carries, or `undefined` for any other body. */
export function composerOccupiedDraft(body: unknown): string | undefined {
  const parsed = ComposerOccupiedBodySchema.safeParse(body);
  return parsed.success ? parsed.data.draft : undefined;
}

/**
 * Pressing Enter on, or erasing, the person's own draft in the agent's composer.
 *
 * `draft` is the text the refusal quoted back. The daemon acts ONLY while the composer still holds
 * exactly that, so a draft the person has since changed in the terminal is never sent or wiped from
 * here.
 */
export const ComposerDraftRequestSchema = z.strictObject({
  action: z.enum(['submit', 'clear']),
  draft: z.string().min(1).max(COMPOSER_DRAFT_MAX_CHARS),
});
export type ComposerDraftRequest = z.infer<typeof ComposerDraftRequestSchema>;

/**
 * What acting on the draft did. `submitted` and `cleared` free the composer; `holding` is an Enter the
 * harness did not take; `absent` is a composer that is already empty; `changed` is a composer that no
 * longer holds exactly that draft, so nothing was pressed; `stuck` is an erase that stopped responding.
 */
export const ComposerDraftOutcomeSchema = z.enum(['submitted', 'holding', 'cleared', 'absent', 'changed', 'stuck']);
export type ComposerDraftOutcome = z.infer<typeof ComposerDraftOutcomeSchema>;

export const ComposerDraftResultSchema = z.object({
  action: z.enum(['submit', 'clear']),
  outcome: ComposerDraftOutcomeSchema,
});
export type ComposerDraftResult = z.infer<typeof ComposerDraftResultSchema>;

export const RuntimeModelOptionSchema = z.object({
  value: z.string().min(1),
  label: z.string().min(1),
});
export type RuntimeModelOption = z.infer<typeof RuntimeModelOptionSchema>;

export const RuntimeReasoningChoiceSchema = z.object({
  value: z.string().min(1),
  description: z.string().optional(),
});
export type RuntimeReasoningChoice = z.infer<typeof RuntimeReasoningChoiceSchema>;

export const RuntimeModelChoiceSchema = RuntimeModelOptionSchema.extend({
  description: z.string().optional(),
  /** Where the login's model catalog puts it (docs/model-catalog.md): a picker groups by it. */
  tier: z.enum(['best', 'balanced', 'fast']).optional(),
  /** The context window, in tokens, when the catalog says. */
  context: z.number().int().positive().optional(),
  isDefault: z.literal(true).optional(),
  reasoningEfforts: z.array(RuntimeReasoningChoiceSchema),
  defaultReasoningEffort: z.string().min(1).optional(),
  /**
   * Whether the harness offers FAST MODE on this model: `true` it does, `false` it does not, absent
   * the daemon cannot say (a daemon that predates fast mode, or a catalog that does not describe it).
   * A surface disables its fast toggle only on an explicit `false`.
   */
  fast: z.boolean().optional(),
  /** The model runs in fast mode unless told otherwise (Codex: its default service tier is the fast one). */
  fastDefault: z.literal(true).optional(),
});
export type RuntimeModelChoice = z.infer<typeof RuntimeModelChoiceSchema>;

export const RuntimeModelCatalogSchema = z.object({
  harness: HarnessSchema,
  source: z.enum(['wrapper-inventory', 'codex-app-server']),
  choices: z.array(RuntimeModelChoiceSchema),
  /**
   * The login's model catalog, when it reads one. With it, each choice's `reasoningEfforts` is what that
   * model takes — empty means none — and `customIds` says the session may be switched to any id.
   */
  catalog: z.object({ id: z.string().min(1), label: z.string().min(1), customIds: z.boolean() }).optional(),
});
export type RuntimeModelCatalog = z.infer<typeof RuntimeModelCatalogSchema>;

export const RuntimeControlRequestSchema = z.discriminatedUnion('action', [
  // Codex's native picker can be opened without selecting a target. It is a
  // real control operation, but deliberately makes no claim about the eventual
  // model; targeted callers supply both opaque values unchanged.
  z.strictObject({
    action: z.literal('model'),
    model: z.string().min(1).optional(),
    effort: z.string().min(1).optional(),
  }),
  z.strictObject({ action: z.literal('effort'), effort: z.string().min(1) }),
  // Fast mode is a switch, not a level: `true` turns it on and `false` off, and either is applied
  // with the harness's own command at an idle prompt and confirmed by what the harness then reports.
  z.strictObject({ action: z.literal('fast'), fast: z.boolean() }),
  z.strictObject({ action: z.literal('compact') }),
]);
export type RuntimeControlRequest = z.infer<typeof RuntimeControlRequestSchema>;

/**
 * WHOSE TURN IT IS in a live session — the one fact the spinner, the status dots and the
 * notifications all read.
 *
 * `status` cannot answer it: `running` means the agent's terminal is live, and nothing moved it off
 * `running` when a turn ended. The daemon's turn watcher owns this field and derives it from the
 * harness's own evidence — its transcript's turn boundaries and the live pane (its spinner line, an
 * idle prompt, a permission prompt) — never from "a message was sent".
 *
 *   * `working` — the agent is mid-turn.
 *   * `your-turn` — the agent is idle at its prompt, waiting for the next message.
 *   * `needs-input` — the agent is blocked on a person: a permission prompt or a question.
 *
 * Absent for a session that is not live (not launched yet, or finished), and from a daemon that
 * predates the watcher.
 */
export const SessionTurnStateSchema = z.enum(['working', 'your-turn', 'needs-input']);
export type SessionTurnState = z.infer<typeof SessionTurnStateSchema>;

export const SessionStatusSchema = z.enum([
  'created',
  'starting',
  'running',
  'thinking',
  'tool_running',
  'awaiting_question',
  'awaiting_user',
  'interrupted',
  'rate_limited',
  'retrying',
  'kill_failed',
  'waiting',
  'completed',
  'failed',
  'stalled',
  'stopped',
]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const PendingQuestionOptionSchema = z.object({
  label: z.string().min(1),
  description: z.string().optional(),
});
export type PendingQuestionOption = z.infer<typeof PendingQuestionOptionSchema>;

export const PendingQuestionSchema = z.object({
  toolUseId: z.string().min(1),
  questions: z
    .array(
      z.object({
        question: z.string().min(1),
        header: z.string().optional(),
        options: z.array(PendingQuestionOptionSchema).optional(),
        multiSelect: z.boolean().optional(),
      }),
    )
    .min(1),
  askedAt: InstantSchema.optional(),
  lastSeenAt: InstantSchema.optional(),
  missingSince: InstantSchema.optional(),
});
export type PendingQuestion = z.infer<typeof PendingQuestionSchema>;

export const TaskBoardAccessSchema = z.enum(['none', 'read', 'worker', 'coordinator']);
export type TaskBoardAccess = z.infer<typeof TaskBoardAccessSchema>;

const RetryPolicySchema = z.object({
  transientAttempts: NonNegativeIntegerSchema,
  stalledAttempts: NonNegativeIntegerSchema,
  waitForQuotaReset: z.boolean(),
  allowAccountFailover: z.boolean(),
});

/**
 * How this session's harness transcript was IDENTIFIED.
 *
 * `minted` — the daemon chose the harness session id itself and put it on the launch argv, so the
 * transcript's name was decided before the harness ran. Nothing was inferred.
 * `correlated` — the harness named its own session, and the daemon proved which one by finding a
 * string only this session could contain in a rollout that did not exist before the launch.
 * `adopted` — the conversation existed before this session did, and the owner chose to keep it as a
 * ferret (`conversation-import.ts`). Its id is the CLI's own, read from the file the session resumes.
 * `undiscovered` — neither proof is available yet. A session in this state has NO transcript, which
 * is the point: attributing one by working directory or recency silently hands one agent's
 * transcript to another session and the mistake is invisible.
 */
export const TranscriptIdentitySchema = z.enum(['minted', 'correlated', 'adopted', 'undiscovered']);
export type TranscriptIdentity = z.infer<typeof TranscriptIdentitySchema>;

/**
 * Where this session's transcript lives, recorded as evidence captured at launch.
 *
 * This is a PROVENANCE record, not a cache. Every field is something the daemon observed or decided
 * at the moment the session was created — the harness home the wrapper exports, the session id the
 * daemon minted, the rollouts that already existed before this launch — because after the fact
 * there is no way to tell two concurrent sessions of the same agent in the same directory apart.
 */
export const TranscriptProvenanceSchema = z
  .object({
    v: z.literal(1),
    /** The harness's own private home, as the launched wrapper exports it. */
    home: z.string().min(1),
    /** The harness's identity for this session, once it is known. */
    harnessSessionId: z.string().min(1).optional(),
    identity: TranscriptIdentitySchema,
    /**
     * The harness session ids that already existed when this session launched.
     *
     * Recorded only for a harness that names its own session (Codex). Everything listed here
     * belongs to somebody else by construction, so a later discovery can exclude all of it without
     * having to reason about time.
     */
    baseline: z.array(z.string().min(1)).optional(),
    /**
     * A string this daemon injected into this session and into no other.
     *
     * It is the whole proof behind `correlated`: a rollout containing it was written by this
     * session, and a rollout that does not is not this session's however recent it is.
     */
    correlationToken: z.string().min(1).optional(),
    /** The exact transcript file. Present exactly when the identity is established. */
    file: z.string().min(1).optional(),
    /** When the identity was established. */
    resolvedAt: InstantSchema.optional(),
  })
  .refine(value => (value.identity === 'undiscovered') === (value.harnessSessionId === undefined), {
    message: 'an identified transcript must name the harness session it belongs to',
    path: ['harnessSessionId'],
  })
  .refine(value => (value.identity === 'undiscovered') === (value.file === undefined), {
    message: 'an identified transcript must name its file',
    path: ['file'],
  });
export type TranscriptProvenance = z.infer<typeof TranscriptProvenanceSchema>;

/**
 * Where a session's conversation came from, when a cross-harness migration converted it
 * (`conversation: 'convert'`). The original transcript is never deleted; this is the pointer back to
 * it, and the reason the converted one opens with a notice saying it was carried.
 */
export const ConversationConversionSchema = z.strictObject({
  v: z.literal(1),
  /** The converter version that wrote it. */
  converter: PositiveIntegerSchema,
  fromHarness: HarnessSchema,
  /** The source harness's own id for the conversation. */
  fromConversation: z.string().min(1),
  /** The source transcript, left where it was. */
  fromFile: z.string().min(1),
  toHarness: HarnessSchema,
  toConversation: z.string().min(1),
  at: InstantSchema,
  keptTurns: NonNegativeIntegerSchema,
  omittedTurns: NonNegativeIntegerSchema,
});
export type ConversationConversion = z.infer<typeof ConversationConversionSchema>;

/** Effective, safe-to-publish session configuration. */
export const SessionConfigSchema = z.object({
  id: z.string().min(1),
  incarnation: z.string().min(1),
  runtimeGeneration: PositiveIntegerSchema,
  name: z.string().min(1),
  teammate: z.string().optional(),
  label: z.string().optional(),
  parent: z.string().optional(),
  /**
   * The spawn-side warden stamp: who caused this session to exist, and whether it descends from a
   * warden.
   *
   * OPTIONAL FOR TWO SEPARATE REASONS, and conflating them would be a bug. A session started before
   * stamping existed carries none; and "no stamp" is a genuinely different answer from "not a
   * descendant", because the first means nobody has decided and the second means somebody did.
   *
   * A PRESENT-BUT-DAMAGED STAMP FAILS THIS WHOLE PARSE, deliberately. Zod strips unknown keys, not
   * invalid declared ones, so a corrupt record takes the session out of every surface at once rather
   * than quietly handing the warden detector `undefined` for a session that may well be
   * warden-descended. That is the loop the shield exists to prevent, so the loud failure is the safe
   * one — and `transcript` below already carries exactly this blast radius, so it is not a new
   * hazard class.
   */
  provenance: SessionProvenanceSchema.optional(),
  boardAccess: TaskBoardAccessSchema,
  agent: z.string().min(1),
  harness: HarnessSchema,
  modelHint: z.string(),
  model: z.string().optional(),
  /**
   * The reasoning level this session was LAUNCHED on: the start request's, else the one the
   * runtime's own settings file held at launch. A launch fact, not an observation — a surface prefers
   * anything the harness later reports. Absent means the harness's own default.
   */
  launchReasoningEffort: z.string().min(1).optional(),
  /**
   * Whether this session was LAUNCHED in fast mode: the start request's choice, kept so a Restart and a
   * revive launch it the same way. A launch fact, not an observation — a surface prefers anything the
   * harness later reports (`observedFast`). Absent means the harness's own default (off).
   */
  launchFast: z.boolean().optional(),
  /**
   * A digest of the FLEET settings this session's process was launched under: its wrapper and the
   * fixed settings file beside it. Compared with the same digest taken now to say whether the running
   * process is on older settings than a relaunch would give it. Absent for a session launched before
   * this was recorded, which a relaunch then records.
   */
  launchSettings: z.string().min(1).optional(),
  mode: InteractionModeSchema,
  remoteControl: z.boolean(),
  harnessFlags: z.array(z.string()),
  cwd: z.string().min(1),
  createdAt: InstantSchema,
  updatedAt: InstantSchema,
  turn: NonNegativeIntegerSchema,
  intervalSeconds: PositiveIntegerSchema,
  timeoutSeconds: NonNegativeIntegerSchema,
  nudgeAfterSeconds: NonNegativeIntegerSchema,
  killAfterSeconds: NonNegativeIntegerSchema,
  directSendMaxChars: NonNegativeIntegerSchema,
  resumeMenuChoice: z.enum(['full', 'summary']),
  maxSnapshots: PositiveIntegerSchema,
  migration: z
    .object({
      from: z.string().min(1),
      to: z.string().min(1),
      at: InstantSchema,
    })
    .optional(),
  /** Target-only lineage back to the transfer decision that created this fresh session. */
  transferredFrom: SessionTransferEdgeSchema.optional(),
  /** Where the conversation came from, when a cross-harness migration converted it. */
  conversion: ConversationConversionSchema.optional(),
  /**
   * Optional because a session started before this record existed has none, and because a harness
   * home the daemon cannot resolve must leave the session with no transcript rather than a guessed
   * one.
   */
  transcript: TranscriptProvenanceSchema.optional(),
  retry: RetryPolicySchema,
  /**
   * Whether this ferret is told it may explain with hypermedia (docs/hypermedia.md). ABSENT MEANS THE MODE'S DEFAULT: on
   * for an interactive ferret, off for an auto one, so a session started before the switch existed follows it
   * at its next launch unless the owner set it explicitly. Read at launch, so a change takes effect at the next launch.
   */
  hypermedia: z.boolean().optional(),
  /**
   * Whether this ferret is told it may delegate to sub-ferrets (docs/pack-mode.md). ABSENT MEANS ON, as
   * for hypermedia; the machine's own switch and the depth limit still apply. Read at launch.
   */
  pack: z.boolean().optional(),
});
export type SessionConfig = z.infer<typeof SessionConfigSchema>;

/**
 * Whether a ferret is told it may use hypermedia, resolved: the recorded switch, else the default for
 * its mode — ON for an interactive ferret, OFF for every auto one (a worker, a warden, a miner), which
 * has no reader to look at a picture (docs/hypermedia.md).
 */
export const sessionHypermediaEnabled = (config: Pick<SessionConfig, 'mode' | 'hypermedia'>): boolean =>
  config.hypermedia ?? config.mode === 'interactive';

export const SessionHealthSchema = z.enum([
  'healthy',
  'thinking',
  'waiting',
  'idle',
  'stalled',
  'rate_limited',
  'crashed',
  'unknown',
]);
export type SessionHealth = z.infer<typeof SessionHealthSchema>;

export const AccountAvailabilitySchema = z.enum(['available', 'unavailable']);
export type AccountAvailability = z.infer<typeof AccountAvailabilitySchema>;

export const AccountUnavailableReasonSchema = z.enum(['cooldown', 'spend_limit', 'auth', 'provider', 'no_credentials']);
export type AccountUnavailableReason = z.infer<typeof AccountUnavailableReasonSchema>;

/** Upstream account-health row. It also breaks the former core/usage type cycle. */
export const AccountUsageSchema = z.object({
  agent: z.string().min(1),
  provider: z.string().optional(),
  ok: z.boolean().optional(),
  usageBased: z.boolean().optional(),
  availability: AccountAvailabilitySchema.optional(),
  unavailable: z.boolean().optional(),
  unavailableReason: AccountUnavailableReasonSchema.optional(),
  retryAt: NonNegativeFiniteSchema.nullable().optional(),
  atLimit: z.boolean().optional(),
  authOk: z.boolean().optional(),
  fiveHourPercent: z.number().finite().min(0).max(100).nullable().optional(),
  weeklyPercent: z.number().finite().min(0).max(100).nullable().optional(),
  fiveHourResetAt: NonNegativeFiniteSchema.nullable().optional(),
  weeklyResetAt: NonNegativeFiniteSchema.nullable().optional(),
  /** An environment login's prepaid credit, when its provider reports one (`lib/usage/provider-quota`). */
  balance: ProviderQuotaBalanceSchema.optional(),
  /** Equivalent cost this month from this daemon's transcripts, when no provider endpoint answers. */
  spendUsd: NonNegativeFiniteSchema.optional(),
});
export type AccountUsage = z.infer<typeof AccountUsageSchema>;

const QuotaSchema = z.object({
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
});

const DeclaredWaitSchema = z.object({
  since: InstantSchema,
  until: InstantSchema.optional(),
  condition: z.string().optional(),
  peer: z.string().optional(),
  peerName: z.string().optional(),
});

/**
 * The named sections of the system prompt Ferretry appends to an agent, in the order a wrapper
 * composes them (`@ferretry/fleet` `launchInstructions`): the tools and the settings rules every agent
 * gets, then each per-ferret section its launch switched on.
 */
export const LaunchInstructionSectionIdSchema = z.enum(['tools', 'settings', 'hypermedia', 'pack', 'learning']);
export type LaunchInstructionSectionId = z.infer<typeof LaunchInstructionSectionIdSchema>;

/** One appended section, by name and size. The text itself is never carried. */
export const LaunchInstructionSectionSchema = z.object({
  id: LaunchInstructionSectionIdSchema,
  chars: NonNegativeIntegerSchema,
});
export type LaunchInstructionSection = z.infer<typeof LaunchInstructionSectionSchema>;

/**
 * What one launch of a session was told, recorded when its pane was built: which Ferretry
 * system-prompt sections it carried, its mode, and whether it may ask the owner a question.
 *
 * A LAUNCH FACT, refreshed by every launch and relaunch: a switch flipped while the session runs
 * reaches the agent only at its next launch, so the stored environment is not what it was told.
 */
export const SessionLaunchInstructionsSchema = z.object({
  sections: z.array(LaunchInstructionSectionSchema),
  mode: InteractionModeSchema,
  questions: z.boolean(),
});
export type SessionLaunchInstructions = z.infer<typeof SessionLaunchInstructionsSchema>;

/** Public session state; internal queue payloads and filesystem proofs are omitted. */
export const SessionStateSchema = z.object({
  id: z.string().min(1),
  status: SessionStatusSchema,
  turn: NonNegativeIntegerSchema,
  pid: PositiveIntegerSchema.optional(),
  startedAt: InstantSchema.optional(),
  finishedAt: InstantSchema.optional(),
  lastActivityAt: InstantSchema.optional(),
  lastSnapshotAt: InstantSchema.optional(),
  lastDiffAt: InstantSchema.optional(),
  exitCode: z.number().int().optional(),
  reason: z.string().optional(),
  health: SessionHealthSchema.optional(),
  promptReady: z.boolean().optional(),
  remoteControlUrl: z.url().optional(),
  openTools: z.array(z.string()).optional(),
  pendingQuestion: PendingQuestionSchema.nullable().optional(),
  /** The exact structured form the daemon confirmed as advanced; prevents a
   * transcript tail from resurrecting that already-answered tool call. */
  lastAnsweredQuestionToolUseId: z.string().min(1).optional(),
  lastTranscriptAt: InstantSchema.optional(),
  lastPaneAt: InstantSchema.optional(),
  lastCounterAdvanceAt: InstantSchema.optional(),
  lastTokenAdvanceAt: InstantSchema.optional(),
  lastSubprocessAt: InstantSchema.optional(),
  subprocessSince: InstantSchema.optional(),
  nudgedAt: InstantSchema.optional(),
  needsHuman: z.string().optional(),
  needsHumanKind: z.string().optional(),
  contextPercent: z.number().finite().min(0).max(100).optional(),
  contextTokens: NonNegativeIntegerSchema.optional(),
  contextWindow: PositiveIntegerSchema.optional(),
  usage5hPercent: z.number().finite().min(0).max(100).optional(),
  usageWeeklyPercent: z.number().finite().min(0).max(100).optional(),
  usage5hResetAt: NonNegativeFiniteSchema.optional(),
  usageWeeklyResetAt: NonNegativeFiniteSchema.optional(),
  usageAtLimit: z.boolean().optional(),
  usageAuthOk: z.boolean().optional(),
  launchedAt: InstantSchema.optional(),
  /** What the current pane was told at launch; absent for a session last launched before it was recorded. */
  launchInstructions: SessionLaunchInstructionsSchema.optional(),
  observedModel: z.string().optional(),
  observedModelAt: InstantSchema.optional(),
  observedReasoningEffort: z.string().optional(),
  /** Whether the harness last reported fast mode on; moves `observedModelAt` like a model switch. */
  observedFast: z.boolean().optional(),
  activity: z.string().optional(),
  lastToolStartedAt: InstantSchema.optional(),
  quota: QuotaSchema.optional(),
  retryAttempt: NonNegativeIntegerSchema.optional(),
  turnCompleted: z.boolean().optional(),
  /** Whose turn it is; see {@link SessionTurnStateSchema}. */
  turnState: SessionTurnStateSchema.optional(),
  /** When `turnState` last CHANGED — a new value here is a new turn boundary, once. */
  turnStateAt: InstantSchema.optional(),
  /**
   * What the agent's screen is asking, in the words a person is shown for it, while `turnState` is
   * `needs-input` because a harness dialog is up ("Make auto mode your default permission mode?").
   * Absent for every other turn, and for a permission prompt, which `permissionRequest` carries.
   */
  turnPrompt: z.string().min(1).max(200).optional(),
  /**
   * The tool-permission prompt the agent's pane is parked on while `turnState` is `needs-input`: what it
   * wants to do and the choices its harness offered. Absent for every other turn.
   */
  permissionRequest: PermissionRequestSchema.optional(),
  /**
   * The harness's own dialog the agent's pane is parked on while `turnState` is `needs-input` — hooks to
   * review, an update, a sign-in, an MCP server to approve — with the choices it offers. Absent for every
   * other turn.
   */
  harnessDialog: HarnessDialogSchema.optional(),
  waiting: DeclaredWaitSchema.optional(),
  waitingCreditSeconds: NonNegativeFiniteSchema.optional(),
});
export type SessionState = z.infer<typeof SessionStateSchema>;

export const SessionViewSchema = z.object({
  config: SessionConfigSchema,
  state: SessionStateSchema,
  directory: z.string().min(1),
  /**
   * The highest event sequence this session's journal held when the view was read: where a reader
   * that has just read the session can start `/v1/events?after=` instead of replaying the whole
   * history. Absent from a daemon that predates it, which a reader takes as `0`.
   */
  journalSequence: NonNegativeIntegerSchema.optional(),
});
export type SessionView = z.infer<typeof SessionViewSchema>;

export const SessionListSchema = z.array(SessionViewSchema);
export type SessionList = z.infer<typeof SessionListSchema>;

/**
 * Why a running session is on older settings than a relaunch would give it.
 *
 *   arguments  the daemon-owned launch arguments a relaunch builds now differ from the ones it runs
 *              with — a `Read(...)` rule it predates, a remote-control surface, the owner's flags
 *   settings   the fleet settings it launched under changed since — permission mode, profile, the
 *              fixed layer
 */
export const SessionRelaunchDriftSchema = z.enum(['arguments', 'settings']);
export type SessionRelaunchDrift = z.infer<typeof SessionRelaunchDriftSchema>;

/** Whether a running session is on the settings a relaunch would give it, and if not, why. */
export const SessionRelaunchSettingsSchema = z.object({
  current: z.boolean(),
  reasons: z.array(SessionRelaunchDriftSchema),
});
export type SessionRelaunchSettings = z.infer<typeof SessionRelaunchSettingsSchema>;

/**
 * The exact tmux process a daemon proved belongs to one managed session.
 *
 * This is deliberately separate from {@link SessionConfigSchema}. A public session view describes
 * the work; it is not authority to address a host runtime. The attach route returns this short-lived
 * proof only after matching the daemon's durable pane registration against a fresh observation, and
 * the CLI checks the same identity once more immediately before it asks tmux to attach.
 */
export const SessionAttachTargetSchema = z.strictObject({
  /** The private tmux server owned by the daemon that answered the request. */
  socketPath: z.string().min(1).regex(/^\//u, 'the tmux socket path must be absolute'),
  tmuxSession: z.string().min(1),
  paneId: z.string().regex(/^%(?:0|[1-9][0-9]*)$/u),
  pid: PositiveIntegerSchema.refine(value => value > 1, 'the pane pid must be greater than one'),
  /** The pane process's start identity (`ProcessIncarnation`: Linux start ticks, macOS epoch seconds), which distinguishes a reused PID. */
  processStartTicks: PositiveIntegerSchema,
});
export type SessionAttachTarget = z.infer<typeof SessionAttachTargetSchema>;

/**
 * The most a single Console write may carry, in UTF-16 code units. A keystroke is one to a handful; a
 * paste is the large case, and a client splits anything longer into ordered writes rather than the
 * daemon accepting an unbounded body into a tmux argument vector.
 */
export const SESSION_CONSOLE_INPUT_MAX = 4_096;

/**
 * Typing into a session's OWN pane — the agent's Claude / Codex CLI — from wherever the reader is.
 *
 * `data` is exactly what a terminal would send: printable text, `\r` for Enter, escape sequences for
 * arrows and the rest. The daemon writes the bytes and keeps nothing of them; the security log counts
 * the writes per session and never records what they said.
 */
export const SessionConsoleInputRequestSchema = z.strictObject({
  data: z.string().min(1).max(SESSION_CONSOLE_INPUT_MAX),
});
export type SessionConsoleInputRequest = z.infer<typeof SessionConsoleInputRequestSchema>;

/** How many bytes reached the pane: the UTF-8 length of `data`, never the bytes themselves. */
export const SessionConsoleInputResultSchema = z.strictObject({
  written: PositiveIntegerSchema,
});
export type SessionConsoleInputResult = z.infer<typeof SessionConsoleInputResultSchema>;

export const NameSuggestionsSchema = z.array(z.string().min(1));
export type NameSuggestions = z.infer<typeof NameSuggestionsSchema>;

export const FyEventSourceSchema = z.string().min(1);

/**
 * Generic event envelope. Event-specific payload schemas parse `data` after dispatch.
 *
 * WHY `turn` IS OPTIONAL. The daemon's durable session journal records exactly four things about an
 * event — its sequence, its time, its type and its data — and nothing about the turn it happened
 * during. A required `turn` therefore forced the only mounted producer to invent one, and `turn: 0`
 * on every replayed event is not a missing number, it is a WRONG one: a reader grouping by turn
 * would render a session's whole history as a single opening turn. Absent says "the daemon does not
 * record this", which is the truth, and it is the shape every consumer can act on honestly.
 */
export const FyEventSchema = z.object({
  sequence: NonNegativeIntegerSchema,
  time: InstantSchema,
  sessionId: z.string().min(1),
  turn: NonNegativeIntegerSchema.optional(),
  type: z.string().min(1),
  source: FyEventSourceSchema,
  data: z.unknown(),
  recordUuid: z.string().optional(),
  blockIndex: NonNegativeIntegerSchema.optional(),
});
export type FyEvent = z.infer<typeof FyEventSchema>;

export const FyEventListSchema = z.array(FyEventSchema);
export type FyEventList = z.infer<typeof FyEventListSchema>;

/** Proof that a live event socket is quiet rather than broken. */
export const FyEventStreamIdleScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('session'),
    sessionId: z.string().min(1),
    /** This session's own last delivered sequence. */
    after: NonNegativeIntegerSchema,
  }),
  z.strictObject({
    kind: z.literal('fleet'),
    /** Sessions in the daemon-local fleet at the instant the proof was emitted. */
    followedSessions: NonNegativeIntegerSchema,
  }),
]);
export type FyEventStreamIdleScope = z.infer<typeof FyEventStreamIdleScopeSchema>;

/**
 * One frame on `/v1/events`.
 *
 * The wrapper keeps a heartbeat from masquerading as a session event: an idle proof has no invented
 * session id, sequence, or lifecycle type, while an event still passes through the exact envelope
 * every replay and history reader uses.
 */
export const FyEventStreamFrameSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('event'), event: FyEventSchema }),
  z.strictObject({
    kind: z.literal('idle'),
    idleSeconds: PositiveIntegerSchema,
    scope: FyEventStreamIdleScopeSchema,
  }),
  /**
   * A working turn's live readout (`session-live.ts`). Only a per-session stream opened with
   * `?live=1` ever carries one, so a reader that never asked never has to recognise it.
   */
  z.strictObject({ kind: z.literal('live'), live: SessionLiveActivitySchema }),
]);
export type FyEventStreamFrame = z.infer<typeof FyEventStreamFrameSchema>;
export type FyEventStreamIdle = Extract<FyEventStreamFrame, { readonly kind: 'idle' }>;

/**
 * The most free-form harness flags one start may carry, and the longest one may be.
 *
 * Generous on purpose: a `--settings` overlay is JSON and can run to a few kilobytes. The bounds exist
 * so a body cannot hand the launch argv an unbounded list, never to judge which flags are wise.
 * Whether a caller may choose them at all is the device unlock's question
 * (`docs/design/zero-trust.md` B1), not this schema's.
 */
const MAX_HARNESS_FLAGS = 64;
const MAX_HARNESS_FLAG_LENGTH = 16_384;

/**
 * One caller-supplied harness flag, bounded and free of control characters.
 *
 * A control character has no business in an argv element a human typed: a newline or an escape in
 * one is either a mistake or an attempt to make the recorded command read differently from the one
 * that ran.
 */
const HarnessFlagSchema = z
  .string()
  .max(MAX_HARNESS_FLAG_LENGTH)
  .refine(value => !/\p{Cc}/u.test(value), 'a harness flag may not contain a control character');

const StartSessionBaseSchema = z.strictObject({
  /**
   * The runtime to start on. Omitted, a start uses this machine's "Default runtime for new agents"
   * (T, session-spec.html Settings) — resolved daemon-side, never guessed by a client — and is
   * refused when nothing resolves (`unknown_agent`, naming the machine setting to use instead).
   */
  agent: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  teammate: z.string().min(1).optional(),
  teammateFallback: z.boolean().optional(),
  label: z.string().min(1).optional(),
  parent: z.string().min(1).optional(),
  boardAccess: TaskBoardAccessSchema.default('none'),
  cwd: z.string().min(1).optional(),
  remoteControl: z.boolean().optional(),
  harnessFlags: z.array(HarnessFlagSchema).max(MAX_HARNESS_FLAGS).optional(),
  model: z.string().min(1).optional(),
  /**
   * Opaque startup reasoning choice. The selected account's live runtime decision validates the
   * value; the protocol deliberately does not own a second harness effort enum.
   */
  effort: z.string().min(1).optional(),
  /** Launch in the harness's fast mode. Refused when the chosen model has none; omitted leaves it off. */
  fast: z.boolean().optional(),
  intervalSeconds: PositiveIntegerSchema.optional(),
  timeoutSeconds: NonNegativeIntegerSchema.optional(),
  nudgeAfterSeconds: NonNegativeIntegerSchema.optional(),
  killAfterSeconds: NonNegativeIntegerSchema.optional(),
  directSendMaxChars: NonNegativeIntegerSchema.optional(),
  resumeMenuChoice: z.enum(['full', 'summary']).optional(),
  maxSnapshots: PositiveIntegerSchema.optional(),
  detach: z.boolean().optional(),
  initialAttachments: z
    .array(
      z.strictObject({
        filename: z.string().min(1),
        mime: z.string().min(1).optional(),
        base64: z
          .string()
          .min(1)
          .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u),
      }),
    )
    .optional(),
});

export const StartSessionRequestSchema = z
  .discriminatedUnion('mode', [
    StartSessionBaseSchema.extend({ mode: z.literal('auto'), prompt: z.string().trim().min(1) }),
    StartSessionBaseSchema.extend({ mode: z.literal('interactive'), prompt: z.string().trim().min(1).optional() }),
  ])
  .superRefine((value, context) => {
    if (value.boardAccess !== 'none' && value.parent === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'parent is required when board access is requested',
        path: ['parent'],
      });
    }
    if (value.boardAccess !== 'none' && value.mode !== 'auto') {
      context.addIssue({
        code: 'custom',
        message: 'board access is available only for auto sessions',
        path: ['boardAccess'],
      });
    }
  });
export type StartSessionRequest = z.infer<typeof StartSessionRequestSchema>;
export type StartSessionRequestInput = z.input<typeof StartSessionRequestSchema>;

/** Client-authored fields only; actor identity and idempotency come from headers. */
export const SendRequestSchema = z.strictObject({
  message: z.string().min(1),
  attachmentIds: z.array(z.string()).optional(),
  now: z.boolean().optional(),
  replyExpected: z.boolean().optional(),
});
export type SendRequest = z.infer<typeof SendRequestSchema>;

/**
 * One answer in an ordered structured-question set.
 *
 * The legacy `labels`/`other`/`responses` fields below cannot represent a
 * multi-select question inside a multi-question set: `responses` has room for
 * only one string per question.  This discriminated shape is deliberately
 * exclusive, so a free-form answer can never be mistaken for an option label,
 * and preserves every selected label in question order.
 */
export const StructuredQuestionAnswerSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('selection'),
    labels: z.array(z.string().min(1)).min(1),
  }),
  z.strictObject({
    kind: z.literal('other'),
    text: z.string().trim().min(1),
  }),
]);
export type StructuredQuestionAnswer = z.infer<typeof StructuredQuestionAnswerSchema>;

export const AnswerSessionRequestSchema = z.strictObject({
  toolUseId: z.string().min(1),
  labels: z.array(z.string().min(1)),
  other: z.string().optional(),
  responses: z.array(z.string()).optional(),
  /** Lossless ordered answers. Legacy fields remain for older callers. */
  answers: z.array(StructuredQuestionAnswerSchema).min(1).optional(),
});
export type AnswerSessionRequest = z.infer<typeof AnswerSessionRequestSchema>;

export const InterruptSessionRequestSchema = z.strictObject({ toolUseId: z.string().min(1).optional() });
export type InterruptSessionRequest = z.infer<typeof InterruptSessionRequestSchema>;

export const StopSessionRequestSchema = z.strictObject({
  reason: z.string().min(1).optional(),
});
export type StopSessionRequest = z.infer<typeof StopSessionRequestSchema>;

export const ResumeSessionRequestSchema = z.strictObject({
  message: z.string().min(1).optional(),
});
export type ResumeSessionRequest = z.infer<typeof ResumeSessionRequestSchema>;

/**
 * What a Restart or a same-harness migration does with the conversation the session is bound to.
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
export const MigrationConversationSchema = z.enum(['resume', 'fresh', 'previous', 'convert']);
export type MigrationConversation = z.infer<typeof MigrationConversationSchema>;

export const MigrateSessionRequestSchema = z.strictObject({
  agent: z.string().min(1),
  model: z.string().min(1).optional(),
  allowContextDowngrade: z.boolean().default(false),
  /** Proceed past a refusal the in-flight inventory raised. Only an explicit, human-confirmed Restart anyway sets it. */
  forceInflight: z.boolean().default(false),
  /**
   * What happens to the conversation the session is bound to; omitted means `resume`. See
   * {@link MigrationConversationSchema}. Optional rather than defaulted so a client never sends it
   * unasked: a daemon that predates the field refuses an unknown key, and Restart must keep working there.
   */
  conversation: MigrationConversationSchema.optional(),
});
export type MigrateSessionRequest = z.infer<typeof MigrateSessionRequestSchema>;
export type MigrateSessionRequestInput = z.input<typeof MigrateSessionRequestSchema>;

/** `POST /v1/sessions/:sessionId/conversion-preview`: what converting onto `agent` would carry. */
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
  sourceHarness: HarnessSchema,
  sourceVersion: z.string().min(1).optional(),
  targetHarness: HarnessSchema,
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
});
export type InflightItem = z.infer<typeof InflightItemSchema>;

/**
 * Why a Restart (a migration) was refused, as data. `restartsWithCli` counts the processes the
 * inventory recognised as the agent's own — the Ferretry tools server, the harness's helpers, servers
 * from its configuration — which a restart relaunches and which therefore never block it.
 */
export const MigrationRefusalSchema = z.strictObject({
  status: z.string().min(1),
  turn: NonNegativeIntegerSchema,
  blockedBy: z.enum(['unknown', 'destructive', 'unreadable']),
  items: z.array(InflightItemSchema),
  restartsWithCli: NonNegativeIntegerSchema,
});
export type MigrationRefusal = z.infer<typeof MigrationRefusalSchema>;

/** The `409 migration_refused` body. `inflight` is absent from a daemon that predates it. */
export const MigrationRefusedBodySchema = ApiErrorResponseSchema.extend({
  code: z.literal('migration_refused'),
  inflight: MigrationRefusalSchema.optional(),
});
export type MigrationRefusedBody = z.infer<typeof MigrationRefusedBodySchema>;

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

/**
 * An agent's first name as a caller may type it: `Hadi`, `marin`, `mary-jane`.
 *
 * It is the session's `teammate` callsign — the one fact the list, the header, the picker, the chips
 * and the notifications all read — so its grammar is the callsign's: a letter, then letters, digits
 * or hyphens, at most {@link AGENT_NAME_MAX_LENGTH} characters. Case is not part of the name: the
 * daemon stores it lowercase and every surface title-cases it for display, so `Hadi` and `hadi` are
 * one name and cannot belong to two agents.
 */
export const AGENT_NAME_MAX_LENGTH = 32;
export const AgentNameSchema = z
  .string()
  .trim()
  .min(1, 'a name must not be empty')
  .max(AGENT_NAME_MAX_LENGTH, `a name must be at most ${AGENT_NAME_MAX_LENGTH} characters`)
  .regex(/^[A-Za-z][A-Za-z0-9-]*$/, 'a name must start with a letter and contain only letters, digits or hyphens');

export const RenameSessionRequestSchema = z
  .strictObject({
    name: z.string().trim().min(1).optional(),
    teammate: AgentNameSchema.optional(),
    clearParent: z.boolean().optional(),
  })
  .superRefine((value, context) => {
    if (value.name === undefined && value.teammate === undefined && value.clearParent !== true) {
      context.addIssue({ code: 'custom', message: 'name, teammate, or clearParent is required' });
    }
  });
export type RenameSessionRequest = z.infer<typeof RenameSessionRequestSchema>;

/** `PATCH /v1/sessions/:sessionId/hypermedia` — switch whether one ferret is told to use hypermedia. */
export const SessionHypermediaPatchSchema = z.strictObject({ enabled: z.boolean() });
export type SessionHypermediaPatch = z.infer<typeof SessionHypermediaPatchSchema>;

/**
 * What switching it did. Nothing is sent to the ferret: its instructions were fixed at launch, so a
 * RUNNING ferret takes the change at its next launch (`restartRequired`), and `note` says so in words.
 */
export const SessionHypermediaPatchResultSchema = z.strictObject({
  view: SessionViewSchema,
  restartRequired: z.boolean(),
  note: z.string().min(1),
});
export type SessionHypermediaPatchResult = z.infer<typeof SessionHypermediaPatchResultSchema>;

/**
 * What the transport did, said at the moment the send returns. `sent` is a busy pane that took the
 * keys without yet proving the harness is holding them: the ledger fate (`fate`) says where it is.
 */
export const SendDispositionSchema = z.enum(['delivered', 'queued', 'sent', 'revived', 'queued-for-revive']);
export type SendDisposition = z.infer<typeof SendDispositionSchema>;

export const SendResultSchema = SessionViewSchema.extend({
  disposition: SendDispositionSchema,
  /** The ledger id this send is tracked under: the request id the client sent. */
  sendId: z.string().min(1).optional(),
  /** The ledger fate as of the answer; read the send later for where it settled. */
  fate: SendFateSchema.optional(),
});
export type SendResult = z.infer<typeof SendResultSchema>;

export const SignalKindSchema = z.enum(['done', 'help', 'waiting', 'working']);
export type SignalKind = z.infer<typeof SignalKindSchema>;

export const SignalOptionsSchema = z.strictObject({
  until: z.string().min(1).optional(),
  condition: z.string().min(1).optional(),
  peer: z.string().min(1).optional(),
});
export type SignalOptions = z.infer<typeof SignalOptionsSchema>;

/** How much of a live pane a snapshot read returns: the whole scrollback, or only the visible frame. */
export const SnapshotScopeSchema = z.enum(['history', 'screen']);
export type SnapshotScope = z.infer<typeof SnapshotScopeSchema>;

export const SignalSessionRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('done'), message: z.string().min(1).optional() }),
  z.strictObject({ kind: z.literal('help'), message: z.string().min(1) }),
  z.strictObject({
    kind: z.literal('waiting'),
    message: z.string().min(1).optional(),
    until: z.string().min(1).optional(),
    condition: z.string().min(1).optional(),
    peer: z.string().min(1).optional(),
  }),
  z.strictObject({ kind: z.literal('working'), message: z.string().min(1).optional() }),
]);
export type SignalSessionRequest = z.infer<typeof SignalSessionRequestSchema>;
