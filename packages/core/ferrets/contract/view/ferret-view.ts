/**
 * THE FERRET VIEW (§2.2): one ferret as a reader sees it — its effective configuration, its public state (status,
 * whose turn it is, the live prompt, the question it is asking), whether it can be brought back, how full its context
 * is. Today's session view, moved into the contract whole so the app's chat and the daemon parse ONE shape; the
 * daemon builds it, every surface reads it.
 */
import { z } from 'zod';
import { SessionProvenanceSchema, SessionTransferEdgeSchema, TranscriptProvenanceSchema } from '../records.ts';
import { SessionAgendaSummarySchema } from './agenda.ts';
import { BoardProjectIdSchema, BoardSkipSchema, TaskRefSchema } from './board-refs.ts';
import { InstantSchema, NonNegativeFiniteSchema, NonNegativeIntegerSchema, PositiveIntegerSchema } from './common.ts';
import { CompactAtSchema } from './compact-at.ts';
import { ProviderQuotaBalanceSchema } from './fleet-credentials.ts';
import { HarnessSchema, SessionStatusSchema } from './session-base.ts';
import { HarnessDialogSchema } from './session-dialog.ts';
import { PermissionRequestSchema } from './session-permission.ts';

export const InteractionModeSchema = z.enum(['auto', 'interactive']);
export type InteractionMode = z.infer<typeof InteractionModeSchema>;

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

export const PendingQuestionOptionSchema = z.object({
  label: z.string().min(1),
  description: z.string().optional(),
});
/** @pending ferrets: The 5.0 ferret record carries no turn state, model, effort, limits or context */
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
/** @pending ferrets: The 5.0 ferret record carries no turn state, model, effort, limits or context */
export type PendingQuestion = z.infer<typeof PendingQuestionSchema>;

const RetryPolicySchema = z.object({
  transientAttempts: NonNegativeIntegerSchema,
  stalledAttempts: NonNegativeIntegerSchema,
  waitForQuotaReset: z.boolean(),
  allowAccountFailover: z.boolean(),
});

/**
 * Where a session's conversation came from, when a cross-harness move converted it
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
/** @pending ferrets: Continue-conversation (resume a finished ferret */
export type ConversationConversion = z.infer<typeof ConversationConversionSchema>;

/** Effective, safe-to-publish session configuration. */
export const SessionConfigSchema = z.object({
  id: z.string().min(1),
  incarnation: z.string().min(1),
  runtimeGeneration: PositiveIntegerSchema,
  name: z.string().min(1),
  /**
   * Who chose `name`. `auto`: the daemon titled the session itself (from its focus card or its first owner
   * message) and may retitle it; `owner`: a person or `--name` chose it and nothing overrides it. Absent on a
   * session older than the field: its name is the owner's, except the bare `interactive` placeholder.
   */
  nameSource: z.enum(['auto', 'owner']).optional(),
  teammate: z.string().optional(),
  label: z.string().optional(),
  parent: z.string().optional(),
  /**
   * A person revoked this session's credential (`fy session revoke-credential`, docs/agent-tools.md): no launch
   * hands it one again — no Warden revive, peer resume, restart or move — until a person resumes it. Absent
   * on every session that was never cut off.
   */
  credentialRevoked: z.literal(true).optional(),
  /**
   * The board this session works on (`board-design.md` §2.2): resolved once at start — inherited from the
   * parent, else the project its cwd is in, else `unfiled` — and kept. Absent for a session started before
   * boards existed.
   */
  projectId: BoardProjectIdSchema.optional(),
  /**
   * The one card this session's activity is attributed to ("last touched"). Set when the session's card is
   * created, by `fy task focus`, and by any write the session makes to a card. Absent: no card yet.
   */
  focusTask: TaskRefSchema.optional(),
  /**
   * The card this session's own delegations go under: set only on purpose (`fy task focus`, creating a card, or the
   * card a start gave it), never by merely writing to a card. `focusTask` follows every touch; this does not.
   */
  focusAnchor: TaskRefSchema.optional(),
  /**
   * Why this session's work has no card (`fy task skip`): the turn-end check stays quiet while it stands. Cleared
   * when the session takes a card, so it covers the work it was recorded for and no later ask.
   */
  boardSkip: BoardSkipSchema.optional(),
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
  move: z
    .object({
      from: z.string().min(1),
      to: z.string().min(1),
      at: InstantSchema,
    })
    .optional(),
  /**
   * EVERY move this session made, oldest first — `move` is only the last. What a spend budget books a
   * request against (docs/budgets.md): the login the session ran on when the request was made. Absent until
   * the first move.
   */
  moves: z
    .array(z.object({ from: z.string().min(1), to: z.string().min(1), at: InstantSchema }))
    .max(1_000)
    .optional(),
  /** Target-only lineage back to the transfer decision that created this fresh session. */
  transferredFrom: SessionTransferEdgeSchema.optional(),
  /** Where the conversation came from, when a cross-harness move converted it. */
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
  /**
   * Whether this ferret is told to keep an agenda of items for the owner (docs/agenda.md). ABSENT MEANS OFF, unlike
   * hypermedia and Pack: a ferret that recorded nothing is off, a new ferret records ON from the machine default
   * (`machine.yaml` agendaMode), and it is recorded ON for a ferret that already had open items. Read at launch, so a change takes effect at the next launch.
   */
  agenda: z.boolean().optional(),
  /**
   * Where this ferret's harness compacts its own conversation, in tokens, or `auto` for the harness's own trigger
   * (docs/compact-at.md). ABSENT MEANS THE LOGIN'S DEFAULT (the runtime's `compactAt`, else `auto`), so a session
   * that recorded nothing follows it. Read at launch AND on every relaunch, so a change reaches a running ferret at
   * its next restart.
   */
  compactAt: CompactAtSchema.optional(),
});
export type SessionConfig = z.infer<typeof SessionConfigSchema>;

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

