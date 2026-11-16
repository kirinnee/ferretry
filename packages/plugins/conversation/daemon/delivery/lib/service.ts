import {
  combinedDelivery,
  type PeerMessageLabel,
  type QueueAuthor,
  type SendCancelEffect,
  type SendDisposition,
} from '../../seams/protocol.ts';
import type { ClockPort, SerialExecutor } from '../../seams/ports.ts';
import type { SessionId } from '../../seams/ferret-id.ts';
import {
  authorizeSend,
  endsPeerWait,
  isDirectSend,
  isFileBackedQueue,
  paneMidTurn,
  peerMessageKind,
  peerPreamble,
  peerSender,
  queuedPayloadInstruction,
  routeSend,
  sendPayload,
  turnInstruction,
  typedIntoBusyPane,
} from './policy.ts';
import type { SessionSendSettings } from './settings.ts';
import {
  retractedPointer,
  sameComposerText,
  showsOwnText,
  strandablePointer,
  strandableText,
  strandedSend,
} from './stranded.ts';
import type { SendRetractionProof } from './retraction.ts';
import { isOpenSend } from './tracking.ts';
import {
  type ComposerDraftAction,
  type ComposerDraftOutcome,
  type ComposerSubmitOutcome,
  dispositionOf,
  isUpdateUnconfirmed,
  isUnconfirmedTyping,
  type PeerWaitEnder,
  ReviveRefusedForSend,
  type SendChannel,
  SendComposerOccupied,
  SendComposerUnreadable,
  SendDraftRefused,
  SendLandingUnconfirmed,
  type SendLaunchGate,
  type SendLedger,
  SendNotReady,
  type SendNotReadyCause,
  SendPaneNotReady,
  type SendPaneObservation,
  type SendPath,
  SendPending,
  type SendQueueOutcome,
  type SendRecord,
  SendRefused,
  type SendRepository,
  SendRetypeWithheld,
  type SendReviver,
  SendScreenUnreadable,
  type SendSettlement,
  type SendTarget,
  type SendTerminal,
  type SendTracking,
  type SendTurnStore,
  SendUnconfirmed,
} from './types.ts';

export interface SessionSendPorts {
  readonly repository: SendRepository;
  readonly ledger: SendLedger;
  readonly terminal: SendTerminal;
  readonly turns: SendTurnStore;
  readonly channel: SendChannel;
  readonly gate: SendLaunchGate;
  readonly reviver: SendReviver;
  readonly peerWaits: PeerWaitEnder;
  /** Serializes every mutation of one session, so two sends cannot both claim the next turn. */
  readonly serial: SerialExecutor;
  readonly clock: ClockPort;
  /**
   * Waits this long. Only the release of held sends uses it, to wait out a
   * Codex startup park; without it the park is looked at once and a still-parked pane leaves the sends held.
   */
  readonly pause?: ((ms: number) => Promise<void>) | undefined;
  /** Told after every transport, so the send's true fate is looked for rather than assumed. */
  readonly tracking: SendTracking;
  /**
   * &B153: proves a delivered pointer seen back in the box was taken back by the harness, unanswered, rather than
   * recalled by a person. Without it no delivered send is ever pressed.
   */
  readonly retraction?: SendRetractionProof | undefined;
}

/** One ferret's message inside a combined delivery (`SendMessageRequest.parts`). */
interface SendPart {
  /** The queued message's own id. */
  readonly queueId: string;
  /** The sending ferret's session. */
  readonly senderReference: string;
  /** The message as its sender wrote it, without a banner. */
  readonly text: string;
  readonly replyExpected: boolean;
  readonly label?: PeerMessageLabel | undefined;
}

export interface SendMessageRequest {
  readonly id: SessionId;
  /**
   * The caller's idempotency key, from the request-id header the client already sends.
   *
   * It is the whole protection against a retried request whose first answer was lost in transit: a
   * send is the one write in this daemon that a duplicate makes visibly, expensively wrong — the
   * agent reads the same instruction twice and acts on it twice.
   */
  readonly sendId: string;
  readonly message: string;
  readonly attachmentIds?: readonly string[] | undefined;
  /** Stop the active turn first, rather than riding the harness's queue behind it. */
  readonly now?: boolean | undefined;
  /** The sender is parked awaiting the reply, so the receiver is told how to unblock them. */
  readonly replyExpected?: boolean | undefined;
  /** The sender's label for the message, shown in its banner (`fy send --kind`). */
  readonly label?: PeerMessageLabel | undefined;
  /**
   * Several ferret messages delivered as ONE turn, oldest first (two or more). `message` is then only
   * their text joined, for the record; the agent reads one `combinedDelivery` built from these, and
   * `senderReference` names the first part's sender, who attributes the one ledger record.
   */
  readonly parts?: readonly SendPart[] | undefined;
  /**
   * The session that made this call, when a teammate did rather than a person.
   *
   * Derived by the route from the caller's own credential, never from the body: `from` is a LABEL
   * used for attribution and for ending a declared wait, and a caller that could name itself could
   * end somebody else's park.
   */
  readonly senderReference?: string | undefined;
  /**
   * The daemon itself is the sender — a failure notice handed back to an agent whose message did not
   * arrive. Recorded as such so nothing retries it on anybody's behalf, and so it never notifies.
   */
  readonly origin?: 'daemon' | undefined;
  /** Who the sender is, as data, for a send that bypasses the queue (which would have recorded it). */
  readonly by?: QueueAuthor | undefined;
}

export interface SendOutcome {
  readonly target: SendTarget;
  readonly disposition: SendDisposition;
  /** The ledger record as the send left it: its id and the fate proven so far. */
  readonly record: SendRecord;
}

/** Options for re-attempting one send under its original id. */
export interface ReattemptOptions {
  /** A person or the daemon asked, which decides what the journal says. */
  readonly by: 'person' | 'daemon';
  /**
   * Re-send a message whose original may have landed: an `unaccounted` one, or — by a person — one
   * still open whose transport stalled. Never one the pane shows held, which would become a copy.
   */
  readonly force?: boolean | undefined;
}

/**
 * Why a send is PENDING (not refused) while Codex holds an earlier submission until its startup ends: nothing is typed or
 * pressed, and the caller retries once startup has ended. The send-now's stop is held back for the same reason.
 */
export function startupParkedPending(id: SessionId): SendPending {
  return new SendPending(
    `session ${id} is still starting; its agent is holding an earlier message until startup ends, so this one is pending, not failed`,
  );
}

/** The longest stretch of a draft quoted back in a refusal: enough to recognise, not a transcript. */
const DRAFT_QUOTE_CHARS = 40;

/**
 * Why nothing was typed when the composer already held text that is not provably Ferretry's own.
 *
 * Quoted so a person can recognise it, and the remedy named, because the obvious one (send again) is
 * what made it worse. The whole draft rides along, so the app can offer to send or clear exactly it.
 */
export function composerOccupiedRefusal(draft: string): SendDraftRefused {
  const quoted = draft.length > DRAFT_QUOTE_CHARS ? `${draft.slice(0, DRAFT_QUOTE_CHARS)}…` : draft;
  return new SendDraftRefused(
    `the agent's composer already holds unsent text ("${quoted}"); a message typed now would be sent ` +
      'joined to it. Press Enter on it or clear it first',
    draft,
  );
}

/**
 * Why nothing was typed when the agent's composer could not be read: it may hold a person's draft, and
 * a message typed onto one is submitted joined to it. Usually a passing repaint, so trying again works.
 */
export function composerUnreadableRefusal(): SendScreenUnreadable {
  return new SendScreenUnreadable(
    "the agent's screen could not be read to prove its composer empty, so nothing was typed; send it again " +
      'in a moment, or check the terminal for a half-written message',
  );
}

/** What a queue waits on when a pane never came to a prompt. */
const NOT_READY_REASON: Readonly<Record<SendNotReadyCause, SendNotReady['reason']>> = {
  busy: 'busy',
  dialog: 'dialog',
  exited: 'stopped',
};

/**
 * Why nothing was typed when the agent's pane never came to a prompt (&B153). A session record can say
 * idle while its agent is still mid-turn — a declared wait is set from inside the turn — and the wait for a
 * prompt then gives up before the first key. Nothing was typed, so the same send may go again.
 */
function paneNotReadyRefusal(error: SendPaneNotReady): SendNotReady {
  const reason = NOT_READY_REASON[error.why];
  const remedy =
    reason === 'dialog'
      ? 'answer the prompt on its screen'
      : reason === 'stopped'
        ? 'it is revived with the message when sent again'
        : 'send it again once its turn ends';
  return new SendNotReady(`the agent never came to a prompt (${error.message}); ${remedy}`, reason);
}

/** What the locked section decided, before anything that must happen outside the lock. */
type LockedOutcome =
  | { readonly kind: 'revive' }
  | {
      readonly kind: 'settled';
      readonly path: SendPath;
      readonly applied: boolean;
      readonly record: SendRecord;
      /** A busy-pane transport that proved the harness is holding the text. */
      readonly held: boolean;
    };

/** What a transport did: typed (and what it proved), or refused before any key and kept open. */
type Transported<T> =
  | { readonly typed: true; readonly value: T }
  | { readonly typed: false; readonly record: SendRecord };

/**
 * Whose refused send is kept open rather than withdrawn: a PERSON'S. A ferret's send is answered with
 * the refusal and its sender acts on it; the daemon's own (the Warden's) is re-planned by its sweep. A
 * person sent it from a screen that has already said "sent", and is not watching for a retry prompt.
 */
function keptForTheTracker(record: SendRecord): boolean {
  return record.senderKind === 'human';
}

