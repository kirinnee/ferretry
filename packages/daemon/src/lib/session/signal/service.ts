import type { ClockPort, SerialExecutor } from '../../ports.ts';
import type { SessionId } from '../../session-id.ts';
import { composeWait, creditedSeconds, parseDeadline, waitDetail } from './policy.ts';
import {
  PROTECTED_SIGNAL_STATUSES,
  SignalRefused,
  UnknownPeerRefused,
  type DeclaredWait,
  type SessionSignalKind,
  type SignalArtifacts,
  type SignalRepository,
  type SignalTarget,
  type SignalTerminal,
} from './types.ts';

export interface SessionSignalPorts {
  readonly repository: SignalRepository;
  readonly artifacts: SignalArtifacts;
  readonly terminal: SignalTerminal;
  /** Serializes every mutation of one session, so a completion and a park cannot interleave. */
  readonly serial: SerialExecutor;
  readonly clock: ClockPort;
}

/** What the session said about itself. `until`, `condition` and `peer` only mean anything on a wait. */
export interface SessionSignalRequest {
  readonly id: SessionId;
  readonly kind: SessionSignalKind;
  readonly message?: string | undefined;
  readonly until?: string | undefined;
  readonly condition?: string | undefined;
  /** A session id or a teammate callsign. Resolved before anything is written. */
  readonly peer?: string | undefined;
}

/**
 * The four things a session may say about itself, and what the daemon does about each.
 *
 * `done` RETIRES THE SESSION. The summary and the turn-certified marker are written BEFORE the pane
 * is touched, because they are the only account of the work that survives the kill — a completion
 * that died between stopping the pane and writing its evidence would leave a finished session
 * indistinguishable from one that crashed at the finish line.
 *
 * `help` IS A PROTOCOL VIOLATION IN AUTOMODE, and that asymmetry is the whole point. An interactive
 * session has a person at the keyboard, so asking a question is an ordinary pause. An automode
 * teammate has nobody, so a question is an agent that has stopped and will never be answered: it is
 * recorded, the pane is retired, and the session fails loudly rather than sitting open forever
 * waiting for a human who was never watching. `waiting` exists precisely so an automode teammate can
 * park on an EXTERNAL condition without asking anyone for anything.
 *
 * `waiting` REFUSES BEFORE IT WRITES. A park suspends the supervision that would otherwise nudge or
 * reap the session, so every reason to decline — a protected status, an unreadable deadline, a peer
 * that resolves to nobody — is evaluated while the teammate can still be told what is wrong. A park
 * declared on a mistyped callsign would suspend the reflex layer awaiting a reply that can never
 * arrive; the backstop would eventually wake it, but hours late and with no explanation.
 *
 * `working` ENDS A PARK AND CREDITS IT BACK. The turn ceiling must never charge a session for time
 * it spent deliberately parked, so the credit is banked on the document and outlives the wait.
 */
export class SessionSignalService {
  constructor(private readonly ports: SessionSignalPorts) {}

  async signal(request: SessionSignalRequest): Promise<SignalTarget> {
    return await this.ports.serial.run(request.id, async () => await this.locked(request));
  }

  /**
   * Ends a declared wait because the session it named has just replied.
   *
   * THIS IS THE HALF THAT WAS MISSING. `park` already resolved the peer whose reply would end the
   * wait and wrote it onto the document — and nothing could ever fire this, because the reply is a
   * SEND and the daemon had no send. Every `--peer` park therefore ran to its deadline, however
   * promptly the peer answered.
   *
   * It lives here rather than in the send domain because clearing a wait means crediting the parked
   * time back against the turn ceiling and re-anchoring the activity ledger, and that is this slice's
   * own arithmetic. The send merely reports that a reply arrived.
   *
   * A REPLY FROM ANYONE ELSE CHANGES NOTHING, and the check is made under the lock rather than by the
   * caller: the session may have been re-parked on a different peer between the send landing and this
   * call, and waking it then would resume a teammate that is still waiting for somebody.
   */
  async endPeerWait(recipient: SessionId, sender: SessionId): Promise<void> {
    await this.ports.serial.run(recipient, async () => {
      const target = await this.ports.repository.read(recipient);
      const waiting = target?.waiting;
      if (target === undefined || waiting === undefined || waiting.peer !== sender) return;
      await this.clearWait(target, waiting, `${waiting.peerName ?? sender} replied`);
    });
  }

  private async locked(request: SessionSignalRequest): Promise<SignalTarget> {
    const target = await this.require(request.id);
    if (request.kind === 'done') return await this.complete(target, request.message);
    if (request.kind === 'help') return await this.help(target, request.message);
    if (request.kind === 'working') return await this.resumeWork(target);
    return await this.park(target, request);
  }

