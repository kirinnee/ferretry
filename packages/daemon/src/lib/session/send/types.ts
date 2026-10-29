import type {
  SendCancelEffect,
  SendDisposition,
  SendEvidence,
  SendQueueProof,
  SendUnaccountedReason,
  SessionHealth,
  SessionStatus,
} from '@ferretry/protocol';
import type { SessionId } from '../../session-id.ts';

/**
 * Handing a RUNNING session its next turn — the verb the daemon declared on the wire and could not
 * serve.
 *
 * The lifecycle delivers turn one and the revive replaces a dead pane; between those two there was
 * nothing, so a session that was started could never be spoken to again. Three consequences, none of
 * them cosmetic:
 *
 *   * `packages/cli/src/lib/session/send-controller.ts` shipped complete — planning, attachments,
 *     the `--ask` park — and posted to a route that answered `unknown_route`.
 *   * A DECLARED WAIT ON A PEER COULD NEVER END. `SessionSignalService.park` resolves the peer whose
 *     reply ends the wait, and the reply is a send. Without one, every `--peer` park ran to its
 *     deadline and the request/response pattern the two halves were built for did not exist.
 *   * PEER MESSAGING WAS UNREACHABLE. A teammate could be started by another agent and never told
 *     anything after its first turn.
 *
 * WHAT A SEND IS NOT: a durable promise of delivery. The daemon can prove a payload reached the
 * composer and left it; it cannot prove the agent read it. `SendFate` is that distinction, and it is
 * why `accepted` is written before a single keystroke — see `SendRecord`.
 */

/**
 * How a message physically reached (or will reach) the agent.
 *
 * The path is a TRANSPORT fact, decided from the pane, and it is what `SendDisposition` on the wire
 * is derived from. Keeping the two separate is deliberate: the wire vocabulary is four words a human
 * reads, and the ledger needs to distinguish an inline native queue from a file-backed one because
 * only the second leaves a payload file behind to clean up.
 */
export type SendPath =
  /** Typed verbatim into an idle composer and submitted. Short, single-line payloads only. */
  | 'direct'
  /** Written to a turn document; the composer receives the instruction to open it. */
  | 'turn-file'
  /** Typed into a BUSY pane's composer, riding the harness's own queue to the turn boundary. */
  | 'native-inline'
  /** The same, but the payload was too long to type: the composer gets a pointer to a file. */
  | 'native-file'
  /** The session was terminal or its pane was gone: the message became a revive's first turn. */
  | 'revive'
  /** The revive was refused, so the message is held durably for an explicit one. */
  | 'revive-queue';

/**
 * What the daemon KNOWS about a send, as distinct from what it hoped.
 *
 * `accepted` is written before any keystroke, so a crash mid-transport leaves evidence rather than
 * silence. Every later fate is written by the tracker (`tracker.ts`) and ONLY on proof:
 *
 *   * `queued` — the harness itself is holding it: a Claude queue record in the transcript, or the
 *     pane still showing the payload after the queue key. A busy pane alone proves nothing.
 *   * `delivered` — the message appears as a user turn in the transcript.
 *   * `timed_out` — proven ABSENT after every attempt: not in the transcript, not held by the
 *     harness, not in the composer. Only this fate may be re-attempted under the same id freely.
 *   * `unaccounted` — it could be proven neither way. It may have landed.
 *   * `withdrawn` — nothing was ever typed; the id may honestly start over.
 *   * `cancelled` — a person took it back; `cancelEffect` says what that did on the agent's screen.
 */
export type SendFate = 'accepted' | 'queued' | 'delivered' | 'unaccounted' | 'timed_out' | 'withdrawn' | 'cancelled';

/** Who asked for a send, which decides who may retry it: a person by hand, the daemon for an agent. */
export type SendSenderKind = 'human' | 'agent' | 'daemon';

/** The wire word for each transport path. The only place the two vocabularies meet. */
const DISPOSITIONS: Readonly<Record<SendPath, SendDisposition>> = {
  direct: 'delivered',
  'turn-file': 'delivered',
  'native-inline': 'queued',
  'native-file': 'queued',
  revive: 'revived',
  'revive-queue': 'queued-for-revive',
};