export const AccountUnavailableReasonSchema = z.enum(['cooldown', 'spend_limit', 'auth', 'provider', 'no_credentials']);

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
  /** The harness's own words for the limit Ferretry read this session as `rate_limited` on (a pane dialog or a
   *  transcript record) — present exactly while that reading holds. */
  limitNotice: z.string().min(1).optional(),
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
 * composes them (`@ferretry/fleet` `launchInstructions`): the tools, the settings rules, the notify rule and the board rules every agent
 * gets, then each per-ferret section its launch switched on. `attention` is the notify rule's old name, kept so a
 * launch record made before the rename still parses.
 */
export const LaunchInstructionSectionIdSchema = z.enum([
  'tools',
  'settings',
  'attention',
  'notify',
  'board',
  'sub-ferret',
  'hypermedia',
  'pack',
  'agenda',
  'learning',
]);
export type LaunchInstructionSectionId = z.infer<typeof LaunchInstructionSectionIdSchema>;

/**
 * One appended section, by name and size. The text itself is never carried — only a short fingerprint of it
 * (`@ferretry/fleet` `instructionDigest`), so the daemon can tell which sections changed since the launch
 * (live-patched, or outdated until a restart). Absent on a record made before fingerprints were kept.
 */
export const LaunchInstructionSectionSchema = z.object({
  id: LaunchInstructionSectionIdSchema,
  chars: NonNegativeIntegerSchema,
  digest: z.string().min(1).max(64).optional(),
});
export type LaunchInstructionSection = z.infer<typeof LaunchInstructionSectionSchema>;