/** A held message being delivered after its session came back. */
interface HeldRelease {
  readonly record: SendRecord;
}

/** Fates still being looked for, which only the daemon's tracker may re-attempt. */
const OPEN_FATES: ReadonlySet<SendRecord['fate']> = new Set(['accepted', 'queued']);

/**
 * The most Enters the daemon presses, across all its callers, for one send's own text left typed in the
 * composer — the tracker's nudges, the queue clearing its way, a new send finishing it first. Counted on the
 * record BEFORE each key, so a daemon that dies mid-press cannot come back and press without limit. Past
 * it the text stays where it is and the Warden says so (`input-stuck.ts`).
 */
export const STRANDED_ENTER_LIMIT = 5;

/**
 * The next turn number a turn file may take: past the session's own, and past every turn a send of this
 * session still points at.
 *
 * B144: a pointer whose landing was unconfirmed never started its turn, so the session stayed on 62 while
 * `turn-063.md` was the file its pointer named. Five hours later a person pressed Enter on that pointer, and
 * the next send — claiming 63 again — overwrote the very file the agent was about to read. A withdrawn
 * send typed nothing, so nothing can point at its file.
 */
export function nextTurnNumber(target: Pick<SendTarget, 'turn'>, records: readonly SendRecord[]): number {
  let claimed = target.turn;
  for (const record of records)
    if (record.turn !== undefined && record.fate !== 'withdrawn' && record.turn > claimed) claimed = record.turn;
  return claimed + 1;
}

/** What one Enter on a send's own stranded text did, for a caller that is not a send. */
export type StrandedEnterOutcome = ComposerSubmitOutcome | 'refused';

/**
 * Handing a running session its next turn.
 *
 * Four orderings carry the whole of this slice, and each one is a way a send goes wrong:
 *
 * EVERY REFUSAL IS EVALUATED BEFORE A KEYSTROKE. A quarantined harness, an unconfirmed kill, an
 * unanswered structured question: each is a pane whose composer belongs to something other than this
 * session's agent, and each is checked from the record before a frame is even captured.
 *
 * THE LEDGER IS WRITTEN BEFORE THE TRANSPORT, and the transport never withdraws it. A record exists
 * from the moment the send is accepted, so a daemon that dies mid-keystroke leaves evidence rather
 * than silence. The only tombstone is from the narrow phase where nothing has been typed at all —
 * once a key has gone to the pane the fate is UNCERTAIN, not absent, and withdrawing it would invite
 * a retry into a composer that may already hold the message.
 *
 * THE PANE IS RE-READ AFTER THE ROUTE SAYS BUSY. The frame that said busy is already stale by the
 * time the lock is held, and the cost of the two mistakes is not symmetric: queueing behind a turn
 * that just ended merely delays the message, while typing into a composer that has gone idle SUBMITS
 * it as an untracked ghost turn.
 *
 * THE TURN ADVANCES ONLY ONCE THE PROMPT HAS LANDED, and the completion markers are cleared after
 * that same moment. A marker written between the request and the keystroke belongs to the turn that
 * is ending; clearing it earlier would leave the previous turn's `done` free to certify the one that
 * is just starting.
 */
/**
 * What every refusal of a key for an update-unconfirmed send says. The v4 → 5.0 conversion could not prove whether the
 * agent got it, and the mark leaves ONE act that may press a key for it: a PERSON's Retry (`reattempt`, `by: 'person'`).
 */
function updateUnconfirmedRefusal(sendId: string): SendRefused {
  return new SendRefused(
    `send ${sendId} was sent before this update and Ferretry can't tell whether the agent got it; only a person's Retry sends it again`,
  );
}

/** The fields a re-attempt overwrites, as they stood before it, so a refused one can put them back. */
function restorable(record: SendRecord): SendSettlement {
  return {
    acceptedAt: record.acceptedAt,
    fate: record.fate,
    attempt: record.attempt,
    attemptAt: record.attemptAt,
    fateAt: record.fateAt,
    deadlineAt: record.deadlineAt,
    unaccountedReason: record.unaccountedReason,
    retryable: record.retryable,
    queuedAt: record.queuedAt,
    queueProof: record.queueProof,
    submitNudges: record.submitNudges,
    busyTyped: record.busyTyped,
    untyped: record.untyped,
    evidenceNotBefore: record.evidenceNotBefore,
  };
}

/** A part of a combined delivery with its sender resolved, when it still can be. */
interface Party {
  readonly part: SendPart;
  readonly sender: SendTarget | undefined;
}

export class SessionSendService {
  constructor(
    private readonly ports: SessionSendPorts,
    private readonly settings: SessionSendSettings,
  ) {}

  async send(request: SendMessageRequest): Promise<SendOutcome> {
    // Pending, not refused: a send that lands mid-bootstrap has no way to time itself, and failing it
    // would turn a launch the caller cannot observe into an error they cannot act on.
    if (
      this.ports.gate.launching(request.id) &&
      !(await this.ports.gate.awaitSettled(request.id, this.settings.controlLaunchWaitMs))
    )
      throw new SendPending(
        `session ${request.id} is still launching after ` +
          `${Math.round(this.settings.controlLaunchWaitMs / 1_000)}s; it is pending, not failed`,
      );
    const sender = await this.sender(request);
    const parties = await this.parties(request);
    const payload = await this.payload(request, sender, parties);
    const settled = await this.watchedOnThrow(request.id, request.sendId, async () => {
      const locked = await this.ports.serial.run(request.id, async () => await this.locked(request, payload, sender));
      return locked.kind === 'revive' ? await this.revive(request, payload, sender) : locked;
    });
    // Only a NEW transport is tracked: a duplicate request found a send already being watched.
    if (settled.applied) this.ports.tracking.track(request.id);
    const target = await this.require(request.id);
    if (settled.applied) {
      if (parties !== undefined) {
        for (const party of parties)
          if (party.sender !== undefined) await this.attribute(target, party.sender, party.part.text, settled);
      } else if (sender !== undefined) await this.attribute(target, sender, request.message, settled);
    }
    return { target, disposition: dispositionOf(settled.path, settled.held), record: settled.record };
  }