/**
 * What the client is told happened, given how the message physically travelled.
 *
 * A busy-pane send is `queued` ONLY when the harness was proven to be holding it; one that merely went
 * into a busy pane is `sent`, and the ledger fate says where it settles.
 */
export function dispositionOf(path: SendPath, held = true): SendDisposition {
  const disposition = DISPOSITIONS[path];
  return disposition === 'queued' && !held ? 'sent' : disposition;
}

/**
 * One send, durably, from the instant it was accepted.
 *
 * `matchText` is what the tracker looks for in the transcript — the composer text for a direct send,
 * the turn instruction for a turn-file one, and whatever the relaunch typed for a revive — which the
 * reviver reports once it has typed it, so a revive still relaunching has none yet. It is recorded by
 * the only code that knows what was typed, so the tracker does not have to re-derive it.
 */
export interface SendRecord {
  /** The caller's idempotency key. A retry with the same one must never become a second message. */
  readonly sendId: string;
  readonly acceptedAt: string;
  /** The turn the session was on when this was accepted, which a later turn bump does not change. */
  readonly acceptedTurn: number;
  readonly path: SendPath;
  readonly message: string;
  readonly matchText?: string | undefined;
  /** The turn this send STARTS, when it starts one. Absent for a native-queue ride. */
  readonly turn?: number | undefined;
  readonly attachmentIds?: readonly string[] | undefined;
  /** The sending session, present only for peer-to-peer messages. Its absence means a human sent it. */
  readonly from?: string | undefined;
  readonly fromName?: string | undefined;
  readonly senderKind?: SendSenderKind | undefined;
  /** The sender is parked on a reply, so the receiver is told the exact command that unblocks them. */
  readonly replyExpected?: boolean | undefined;
  /** The file a file-backed payload was written to, so a failed transport does not lose the text. */
  readonly payloadFile?: string | undefined;
  /** Retained for an explicit revive rather than transported now. */
  readonly held?: boolean | undefined;
  readonly fate: SendFate;
  /** When the current fate was proven. */
  readonly fateAt?: string | undefined;
  /** The transcript record a `delivered` fate cites. */
  readonly evidence?: SendEvidence | undefined;
  /** Why an `unaccounted` or `timed_out` send settled where it did. */
  readonly unaccountedReason?: SendUnaccountedReason | undefined;
  readonly queuedAt?: string | undefined;
  readonly queueProof?: SendQueueProof | undefined;
  /** 1 for the first transport; each re-attempt under the same id adds one. */
  readonly attempt?: number | undefined;
  readonly attemptAt?: string | undefined;
  /** An extended re-check instant, written when the harness is still visibly holding the message. */
  readonly deadlineAt?: string | undefined;
  /** True only on a `timed_out` send the daemon proved absent and a re-attempt could reach. */
  readonly retryable?: boolean | undefined;
  /** The pane shows it typed in the composer and not submitted, as of the last look. */
  readonly typedNotSent?: boolean | undefined;
  /**
   * Enters the daemon pressed for this attempt's pointer after it was left typed in the composer —
   * bounded per attempt, and the daemon's own bookkeeping: it never leaves the daemon.
   */
  readonly submitNudges?: number | undefined;
  /**
   * A re-attempt typed it into a BUSY pane. With a first transport that rode a harness queue, this
   * is what `typedIntoBusyPane` reads, and the daemon's own bookkeeping: it never leaves the daemon.
   */
  readonly busyTyped?: boolean | undefined;
  /** What a `cancelled` fate did to the agent's screen. */
  readonly cancelEffect?: SendCancelEffect | undefined;
}

/** The fields the tracker and a re-attempt may move on an existing record. */
export type SendSettlement = Partial<
  Pick<
    SendRecord,
    | 'fate'
    | 'fateAt'
    | 'evidence'
    | 'unaccountedReason'
    | 'queuedAt'
    | 'queueProof'
    | 'attempt'
    | 'attemptAt'
    | 'deadlineAt'
    | 'retryable'
    | 'typedNotSent'
    | 'submitNudges'
    | 'busyTyped'
    | 'cancelEffect'
    | 'held'
    | 'path'
    | 'matchText'
    | 'turn'
    | 'payloadFile'
  >
