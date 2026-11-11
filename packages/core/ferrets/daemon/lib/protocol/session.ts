import { z } from 'zod';
import { PEER_MESSAGE_LABELS } from './agent-messages.ts';
import { BoardTaskIdSchema } from './board-refs.ts';
import { InstantSchema, NonNegativeIntegerSchema, PositiveIntegerSchema } from './common.ts';
import { CompactAtSchema } from './compact-at.ts';
import { HarnessSchema, SessionStatusSchema } from './session-base.ts';
import { QueueWaitReasonSchema } from './session-queue-wait.ts';
import { SharedDraftSentSchema } from './shared-draft.ts';
import { FerretViewSchema, type SessionConfig } from '../../../contract/view/ferret-view.ts';

/**
 * The ferret view is the contract's (`contract/view/ferret-view.ts`): the app and the daemon parse one shape. The
 * daemon's bodies read it by the names they were written against.
 */
export {
  AccountAvailabilitySchema,
  AccountUnavailableReasonSchema,
  AccountUsageSchema,
  ConversationConversionSchema,
  FerretContextSchema as SessionContextSchema,
  type FerretView as SessionView,
  FerretViewConfigSchema as SessionViewConfigSchema,
  FerretViewSchema as SessionViewSchema,
  type InteractionMode,
  InteractionModeSchema,
  type LaunchInstructionSection,
  type LaunchInstructionSectionId,
  LaunchInstructionSectionIdSchema,
  LaunchInstructionSectionSchema,
  type PendingQuestion,
  PendingQuestionOptionSchema,
  PendingQuestionSchema,
  type SessionConfig,
  SessionConfigSchema,
  type SessionHealth,
  SessionHealthSchema,
  type SessionLaunchInstructions,
  SessionLaunchInstructionsSchema,
  SessionOutdatedSchema,
  type SessionRevive,
  SessionReviveSchema,
  type SessionState,
  SessionStateSchema,
  type SessionTurnState,
  SessionTurnStateSchema,
} from '../../../contract/view/ferret-view.ts';
export { HarnessSchema } from './session-base.ts';
/**
 * Re-exported here rather than added to the package barrel separately, because the stamp is a FIELD
 * of the session config below: a reader that has `SessionConfig` should reach its provenance shape
 * through the same module, not hunt for a second import path.
 */
export type { SessionProvenance } from './session-provenance.ts';
export { SessionProvenanceSchema, SessionSpawnOriginSchema, WardenLineageSourceSchema } from './session-provenance.ts';

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

export const SendPathSchema = z.enum(['direct', 'turn-file', 'native-inline', 'native-file', 'revive', 'revive-queue']);

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
  /**
   * Carried by a revive — written to the turn file the relaunch started on — and never proven in the
   * transcript. The agent may well have read it, so it is unconfirmed rather than not delivered.
   */
  'revive_unconfirmed',
  /**
   * Typed into the agent's composer, and the agent never showed it there in time: a stalled pane may
   * still draw it, or the keys were lost. It was not typed again, so it is unconfirmed, never a copy.
   */
  'landing_unconfirmed',
  /**
   * Its text sits in the agent's composer and the one Enter the daemon pressed for it did not take (B187): the agent
   * is idle with the message typed and not submitted. Raised once; the Warden's input-stuck takes it from there.
   */
  'typed_not_submitted',
  /** Proven absent after every attempt. */
  'not_delivered',
  /** Sent before the 5.0 update, and its transcript input cannot be told apart from another's: the person checks the chat. */
  'update_unconfirmed',
]);

/** Who asked for the message: a person, another agent, or the daemon itself (a failure notice). */
export const SendSenderKindSchema = z.enum(['human', 'agent', 'daemon']);

/**
 * WHO A MESSAGE IS FROM, AS DATA. The owner (2026-10-30): "there should not be any append or prepend on any
 * feature". Who sent a message and which feature it came from are never text in its body: the app reads
 * them from here and shows a sender chip — "Ferretry · Board", a ferret's name, nothing for the owner.
 */
