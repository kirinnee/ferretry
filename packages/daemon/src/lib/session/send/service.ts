import type { SendCancelEffect, SendDisposition } from '@ferretry/protocol';
import type { ClockPort, SerialExecutor } from '../../ports.ts';
import type { SessionId } from '../../session-id.ts';
import {
  authorizeSend,
  directLimitFor,
  endsPeerWait,
  isDirectPayload,
  isFileBackedQueue,
  paneMidTurn,
  peerMessageKind,
  peerPreamble,
  queuedPayloadInstruction,
  routeSend,
  sendPayload,
  shouldPressStopKey,
  turnInstruction,
  typedIntoBusyPane,
} from './policy.ts';
import type { SessionSendSettings } from './settings.ts';
import { sameComposerText, showsOwnPointer, strandablePointer, strandedPointerSend } from './stranded.ts';
import {
  type ComposerDraftAction,
  type ComposerDraftOutcome,
  type ComposerSubmitOutcome,
  dispositionOf,
  type PeerWaitEnder,
  ReviveRefusedForSend,
  type SendChannel,
  SendComposerOccupied,
  SendComposerUnreadable,
  SendDraftRefused,
  SendLandingUnconfirmed,
  type SendLaunchGate,
  type SendLedger,
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
  SendUnavailable,
  SendUnconfirmed,
  TERMINAL_SEND_STATUSES,
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
  /** Told after every transport, so the send's true fate is looked for rather than assumed. */
  readonly tracking: SendTracking;
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

/** A held message being delivered after its session came back. */
interface HeldRelease {
  readonly record: SendRecord;
}

/** Fates still being looked for, which only the daemon's tracker may re-attempt. */
const OPEN_FATES: ReadonlySet<SendRecord['fate']> = new Set(['accepted', 'queued']);

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
/** The fields a re-attempt overwrites, as they stood before it, so a refused one can put them back. */
function restorable(record: SendRecord): SendSettlement {
  return {
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
  };
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
    const payload = await this.payload(request, sender);
    const locked = await this.ports.serial.run(request.id, async () => await this.locked(request, payload, sender));
    const settled = locked.kind === 'revive' ? await this.revive(request, payload, sender) : locked;
    // Only a NEW transport is tracked: a duplicate request found a send already being watched.
    if (settled.applied) this.ports.tracking.track(request.id);
    const target = await this.require(request.id);
    if (sender !== undefined && settled.applied) await this.attribute(target, sender, request, settled);
    return { target, disposition: dispositionOf(settled.path, settled.held), record: settled.record };
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
    const record = await this.ports.serial.run(id, async () => {
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
      const target = await this.require(id);
      authorizeSend(target, []);
      const observed = await this.ports.terminal.observe(id);
      if (routeSend(target, observed) === 'revive')
        throw new SendRefused(`session ${id} has no live agent to retype ${sendId} into; revive it first`);
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
          `send ${sendId} is typed in the agent's composer and not sent; press Enter instead`,
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
      const attempt = (current.attempt ?? 1) + 1;
      const next = await this.ports.ledger.settle(id, sendId, {
        fate: 'accepted',
        attempt,
        attemptAt: this.ports.clock.now(),
        fateAt: undefined,
        deadlineAt: undefined,
        unaccountedReason: undefined,
        retryable: undefined,
        queuedAt: undefined,
        queueProof: undefined,
        submitNudges: undefined,
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
        if (!(error instanceof SendComposerOccupied) && !(error instanceof SendComposerUnreadable)) throw error;
        // Nothing was typed, so the record goes back to exactly what it said before this attempt.
        await this.ports.ledger.settle(id, sendId, restorable(current));
        if (error instanceof SendComposerOccupied) throw composerOccupiedRefusal(error.draft);
        throw new SendRetypeWithheld(
          `the agent's composer could not be read to prove it empty, so send ${sendId} was not typed again`,
          'unreadable',
        );
      }
    });
    this.ports.tracking.track(id);
    return record;
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
    const held = (await this.ports.ledger.list(id)).filter(
      record => record.held === true && record.fate === 'accepted',
    );
    let released = 0;
    for (const record of held) {
      const outcome = await this.ports.serial.run(id, async () => {
        const current = (await this.ports.ledger.list(id)).find(entry => entry.sendId === record.sendId);
        if (current?.held !== true || current.fate !== 'accepted') return undefined;
        const target = await this.require(id);
        const pane = await this.ports.terminal.observe(id);
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
    if (released > 0) this.ports.tracking.track(id);
    return released;
  }

  /**
   * Stops whatever the agent is doing, and hands the terminal back.
   *
   * A BOUND abandon — an interrupt that names the structured question it is cancelling — is refused
   * rather than approximated. Cancelling a rendered question means driving the harness's own form
   * back out of the way and confirming it went, and that machinery is not in this daemon (survey
   * section F). Pressing the generic interrupt at a form would answer it with whatever the keys land
   * on, which is a worse outcome than a clear refusal.
   */
  async interrupt(id: SessionId): Promise<SendTarget> {
    return await this.ports.serial.run(id, async () => await this.interruptLocked(id));
  }

  private async interruptLocked(id: SessionId): Promise<SendTarget> {
    const target = await this.require(id);
    if (target.status === 'kill_failed')
      throw new SendUnavailable(
        `the previous terminal shutdown for ${id} was not confirmed; stop it successfully rather than interrupting it`,
      );
    if (target.pendingQuestion !== undefined)
      throw new SendUnavailable(
        `session ${id} is holding structured question ${target.pendingQuestion.toolUseId}; abandoning a ` +
          'rendered question is not served yet, and a generic interrupt would answer it by accident',
      );
    if (TERMINAL_SEND_STATUSES.has(target.status))
      throw new SendRefused(`session ${id} is ${target.status}; there is no running turn to interrupt`);
    const before = await this.ports.terminal.observe(id);
    if (!before.alive || before.dead)
      throw new SendRefused(`the pane for session ${id} is gone; revive it rather than interrupting it`);
    await this.ports.repository.journal(id, 'control.interrupt_requested', { status: target.status });
    // The keystroke is conditional; the state edge is not. See `shouldPressStopKey` for why sending a
    // stop key at an idle prompt is a way to KILL the very agent the caller asked to pause.
    if (shouldPressStopKey(target, before)) await this.ports.terminal.pressStopKey(id);
    const after = await this.ports.terminal.observe(id).catch(() => undefined);
    // An interactive pane with no active work goes to `awaiting_user`, not `interrupted`: the human
    // pressed stop and the terminal is theirs again. `interrupted` would also be STICKY — the status
    // an idle session claims forever — so a person who paused their own agent would keep being shown
    // as having interrupted it. "Idle" here is the absence of active work rather than a ready prompt,
    // because a human with half a message typed has a busy composer and is plainly still idle.
    const handedBack = target.mode === 'interactive' && after !== undefined && !after.activeWork;
    return await this.ports.repository.transition(id, {
      event: 'control.interrupted',
      status: handedBack ? 'awaiting_user' : 'interrupted',
      health: 'idle',
      promptReady: true,
      ...(handedBack ? {} : { reason: 'interrupted by client' }),
    });
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
    const turn = target.turn + 1;
    const turnFile = await this.ports.turns.writeTurn(target.id, turn, `${payload}\n`);
    const direct = isDirectPayload(payload, directLimitFor(target, this.settings));
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
    // one exception is a refusal BEFORE any keystroke, which `untyped` turns back into a refusal.
    await this.untyped(
      target.id,
      accepted.record,
      release,
      async () => await this.ports.terminal.deliver(target.id, text),
    );
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
    const outcome = await this.untyped(
      target.id,
      accepted.record,
      release,
      async () => await this.ports.terminal.queue(target.id, text),
    );
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
   * over) and a released held message goes back to being held.
   */
  private async untyped<T>(
    id: SessionId,
    record: SendRecord,
    release: HeldRelease | undefined,
    transport: () => Promise<T>,
  ): Promise<T> {
    try {
      return await transport();
    } catch (error) {
      if (error instanceof SendLandingUnconfirmed) throw await this.unconfirmed(id, record);
      if (!(error instanceof SendComposerOccupied) && !(error instanceof SendComposerUnreadable)) throw error;
      const occupied = error instanceof SendComposerOccupied;
      if (release !== undefined) await this.ports.ledger.settle(id, record.sendId, { held: true });
      else
        await this.ports.ledger.withdraw(
          id,
          record.sendId,
          occupied ? 'the composer held unsent text' : 'the composer could not be read',
        );
      if (occupied) throw composerOccupiedRefusal(error.draft);
      throw composerUnreadableRefusal();
    }
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
    await this.ports.ledger.settle(id, record.sendId, {
      fate: 'unaccounted',
      fateAt: this.ports.clock.now(),
      unaccountedReason: 'landing_unconfirmed',
      deadlineAt: undefined,
      retryable: undefined,
    });
    await this.ports.repository.journal(id, 'control.send_unaccounted', {
      sendId: record.sendId,
      reason: 'landing_unconfirmed',
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
   * Presses Enter for this send's own POINTER, still sitting typed in the composer — the tracker's
   * bounded nudge for an Enter the harness swallowed.
   *
   * Every condition is re-read under the session's lock, because the look that asked was not holding
   * it: the record must still be unsettled, the pane idle and undialogued, and the composer must hold
   * exactly this pointer. The nudge is counted BEFORE the key, as an attempt is, so a daemon that dies
   * mid-press cannot come back and press without limit. Anything else answers the record unchanged.
   */
  async resubmit(id: SessionId, sendId: string): Promise<SendRecord | undefined> {
    const record = await this.ports.serial.run(id, async () => {
      const current = (await this.ports.ledger.list(id)).find(entry => entry.sendId === sendId);
      const pointer = current === undefined ? undefined : strandablePointer(current);
      if (current === undefined || pointer === undefined) return current;
      const pane = await this.ports.terminal.observe(id);
      if (!this.finishable(pane) || pane.draft === undefined || !showsOwnPointer(pane.draft, pointer)) return current;
      const counted = await this.ports.ledger.settle(id, sendId, { submitNudges: (current.submitNudges ?? 0) + 1 });
      const outcome = await this.finishStranded(await this.require(id), counted ?? current, 'daemon');
      return outcome.record;
    });
    if (record !== undefined) this.ports.tracking.track(id);
    return record;
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

  /**
   * The pane with any pointer of OURS cleared out of its composer, and the session as it then stands.
   *
   * A pointer this session's ledger proves the daemon typed, and whose Enter never took, is pressed
   * once more with the usual verification, its send settled as entered, and the pane read again. Any
   * other draft — a person's, an edited pointer, one that will not leave — is refused before a key,
   * exactly as before. `except` is the send being retried, whose own text is never finished here.
   */
  private async withoutStrandedPointer(
    target: SendTarget,
    pane: SendPaneObservation,
    except?: string,
  ): Promise<{ readonly target: SendTarget; readonly pane: SendPaneObservation }> {
    if (pane.draft === undefined) return { target, pane };
    const draft = pane.draft;
    const records = (await this.ports.ledger.list(target.id)).filter(record => record.sendId !== except);
    const stranded = this.finishable(pane) ? strandedPointerSend(draft, records) : undefined;
    if (stranded === undefined) throw composerOccupiedRefusal(draft);
    const finished = await this.finishStranded(target, stranded, 'send');
    if (finished.outcome !== 'submitted') throw composerOccupiedRefusal(draft);
    this.ports.tracking.track(target.id);
    return { target: await this.require(target.id), pane: await this.ports.terminal.observe(target.id) };
  }

  /** A pane where Enter submits the composer: alive, not mid-turn, and not parked on a dialog. */
  private finishable(pane: SendPaneObservation): boolean {
    return pane.alive && !pane.dead && !pane.activeWork && pane.blockingPrompt === undefined;
  }

  /** One verified Enter for a stranded pointer, journalled, and the send settled when it left. */
  private async finishStranded(
    target: SendTarget,
    record: SendRecord,
    by: 'send' | 'daemon',
  ): Promise<{ readonly outcome: ComposerSubmitOutcome; readonly record: SendRecord }> {
    const outcome = await this.ports.terminal.submitComposer(target.id, record.matchText ?? record.message);
    await this.ports.repository.journal(target.id, 'control.send_resubmitted', {
      sendId: record.sendId,
      outcome,
      by,
      reason: 'pointer typed but not submitted',
    });
    return { outcome, record: outcome === 'submitted' ? await this.entered(target, record) : record };
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
      ...(record.fate === 'unaccounted'
        ? { fate: 'accepted', fateAt: undefined, unaccountedReason: undefined, retryable: undefined }
        : {}),
    });
    const turn = record.turn;
    if (turn !== undefined && (record.path === 'turn-file' || record.path === 'direct') && target.turn < turn)
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
        turn: target.turn + 1,
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
      ...(request.attachmentIds === undefined || request.attachmentIds.length === 0
        ? {}
        : { attachmentIds: [...request.attachmentIds] }),
      ...(request.replyExpected === true ? { replyExpected: true } : {}),
      ...this.attribution(sender),
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
    request: SendMessageRequest,
    settled: Extract<LockedOutcome, { kind: 'settled' }>,
  ): Promise<void> {
    const disposition = dispositionOf(settled.path, settled.held);
    await this.ports.channel
      .recordOutbound(sender.id, {
        at: this.ports.clock.now(),
        to: target.id,
        from: sender.id,
        disposition,
        message: request.message.trim(),
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
  private async payload(request: SendMessageRequest, sender: SendTarget | undefined): Promise<string> {
    const message = sendPayload(request.message);
    if (sender === undefined) return message;
    const recipient = await this.ports.repository.read(request.id).catch(() => undefined);
    const kind = peerMessageKind(recipient, sender.id, request.replyExpected === true);
    return `${peerPreamble(sender, kind, this.settings.clientName)}${message}`;
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