>;

/** What the pane itself shows, independent of what any record claims. */
export interface SendPaneObservation {
  readonly alive: boolean;
  /** The pane exists but its process is gone — a shell that outlived its agent. */
  readonly dead: boolean;
  /** The harness is at a prompt and will accept typed input. */
  readonly promptReady: boolean;
  /** The harness is visibly mid-turn. A pane can be neither prompt-ready nor working: a human's
   *  half-typed draft is exactly that, and it must not be treated as busy. */
  readonly activeWork: boolean;
  /** A harness dialog the pane is parked on, in the words a person is shown for it. */
  readonly blockingPrompt?: string | undefined;
  /**
   * Input already typed in the composer and not submitted. Anything typed now would be submitted
   * joined to it, so a send refuses rather than type.
   */
  readonly draft?: string | undefined;
}

/** One session, as everything in this slice reads it. */
export interface SendTarget {
  readonly id: SessionId;
  readonly status: SessionStatus;
  readonly mode: 'auto' | 'interactive';
  /** Which TUI is in the pane. The stop key is safe at an idle prompt in one of them and quits the
   *  other, so the harness decides whether a stop may be pressed at all. */
  readonly harness?: string | undefined;
  readonly turn: number;
  readonly teammate?: string | undefined;
  /** The document's own belief about the composer, used when the transcript-derived status lags. */
  readonly promptReady?: boolean | undefined;
  /** Set when the session is quarantined awaiting a person; the value names why. */
  readonly needsHumanKind?: string | undefined;
  /** A structured question the agent asked and nobody answered. */
  readonly pendingQuestion?: { readonly toolUseId: string } | undefined;
  /** The session's own ceiling on a verbatim composer send, from its configuration. */
  readonly directSendMaxChars?: number | undefined;
  /** A declared wait, so a reply from the session it names can end it. */
  readonly waiting?: { readonly peer?: string | undefined; readonly peerName?: string | undefined } | undefined;
}

/**
 * Statuses from which the pane is not a place to type.
 *
 * The three the resume domain calls terminal, for its reason: nothing is monitoring whatever pane
 * survived, so a message typed there is simply lost. A send to one of these becomes a revive.
 */
export const TERMINAL_SEND_STATUSES: ReadonlySet<SessionStatus> = new Set(['failed', 'stopped', 'completed']);

/**
 * Statuses that are idle by their own account, whatever the composer looks like.
 *
 * A parked or rate-limited session is not mid-turn; treating it as busy would ride the native queue
 * and produce an untracked turn instead of the tracked one the caller asked for.
 */
export const IDLE_SEND_STATUSES: ReadonlySet<SessionStatus> = new Set([
  'waiting',
  'awaiting_user',
  'rate_limited',
  'interrupted',
]);

/** One durable state change a send or an interrupt makes, named by the event it journals. */
export interface SendTransition {
  readonly event: 'turn.started' | 'control.interrupted';
  readonly status?: SessionStatus | undefined;
  readonly health?: SessionHealth | undefined;
  readonly turn?: number | undefined;
  readonly promptReady?: boolean | undefined;
  readonly reason?: string | undefined;
  /** Re-anchors the activity ledger and drops the nudge mark: a new turn is a new liveness episode,
   *  and a stale nudge from the previous one must not cold-kill this one. */
  readonly restartTurnClock?: boolean | undefined;
  readonly data?: Readonly<Record<string, string | number | boolean | null>> | undefined;
}

/** Durable boundary for sends: reads the target, journals, and records each transition. */
export interface SendRepository {
  read(id: SessionId): Promise<SendTarget | undefined>;
  /**
   * The session an actor reference names — an id or a teammate callsign.
   *
   * Separate from `read` for the reason the signal domain gives: a sender arrives as a REFERENCE
   * derived from the caller's own credential, not an id a route already parsed.
   */
  resolveSender(reference: string): Promise<SendTarget | undefined>;
  /** An event with no state change of its own: the send ledger's own audit trail. */
  journal(id: SessionId, event: string, data: Readonly<Record<string, unknown>>): Promise<void>;
  transition(id: SessionId, change: SendTransition): Promise<SendTarget>;
}