export const QueueAuthorSchema = z.strictObject({
  kind: z.enum(['owner', 'ferret', 'ferretry']),
  /** A ferret's name (its callsign), for a ferret's message. */
  name: z.string().min(1).optional(),
  /** The part of Ferretry that sent it: Board, Warden, Agenda, Monitor, Lessons, Instructions. */
  feature: z.string().min(1).optional(),
  /**
   * What the message is about, by name, for a row that says so instead of showing the words: the always-on
   * instruction sections an `Instructions` message restates ("Board", "Notify"…).
   */
  sections: z.array(z.string().min(1).max(64)).min(1).max(16).optional(),
});
export type QueueAuthor = z.infer<typeof QueueAuthorSchema>;

/** How a `queued` fate was proven. */
export const SendQueueProofSchema = z.enum(['transcript', 'pane']);

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
  /** Who sent it, as data, when the send never went through the queue that would have said so (see {@link QueueAuthorSchema}). */
  by: QueueAuthorSchema.optional(),
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

/**
 * One page of a session's sends, newest first: without a cursor, the newest ones and every open one however old.
 * `nextCursor` is where the next, older page starts (`?before=`); absent from a daemon that answered the whole
 * ledger, and `null` once the oldest send is on the page.
 */
export const SendListResponseSchema = z.object({
  sends: z.array(SendRecordSchema),
  nextCursor: z.string().nullable().optional(),
});

/**
 * Re-attempting one send under its ORIGINAL id.
 *
 * `force` is the "send again anyway" path for an `unaccounted` send, whose original may have landed;
 * without it the daemon only re-attempts a send it has proven absent.
 */
export const SendRetryRequestSchema = z.strictObject({ force: z.boolean().optional() });

/**
 * Taking back one send that was not proven delivered: the record leaves the open queue, and a copy
 * sitting typed in the agent's composer is erased. Nothing else is accepted, so a body is refused.
 */
export const SendCancelRequestSchema = z.strictObject({});

/**
 * Pressing Enter ONCE for a send that is sitting typed in the agent's composer. Refused unless the
 * composer holds exactly that message, so it can never submit somebody else's draft.
 */
export const SendSubmitRequestSchema = z.strictObject({});

/**
 * The code a send answers with when the agent's composer already holds a PERSON's unsent text.
 *
 * A pointer Ferretry typed itself and never submitted is finished by the daemon rather than refused;
 * this is what is left — text only the person can decide about. The body carries that `draft` exactly
 * as the composer reads, so the app can offer "Send it" and "Clear it" for exactly that text.
 */
export const COMPOSER_OCCUPIED_CODE = 'composer_occupied';

/** Longest draft the composer routes will act on; a composer holding more is not a draft to tap away. */
const COMPOSER_DRAFT_MAX_CHARS = 20_000;

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
 * The code a send answers with when its message WAS typed into the agent's composer and the agent
 * never showed it there in time.
 *
 * Not a refusal — a key reached the pane — and not a loss: the message may be sitting in the agent's
 * box, or on its way to it from a pane too slow to draw it. The send is settled `unaccounted` with
 * `landing_unconfirmed` and still watched, and the body carries its `sendId` so the app can offer
 * "Send it" (press Enter on it), "Clear it" (cancel it) and "Retry" (send it again, which the daemon
 * types only when it can prove no copy is held) for exactly this send.
 */
export const SEND_UNCONFIRMED_CODE = 'send_unconfirmed';

const SendUnconfirmedBodySchema = z.object({
  code: z.literal(SEND_UNCONFIRMED_CODE),
  sendId: z.string().min(1),
});