/**
 * What one launch of a session was told, recorded when its pane was built: which Ferretry
 * system-prompt sections it carried, its mode, and whether it may ask the owner a question.
 *
 * A LAUNCH FACT, refreshed by every launch and relaunch: a switch flipped while the session runs
 * reaches the agent only at its next launch, so the stored environment is not what it was told. The one
 * exception is an always-on section whose words changed: the daemon tells a running ferret the new words
 * once, with its owner's next message, and then records that section as told (docs/launch-settings.md).
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
  /** The open agenda items waiting on the owner; absent when none is open. */
  agenda: SessionAgendaSummarySchema.optional(),
  contextPercent: z.number().finite().min(0).max(100).optional(),
  contextTokens: NonNegativeIntegerSchema.optional(),
  /** When the transcript record `contextTokens` was read from was written. */
  contextAt: InstantSchema.optional(),
  contextWindow: PositiveIntegerSchema.optional(),
  usage5hPercent: z.number().finite().min(0).max(100).optional(),
  usageWeeklyPercent: z.number().finite().min(0).max(100).optional(),
  usage5hResetAt: NonNegativeFiniteSchema.optional(),
  usageWeeklyResetAt: NonNegativeFiniteSchema.optional(),
  usageAtLimit: z.boolean().optional(),
  usageAuthOk: z.boolean().optional(),
  launchedAt: InstantSchema.optional(),
  /**
   * How long the harness took, from launch, to take its first turn and finish its own startup. Codex 0.166+ waits
   * on an account check with chatgpt.com, so a large value is the network. Absent for a session launched before it
   * was measured, or one whose start launched nothing.
   */
  harnessStartupMs: NonNegativeIntegerSchema.optional(),
  /**
   * How long the start waited for the harness to finish its own startup before giving up. Set instead of
   * `harnessStartupMs`, by the same launch, when the harness was still starting (a parked first turn) at the
   * bound; it is a lower bound on the startup, not a startup time.
   */
  harnessNotReadyAfterMs: NonNegativeIntegerSchema.optional(),
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

/**
 * A running ferret whose appended system prompt is not what a launch now would give it: the sections that
 * differ (changed words, or a section switched on or off), minus any the daemon already told it in a
 * live `[instructions updated]` turn. Derived when the view is read, never stored.
 */
export const SessionOutdatedSchema = z.strictObject({
  sections: z.array(LaunchInstructionSectionIdSchema).min(1),
});

/**
 * Whether a session can be brought back, with the reason in words: the one answer every Resume button
 * reads, so no surface decides it from the status on its own. Derived when the view is read, never stored.
 */
export const SessionReviveSchema = z.strictObject({
  revivable: z.boolean(),
  reason: z.string().min(1),
});
export type SessionRevive = z.infer<typeof SessionReviveSchema>;

/**
 * How full a session's context window is, from the newest usage the harness recorded.
 *
 * Derived when the view is read, never stored: the stored facts are the harness's own token count
 * (`contextTokens`, `contextAt`) and the daemon resolves the window from the model evidence it holds. It
 * is ABSENT whenever either half is unknown — no usage record yet, or a model whose window nothing states —
 * because a ring filled from a guessed window is a lie about a measurement.
 */
export const FerretContextSchema = z.strictObject({
  /** Tokens the newest model call carried: input plus cache reads and writes. */
  usedTokens: NonNegativeIntegerSchema,
  /** The model's context window in tokens. */
  windowTokens: PositiveIntegerSchema,
  /** `usedTokens` over `windowTokens`, one decimal, never above 100. */
  percent: z.number().finite().min(0).max(100),
  /** When the usage record was written. */
  at: InstantSchema,
});
export type FerretContext = z.infer<typeof FerretContextSchema>;

/** Public reads never carry the launch-time rollout exclusion set; discovery reads stored config. */
export const FerretViewConfigSchema = SessionConfigSchema.extend({
  transcript: TranscriptProvenanceSchema.transform(({ baseline: _baseline, ...provenance }) => provenance).optional(),
});

export const FerretViewSchema = z.object({
  config: FerretViewConfigSchema,
  state: SessionStateSchema,
  /** Whether this session can be brought back, and why (or why not); see {@link SessionReviveSchema}. Absent from a daemon that predates it. */
  revive: SessionReviveSchema.optional(),
  /** Present only while the running ferret carries out-of-date instructions (`fy restart --outdated`). */
  outdated: SessionOutdatedSchema.optional(),
  /** How full the context window is; absent while unknown (see {@link FerretContextSchema}). */
  context: FerretContextSchema.optional(),
  /**
   * When the owner pinned this ferret to the top of the sidebar; absent while it is not pinned. Derived when
   * the view is read from the owner's pin list, never part of the session's own config, so it rides the
   * polled list to every device the owner has open.
   */
  pinnedAt: InstantSchema.optional(),
  directory: z.string().min(1),
  /**
   * The highest event sequence this session's journal held when the view was read: where a reader
   * that has just read the session can start `/v1/events?after=` instead of replaying the whole
   * history. Absent from a daemon that predates it, which a reader takes as `0`.
   */
  journalSequence: NonNegativeIntegerSchema.optional(),
});
export type FerretView = z.infer<typeof FerretViewSchema>;