/**
 * The durable send ledger.
 *
 * IDEMPOTENCY LIVES HERE, not in the route. `accept` returning `created: false` is the whole
 * protection against a client that retried a request whose answer it never saw: the second call
 * finds the first record and no second message is typed.
 */
export interface SendLedger {
  /** Records a send as accepted, or returns the existing record for a `sendId` already seen. */
  accept(id: SessionId, record: SendRecord): Promise<{ readonly record: SendRecord; readonly created: boolean }>;
  /** Revises transport facts on a live accepted record without creating a second logical send. */
  revise(
    id: SessionId,
    sendId: string,
    patch: Partial<Pick<SendRecord, 'path' | 'matchText' | 'payloadFile' | 'held' | 'turn'>>,
  ): Promise<SendRecord | undefined>;
  /**
   * Tombstones a record, and ONLY from the narrow phase where nothing was typed.
   *
   * Once a keystroke has been sent the fate is uncertain rather than absent, and withdrawing it
   * would invite a duplicate retry into a pane that may already hold the message.
   */
  withdraw(id: SessionId, sendId: string, reason: string): Promise<SendRecord | undefined>;
  /** Every send this session holds, the latest line for each, oldest acceptance first. */
  list(id: SessionId): Promise<readonly SendRecord[]>;
  /**
   * Appends a new snapshot of an existing send with `patch` applied — a proven fate, a re-attempt, an
   * extended deadline. A field set to `undefined` is cleared. A withdrawn send is never settled, and a
   * cancelled one only by proof it was delivered before the cancel.
   */
  settle(id: SessionId, sendId: string, patch: SendSettlement): Promise<SendRecord | undefined>;
}

/** What a busy-pane transport proved: the harness is HOLDING the text, or the keys merely went in. */
export type SendQueueOutcome = 'held' | 'unproven';

/** Where the pane shows a payload being held: typed in the composer, or in the harness's own queue. */
export type SendHeldAt = 'composer' | 'queue';

/**
 * What erasing a payload from the composer did.
 *
 * `foreign` means the composer holds something other than exactly this payload — a person's draft, or
 * the payload joined to other text — and was deliberately left untouched.
 */
export type ComposerClearOutcome = 'cleared' | 'absent' | 'foreign' | 'stuck';

/** What one Enter for a stranded payload did: it left the composer, stayed, or was not there to send. */
export type ComposerSubmitOutcome = 'submitted' | 'holding' | 'absent';

/** The terminal side of a send. Every address goes through the daemon's own isolated tmux socket. */
export interface SendTerminal {
  observe(id: SessionId): Promise<SendPaneObservation>;
  /**
   * Types into a prompt-ready composer and submits, proving the payload left the composer. Throws
   * `SendLandingUnconfirmed` when the payload was typed and no frame proved it landed.
   */
  deliver(id: SessionId, text: string): Promise<void>;
  /** Types into a BUSY composer so the harness holds it until the turn boundary. Throws as `deliver` does. */
  queue(id: SessionId, text: string): Promise<SendQueueOutcome>;
  /** Sends the safe stop key, waits for the turn to wind down, and re-reads the pane. */
  stopActiveTurn(id: SessionId): Promise<SendPaneObservation>;
  /** Sends the safe stop key once, with no readiness wait. Exactly one keystroke per call. */
  pressStopKey(id: SessionId): Promise<void>;
  /**
   * Where the pane still shows `text` held — typed in the composer, or in the harness's visible queue —
   * read from those places only, never from the payload's words appearing elsewhere on screen.
   * Throws when the pane cannot be read: an unread pane proves nothing either way.
   */
  heldAt(id: SessionId, text: string): Promise<SendHeldAt | undefined>;
  /**
   * Erases `text` from the composer, ONLY when the composer holds exactly that and nothing else.
   * Bounded, and verified by reading the composer after each key.
   */
  clearComposer(id: SessionId, text: string): Promise<ComposerClearOutcome>;
  /** Presses Enter once, ONLY when the composer holds exactly `text`, and reports where it went. */
  submitComposer(id: SessionId, text: string): Promise<ComposerSubmitOutcome>;
}

