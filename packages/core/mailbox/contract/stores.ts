/**
 * What the Mailbox keeps and where: the daemon's own record of a send (`SendRecord`), the ledger that holds it, and the
 * queue's log. These are the Mailbox's own shapes; the FILES they are kept in (`state/conversation/<ferret>/sends.jsonl`,
 * `queue.jsonl`) are declared and opened by Conversation, which fills the `mailbox.host` slot (`./host.ts`) with a store
 * and a ledger over them. Moved here unchanged from Conversation's send path.
 */
import type { FerretId } from '@ferretry/core-ferrets/contract';
import type { QueueEvent } from './lines.ts';
import type { SendCancelEffect, SendQueueProof } from './protocol-names.ts';
import type { QueueAuthor, SendEvidence, SendUnaccountedReason } from './wire-send.ts';

type SessionId = FerretId;

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

/**
 * One send, durably, from the instant it was accepted.
 *
 * `matchText` is what the tracker looks for in the transcript — the composer text for a direct send,
 * the turn instruction for a turn-file one, and whatever the relaunch typed for a revive — which the
 * reviver reports once it has typed it, so a revive still relaunching has none yet. It is recorded by
 * the only code that knows what was typed, so the tracker does not have to re-derive it.
 */
/** One message inside a combined delivery, as the ledger remembers it. */
interface SendBatchMember {
  /** The queued message's own id — the send id its sender was given. */
  readonly queueId: string;
  /** The sending ferret's session. */
  readonly from: string;
}

/** A failure notice still owed to one sender: who is told, and the message id the notice is keyed by. */
export interface SendNoticeOwed {
  readonly from: string;
  readonly sendId: string;
}

export interface SendRecord {
  /** The caller's idempotency key. A retry with the same one must never become a second message. */
  readonly sendId: string;
  readonly acceptedAt: string;
  /** The turn the session was on when this was accepted, which a later turn bump does not change. */
  readonly acceptedTurn: number;
  readonly path: SendPath;
  readonly message: string;
  readonly matchText?: string | undefined;
  /**
   * The earliest instant a transcript input may count as proof this send was delivered, with NO clock-skew slack. Written
   * ONLY by a person's Retry of an update-unconfirmed send, at the moment that Retry was accepted, and moved by nothing
   * else: an input from before it is the history that left the send unconfirmed. Absent for every other send, whose
   * evidence window opens `matchSlackMs` before its acceptance. The daemon's own bookkeeping: it never leaves the daemon.
   */
  readonly evidenceNotBefore?: string | undefined;
  /** The turn this send STARTS, when it starts one. Absent for a native-queue ride. */
  readonly turn?: number | undefined;
  readonly attachmentIds?: readonly string[] | undefined;
  /** The sending session, present only for peer-to-peer messages. Its absence means a human sent it. */
  readonly from?: string | undefined;
  readonly fromName?: string | undefined;
  readonly senderKind?: SendSenderKind | undefined;
  /**
   * The messages one combined turn carries, oldest first, each with its queued id and its sender. Present
   * only on the ONE row a combined delivery is ledgered under (`from` then names the first sender alone),
   * so a failure can be handed back to every sender whose message was in it.
   */
  readonly batch?: readonly SendBatchMember[] | undefined;
  /** Who sent it, as data, when it did not come through the queue that records that. */
  readonly by?: QueueAuthor | undefined;
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
  /**
   * A PERSON'S send that NOTHING has been typed for yet: the composer could not be read to prove it
   * empty, so the transport refused before its first key. It used to be withdrawn, and nothing ever
   * tried again — the owner's message sat as a payload file while Warden notices kept arriving. It is
   * kept open instead, and the tracker types it, ahead of every other send, the first time the pane
   * reads clear. Nothing typed means no copy can exist, so none of the duplicate guards apply until the
   * first key. The daemon's own bookkeeping: it never leaves the daemon.
   */
  readonly untyped?: boolean | undefined;
  /**
   * When an `untyped` send was said to be STUCK: still not typed `stuckAlarmMs` after it was accepted, because every
   * try found a composer that could not be proven empty. Set once, so the warning is given once; cleared when a try
   * finally types it, or when the send settles. Shown on the wire, so the person who sent it can see it is waiting
   * on the agent's screen and what to do about it.
   */
  readonly stuckAt?: string | undefined;
  /** What a `cancelled` fate did to the agent's screen. */
  readonly cancelEffect?: SendCancelEffect | undefined;
  /**
   * The failure notices a final `unaccounted` / `timed_out` fate still owes its senders, written in the
   * SAME ledger line as the fate and shortened one member at a time as each notice is sent, so a crash
   * between the fate and the news cannot drop any. The daemon's own bookkeeping: it never leaves the daemon.
   */
  readonly noticesOwed?: readonly SendNoticeOwed[] | undefined;
}

/** The fields the tracker and a re-attempt may move on an existing record. */
export type SendSettlement = Partial<
  Pick<
    SendRecord,
    | 'fate'
    | 'acceptedAt'
    | 'fateAt'
    | 'evidence'
    | 'unaccountedReason'
    | 'queuedAt'
    | 'queueProof'
    | 'attempt'
    | 'attemptAt'
    | 'evidenceNotBefore'
    | 'deadlineAt'
    | 'retryable'
    | 'typedNotSent'
    | 'submitNudges'
    | 'busyTyped'
    | 'untyped'
    | 'stuckAt'
    | 'cancelEffect'
    | 'noticesOwed'
    | 'held'
    | 'path'
    | 'matchText'
    | 'turn'
    | 'payloadFile'
  >
>;

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

/** Where a session's queue is kept: its log, read whole, and one event appended durably at a time. */
export interface SessionQueueStore {
  /** Every event this session's queue has recorded, oldest first; an empty log when it has none. */
  read(id: SessionId): Promise<readonly QueueEvent[]>;
  /** Records one event; it is on disk when this resolves. */
  append(id: SessionId, event: QueueEvent): Promise<void>;
}