/** The send a `send_unconfirmed` answer names, or `undefined` for any other body. */
export function unconfirmedSendId(body: unknown): string | undefined {
  const parsed = SendUnconfirmedBodySchema.safeParse(body);
  return parsed.success ? parsed.data.sendId : undefined;
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

/**
 * What acting on the draft did. `submitted` and `cleared` free the composer; `holding` is an Enter the
 * harness did not take; `absent` is a composer that is already empty; `changed` is a composer that no
 * longer holds exactly that draft, so nothing was pressed; `stuck` is an erase that stopped responding.
 */
export const ComposerDraftOutcomeSchema = z.enum(['submitted', 'holding', 'cleared', 'absent', 'changed', 'stuck']);

export const ComposerDraftResultSchema = z.object({
  action: z.enum(['submit', 'clear']),
  outcome: ComposerDraftOutcomeSchema,
});

export const RuntimeModelOptionSchema = z.object({
  value: z.string().min(1),
  label: z.string().min(1),
});

export const RuntimeReasoningChoiceSchema = z.object({
  value: z.string().min(1),
  description: z.string().optional(),
});

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

// Defined in session-base.ts, so a module that needs only the status vocabulary (the conversation import
// rows) does not load every schema this file holds; re-exported here, where it has always been found.
export { type SessionStatus, SessionStatusSchema } from './session-base.ts';

/** How a transcript was identified and where it lives: the contract owns both (`contract/records.ts`). */
export {
  TranscriptIdentitySchema,
  type TranscriptProvenance,
  TranscriptProvenanceSchema,
} from '../../../contract/records.ts';

/** Whether a ferret is told to keep an agenda, resolved: the recorded switch, else OFF (docs/agenda.md). */
export const sessionAgendaEnabled = (config: Pick<SessionConfig, 'agenda'>): boolean => config.agenda ?? false;

/**
 * Whether a ferret is told it may use hypermedia, resolved: the recorded switch, else the default for
 * its mode — ON for an interactive ferret, OFF for every auto one (a worker, a warden, a miner), which
 * has no reader to look at a picture (docs/hypermedia.md).
 */
export const sessionHypermediaEnabled = (config: Pick<SessionConfig, 'mode' | 'hypermedia'>): boolean =>
  config.hypermedia ?? config.mode === 'interactive';

export const SessionListSchema = z.array(FerretViewSchema);

/**
 * The older finished autonomous sessions the daemon has taken out of the live list — `GET /v1/archived-sessions`
 * (docs/session-archive.md). `count` is every archived session; `sessions` is the newest `limit` of them, read from
 * disk, so `limit=0` is the cheap way to ask only how many there are.
 */
export const ArchivedSessionsSchema = z.strictObject({
  count: NonNegativeIntegerSchema,
  sessions: z.array(FerretViewSchema),
});
export type ArchivedSessions = z.infer<typeof ArchivedSessionsSchema>;

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

/** How many bytes reached the pane: the UTF-8 length of `data`, never the bytes themselves. */
export const SessionConsoleInputResultSchema = z.strictObject({
  written: PositiveIntegerSchema,
});

export const NameSuggestionsSchema = z.array(z.string().min(1));

/** The journal event socket's shapes are the contract's (`contract/view/event-stream.ts`); the daemon reads them by today's names. */
export * from '../../../contract/view/event-stream.ts';

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
  cwd: z.string().min(1).optional(),
  /** An EXISTING card the new session works on (`start --card`): assigned to it, no second card made. Judged like `new --card`. */
  card: BoardTaskIdSchema.optional(),
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
  /** Compact the conversation at this many tokens, or `auto`. Refused outside the floor and the model's window. */
  compactAt: CompactAtSchema.optional(),
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

const StartSessionRequestShapeSchema = z.discriminatedUnion('mode', [
  StartSessionBaseSchema.extend({ mode: z.literal('auto'), prompt: z.string().trim().min(1) }),
  StartSessionBaseSchema.extend({ mode: z.literal('interactive'), prompt: z.string().trim().min(1).optional() }),
]);

export const StartSessionRequestSchema = StartSessionRequestShapeSchema;

/** Client-authored fields only; actor identity and idempotency come from headers. */
/** How soon a ferret's message is delivered: `blocker` at once, `action` combined, `fyi` held (`fy send --kind`). */
export const PeerMessageLabelSchema = z.enum(PEER_MESSAGE_LABELS);

export const SendRequestSchema = z.strictObject({
  message: z.string().min(1),
  attachmentIds: z.array(z.string()).optional(),
  now: z.boolean().optional(),
  replyExpected: z.boolean().optional(),
  /**
   * The sender's label for a ferret's message (`fy send --kind`). Absent means `action`; it is ignored
   * for the owner and the daemon, whose messages are never held.
   */
  label: PeerMessageLabelSchema.optional(),
  /** What this send takes out of the owner's shared draft once it is accepted (`shared-draft.ts`). */
  sharedDraft: SharedDraftSentSchema.optional(),
});

/**
 * One answer in an ordered structured-question set.
 *
 * The flat `labels`/`other`/`responses` fields below cannot represent a
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

export const AnswerSessionRequestSchema = z.strictObject({
  toolUseId: z.string().min(1),
  labels: z.array(z.string().min(1)),
  other: z.string().optional(),
  responses: z.array(z.string()).optional(),
  /** Lossless ordered answers, beside the flat fields. */
  answers: z.array(StructuredQuestionAnswerSchema).min(1).optional(),
});