/** Where a send's fate is decided, told each time a transport finishes so it can look. */
export interface SendTracking {
  track(id: SessionId): void;
}

/** Where a tracked send leaves the documents an agent and a supervisor read. */
export interface SendTurnStore {
  /** Persists the turn document and returns the absolute file the agent must open. */
  writeTurn(id: SessionId, turn: number, document: string): Promise<string>;
  /** Persists a payload too long to type, and returns the absolute file to point the composer at. */
  writeQueuedPayload(id: SessionId, sendId: string, payload: string): Promise<string>;
  /**
   * Clears the completion markers a previous turn left.
   *
   * Cleared AFTER the prompt lands, not before: a marker written between the request and the
   * keystroke belongs to the turn that is ending, and leaving it would have a supervisor report a
   * completion for the turn that is just starting.
   */
  clearMarkers(id: SessionId): Promise<void>;
}

/** One message as the session's own append-only channel log records it. */
export interface InboundMessage {
  readonly at: string;
  readonly message: string;
  readonly turn?: number | undefined;
  readonly queueId?: string | undefined;
  readonly queued?: boolean | undefined;
  readonly queuedForRevive?: boolean | undefined;
  readonly from?: string | undefined;
  readonly fromName?: string | undefined;
  readonly reason?: string | undefined;
}

/** The sender's own copy: the logical message it asked to send, before any transport decoration. */
export interface OutboundMessage {
  readonly at: string;
  readonly to: string;
  readonly from: string;
  readonly fromName?: string | undefined;
  readonly disposition: SendDisposition;
  readonly message: string;
}

/**
 * The append-only conversation logs beside each session.
 *
 * Two files, not one: a receiver reads its inbox to see what it was told, and a sender's outbox is
 * the audit record of what it asked to say — which is the message WITHOUT the attribution banner the
 * receiver needs. Conflating them would make a peer's own log unreadable.
 */
export interface SendChannel {
  recordInbound(id: SessionId, entry: InboundMessage): Promise<void>;
  recordOutbound(id: SessionId, entry: OutboundMessage): Promise<void>;
}

/** Whether a first launch for this session is still in flight, and how a caller waits for it. */
export interface SendLaunchGate {
  launching(id: SessionId): boolean;
  /** Resolves true once the launch settled, false if it did not within the budget. */
  awaitSettled(id: SessionId, timeoutMs: number): Promise<boolean>;
}

/**
 * The revive a send falls back to when there is no live agent to type into.
 *
 * A narrow port rather than the resume service itself: this slice needs exactly one verb from it,
 * and depending on the whole service would couple two domains that have no other reason to meet.
 */
export interface SendReviver {
  /**
   * Answers exactly what the relaunch typed into the replacement pane — the pointer to the turn the
   * message was written to, usually — because that line, not the message, is what the transcript
   * records the agent receiving. `undefined` when the revive cannot say what it typed.
   */
  revive(id: SessionId, message: string): Promise<string | undefined>;
}

/**
 * Ending the recipient's declared wait when this send IS the reply it was parked on.
 *
 * The daemon does it rather than making the waiter poll, or asking the replier to also signal on
 * somebody else's behalf: both sides only ever call `send`, which is what makes request/response a
 * real pattern instead of a convention.
 */
export interface PeerWaitEnder {
  endPeerWait(recipient: SessionId, sender: SessionId): Promise<void>;
}

/** A send the daemon declined to perform. Distinct from one attempted and failed. */
export class SendRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SendRefused';
  }
}

/** Why the pane said not to type a re-attempt. */
export type SendRetypeWithholding = 'held' | 'busy' | 'unreadable';

