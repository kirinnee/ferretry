import type { SendDisposition } from '@ferretry/protocol';
import type { ClockPort, SerialExecutor } from '../../ports.ts';
import type { SessionId } from '../../session-id.ts';
import {
  authorizeSend,
  directLimitFor,
  endsPeerWait,
  isDirectPayload,
  isFileBackedQueue,
  peerPreamble,
  queuedPayloadInstruction,
  routeSend,
  sendPayload,
  shouldPressStopKey,
  turnInstruction,
} from './policy.ts';
import type { SessionSendSettings } from './settings.ts';
import {
  dispositionOf,
  type PeerWaitEnder,
  ReviveRefusedForSend,
  type SendChannel,
  type SendLaunchGate,
  type SendLedger,
  type SendPath,
  SendPending,
  type SendRecord,
  SendRefused,
  type SendRepository,
  type SendReviver,
  type SendTarget,
  type SendTerminal,
  type SendTurnStore,
  SendUnavailable,
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
}

export interface SendOutcome {
  readonly target: SendTarget;
  readonly disposition: SendDisposition;
}

/** What the locked section decided, before anything that must happen outside the lock. */
type LockedOutcome =
  | { readonly kind: 'revive' }
  | { readonly kind: 'settled'; readonly path: SendPath; readonly applied: boolean };

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
    const payload = this.payload(request, sender);
    const locked = await this.ports.serial.run(request.id, async () => await this.locked(request, payload, sender));
    const settled = locked.kind === 'revive' ? await this.revive(request, payload, sender) : locked;
    const target = await this.require(request.id);
    if (sender !== undefined && settled.applied) await this.attribute(target, sender, request, settled.path);
    return { target, disposition: dispositionOf(settled.path) };
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
    const target = await this.require(request.id);
    authorizeSend(target, request.attachmentIds ?? []);
    const first = await this.ports.terminal.observe(request.id);
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
    if (settled === 'idle') return await this.deliver(target, request, payload, sender);
    return await this.queue(target, request, payload, sender);
  }

  /**
   * The tracked path: a turn document, a proven prompt, and a session that has genuinely moved on.
   *
   * The turn document is written on BOTH transports, not only the indirect one. It is what the logs
   * and a later revive read to know what this turn asked for, and a direct send that skipped it would
   * leave the agent holding an instruction with no durable record of what it was.
   */
  private async deliver(
    target: SendTarget,
    request: SendMessageRequest,
    payload: string,
    sender: SendTarget | undefined,
  ): Promise<LockedOutcome> {
    const turn = target.turn + 1;
    const turnFile = await this.ports.turns.writeTurn(target.id, turn, `${payload}\n`);
    const direct = isDirectPayload(payload, directLimitFor(target, this.settings));
    const text = direct ? payload : turnInstruction(turnFile);
    const accepted = await this.accept(target, request, sender, {
      sendId: request.sendId,
      path: direct ? 'direct' : 'turn-file',
      message: payload,
      matchText: text,
      turn,
    });
    if (!accepted.created) return { kind: 'settled', path: accepted.record.path, applied: false };
    // May throw after the keys landed or the Enter was consumed. That is an UNCERTAIN fate, never a
    // withdrawal: the record stays accepted so a human can see a message that may have arrived.
    await this.ports.terminal.deliver(target.id, text);
    await this.ports.channel.recordInbound(target.id, {
      at: this.ports.clock.now(),
      message: payload,
      turn,
      ...this.attribution(sender),
    });
    // Cleared now that the new prompt has demonstrably landed: a `done` written while this send was
    // in flight belongs to the turn that just ended.
    await this.ports.turns.clearMarkers(target.id);
    await this.ports.repository.journal(target.id, 'control.send', {
      sendId: request.sendId,
      turn,
      direct,
      ...(request.replyExpected === true ? { replyExpected: true } : {}),
      ...this.attribution(sender),
    });
    await this.ports.repository.transition(target.id, {
      event: 'turn.started',
      status: 'running',
      health: 'healthy',
      turn,
      promptReady: false,
      // Every user turn restarts the clock, or a healthy long-lived session is reaped the moment its
      // wall-clock AGE passes a timeout that was only ever meant to bound one turn of work.
      restartTurnClock: true,
    });
    return { kind: 'settled', path: accepted.record.path, applied: true };
  }

  /**
   * The busy path: the harness's own queue, which holds text typed mid-turn and submits it at the
   * next turn boundary.
   *
   * No turn is claimed and no state moves, because none has started — the agent is still working on
   * the previous one. That is exactly why this is reported as `queued` rather than `delivered`.
   */
  private async queue(
    target: SendTarget,
    request: SendMessageRequest,
    payload: string,
    sender: SendTarget | undefined,
  ): Promise<LockedOutcome> {
    const fileBacked = isFileBackedQueue(payload, this.settings);
    // Written before the ledger and before any keystroke: it costs nothing if the send is refused
    // afterwards, and it is the only copy of the payload if the transport goes wrong.
    const payloadFile = fileBacked
      ? await this.ports.turns.writeQueuedPayload(target.id, request.sendId, payload)
      : undefined;
    const text = payloadFile === undefined ? payload : queuedPayloadInstruction(payloadFile);
    const accepted = await this.accept(target, request, sender, {
      sendId: request.sendId,
      path: fileBacked ? 'native-file' : 'native-inline',
      message: payload,
      matchText: text,
      ...(payloadFile === undefined ? {} : { payloadFile }),
    });
    if (!accepted.created) return { kind: 'settled', path: accepted.record.path, applied: false };
    await this.ports.terminal.queue(target.id, text);
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
      ...(payloadFile === undefined ? {} : { fileBacked: true, payloadFile }),
      ...(request.replyExpected === true ? { replyExpected: true } : {}),
      ...this.attribution(sender),
    });
    return { kind: 'settled', path: accepted.record.path, applied: true };
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
    if (!accepted.created) return { kind: 'settled', path: accepted.record.path, applied: false };
    try {
      await this.ports.reviver.revive(request.id, payload);
    } catch (error) {
      // A refusal is a policy decision about the RELAUNCH, not about the message. Turning it into a
      // lost message would make a safety check into data loss, so the send is held durably and an
      // explicit revive remains available.
      if (error instanceof ReviveRefusedForSend) return await this.hold(request, payload, sender, error);
      throw error;
    }
    await this.ports.channel.recordInbound(request.id, {
      at: this.ports.clock.now(),
      message: payload,
      turn: accepted.record.turn,
      ...this.attribution(sender),
    });
    return { kind: 'settled', path: 'revive', applied: true };
  }

  /** Retains a message the reviver would not carry, so an explicit revive can still deliver it. */
  private async hold(
    request: SendMessageRequest,
    payload: string,
    sender: SendTarget | undefined,
    refusal: ReviveRefusedForSend,
  ): Promise<Extract<LockedOutcome, { kind: 'settled' }>> {
    await this.ports.serial.run(request.id, async () => {
      const held = await this.ports.ledger.revise(request.id, request.sendId, {
        path: 'revive-queue',
        held: true,
        matchText: undefined,
        turn: undefined,
      });
      if (held === undefined)
        throw new Error(`could not retain accepted send ${request.sendId} for an explicit revive`);
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
    return { kind: 'settled', path: 'revive-queue', applied: true };
  }

  /** Records the send as accepted, and journals that acceptance before anything is typed. */
  private async accept(
    target: SendTarget,
    request: SendMessageRequest,
    sender: SendTarget | undefined,
    input: Pick<SendRecord, 'sendId' | 'path' | 'message' | 'matchText' | 'turn' | 'payloadFile'>,
  ): Promise<{ record: SendRecord; created: boolean }> {
    const accepted = await this.ports.ledger.accept(target.id, {
      ...input,
      acceptedAt: this.ports.clock.now(),
      acceptedTurn: target.turn,
      fate: 'accepted',
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
    path: SendPath,
  ): Promise<void> {
    const disposition = dispositionOf(path);
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
    if (path === 'revive-queue') return;
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

  /** The text the agent actually reads: the message, with peer attribution when a peer sent it. */
  private payload(request: SendMessageRequest, sender: SendTarget | undefined): string {
    const message = sendPayload(request.message);
    if (sender === undefined) return message;
    return `${peerPreamble(sender, request.replyExpected === true, this.settings.clientName)}${message}`;
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