  /**
   * Runs a send's work and, when it throws with the send's row still open, tells the tracker (&B153).
   *
   * A row is written before the first key and a throw does not take it back, so a send that threw is the
   * one that most needs a look: only the tracker can prove where it went and type it again once it is
   * proven absent. The look used to be scheduled only by a send that returned, and every queue whose
   * hand-over threw sat behind an `accepted` row nothing looked at again until the daemon restarted. A
   * refusal before any key leaves no open row and schedules nothing.
   */
  private async watchedOnThrow<T>(id: SessionId, sendId: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      const records = await this.ports.ledger.list(id).catch(() => undefined);
      const row = records?.find(record => record.sendId === sendId);
      // A ledger that cannot be read cannot rule an open row out, and an extra look costs one read.
      if (records === undefined || (row !== undefined && isOpenSend(row))) this.ports.tracking.track(id);
      throw error;
    }
  }

  /**
   * Types one send AGAIN, under its ORIGINAL id, as attempt N+1.
   *
   * WHAT MAKES THIS SAFE is the fate it starts from, and nothing else. A `timed_out` send was proven
   * absent — not in the transcript, not held by the harness, not in the composer — so typing it again
   * cannot make the agent read it twice. An `accepted`/`queued` one is re-attempted only by the
   * daemon's own tracker, which has just proven the same absence. An `unaccounted` one MAY have landed,
   * so it needs `force`: a person who read "it may still arrive" and chose to send it anyway.
   *
   * The attempt is ledgered BEFORE the keys, exactly as the first one was: a crash mid-retype leaves
   * a record saying an attempt was in flight, not silence.
   */
  async reattempt(id: SessionId, sendId: string, options: ReattemptOptions): Promise<SendRecord> {
    const record = await this.watchedOnThrow(id, sendId, async () => await this.reattemptLocked(id, sendId, options));
    this.ports.tracking.track(id);
    return record;
  }

  private async reattemptLocked(id: SessionId, sendId: string, options: ReattemptOptions): Promise<SendRecord> {
    return await this.ports.serial.run(id, async () => {
      const current = (await this.ports.ledger.list(id)).find(entry => entry.sendId === sendId);
      if (current === undefined) throw new SendRefused(`session ${id} has no send ${sendId}`);
      if (current.fate === 'delivered') throw new SendRefused(`send ${sendId} is already delivered`);
      // A PERSON may only retry what the daemon proved absent (or force an unconfirmed one); an open
      // send is the tracker's alone to retype, because only the tracker has just proven it absent.
      const permitted =
        (current.fate === 'timed_out' && current.retryable === true) ||
        (options.by === 'daemon' && OPEN_FATES.has(current.fate)) ||
        (options.force === true && (current.fate === 'unaccounted' || OPEN_FATES.has(current.fate)));
      if (!permitted)
        throw new SendRefused(
          current.fate === 'unaccounted'
            ? `send ${sendId} may still have landed; send it again anyway to retry it`
            : `send ${sendId} is ${current.fate} and cannot be retried`,
        );
      if (current.held === true || current.path === 'revive' || current.path === 'revive-queue')
        throw new SendRefused(`send ${sendId} rides a revive; revive the session to deliver it`);
      // The update's mark is cleared by a PERSON's Retry alone; nothing automatic is consent to resend this send.
      const leftByUpdate = isUpdateUnconfirmed(current);
      if (leftByUpdate && options.by !== 'person') throw updateUnconfirmedRefusal(sendId);
      const target = await this.require(id);
      authorizeSend(target, []);
      const observed = await this.ports.terminal.observe(id);
      if (routeSend(target, observed) === 'revive')
        throw new SendRefused(`session ${id} has no live agent to retype ${sendId} into; revive it first`);
      // A parked composer is Codex's own accepted submission, not a copy of this send to rule out and not a
      // draft to quote: wait (the tracker reads `busy` as "not yet"), type nothing, press nothing.
      if (observed.startupParked === true)
        throw new SendRetypeWithheld(
          `session ${id} is still starting; its agent is holding an earlier message until startup ends, so send ${sendId} is not typed yet`,
          'busy',
        );
      const text = current.matchText ?? current.message;
      // EVERY retry is checked against the pane, the daemon's as well as a person's: a message still
      // typed in the composer, or held in the harness's queue, is not lost, and retyping it would be the
      // copy. The tracker proved it absent a moment ago — but not under this lock, and a queue it did not
      // recognise is exactly how one message became four. A pane that cannot be read rules nothing out.
      const where = await this.ports.terminal.heldAt(id, text).then(
        held => held ?? 'absent',
        () => 'unreadable' as const,
      );
      if (where === 'queue') {
        if (options.by === 'daemon') return await this.provenHeld(id, current);
        throw new SendRetypeWithheld(
          `send ${sendId} is held in the agent's own queue and will be read at its next turn`,
          'held',
        );
      }
      if (where === 'composer')
        throw new SendRetypeWithheld(
          leftByUpdate
            ? `send ${sendId} is typed in the agent's composer; Ferretry will not press Enter for a send it can't confirm. Clear the draft, then send the message again yourself`
            : `send ${sendId} is typed in the agent's composer and not sent; press Enter instead`,
          'held',
        );
      if (where === 'unreadable' && options.force !== true)
        throw new SendRetypeWithheld(
          `the agent's screen could not be read to rule out a held copy of send ${sendId}; send it again anyway to retry it`,
          'unreadable',
        );
      // Another send's pointer left typed is finished first; this one's own is never, because the
      // checks above refused a retry of it while the composer shows it.
      const { target: ready, pane } = await this.withoutStrandedPointer(target, observed, sendId);
      const routing = routeSend(ready, pane);
      if (routing === 'revive')
        throw new SendRefused(`session ${id} has no live agent to retype ${sendId} into; revive it first`);
      // The hard guard (`typedIntoBusyPane`): never a second copy behind a running turn unless forced.
      const midTurn = paneMidTurn(ready, pane);
      if (midTurn && typedIntoBusyPane(current) && options.force !== true)
        throw new SendRetypeWithheld(
          `send ${sendId} was already typed into this agent mid-turn, so it is typed again only once the turn ` +
            'ends; send it again anyway to queue another copy now',
          'busy',
        );
      // A send nothing was typed for yet keeps its attempt number: this is its FIRST typing.
      const attempt = current.untyped === true ? (current.attempt ?? 1) : (current.attempt ?? 1) + 1;
      const now = this.ports.clock.now();
      const next = await this.ports.ledger.settle(id, sendId, {
        fate: 'accepted',
        attempt,
        attemptAt: now,
        // A person's Retry of an update-unconfirmed send is a FRESH send: the historical input that left it unconfirmed
        // is exactly the one it must not confirm from. The floor is written HERE and nowhere else (a later Enter, a
        // queue, a resubmit or a Warden retry never moves it), and the tracker honours it with no clock-skew slack.
        ...(leftByUpdate ? { acceptedAt: now, evidenceNotBefore: now } : {}),
        fateAt: undefined,
        deadlineAt: undefined,
        unaccountedReason: undefined,
        retryable: undefined,
        queuedAt: undefined,
        queueProof: undefined,
        // &B153: a repaired retraction (open WITH evidence) keeps its count, so retyping it never earns a second
        // repair once the harness takes the new copy back too.
        submitNudges: current.evidence === undefined ? undefined : current.submitNudges,
        untyped: undefined,
        // Marked BEFORE the keys, like the attempt itself: a crash mid-retype must still count it.
        ...(midTurn ? { busyTyped: true } : {}),
      });
      if (next === undefined) throw new SendRefused(`send ${sendId} could not be re-attempted`);
      await this.ports.repository.journal(id, 'control.send_retried', { sendId, attempt, by: options.by });
      try {
        if (routing === 'idle') {
          await this.ports.terminal.deliver(id, text);
          return next;
        }
        return (await this.queued(id, next, await this.ports.terminal.queue(id, text))) ?? next;
      } catch (error) {
        if (error instanceof SendLandingUnconfirmed) throw await this.unconfirmed(id, next);
        if (
          !(error instanceof SendComposerOccupied) &&
          !(error instanceof SendComposerUnreadable) &&
          !(error instanceof SendPaneNotReady)
        )
          throw error;
        // Nothing was typed, so the record goes back to exactly what it said before this attempt.
        await this.ports.ledger.settle(id, sendId, restorable(current));
        if (error instanceof SendComposerOccupied) throw composerOccupiedRefusal(error.draft);
        // A pane that never came to a prompt is waited out, like one mid-turn: the tracker looks again.
        if (error instanceof SendPaneNotReady)
          throw new SendRetypeWithheld(
            `the agent never came to a prompt (${error.message}), so send ${sendId} was not typed again`,
            'busy',
          );
        throw new SendRetypeWithheld(
          `the agent's composer could not be read to prove it empty, so send ${sendId} was not typed again`,
          'unreadable',
        );
      }
    });
  }

  /**
   * Delivers every message held for this session's revive, ONCE each, now that it is back.
   *
   * A held send was accepted while the session could not take input and the relaunch was refused; the
   * promise made to its sender was "kept durably; it will be delivered when this session is revived".
   * This is that delivery. Each record is released under the session's lock and its `held` flag is
   * cleared in the same step that chooses its transport, so a second revive — or a crash and a
   * restart — can never type it twice: the flag is the idempotency, keyed by the send's own id.
   */
  async releaseHeld(id: SessionId): Promise<number> {
    if (this.ports.gate.launching(id)) await this.ports.gate.awaitSettled(id, this.settings.controlLaunchWaitMs);
    // An update-unconfirmed row rides held too (the conversion keeps its fate), but releasing it types it: only a
    // person's Retry may, so it is never selected here.
    const held = (await this.ports.ledger.list(id)).filter(
      record => record.held === true && record.fate === 'accepted' && !isUpdateUnconfirmed(record),
    );
    if (held.length === 0) return 0;
    // A revived Codex 0.166 parks its resume turn and the launch settles at once; the held sends wait for the
    // park to clear instead of reading its text as a draft and going back to held until the NEXT revive.
    if (!(await this.awaitStartupParkCleared(id))) {
      await this.ports.repository.journal(id, 'control.send_release_deferred', {
        held: held.length,
        waitedMs: this.settings.startupParkWaitMs,
      });
      return 0;
    }
    let released = 0;
    let leftParked = 0;
    for (const record of held) {
      const outcome = await this.ports.serial.run(id, async () => {
        const current = (await this.ports.ledger.list(id)).find(entry => entry.sendId === record.sendId);
        if (current?.held !== true || current.fate !== 'accepted') return undefined;
        // Re-read under the lock, before any transport: the mark may have arrived since the selection.
        if (isUpdateUnconfirmed(current)) return undefined;
        const target = await this.require(id);
        const pane = await this.ports.terminal.observe(id);
        // Parked again between the wait and the lock: leave it held, nothing typed.
        if (pane.startupParked === true) {
          leftParked += 1;
          return undefined;
        }
        const routing = routeSend(target, pane);
        if (routing === 'revive') return undefined;
        const request: SendMessageRequest = {
          id,
          sendId: current.sendId,
          message: current.message,
          ...(current.replyExpected === true ? { replyExpected: true } : {}),
        };
        const release = { record: current };
        return routing === 'idle'
          ? await this.deliver(target, request, current.message, undefined, release)
          : await this.queue(target, request, current.message, undefined, release);
      });
      if (outcome !== undefined) released += 1;
    }
    // Parked again under the lock: those sends stay held for the next revive, which is said as the pre-lock wait does.
    if (leftParked > 0)
      await this.ports.repository.journal(id, 'control.send_release_deferred', {
        held: leftParked,
        waitedMs: this.settings.startupParkWaitMs,
      });
    if (released > 0) this.ports.tracking.track(id);
    return released;
  }

  /**
   * Waits, bounded, for Codex to end a startup park (`Waiting for startup`). True when the pane is not parked
   * (or cannot be read, which the locked release then answers for itself); false when it was still parked at
   * the bound. Codex ends a park itself within ~15 s or exits, so the default bound is many times that.
   */
  private async awaitStartupParkCleared(id: SessionId): Promise<boolean> {
    const { startupParkWaitMs, startupParkPollMs } = this.settings;
    const pause = this.ports.pause;
    const polls = pause === undefined ? 0 : Math.ceil(startupParkWaitMs / startupParkPollMs);
    for (let poll = 0; ; poll += 1) {
      const pane = await this.ports.terminal.observe(id).catch(() => undefined);
      if (pane?.startupParked !== true) return true;
      if (pause === undefined || poll >= polls) return false;
      await pause(startupParkPollMs);
    }
  }

  /**
   * Every refusal a send makes before a keystroke that only a person can lift — an unconfirmed kill, a
   * quarantined harness, an unanswered structured question — without typing anything.
   *
   * The queue asks it before it accepts a message: holding prose behind a question the pane may never
   * release would be a message that silently never arrives, where the refusal tells its sender to answer
   * the question first.
   */
  async authorize(id: SessionId, attachmentIds: readonly string[]): Promise<void> {
    authorizeSend(await this.require(id), attachmentIds);
  }

  /** Everything that must see one consistent view of the session and its pane. */
  private async locked(
    request: SendMessageRequest,
    payload: string,
    sender: SendTarget | undefined,
  ): Promise<LockedOutcome> {
    const current = await this.require(request.id);
    authorizeSend(current, request.attachmentIds ?? []);
    const observed = await this.ports.terminal.observe(request.id);
    this.refuseWhileParked(request.id, observed);
    if (routeSend(current, observed) === 'revive') return { kind: 'revive' };
    // A pointer of ours left typed is finished, and the session re-read: finishing a turn pointer
    // starts that turn, so this send must not claim the same turn number again.
    const { target, pane: first } = await this.withoutStrandedPointer(current, observed);
    const routing = routeSend(target, first);
    if (routing === 'revive') return { kind: 'revive' };
    if (routing === 'idle') return await this.deliver(target, request, payload, sender);
    // Busy, as of a frame captured before the lock was held. `--now` ends the active turn with the
    // same safe key the interrupt uses; either way the pane is read again, and a pane that has since
    // died routes to a revive rather than being typed into.
    const second =
      request.now === true && first.activeWork
        ? await this.ports.terminal.stopActiveTurn(request.id)
        : await this.ports.terminal.observe(request.id);
    this.refuseWhileParked(request.id, second);
    const settled = routeSend(target, second);
    if (settled === 'revive') return { kind: 'revive' };
    if (second.draft !== undefined) throw composerOccupiedRefusal(second.draft);
    if (settled === 'idle') return await this.deliver(target, request, payload, sender);
    return await this.queue(target, request, payload, sender);
  }

  /**
   * The tracked path: a turn document, a proven prompt, and a session that has genuinely moved on.
   *
   * The turn document is written on BOTH transports, not only the indirect one. It is what the logs
   * and a later revive read to know what this turn asked for, and a direct send that skipped it would
   * leave the agent holding an instruction with no durable record of what it was.
   *
   * A `release` is a held message being delivered after a revive: its record already exists, so it
   * is moved onto this transport in the same step rather than accepted a second time.
   */
  private async deliver(
    target: SendTarget,
    request: SendMessageRequest,
    payload: string,
    sender: SendTarget | undefined,
    release?: HeldRelease,
  ): Promise<Extract<LockedOutcome, { kind: 'settled' }>> {
    const turn = nextTurnNumber(target, await this.ports.ledger.list(target.id));
    const turnFile = await this.ports.turns.writeTurn(target.id, turn, `${payload}\n`);
    const direct = isDirectSend(target, payload, this.settings);
    const text = direct ? payload : turnInstruction(turnFile);
    const path: SendPath = direct ? 'direct' : 'turn-file';
    const accepted = await this.transported(target, request, sender, release, {
      path,
      message: payload,
      matchText: text,
      turn,
    });
    if (!accepted.created) return this.settledAs(accepted.record, false);
    // May throw after the keys landed or the Enter was consumed. That is an UNCERTAIN fate, never a
    // withdrawal: the record stays accepted so a human can see a message that may have arrived. The
    // one exception is a refusal BEFORE any keystroke, which `untyped` turns back into a refusal — or,
    // for a person's send behind an unreadable screen, into a send kept open for the tracker to type.
    const typed = await this.untyped(
      target.id,
      accepted.record,
      release,
      async () => await this.ports.terminal.deliver(target.id, text),
    );
    if (!typed.typed) return { kind: 'settled', path, applied: true, record: typed.record, held: false };
    await this.turnStarted(target.id, {
      sendId: request.sendId,
      message: payload,
      turn,
      direct,
      replyExpected: request.replyExpected === true,
      ...this.attribution(sender),
    });
    return { kind: 'settled', path, applied: true, record: accepted.record, held: true };
  }

  /**
   * Everything a turn's start owes once its prompt has demonstrably landed: the inbound record, the
   * cleared completion markers, the journal and the state edge. Shared by a fresh send and by a
   * stranded pointer finished later, whose own send never got this far.
   */
  private async turnStarted(
    id: SessionId,
    landed: {
      readonly sendId: string;
      readonly message: string;
      readonly turn: number;
      readonly direct: boolean;
      readonly replyExpected: boolean;
      readonly from?: string | undefined;
      readonly fromName?: string | undefined;
    },
  ): Promise<void> {
    const attribution = {
      ...(landed.from === undefined ? {} : { from: landed.from }),
      ...(landed.fromName === undefined ? {} : { fromName: landed.fromName }),
    };
    await this.ports.channel.recordInbound(id, {
      at: this.ports.clock.now(),
      message: landed.message,
      turn: landed.turn,
      ...attribution,
    });
    // Cleared now that the new prompt has demonstrably landed: a `done` written while this send was
    // in flight belongs to the turn that just ended.
    await this.ports.turns.clearMarkers(id);
    await this.ports.repository.journal(id, 'control.send', {
      sendId: landed.sendId,
      turn: landed.turn,
      direct: landed.direct,
      ...(landed.replyExpected ? { replyExpected: true } : {}),
      ...attribution,
    });
    await this.ports.repository.transition(id, {
      event: 'turn.started',
      status: 'running',
      health: 'healthy',
      turn: landed.turn,
      promptReady: false,
      // Every user turn restarts the clock, or a healthy long-lived session is reaped the moment its
      // wall-clock AGE passes a timeout that was only ever meant to bound one turn of work.
      restartTurnClock: true,
    });
  }

  /**
   * The busy path: the harness's own queue, which holds text typed mid-turn and submits it at the
   * next turn boundary.
   *
   * No turn is claimed and no state moves, because none has started — the agent is still working on
   * the previous one. The send is `queued` only once the pane PROVED the harness is holding the text;
   * a busy pane that merely took the keys stays `accepted`, and the tracker settles where it went.
   */
  private async queue(
    target: SendTarget,
    request: SendMessageRequest,
    payload: string,
    sender: SendTarget | undefined,
    release?: HeldRelease,
  ): Promise<Extract<LockedOutcome, { kind: 'settled' }>> {
    const fileBacked = isFileBackedQueue(payload, this.settings);
    // Written before the ledger and before any keystroke: it costs nothing if the send is refused
    // afterwards, and it is the only copy of the payload if the transport goes wrong.
    const payloadFile = fileBacked
      ? await this.ports.turns.writeQueuedPayload(target.id, request.sendId, payload)
      : undefined;
    const text = payloadFile === undefined ? payload : queuedPayloadInstruction(payloadFile);
    const path: SendPath = fileBacked ? 'native-file' : 'native-inline';
    const accepted = await this.transported(target, request, sender, release, {
      path,
      message: payload,
      matchText: text,
      ...(payloadFile === undefined ? {} : { payloadFile }),
    });
    if (!accepted.created) return this.settledAs(accepted.record, accepted.record.fate === 'queued');
    const typed = await this.untyped(
      target.id,
      accepted.record,
      release,
      async () => await this.ports.terminal.queue(target.id, text),
    );
    if (!typed.typed) return { kind: 'settled', path, applied: true, record: typed.record, held: false };
    const outcome = typed.value;
    const record = (await this.queued(target.id, accepted.record, outcome)) ?? accepted.record;
    await this.ports.channel.recordInbound(target.id, {
      at: this.ports.clock.now(),
      message: payload,
      queued: true,
      queueId: request.sendId,
      ...this.attribution(sender),
    });
    await this.ports.repository.journal(target.id, 'control.send_queued', {
      sendId: request.sendId,
      native: true,
      held: outcome === 'held',
      ...(payloadFile === undefined ? {} : { fileBacked: true, payloadFile }),
      ...(request.replyExpected === true ? { replyExpected: true } : {}),
      ...this.attribution(sender),
    });
    return { kind: 'settled', path, applied: true, record, held: outcome === 'held' };
  }

  /**
   * Runs a transport, and undoes the record when the terminal refused before typing anything — or
   * settles it unconfirmed when the terminal typed it and could not prove it landed.
   *
   * A composer that already held text is refused by the terminal before its first keystroke, so the
   * acceptance is the one thing to take back: a fresh send is withdrawn (its id may honestly start
   * over) and a released held message goes back to being held. A pane that never came to a prompt is
   * the same (&B153): the wait for one gives up before the fill, so no key of the message went.
   */
  private async untyped<T>(
    id: SessionId,
    record: SendRecord,
    release: HeldRelease | undefined,
    transport: () => Promise<T>,
  ): Promise<Transported<T>> {
    try {
      return { typed: true, value: await transport() };
    } catch (error) {
      if (error instanceof SendLandingUnconfirmed) throw await this.unconfirmed(id, record);
      if (
        !(error instanceof SendComposerOccupied) &&
        !(error instanceof SendComposerUnreadable) &&
        !(error instanceof SendPaneNotReady)
      )
        throw error;
      const occupied = error instanceof SendComposerOccupied;
      const notReady = error instanceof SendPaneNotReady ? error : undefined;
      const why = notReady === undefined ? undefined : 'the agent never came to a prompt';
      // Kept open for the tracker: a person's send, and a held message released into a live session that
      // never came to a prompt — put back on hold, it would wait for a revive a live session never gets. A
      // pane that went away is a revive's to deliver into, never the tracker's (&B153).
      const kept =
        !occupied &&
        notReady?.why !== 'exited' &&
        (release === undefined ? keptForTheTracker(record) : notReady !== undefined);
      if (kept)
        return { typed: false, record: await this.keptUntyped(id, record, why ?? 'the composer could not be read') };
      if (release !== undefined) await this.ports.ledger.settle(id, record.sendId, { held: true });
      else
        await this.ports.ledger.withdraw(
          id,
          record.sendId,
          occupied ? 'the composer held unsent text' : (why ?? 'the composer could not be read'),
        );
      if (occupied) throw composerOccupiedRefusal(error.draft);
      if (error instanceof SendPaneNotReady) throw paneNotReadyRefusal(error);
      throw composerUnreadableRefusal();
    }
  }

  /**
   * A person's send the screen refused before any key, kept OPEN rather than withdrawn.
   *
   * "Send it again in a moment" reached nobody: the owner's message was withdrawn a second after it was
   * accepted, behind a composer the reader could not place, and nothing ever tried it again. The record
   * stays `accepted` and `untyped`, the tracker is told, and it types the send — ahead of any other —
   * the first time the pane reads clear. A pane that never came to a prompt is kept open the same way.
   */
  private async keptUntyped(id: SessionId, record: SendRecord, reason: string): Promise<SendRecord> {
    const kept = await this.ports.ledger.settle(id, record.sendId, { untyped: true });
    await this.ports.repository.journal(id, 'control.send_deferred', { sendId: record.sendId, reason });
    return kept ?? { ...record, untyped: true };
  }

  /**
   * Settles a send whose keys reached the pane but whose landing no frame proved, and says so.
   *
   * `unaccounted`, never withdrawn and never typed again: the message may be in the agent's composer
   * now, or still on its way there from a pane too stalled to draw it, and the next copy is how one
   * message became three. It stays watched, so a transcript record that turns up later still proves it
   * delivered. The answer carries its id, so the person is offered "Send it", "Clear it" and "Retry"
   * for exactly this send rather than a terminal error naming a tmux session.
   */
  private async unconfirmed(id: SessionId, record: SendRecord): Promise<SendUnconfirmed> {
    await this.reserveTurn(id, record);
    await this.ports.ledger.settle(id, record.sendId, {
      fate: 'unaccounted',
      fateAt: this.ports.clock.now(),
      // The update's mark is a durable disposition: an ordinary landing outcome never replaces it.
      ...(isUpdateUnconfirmed(record) ? {} : { unaccountedReason: 'landing_unconfirmed' as const }),
      deadlineAt: undefined,
      retryable: undefined,
    });
    await this.ports.repository.journal(id, 'control.send_unaccounted', {
      sendId: record.sendId,
      reason: isUpdateUnconfirmed(record) ? 'update_unconfirmed' : 'landing_unconfirmed',
      attempt: record.attempt ?? 1,
    });
    this.ports.tracking.track(id);
    return new SendUnconfirmed(
      "the message was typed into the agent's box, but the agent has not shown it there yet, so it was not " +
        'sent. It may still appear: press Enter on it, clear it, or retry',
      record.sendId,
    );
  }

  /**
   * Takes back one send that was not proven delivered.
   *
   * WHAT THIS CAN UNDO is only what is still on Ferretry's side of the glass. A message sitting typed in
   * the composer is erased from it — and only when the composer holds exactly that message, so a
   * person's draft is never wiped. A message the harness already took into its own queue cannot be
   * edited from here and is said to be left there. The record moves to `cancelled` either way, so the
   * daemon stops retyping it and the row stops waiting, and the journal names the effect.
   */
  async cancel(id: SessionId, sendId: string): Promise<SendRecord> {
    return await this.ports.serial.run(id, async () => {
      const current = (await this.ports.ledger.list(id)).find(entry => entry.sendId === sendId);
      if (current === undefined || current.fate === 'withdrawn')
        throw new SendRefused(`session ${id} has no send ${sendId}`);
      if (current.fate === 'cancelled') return current;
      if (current.fate === 'delivered')
        throw new SendRefused(`send ${sendId} is already delivered; the agent has read it and it cannot be taken back`);
      const effect = await this.cancelEffect(id, current);
      const next = await this.ports.ledger.settle(id, sendId, {
        fate: 'cancelled',
        fateAt: this.ports.clock.now(),
        cancelEffect: effect,
        typedNotSent: undefined,
        deadlineAt: undefined,
        retryable: undefined,
      });
      if (next === undefined) throw new SendRefused(`send ${sendId} could not be cancelled`);
      await this.ports.repository.journal(id, 'control.send_cancelled', { sendId, from: current.fate, effect });
      return next;
    });
  }

  private async cancelEffect(id: SessionId, record: SendRecord): Promise<SendCancelEffect> {
    // A message held for a revive was never typed anywhere.
    if (record.held === true) return 'not_in_pane';
    const text = record.matchText ?? record.message;
    const where = await this.ports.terminal.heldAt(id, text).catch(() => undefined);
    if (where === 'queue') return 'left_in_queue';
    if (where !== 'composer') return 'not_in_pane';
    const cleared = await this.ports.terminal.clearComposer(id, text).catch(() => 'stuck' as const);
    return cleared === 'cleared' || cleared === 'absent' ? 'cleared' : 'left_in_composer';
  }

  /**
   * Presses Enter ONCE for a send sitting typed, and not sent, in the agent's composer.
   *
   * The terminal refuses unless the composer holds exactly this message, so it cannot submit somebody
   * else's draft; and it is one key per request, so a double tap is two requests the second of which
   * finds the composer empty. Where the message went is then the tracker's to prove, as for any send.
   */
  async submit(id: SessionId, sendId: string): Promise<SendRecord> {
    const record = await this.ports.serial.run(id, async () => {
      const current = (await this.ports.ledger.list(id)).find(entry => entry.sendId === sendId);
      if (current === undefined || current.fate === 'withdrawn')
        throw new SendRefused(`session ${id} has no send ${sendId}`);
      if (current.fate === 'delivered' || current.fate === 'cancelled')
        throw new SendRefused(`send ${sendId} is ${current.fate}; there is nothing to submit`);
      // THE ONE GUARD for every caller (the route, the Warden's port, a composer act): an Enter is a key, and only a
      // person's Retry may press one for a send the update left unconfirmed. Refused before the pane is even read.
      if (isUpdateUnconfirmed(current)) throw updateUnconfirmedRefusal(sendId);
      // Codex parks a submission made during its startup and has already accepted it: the composer shows the
      // text, but Enter is not ours to press (the terminal refuses too; this says why).
      this.refuseWhileParked(id, await this.ports.terminal.observe(id));
      const outcome = await this.ports.terminal.submitComposer(id, current.matchText ?? current.message);
      if (outcome === 'absent')
        throw new SendRefused(`send ${sendId} is not sitting in the agent's composer, so Enter was not pressed`);
      await this.ports.repository.journal(id, 'control.send_submitted', { sendId, outcome });
      if (outcome === 'holding') return current;
      return await this.entered(await this.require(id), current);
    });
    this.ports.tracking.track(id);
    return record;
  }

  /**
   * Presses Enter for this send's own text — its pointer, or the message typed as itself — still
   * sitting typed in the composer: the tracker's bounded nudge for an Enter the harness swallowed.
   *
   * Every condition is re-read under the session's lock, because the look that asked was not holding
   * it: the record must still be unsettled, the pane idle and undialogued, and the composer must hold
   * exactly this send's text. The nudge is counted BEFORE the key, as an attempt is, so a daemon that
   * dies mid-press cannot come back and press without limit. Anything else answers the record unchanged.
   */
  async resubmit(id: SessionId, sendId: string): Promise<SendRecord | undefined> {
    const record = await this.ports.serial.run(id, async () => {
      const current = (await this.ports.ledger.list(id)).find(entry => entry.sendId === sendId);
      if (current === undefined) return undefined;
      // The tracker watches open sends only; a delivered pointer the harness took back is the Warden's, the
      // queue's and the next send's to finish (&B153), never a nudge's.
      if (current.fate === 'delivered') return current;
      const outcome = await this.enterOwnText(id, current, 'daemon', STRANDED_ENTER_LIMIT);
      return outcome.record;
    });
    if (record !== undefined) this.ports.tracking.track(id);
    return record;
  }

  /**
   * B144 — NEVER QUEUE BEHIND A GHOST. The queue found the composer holding text and was about to wait for
   * a person to clear it. When the text is a send of THIS session's own that the daemon typed and whose
   * Enter never took, waiting is waiting on nobody: on 2026-11-02 a ferret sat idle for five hours with its
   * own turn pointer typed in its box while thirteen messages waited behind it as a "draft". So it is
   * finished here — one verified Enter, counted against {@link STRANDED_ENTER_LIMIT} — and the queue goes
   * on. Answers what blocks the box now: nothing (`submitted`), or the send whose text is still there, with
   * whether an Enter was tried, so the sender can be told plainly what its message is waiting behind.
   */
  async finishOwnDraft(
    id: SessionId,
  ): Promise<
    | { readonly kind: 'clear' }
    | { readonly kind: 'foreign' }
    | { readonly kind: 'stuck'; readonly sendId: string; readonly tried: boolean }
  > {
    const result = await this.ports.serial.run(id, async () => {
      const pane = await this.ports.terminal.observe(id);
      if (pane.draft === undefined) return { kind: 'clear' as const };
      const stranded = strandedSend(pane.draft, await this.ports.ledger.list(id));
      // A delivered pointer nothing proves the harness took back is a person's to deal with (&B153): a recall.
      if (stranded === undefined || !(await this.ours(id, stranded))) return { kind: 'foreign' as const };
      const outcome = await this.enterOwnText(id, stranded, 'queue', STRANDED_ENTER_LIMIT, pane);
      return outcome.outcome === 'submitted'
        ? { kind: 'clear' as const }
        : { kind: 'stuck' as const, sendId: stranded.sendId, tried: outcome.outcome !== 'refused' };
    });
    if (result.kind !== 'foreign') this.ports.tracking.track(id);
    return result;
  }

  /**
   * The Warden's one press for a send it found stuck (`input-stuck.ts`): the same verified Enter, allowed
   * one past {@link STRANDED_ENTER_LIMIT} because the Warden presses once per episode and then escalates.
   * `absent` when an idle, undialogued pane shows an EMPTY box: the message is not sitting there at all.
   */
  async resubmitStuck(id: SessionId, sendId: string): Promise<StrandedEnterOutcome> {
    const outcome = await this.ports.serial.run(id, async (): Promise<StrandedEnterOutcome> => {
      const current = (await this.ports.ledger.list(id)).find(entry => entry.sendId === sendId);
      if (current === undefined) return 'refused';
      const pane = await this.ports.terminal.observe(id);
      if (this.finishable(pane) && pane.draft === undefined) return 'absent';
      return (await this.enterOwnText(id, current, 'warden', STRANDED_ENTER_LIMIT + 1, pane)).outcome;
    });
    if (outcome !== 'refused') this.ports.tracking.track(id);
    return outcome;
  }

  /**
   * One verified Enter for a send's own text left typed in the composer, under the caller's lock. Refused —
   * nothing pressed — unless the send can still be stranded, the pane is idle and undialogued, the
   * composer holds EXACTLY this send's text, and the send has Enters left under `limit`. `observed` is a
   * frame the caller read under the same lock, so the pane is not captured twice for one decision.
   */
  private async enterOwnText(
    id: SessionId,
    record: SendRecord,
    by: 'send' | 'daemon' | 'queue' | 'warden',
    limit: number,
    observed?: SendPaneObservation,
  ): Promise<{ readonly outcome: StrandedEnterOutcome; readonly record: SendRecord }> {
    // A send the update left unconfirmed is a person's to retry: no automatic Enter is pressed for it, and no Enter
    // here is consent to resend it (`isUpdateUnconfirmed`).
    if (isUpdateUnconfirmed(record)) return { outcome: 'refused', record };
    const records = await this.ports.ledger.list(id);
    const text = strandableText(record, records);
    if (text === undefined || (record.submitNudges ?? 0) >= limit) return { outcome: 'refused', record };
    const pane = observed ?? (await this.ports.terminal.observe(id));
    if (!this.finishable(pane) || pane.draft === undefined || !showsOwnText(pane.draft, text))
      return { outcome: 'refused', record };
    // The same uniqueness every caller gets: when another unsettled send could equally be what the box holds
    // (two pastes whose placeholders read alike), neither is provably this one, and nothing is pressed.
    if (strandedSend(pane.draft, records)?.sendId !== record.sendId) return { outcome: 'refused', record };
    if (!(await this.provablyStranded(id, record))) return { outcome: 'refused', record };
    // A taken-back pointer is pressed only when the box is the WHOLE pointer — never a clipped or edited drawing of it.
    if (record.fate === 'delivered' && !sameComposerText(pane.draft, text)) return { outcome: 'refused', record };
    const counted = await this.ports.ledger.settle(id, record.sendId, { submitNudges: (record.submitNudges ?? 0) + 1 });
    return await this.finishStranded(await this.require(id), counted ?? record, by);
  }

  /**
   * Presses Enter on, or erases, the PERSON's own draft in the agent's composer — the one-tap way out
   * of a `composer_occupied` refusal.
   *
   * `draft` is what that refusal quoted back, and nothing is pressed unless the composer still holds
   * exactly it: a draft the person has since edited in the terminal answers `changed`. Clearing is the
   * same verified erase a cancel uses, so it stops rather than wipe text that is not that draft. The
   * journal records the act and its outcome, never the text.
   */
  async resolveDraft(id: SessionId, action: ComposerDraftAction, draft: string): Promise<ComposerDraftOutcome> {
    const outcome = await this.ports.serial.run(id, async () => {
      const target = await this.require(id);
      authorizeSend(target, []);
      const pane = await this.ports.terminal.observe(id);
      if (!pane.alive || pane.dead)
        throw new SendRefused(`the pane for session ${id} is gone; there is no composer to act on`);
      if (pane.blockingPrompt !== undefined)
        throw new SendRefused(`session ${id} is showing a prompt ("${pane.blockingPrompt}"); answer it first`);
      if (pane.draft === undefined) return 'absent' as const;
      if (!sameComposerText(pane.draft, draft)) return 'changed' as const;
      // The same guard as a send's own Enter: a draft that IS an update-unconfirmed send's text is that send in the
      // box, and an Enter here would send it without the person's Retry.
      if (action === 'submit') await this.refuseFlaggedDraft(id, pane.draft);
      const result: ComposerDraftOutcome =
        action === 'submit'
          ? await this.ports.terminal
              .submitComposer(id, pane.draft)
              .then(entered => (entered === 'absent' ? 'changed' : entered))
          : await this.ports.terminal
              .clearComposer(id, pane.draft)
              .then(cleared => (cleared === 'foreign' ? 'changed' : cleared));
      await this.ports.repository.journal(
        id,
        action === 'submit' ? 'control.composer_submitted' : 'control.composer_cleared',
        { outcome: result },
      );
      return result;
    });
    // An Enter may have answered an open send whose text the person had typed; its fate is looked for.
    if (outcome === 'submitted') this.ports.tracking.track(id);
    return outcome;
  }

  /** Refuses an Enter for a composer draft that shows an update-unconfirmed send's text, before any key. */
  private async refuseFlaggedDraft(id: SessionId, draft: string): Promise<void> {
    const flagged = (await this.ports.ledger.list(id)).find(record => {
      if (!isUpdateUnconfirmed(record)) return false;
      const text = record.matchText ?? record.message;
      return sameComposerText(draft, text) || showsOwnText(draft, text);
    });
    if (flagged !== undefined) throw updateUnconfirmedRefusal(flagged.sendId);
  }

  /**
   * The pane with any text of OURS cleared out of its composer, and the session as it then stands.
   *
   * A pointer — or a message typed as itself — that this session's ledger proves the daemon typed, and
   * whose Enter never took, is pressed once more with the usual verification (counted against
   * {@link STRANDED_ENTER_LIMIT}), its send settled as entered, and the pane read again. Any other draft —
   * a person's, an edited pointer, one that will not leave — is refused before a key, exactly as before.
   * `except` is the send being retried, whose own text is never finished here.
   */
  private async withoutStrandedPointer(
    target: SendTarget,
    pane: SendPaneObservation,
    except?: string,
  ): Promise<{ readonly target: SendTarget; readonly pane: SendPaneObservation }> {
    if (pane.draft === undefined) return { target, pane };
    const draft = pane.draft;
    const records = (await this.ports.ledger.list(target.id)).filter(record => record.sendId !== except);
    const stranded = this.finishable(pane) ? strandedSend(draft, records) : undefined;
    if (stranded === undefined) throw composerOccupiedRefusal(draft);
    const finished = await this.enterOwnText(target.id, stranded, 'send', STRANDED_ENTER_LIMIT, pane);
    if (finished.outcome !== 'submitted') throw composerOccupiedRefusal(draft);
    this.ports.tracking.track(target.id);
    return { target: await this.require(target.id), pane: await this.ports.terminal.observe(target.id) };
  }

  /**
   * A send arriving while Codex holds an earlier submission until its startup ends is PENDING, not refused,
   * and nothing is typed or pressed: the composer is drawn full but the harness has already taken what it
   * holds, so Enter would key a message Codex is about to send itself, and typing beside it would be refused
   * as a draft nobody wrote. The caller retries once startup has ended (the queue reads this as `launching`).
   */
  private refuseWhileParked(id: SessionId, pane: SendPaneObservation): void {
    if (pane.startupParked === true) throw startupParkedPending(id);
  }

  /** A pane where Enter submits the composer: alive, not mid-turn, not parked on a dialog, and not holding a submission until startup ends. */
  private finishable(pane: SendPaneObservation): boolean {
    return (
      pane.alive && !pane.dead && !pane.activeWork && pane.blockingPrompt === undefined && pane.startupParked !== true
    );
  }

  /** One verified Enter for a send's stranded text, journalled, and the send settled when it left. */
  private async finishStranded(
    target: SendTarget,
    record: SendRecord,
    by: 'send' | 'daemon' | 'queue' | 'warden',
  ): Promise<{ readonly outcome: ComposerSubmitOutcome; readonly record: SendRecord }> {
    const retracted = record.fate === 'delivered';
    const outcome = await this.ports.terminal.submitComposer(target.id, record.matchText ?? record.message, retracted);
    await this.ports.repository.journal(target.id, 'control.send_resubmitted', {
      sendId: record.sendId,
      outcome,
      by,
      reason: retracted
        ? 'pointer taken back into the composer by the harness'
        : strandablePointer(record) === undefined
          ? 'typed but not submitted'
          : 'pointer typed but not submitted',
    });
    if (outcome !== 'submitted') return { outcome, record };
    return {
      outcome,
      record: retracted ? await this.reopenedRetraction(target.id, record) : await this.entered(target, record),
    };
  }

  /**
   * &B153: a delivered pointer the harness took back, Entered again, is OPEN again: its delivery was the user record
   * the harness rewound, and only the record this Enter writes can prove it now. Left `delivered` on the old record,
   * it would read "never answered" for good — the new turn answers the NEW record — and a person's later Up-arrow
   * recall of it would qualify for another press.
   *
   * The old evidence STAYS on the record while it is open: every key on the ledger is claimed, so the tracker can
   * only settle it on a new user record, never on the rewound one again. Its turn is not started again (it already
   * was), and the attempt clock restarts now, like any Enter that took.
   */
  private async reopenedRetraction(id: SessionId, record: SendRecord): Promise<SendRecord> {
    const settled = await this.ports.ledger.settle(id, record.sendId, {
      fate: 'accepted',
      fateAt: undefined,
      typedNotSent: undefined,
      deadlineAt: undefined,
      attemptAt: this.ports.clock.now(),
    });
    return settled ?? record;
  }

  /**
   * Whether a send the box holds may be finished by the daemon: any unsettled send of ours, and a DELIVERED pointer
   * only when the transcript proves its user record was never answered — the harness took it back (&B153). A
   * delivered pointer that was answered and sits there again was put there by a person (a history recall), and an
   * unprovable one is treated the same: nothing is pressed.
   */
  private async provablyStranded(id: SessionId, record: SendRecord): Promise<boolean> {
    // A repaired retraction the tracker has not yet settled on its new user record is OPEN WITH EVIDENCE — no other
    // send ever is (`reopenedRetraction`). Nothing proves the box's text is still ours then, so no path presses it.
    if (record.evidence !== undefined && record.fate !== 'delivered') return false;
    if (record.fate !== 'delivered') return true;
    // ONE repair per send: a pointer pressed once already and taken back again is escalated, never pressed again.
    // Its earlier user records are no longer on the ledger, so a later recall could otherwise lean on a stale one.
    return (record.submitNudges ?? 0) === 0 && (await this.ours(id, record));
  }

  /**
   * Whether the box's text is provably a send of ours at all: any unsettled one, or a delivered pointer the transcript
   * proves was never answered (&B153). Ours is not the same as pressable — see {@link provablyStranded}.
   */
  private async ours(id: SessionId, record: SendRecord): Promise<boolean> {
    if (record.fate !== 'delivered') return true;
    const proof = this.ports.retraction;
    return proof !== undefined && (await proof.unanswered(id, record).catch(() => false));
  }

  /**
   * &B153: the delivered pointer of this session that the harness has put back in its composer, if an idle,
   * undialogued pane shows exactly that (`retractedPointer`) — for the Warden's input-stuck sweep, which
   * otherwise only sees sends the tracker still watches. Reads the pane; presses nothing.
   */
  async retractedDraft(id: SessionId): Promise<string | undefined> {
    return await this.ports.serial.run(id, async () => {
      const records = await this.ports.ledger.list(id);
      if (!records.some(record => retractedPointer(record, records) !== undefined)) return undefined;
      const pane = await this.ports.terminal.observe(id);
      if (!this.finishable(pane) || pane.draft === undefined) return undefined;
      const stranded = strandedSend(pane.draft, records);
      // Flagged when provably ours, so one already repaired once is still reported and the Warden escalates it —
      // `resubmitStuck` refuses to press it again (`provablyStranded`).
      return stranded?.fate === 'delivered' && (await this.ours(id, stranded)) ? stranded.sendId : undefined;
    });
  }

  /**
   * A send whose text an Enter just took out of the composer, recorded as entered.
   *
   * NOT `delivered`: only the transcript proves that, and the tracker will look. What the Enter does
   * prove is that the message is no longer typed-and-waiting, so that flag goes, an unconfirmed fate
   * re-opens, and the attempt's clock restarts NOW — measured from the original typing, a deadline
   * long past would call it absent before the harness had written its record, and retype it. A turn
   * its own send never got to start is started here, so the next send does not claim the same number.
   */
  private async entered(target: SendTarget, record: SendRecord): Promise<SendRecord> {
    const settled = await this.ports.ledger.settle(target.id, record.sendId, {
      typedNotSent: undefined,
      deadlineAt: undefined,
      attemptAt: this.ports.clock.now(),
      // The update's mark is not reopened by an Enter: the old claim still cannot be told from this send's input.
      ...(record.fate === 'unaccounted' && !isUpdateUnconfirmed(record)
        ? { fate: 'accepted', fateAt: undefined, unaccountedReason: undefined, retryable: undefined }
        : {}),
    });
    const turn = record.turn;
    // A turn an unconfirmed typing RESERVED (`reserveTurn`) has its number already and has not started yet.
    const reserved = target.turn === turn && isUnconfirmedTyping(record);
    if (
      turn !== undefined &&
      (record.path === 'turn-file' || record.path === 'direct') &&
      (target.turn < turn || reserved)
    )
      await this.turnStarted(target.id, {
        sendId: record.sendId,
        message: record.message,
        turn,
        direct: record.path === 'direct',
        replyExpected: record.replyExpected === true,
        from: record.from,
        fromName: record.fromName,
      });
    return settled ?? record;
  }

  /**
   * The daemon's retry found the send already held in the harness's queue: that is the proof the
   * tracker was looking for, so the send becomes `queued` on it instead of being typed again.
   */
  private async provenHeld(id: SessionId, record: SendRecord): Promise<SendRecord> {
    if (record.fate === 'queued') return record;
    const settled = (await this.queued(id, record, 'held')) ?? record;
    await this.ports.repository.journal(id, 'control.send_queued', { sendId: record.sendId, proof: 'pane' });
    return settled;
  }

  /** Records the pane's proof that the harness is holding a send, when it gave one. */
  private async queued(id: SessionId, record: SendRecord, outcome: SendQueueOutcome): Promise<SendRecord | undefined> {
    if (outcome !== 'held') return undefined;
    const at = this.ports.clock.now();
    return await this.ports.ledger.settle(id, record.sendId, {
      fate: 'queued',
      fateAt: at,
      queuedAt: at,
      queueProof: 'pane',
    });
  }

  /**
   * The terminal-or-dead path: the message becomes the first turn of a revive.
   *
   * Accepted under the lock and then revived outside it, because the reviver takes the same
   * per-session lock — holding it here would deadlock the send against the revive it asked for.
   */
  private async revive(
    request: SendMessageRequest,
    payload: string,
    sender: SendTarget | undefined,
  ): Promise<Extract<LockedOutcome, { kind: 'settled' }>> {
    const accepted = await this.ports.serial.run(request.id, async () => {
      const target = await this.require(request.id);
      return await this.accept(target, request, sender, {
        sendId: request.sendId,
        path: 'revive',
        message: payload,
        turn: await this.revivedTurn(target, request.sendId),
      });
    });
    if (!accepted.created) return this.settledAs(accepted.record, false);
    let delivered: string | undefined;
    try {
      delivered = await this.ports.reviver.revive(request.id, payload);
    } catch (error) {
      // A refusal is a policy decision about the RELAUNCH, not about the message. Turning it into a
      // lost message would make a safety check into data loss, so the send is held durably and an
      // explicit revive remains available.
      if (error instanceof ReviveRefusedForSend) return await this.hold(request, payload, sender, error);
      throw error;
    }
    const record = await this.carried(request.id, accepted.record, delivered);
    await this.ports.channel.recordInbound(request.id, {
      at: this.ports.clock.now(),
      message: payload,
      turn: accepted.record.turn,
      ...this.attribution(sender),
    });
    return { kind: 'settled', path: 'revive', applied: true, record, held: true };
  }

  /**
   * B144 — A TYPED POINTER'S TURN IS TAKEN, started or not. A typing whose landing no frame proved never
   * reached the turn bookkeeping, so the session stayed on the previous turn while the pointer — which the
   * pane may draw and somebody may submit at any time — named the next turn's file. Every later turn file
   * (a send, a revive, the resume domain's own) was numbered from the session's turn, and the next one
   * overwrote it. So the number is reserved on the session itself, its reason left alone; the turn starts
   * when an Enter is seen to take it (`entered`).
   */
  private async reserveTurn(id: SessionId, record: SendRecord): Promise<void> {
    const turn = record.turn;
    if (turn === undefined || (record.path !== 'turn-file' && record.path !== 'direct')) return;
    const target = await this.ports.repository.read(id);
    if (target === undefined || target.turn >= turn) return;
    await this.ports.repository.transition(id, { event: 'control.turn_reserved', turn, keepReason: true });
  }

  /**
   * The turn a revive's message is carried as. The resume domain numbers its turn file from the session's
   * turn, so a turn a send still names that the session has not reserved (one recorded before reservations
   * existed) is reserved first: the relaunch's file and this record then agree, and neither overwrites it.
   */
  private async revivedTurn(target: SendTarget, sendId: string): Promise<number> {
    const records = await this.ports.ledger.list(target.id);
    // A replayed request is answered from its first record by `accept`: nothing is reserved for it again,
    // and its own record is not a turn some OTHER send names.
    const replayed = records.find(record => record.sendId === sendId && record.fate !== 'withdrawn');
    if (replayed !== undefined) return replayed.turn ?? target.turn + 1;
    const turn = nextTurnNumber(target, records);
    if (turn > target.turn + 1)
      await this.ports.repository.transition(target.id, {
        event: 'control.turn_reserved',
        turn: turn - 1,
        keepReason: true,
      });
    return turn;
  }

  /**
   * Records what the relaunch TYPED for a revive-carried send, and starts its attempt from then.
   *
   * A revive does not type the message: it writes it to the new turn's file and types a pointer at
   * it, so the transcript records the pointer as what the user said. The record used to keep only the
   * message, the tracker looked for text no transcript would ever hold, and every revive-delivered
   * message — read and acted on by the agent seconds later — was told to its sender as "not delivered"
   * at the first deadline. The deadline is also counted from the typing, not the acceptance: the
   * relaunch before it can take longer than an agent send's whole first window.
   */
  private async carried(id: SessionId, record: SendRecord, delivered: string | undefined): Promise<SendRecord> {
    if (delivered === undefined) return record;
    const settled = await this.ports.serial.run(
      id,
      async () =>
        await this.ports.ledger.settle(id, record.sendId, { matchText: delivered, attemptAt: this.ports.clock.now() }),
    );
    return settled ?? record;
  }

  /** Retains a message the reviver would not carry, so an explicit revive can still deliver it. */
  private async hold(
    request: SendMessageRequest,
    payload: string,
    sender: SendTarget | undefined,
    refusal: ReviveRefusedForSend,
  ): Promise<Extract<LockedOutcome, { kind: 'settled' }>> {
    const held = await this.ports.serial.run(request.id, async () => {
      const revised = await this.ports.ledger.revise(request.id, request.sendId, {
        path: 'revive-queue',
        held: true,
        matchText: undefined,
        turn: undefined,
      });
      if (revised === undefined)
        throw new Error(`could not retain accepted send ${request.sendId} for an explicit revive`);
      return revised;
    });
    await this.ports.channel.recordInbound(request.id, {
      at: this.ports.clock.now(),
      message: payload,
      queueId: request.sendId,
      queuedForRevive: true,
      reason: refusal.message,
      ...this.attribution(sender),
    });
    await this.ports.repository.journal(request.id, 'control.send_queued', {
      sendId: request.sendId,
      queuedForRevive: true,
      native: false,
      reason: refusal.message,
      ...(refusal.conflictSessionId === undefined ? {} : { conflictSessionId: refusal.conflictSessionId }),
      ...this.attribution(sender),
    });
    // `applied` stays true: the message IS durably held for this session, so the sender's own outbox
    // must record having sent it. What it must NOT do is end a peer wait — see `attribute`.
    return { kind: 'settled', path: 'revive-queue', applied: true, record: held, held: false };
  }

  /** An outcome for a send this request did not transport: a duplicate, answered from its record. */
  private settledAs(record: SendRecord, held: boolean): Extract<LockedOutcome, { kind: 'settled' }> {
    return { kind: 'settled', path: record.path, applied: false, record, held };
  }

  /**
   * The record a transport is about to type for: a fresh acceptance, or — for a held message being
   * released after a revive — the existing record moved onto this transport and un-held.
   */
  private async transported(
    target: SendTarget,
    request: SendMessageRequest,
    sender: SendTarget | undefined,
    release: HeldRelease | undefined,
    input: Pick<SendRecord, 'path' | 'message' | 'matchText' | 'turn' | 'payloadFile'>,
  ): Promise<{ record: SendRecord; created: boolean }> {
    if (release === undefined) return await this.accept(target, request, sender, { sendId: request.sendId, ...input });
    const { message: _released, ...transport } = input;
    const record = await this.ports.ledger.settle(target.id, release.record.sendId, {
      ...transport,
      held: false,
      attemptAt: this.ports.clock.now(),
    });
    await this.ports.repository.journal(target.id, 'control.send_released', {
      sendId: release.record.sendId,
      path: input.path,
    });
    return { record: record ?? release.record, created: true };
  }

  /** Records the send as accepted, and journals that acceptance before anything is typed. */
  private async accept(
    target: SendTarget,
    request: SendMessageRequest,
    sender: SendTarget | undefined,
    input: Pick<SendRecord, 'sendId' | 'path' | 'message' | 'matchText' | 'turn' | 'payloadFile'>,
  ): Promise<{ record: SendRecord; created: boolean }> {
    const now = this.ports.clock.now();
    const accepted = await this.ports.ledger.accept(target.id, {
      ...input,
      acceptedAt: now,
      acceptedTurn: target.turn,
      fate: 'accepted',
      attempt: 1,
      attemptAt: now,
      senderKind: request.origin === 'daemon' ? 'daemon' : sender === undefined ? 'human' : 'agent',
      ...(request.by === undefined ? {} : { by: request.by }),
      ...(request.attachmentIds === undefined || request.attachmentIds.length === 0
        ? {}
        : { attachmentIds: [...request.attachmentIds] }),
      ...(request.replyExpected === true ? { replyExpected: true } : {}),
      ...this.attribution(sender),
      ...(request.parts === undefined || request.parts.length < 2
        ? {}
        : { batch: request.parts.map(part => ({ queueId: part.queueId, from: part.senderReference })) }),
    });
    if (!accepted.created) return accepted;
    try {
      await this.ports.repository.journal(target.id, 'control.send_accepted', {
        sendId: accepted.record.sendId,
        path: accepted.record.path,
        acceptedTurn: accepted.record.acceptedTurn,
        ...(accepted.record.turn === undefined ? {} : { turn: accepted.record.turn }),
        ...this.attribution(sender),
      });
    } catch (error) {
      // Nothing has been typed yet, so this is the one phase where a tombstone is safe and a retry
      // with the same id may honestly start over.
      await this.ports.ledger.withdraw(target.id, accepted.record.sendId, 'acceptance could not be journalled');
      throw error;
    }
    return accepted;
  }

  /**
   * The sender's own record of the message, and the end of the recipient's wait on it.
   *
   * Both run AFTER delivery, so a waiter is never woken for a message that failed to land — and the
   * outbox is written with the message the sender ASKED to send, before the attribution banner the
   * receiver needs was added to it.
   */
  private async attribute(
    target: SendTarget,
    sender: SendTarget,
    text: string,
    settled: Extract<LockedOutcome, { kind: 'settled' }>,
  ): Promise<void> {
    const disposition = dispositionOf(settled.path, settled.held);
    await this.ports.channel
      .recordOutbound(sender.id, {
        at: this.ports.clock.now(),
        to: target.id,
        from: sender.id,
        disposition,
        message: text.trim(),
        ...(sender.teammate === undefined ? {} : { fromName: sender.teammate }),
      })
      .catch(async (error: unknown) => {
        // Delivery already happened, so the disposition must not change and invite a duplicate retry.
        // The missing audit row is surfaced loudly instead.
        await this.ports.repository
          .journal(target.id, 'control.outbox_write_failed', {
            from: sender.id,
            to: target.id,
            disposition,
            error: error instanceof Error ? error.message : String(error),
          })
          .catch(() => undefined);
      });
    // A message merely HELD for an explicit revive reached no running agent, so a park ended on it
    // would wake the waiter for a reply nobody has been asked to give.
    if (settled.path === 'revive-queue') return;
    if (!endsPeerWait(target, sender.id)) return;
    await this.ports.peerWaits.endPeerWait(target.id, sender.id).catch(() => undefined);
  }

  /**
   * The session this call came from, if a teammate made it.
   *
   * An UNRESOLVABLE reference degrades to an unattributed send rather than failing it: attribution is
   * a label on a message, and a delivered message matters more than a cosmetic field. A session that
   * addressed itself is likewise not a peer — a preamble telling an agent it has a message from
   * itself is noise at best.
   */
  private async sender(request: SendMessageRequest): Promise<SendTarget | undefined> {
    const reference = request.senderReference?.trim();
    if (reference === undefined || reference === '' || reference === request.id) return undefined;
    const sender = await this.ports.repository.resolveSender(reference).catch(() => undefined);
    return sender?.id === request.id ? undefined : sender;
  }

  /**
   * The text the agent actually reads: the message, with peer attribution when a peer sent it.
   *
   * The recipient is read only for a peer send, to tell a REPLY it is parked on from a new message; a
   * recipient that cannot be read yet degrades to the plainer kind rather than failing the send.
   */
  private async payload(
    request: SendMessageRequest,
    sender: SendTarget | undefined,
    parties: readonly Party[] | undefined,
  ): Promise<string> {
    if (parties !== undefined) {
      const recipient = await this.ports.repository.read(request.id).catch(() => undefined);
      return combinedDelivery(
        parties.map(({ part, sender: from }) => {
          // A sender that can no longer be resolved is still named by the reference it sent under.
          const who = from ?? { id: part.senderReference as SessionId };
          const kind = peerMessageKind(recipient, who.id, part.replyExpected);
          return { sender: peerSender(who, kind, part.label), body: sendPayload(part.text) };
        }),
        this.settings.clientName,
      );
    }
    const message = sendPayload(request.message);
    if (sender === undefined) return message;
    const recipient = await this.ports.repository.read(request.id).catch(() => undefined);
    const kind = peerMessageKind(recipient, sender.id, request.replyExpected === true);
    return `${peerPreamble(sender, kind, this.settings.clientName, request.label)}${message}`;
  }

  /** The senders of a combined delivery, each resolved; `undefined` for a send of one message. */
  private async parties(request: SendMessageRequest): Promise<readonly Party[] | undefined> {
    const parts = request.parts;
    if (parts === undefined || parts.length < 2) return undefined;
    return await Promise.all(
      parts.map(async part => ({
        part,
        sender: await this.ports.repository.resolveSender(part.senderReference).catch(() => undefined),
      })),
    );
  }

  /** The sender's canonical identity, never the reference the caller supplied. */
  private attribution(sender: SendTarget | undefined): { from?: string; fromName?: string } {
    if (sender === undefined) return {};
    return { from: sender.id, ...(sender.teammate === undefined ? {} : { fromName: sender.teammate }) };
  }

  private async require(id: SessionId): Promise<SendTarget> {
    const target = await this.ports.repository.read(id);
    if (target === undefined) throw new SendRefused(`session not found: ${id}`);
    return target;
  }
}