/**
 * A re-attempt the PANE refused, before a single key: the message is still held there (`held`), the
 * pane is mid-turn and this send was typed into a mid-turn pane once already (`busy`), or the pane
 * could not be read to rule a held copy out (`unreadable`). Each is a reason a retype would be a copy.
 */
export class SendRetypeWithheld extends SendRefused {
  constructor(
    message: string,
    readonly reason: SendRetypeWithholding,
  ) {
    super(message);
    this.name = 'SendRetypeWithheld';
  }
}

/**
 * The composer holds text that is not provably Ferretry's own, so nothing was typed.
 *
 * A refusal like any other, carrying the composer's text exactly as read so the person can be offered
 * "Send it" and "Clear it" for that text and nothing else.
 */
export class SendDraftRefused extends SendRefused {
  constructor(
    message: string,
    readonly draft: string,
  ) {
    super(message);
    this.name = 'SendDraftRefused';
  }
}

/** What a person asked to do with their own draft in the agent's composer. */
export type ComposerDraftAction = 'submit' | 'clear';

/** What acting on that draft did; see `ComposerDraftOutcomeSchema` in the protocol. */
export type ComposerDraftOutcome = 'submitted' | 'holding' | 'cleared' | 'absent' | 'changed' | 'stuck';
/**
 * The agent's composer already held unsent text, so nothing was typed — the new message would have
 * been submitted joined to it. Thrown by the terminal BEFORE any keystroke.
 */
export class SendComposerOccupied extends Error {
  constructor(
    /** What the composer held, so the refusal can quote it back to the person who will recognise it. */
    readonly draft: string,
  ) {
    super('the composer already holds unsent text; nothing was typed');
    this.name = 'SendComposerOccupied';
  }
}

/**
 * The agent's composer could not be read well enough to prove it empty, so nothing was typed. Thrown
 * by the terminal BEFORE any keystroke: a composer that may hold a person's draft is never typed into.
 */
export class SendComposerUnreadable extends Error {
  constructor() {
    super("the agent's composer could not be read to prove it empty; nothing was typed");
    this.name = 'SendComposerUnreadable';
  }
}

/**
 * The payload WAS typed into the composer and no frame proved it landed, so it was not typed again.
 * Thrown by the terminal AFTER a keystroke: the message may be in the composer now, or on its way to
 * it from a pane too stalled to have drawn it, so it is neither withdrawn nor typed a second time.
 */
export class SendLandingUnconfirmed extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SendLandingUnconfirmed';
  }
}

/**
 * A send that was typed but could not be proven to have landed, settled `unaccounted` and still
 * watched. Not a refusal — a key reached the pane — and not a failure to report as one: its id rides
 * along so the person can be offered "Send it", "Clear it" and "Retry" for exactly this send.
 */
export class SendUnconfirmed extends Error {
  constructor(
    message: string,
    readonly sendId: string,
  ) {
    super(message);
    this.name = 'SendUnconfirmed';
  }
}

/**
 * Nothing was typed because the pane could not be read to prove its composer empty. Usually a passing
 * repaint: the same send may be tried again. Its own class so a caller can tell it from a refusal that
 * would refuse again.
 */
export class SendScreenUnreadable extends SendRefused {
  constructor(message: string) {
    super(message);
    this.name = 'SendScreenUnreadable';
  }
}

/** The session cannot take input at all: a quarantine, an unconfirmed kill, an unanswered question. */
export class SendUnavailable extends SendRefused {
  constructor(message: string) {
    super(message);
    this.name = 'SendUnavailable';
  }
}

/** A launch is still in flight. Pending, not failed — the caller retries rather than gives up. */
export class SendPending extends SendRefused {
  constructor(message: string) {
    super(message);
    this.name = 'SendPending';
  }
}

/** The reviver declined. The message is retained for an explicit revive rather than lost. */
export class ReviveRefusedForSend extends Error {
  constructor(
    message: string,
    /** Set when the refusal names another session as the conflicting one. */
    readonly conflictSessionId?: string,
  ) {
    super(message);
    this.name = 'ReviveRefusedForSend';
  }
}
