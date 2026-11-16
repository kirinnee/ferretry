import type { SendDisposition } from '../protocol-names.ts';
import type { SessionHealth, SessionStatus } from '../ferret-types.ts';
import type { SessionId } from '../session-id.ts';
import type { SendLedger, SendNoticeOwed, SendPath, SendRecord, SendSenderKind, SendSettlement } from '../stores.ts';

// `SendFate`, `SendPath` and `SendRecord` are the ledger's own and clash with the wire's of the same names: they leave
// the package as `LedgerFate`, `LedgerPath` and `LedgerRecord` (index.ts).
export type { SendLedger, SendNoticeOwed, SendSenderKind, SendSettlement };

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
  /**
   * The harness is visibly COMPACTING its context (&B188). A subset of `activeWork` that outranks a stored status:
   * a person can start `/compact` from `awaiting_user` or `interrupted`, so those records say nothing about it.
   */
  readonly compacting?: boolean | undefined;
  /** A harness dialog the pane is parked on, in the words a person is shown for it. */
  readonly blockingPrompt?: string | undefined;
  /**
   * Codex has accepted a submission and PARKED it until its startup ends (`paneShowsStartupWait`). The text
   * is still drawn in the composer, but it is not a `draft` and nothing may press Enter into it: the pane
   * is simply not ready yet, and a send arriving now is pending, not refused.
   */
  readonly startupParked?: boolean | undefined;
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
  /** The whose-turn watcher's last word: `working` once the agent has picked something up. */
  readonly turnState?: string | undefined;
  /** When `turnState` last CHANGED, so a boundary after a send was typed can be told from an older one. */
  readonly turnStateAt?: string | undefined;
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
 * and produce an untracked turn instead of the tracked one the caller asked for. `waiting` is the one
 * a pane visibly at work overrules (`routeSend`): a declared wait is set from inside the agent's turn.
 */
export const IDLE_SEND_STATUSES: ReadonlySet<SessionStatus> = new Set([
  'waiting',
  'awaiting_user',
  'rate_limited',
  'interrupted',
]);

/**
 * Whether a send is TYPED and NOT PROVEN: the keys reached the pane and no proof of them arrived, so the message may be
 * sitting in the composer. Two reasons say it: `landing_unconfirmed` (the fill saw no frame with the text) and
 * `typed_not_submitted` (the tracker saw it in the box, pressed Enter once, and it was still there — B187). The second
 * REPLACES the first on the same row, so every reader of the unconfirmed state asks this one predicate; a second string
 * compare would answer a raised send as if it were delivered.
 */
export function isUnconfirmedTyping(record: Pick<SendRecord, 'fate' | 'unaccountedReason'> | undefined): boolean {
  return (
    record?.fate === 'unaccounted' &&
    (record.unaccountedReason === 'landing_unconfirmed' || record.unaccountedReason === 'typed_not_submitted')
  );
}

/**
 * Whether the v4 → 5.0 conversion marked this send: its ledger claim could not be proved to name the transcript input
 * 5.0 emits, so ANY input might be one an earlier send already used. The mark is a durable disposition, not a state the
 * send path may move out of: only a person's own Retry (`SessionSendService.reattempt`, `by: 'person'`) clears it, as a
 * fresh send. Every automatic act — the tracker's look, a daemon retype, the Warden's Enter — refuses such a row.
 */
export function isUpdateUnconfirmed(record: Pick<SendRecord, 'unaccountedReason'> | undefined): boolean {
  return record?.unaccountedReason === 'update_unconfirmed';
}

/** One durable state change a send or an interrupt makes, named by the event it journals. */
export interface SendTransition {
  /** `control.input_stuck` / `control.input_unstuck`: the Warden's health mark for a ferret stuck on an unsent message. */
  readonly event:
    | 'turn.started'
    | 'control.interrupted'
    | 'control.input_stuck'
    | 'control.input_unstuck'
    /** A turn number a typed pointer names, taken before its turn has started (B144). */
    | 'control.turn_reserved';
  /** Leave the session's `reason` as it is: a change that says nothing about why the session stands where it does. */
  readonly keepReason?: true | undefined;
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
  /**
   * Presses Enter once, ONLY when the composer holds exactly `text`, and reports where it went. `strict` (&B153) also
   * refuses a clipped drawing of it (`…`): the composer must be the whole text, re-wrapped at most.
   */
  submitComposer(id: SessionId, text: string, strict?: boolean): Promise<ComposerSubmitOutcome>;
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

/** What a pane that never came to a prompt was doing instead: still at work, behind a dialog, or gone. */
export type SendNotReadyCause = 'busy' | 'dialog' | 'exited';

/**
 * The pane never came to a prompt, so nothing of the message was typed. Thrown by the terminal BEFORE any
 * keystroke of the payload (&B153): a session whose record said idle while its agent was still mid-turn is
 * the case, and the message is free to go again once the pane is ready.
 */
export class SendPaneNotReady extends Error {
  constructor(
    detail: string,
    readonly why: SendNotReadyCause,
  ) {
    super(`${detail}; nothing was typed`);
    this.name = 'SendPaneNotReady';
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

/**
 * Nothing was typed because the agent's pane never came to a prompt: it stayed at work, sat behind a dialog,
 * or went away. Like an unreadable screen it usually passes, so the same send may be tried again — a queue
 * waits on `reason` rather than failing the message.
 */
export class SendNotReady extends SendRefused {
  constructor(
    message: string,
    readonly reason: 'busy' | 'dialog' | 'stopped',
  ) {
    super(message);
    this.name = 'SendNotReady';
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