export const InterruptSessionRequestSchema = z.strictObject({ toolUseId: z.string().min(1).optional() });

export const StopSessionRequestSchema = z.strictObject({
  reason: z.string().min(1).optional(),
});

export const ResumeSessionRequestSchema = z.strictObject({
  message: z.string().min(1).optional(),
});

/**
 * An agent's first name as a caller may type it: `Hadi`, `marin`, `mary-jane`.
 *
 * It is the session's `teammate` callsign — the one fact the list, the header, the picker, the chips
 * and the notifications all read — so its grammar is the callsign's: a letter, then letters, digits
 * or hyphens, at most {@link AGENT_NAME_MAX_LENGTH} characters. Case is not part of the name: the
 * daemon stores it lowercase and every surface title-cases it for display, so `Hadi` and `hadi` are
 * one name and cannot belong to two agents.
 */
const AGENT_NAME_MAX_LENGTH = 32;
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

/**
 * `POST /v1/sessions/:sessionId/revoke-credential` — a person cuts one ferret off at once
 * (docs/agent-tools.md § "Cutting a ferret off"). No body. The value its pane holds names nobody from
 * now on; a running pane keeps running, without `fy` or its tools, until its next launch is handed a
 * fresh one. The answer names the session and its status, never a credential or a hash.
 */
export const SessionCredentialRevokedSchema = z.strictObject({
  sessionId: z.string().min(1),
  status: SessionStatusSchema,
});

/** `PATCH /v1/sessions/:sessionId/hypermedia` — switch whether one ferret is told to use hypermedia. */
export const SessionHypermediaPatchSchema = z.strictObject({ enabled: z.boolean() });

/**
 * What switching it did. Nothing is sent to the ferret: its instructions were fixed at launch, so a
 * RUNNING ferret takes the change at its next launch (`restartRequired`), and `note` says so in words.
 */
export const SessionHypermediaPatchResultSchema = z.strictObject({
  view: FerretViewSchema,
  restartRequired: z.boolean(),
  note: z.string().min(1),
});

/**
 * What the transport did, said at the moment the send returns. `sent` is a busy pane that took the
 * keys without yet proving the harness is holding them: the ledger fate (`fate`) says where it is.
 */
export const SendDispositionSchema = z.enum(['delivered', 'queued', 'sent', 'revived', 'queued-for-revive']);

export const SendResultSchema = FerretViewSchema.extend({
  disposition: SendDispositionSchema,
  /** The ledger id this send is tracked under: the request id the client sent. */
  sendId: z.string().min(1).optional(),
  /** The ledger fate as of the answer; read the send later for where it settled. */
  fate: SendFateSchema.optional(),
  /**
   * Set when the message is still in FERRETRY's queue — not typed yet, so not in the agent's own queue —
   * and why it waits there. Absent once a key has gone to the pane.
   */
  waitReason: QueueWaitReasonSchema.optional(),
  /**
   * Beside a `draft` wait: the earlier send of Ferretry's own whose text sits typed and unsubmitted in the
   * agent's box. Ferretry pressed Enter on it (bounded) and it did not take; the Warden escalates it.
   */
  waitBehind: z.string().min(1).optional(),
  /** The label the message was queued with, when it is a ferret's. */
  label: PeerMessageLabelSchema.optional(),
  /**
   * Beside a label: the instant the queue stops holding the message to combine it with others. Not typed
   * yet, and not a failure — it is delivered at this time at the latest, or sooner when something frees it.
   */
  heldUntil: InstantSchema.optional(),
});

export const SignalKindSchema = z.enum(['done', 'help', 'waiting', 'working']);

export const SignalOptionsSchema = z.strictObject({
  until: z.string().min(1).optional(),
  condition: z.string().min(1).optional(),
  peer: z.string().min(1).optional(),
});

/** How much of a live pane a snapshot read returns: the whole scrollback, or only the visible frame. */
export const SnapshotScopeSchema = z.enum(['history', 'screen']);

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

/** The name an interactive session carries until it has a card or a first message to be titled from. */
export const INTERACTIVE_PLACEHOLDER_NAME = 'interactive';

/** Whether a session name is only the placeholder — it says the mode, not the work, so no surface may print it. */
export const isPlaceholderSessionName = (name: string): boolean =>
  name.trim().toLowerCase() === INTERACTIVE_PLACEHOLDER_NAME;
