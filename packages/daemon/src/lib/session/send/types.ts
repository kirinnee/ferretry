import type { SendDisposition, SessionHealth, SessionStatus } from '@ferretry/protocol';
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
 * silence. Nothing in this slice ever writes `delivered`: proving consumption means matching the
 * payload against what the harness transcript shows the agent actually received, and that matcher
 * belongs to the monitor loop (survey section F), which does not exist yet. A ledger that marked its
 * own sends delivered would be asserting exactly the thing it cannot observe.
 */
export type SendFate = 'accepted' | 'delivered' | 'withdrawn';

/** The wire word for each transport path. The only place the two vocabularies meet. */
const DISPOSITIONS: Readonly<Record<SendPath, SendDisposition>> = {
  direct: 'delivered',
  'turn-file': 'delivered',
  'native-inline': 'queued',
  'native-file': 'queued',
  revive: 'revived',
  'revive-queue': 'queued-for-revive',
};

/** What the client is told happened, given how the message physically travelled. */
export function dispositionOf(path: SendPath): SendDisposition {
  return DISPOSITIONS[path];
}

/**
 * One send, durably, from the instant it was accepted.
 *
 * `matchText` is what a future consumption matcher will look for in the transcript — the composer
 * text for a direct send, the turn instruction for a turn-file one. It is recorded now, by the only
 * code that knows which of the two was typed, so the monitor unit does not have to re-derive it.
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
  /** The sending session, present only for peer-to-peer messages. Its absence means a human sent it. */
  readonly from?: string | undefined;
  readonly fromName?: string | undefined;
  /** The sender is parked on a reply, so the receiver is told the exact command that unblocks them. */
  readonly replyExpected?: boolean | undefined;
  /** The file a file-backed payload was written to, so a failed transport does not lose the text. */
  readonly payloadFile?: string | undefined;
  /** Retained for an explicit revive rather than transported now. */
  readonly held?: boolean | undefined;
  readonly fate: SendFate;
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
}

/** The terminal side of a send. Every address goes through the daemon's own isolated tmux socket. */
export interface SendTerminal {
  observe(id: SessionId): Promise<SendPaneObservation>;
  /** Types into a prompt-ready composer and submits, proving the payload left the composer. */
  deliver(id: SessionId, text: string): Promise<void>;
  /** Types into a BUSY composer so the harness holds it until the turn boundary. */
  queue(id: SessionId, text: string): Promise<void>;
  /** Sends the safe stop key, waits for the turn to wind down, and re-reads the pane. */
  stopActiveTurn(id: SessionId): Promise<SendPaneObservation>;
  /** Sends the safe stop key once, with no readiness wait. Exactly one keystroke per call. */
  pressStopKey(id: SessionId): Promise<void>;
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
  revive(id: SessionId, message: string): Promise<void>;
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