  /** Retires a finished session: evidence first, then the pane, then the verdict. */
  private async complete(target: SignalTarget, message: string | undefined): Promise<SignalTarget> {
    await this.ports.artifacts.writeSummary(target.id, message);
    await this.ports.artifacts.markDone(target.id, target.turn);
    await this.ports.terminal.snapshot(target.id);
    await this.ports.terminal.stop(target.id, 'completion');
    return await this.ports.repository.transition(target.id, {
      event: 'session.completed',
      status: 'completed',
      health: 'idle',
      reason: 'done marker written',
      finishedAt: this.ports.clock.now(),
      promptReady: false,
    });
  }

  /** Records a question, and in automode fails the session for having had to ask one. */
  private async help(target: SignalTarget, message: string | undefined): Promise<SignalTarget> {
    if (message === undefined || message.trim() === '') throw new SignalRefused('help requires a question');
    await this.ports.artifacts.raiseQuestion(target.id, message);
    if (target.mode !== 'auto')
      return await this.ports.repository.transition(target.id, {
        event: 'interaction.help',
        status: 'waiting',
        health: 'waiting',
        reason: message,
        promptReady: true,
      });
    await this.ports.terminal.snapshot(target.id);
    await this.ports.terminal.stop(target.id, 'automode help protocol violation');
    return await this.ports.repository.transition(target.id, {
      event: 'session.protocol_violation',
      status: 'failed',
      health: 'crashed',
      reason: 'automode teammate requested user input',
      finishedAt: this.ports.clock.now(),
      promptReady: false,
    });
  }

  /** Enters a declared wait, having first established that the wait can end. */
  private async park(target: SignalTarget, request: SessionSignalRequest): Promise<SignalTarget> {
    if (PROTECTED_SIGNAL_STATUSES.has(target.status))
      throw new SignalRefused(`session ${target.id} is ${target.status}; resume it before declaring a wait`);
    const nowIso = this.ports.clock.now();
    const until = request.until === undefined ? undefined : parseDeadline(request.until, Date.parse(nowIso));
    const peer = await this.peer(target, request.peer);
    const waiting = composeWait(nowIso, until, request.condition, peer);
    return await this.ports.repository.transition(target.id, {
      event: 'session.waiting',
      status: 'waiting',
      health: 'waiting',
      reason: `waiting: ${waitDetail(waiting, request.message)}`,
      waiting,
      data: {
        until: waiting.until ?? null,
        condition: waiting.condition ?? null,
        ...(peer === undefined ? {} : { peer: peer.id, peerName: peer.teammate ?? null }),
      },
    });
  }

  /**
   * The session a park will wait on, resolved now so a typo cannot become an immortal session.
   *
   * Waiting on itself is refused for the same reason: nothing would ever arrive, and the reply that
   * would end the park is one the parked session is the only possible sender of.
   */
  private async peer(target: SignalTarget, reference: string | undefined): Promise<SignalTarget | undefined> {
    if (reference === undefined) return undefined;
    const peer = await this.ports.repository.resolvePeer(reference);
    if (peer === undefined) throw new UnknownPeerRefused(reference);
    if (peer.id === target.id) throw new SignalRefused('a session cannot wait on a reply from itself');
    return peer;
  }

  /** Leaves a declared wait. A session that is not parked is already working, so nothing is written. */
  private async resumeWork(target: SignalTarget): Promise<SignalTarget> {
    return target.waiting === undefined ? target : await this.clearWait(target, target.waiting, 'signalled working');
  }

  /**
   * Drops the park, credits the time back, and re-anchors the activity ledger.
   *
   * The status is only restored to `running` when the session is not in a protected one: a park that
   * outlived its session must not resurrect a stopped or failed record just because the wait ended.
   */
  private async clearWait(target: SignalTarget, waiting: DeclaredWait, reason: string): Promise<SignalTarget> {
    const nowIso = this.ports.clock.now();
    const credited = creditedSeconds(target, waiting, Date.parse(nowIso));
    return await this.ports.repository.transition(target.id, {
      event: 'session.waiting_cleared',
      ...(PROTECTED_SIGNAL_STATUSES.has(target.status) ? {} : { status: 'running', health: 'healthy' }),
      reason,
      waiting: 'clear',
      waitingCreditSeconds: credited,
      reanchorActivity: true,
      data: { reason, parkedSeconds: credited - (target.waitingCreditSeconds ?? 0), waitingCreditSeconds: credited },
    });
  }

  private async require(id: SessionId): Promise<SignalTarget> {
    const target = await this.ports.repository.read(id);
    if (target === undefined) throw new SignalRefused(`session not found: ${id}`);
    return target;
  }
}
