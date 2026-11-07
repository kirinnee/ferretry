/**
 * ONE SESSION'S SOCKET, WALKED ACROSS CARRIERS AND KEPT ALIVE — today's `driveRelaySession` and the walk loop of
 * `DaemonCarrierRouter.#walk` (PWA `lib/relay-carrier.ts`), moved below the shell's sealed session.
 *
 * WHY THE WALK CAN LIVE AT THE SOCKET. The shell's session sends NOTHING until the carrier's first frame (the
 * rendezvous `ready`) arrives: the hello is sent in answer to it, and a heartbeat reply only answers a ping. So a leg
 * that closed, or said nothing within its deadline, has carried no byte of the session, and the next leg can be
 * dialled under the same session. The first frame BINDS the leg to the session (its handshake now runs there).
 *
 * A SESSION THE DAEMON NEVER ACCEPTED SENT NOTHING, so even a write may try the next carrier — today's
 * `RelayUnsentError` — but on a FRESH session, because the old one's handshake belongs to the old leg: a bound leg that
 * fails before the shell reports acceptance ends the session, and the shell asks `onward()` for the next leg's dial.
 * Only ACCEPTANCE makes the leg the winner; from then on a failure is the session's, never a reason to dial
 * elsewhere, because a request may already have left (today's "a write is not re-sent").
 *
 * A CARRIER THAT NEITHER ANSWERS NOR CLOSES IS A REFUSAL, NOT A WAIT: each leg has a deadline (4 s for a direct
 * address, whose packets a cellular network drops rather than refuses; the heartbeat grace for a relay), and it stays
 * armed until the session is accepted — a carrier that only ever answers heartbeats has opened nothing.
 *
 * ONCE COMMITTED, THIS SIDE CHECKS THE CARRIER IS ALIVE: a ping every {@link KEEPALIVE_INTERVAL_MS}, and a socket that
 * then hears nothing for {@link KEEPALIVE_DEADLINE_MS} is closed as a heartbeat timeout. ANY inbound message is life.
 * A deadline that fired late measured a frozen page, not the carrier, and is forgiven once.
 */
import {
  type CarrierDial,
  type CarrierSocketEvents,
  type CarrierWalkSocket,
  HEARTBEAT_GRACE_SECONDS,
  HEARTBEAT_REQUEST,
  RELAY_CLOSE_CODES,
} from '@ferretry/app';
import type { RelayCarrierSocket } from '../adapters/browser-relay-dial.ts';
import type { CarrierSessionEnd } from '../lib/carrier-drops.ts';
import type { ConnectionMethod } from '../lib/connection.ts';

/** How long a DIRECT session may take to answer before the walk moves on to a rendezvous (today's value). */
export const DIRECT_SESSION_DEADLINE_MS = 4_000;
/** How often this side pings a live session: inside `heartbeatSeconds`, which §8 makes a ceiling. */
export const KEEPALIVE_INTERVAL_MS = 20_000;
/** How long a ping may go unanswered before the socket is treated as dead. */
export const KEEPALIVE_DEADLINE_MS = 10_000;
/** The shorter deadline a liveness check uses. */
export const LIVENESS_CHECK_DEADLINE_MS = 4_000;
/** How late a heartbeat deadline may fire before the silence it measured is not believed. */
export const HEARTBEAT_LATE_TOLERANCE_MS = 2_000;
/** The relay leg's deadline: the full heartbeat grace, because it is the last resort. */
export const RELAY_SESSION_DEADLINE_MS = HEARTBEAT_GRACE_SECONDS * 1_000;

/** One carrier a session may cross: how to open its socket, and how long it may stay silent. */
export interface WalkLeg {
  readonly method: ConnectionMethod;
  readonly open: () => RelayCarrierSocket;
  readonly deadlineMs: number;
}

/** One thing the walk may do next: try a leg, or record a carrier passed over untried (and why). */
export type WalkStep =
  | { readonly kind: 'leg'; readonly leg: WalkLeg }
  | { readonly kind: 'untried'; readonly method: ConnectionMethod; readonly detail: string };

/** What one leg came to before the daemon accepted a session over it. */
export interface LegFailure {
  readonly method: ConnectionMethod;
  readonly code: number;
  readonly reason: string;
  /** The socket opened (the carrier was reachable) before it failed. */
  readonly opened: boolean;
}

/** What the walk reports, so the router can decide and the health model can keep score. */
export interface WalkObserver {
  /** A leg was passed over untried. */
  untried(method: ConnectionMethod, detail: string): void;
  /** A leg failed before the daemon accepted a session over it; the walk tries the next. */
  failed(failure: LegFailure): void;
  /** The daemon accepted a session over this leg: this is the session's carrier now, and the walk's answer. */
  committed(method: ConnectionMethod): void;
  /** Every leg failed (or there were none): the session ends with this close. */
  exhausted(failures: readonly LegFailure[]): { readonly code: number; readonly reason: string };
  /** An accepted session's carrier failed under this browser (not a close this side made): it stopped carrying. */
  lost?(method: ConnectionMethod): void;
  /** An accepted session's carrier ended under this browser (not a close this side made). */
  dropped?(method: ConnectionMethod, end: CarrierSessionEnd): void;
}

export interface CarrierSocketDependencies {
  readonly after: (delayMs: number, run: () => void) => void;
  readonly now: () => number;
}

/** A cancellable one-shot over a timer that cannot be cancelled. */
const once = (deps: CarrierSocketDependencies, delayMs: number, run: () => void): (() => void) => {
  let live = true;
  deps.after(delayMs, () => {
    if (!live) return;
    live = false;
    run();
  });
  return () => {
    live = false;
  };
};

/**
 * Where a walk belongs: the router's generation of one pairing under one preference. A retired scope dials nothing
 * more and decides nothing more; every socket it tracks is closed by the router saying why.
 */
export interface WalkScope {
  /** Why this walk's generation was retired, or `undefined` while it is still current. */
  retired(): string | undefined;
  /** Registers one live session socket so a retirement can close it; answers the deregistration. */
  track(socket: RetirableSocket): () => void;
}

/** What the router can do to a live session socket when its generation is retired. */
export interface RetirableSocket {
  retire(reason: string): void;
}

const UNSCOPED: WalkScope = { retired: () => undefined, track: () => () => undefined };

/**
 * One walk over `steps`, shared by every fresh session its unsent failures open: a leg tried by one session is never
 * dialled again by the next, and the failures accumulate across them so the exhausted close describes the whole walk.
 */
class Walk {
  readonly failures: LegFailure[] = [];
  #iterator: AsyncIterator<WalkStep> | undefined;
  #finished = false;

  constructor(
    private readonly steps: () => AsyncIterable<WalkStep>,
    readonly observer: WalkObserver,
    readonly scope: WalkScope,
  ) {}

  async next(): Promise<WalkStep | undefined> {
    if (this.#finished) return undefined;
    this.#iterator ??= this.steps()[Symbol.asyncIterator]();
    const result = await this.#iterator.next();
    if (result.done === true) {
      this.#finished = true;
      return undefined;
    }
    return result.value;
  }

  finish(): void {
    this.#finished = true;
  }

  finished(): boolean {
    return this.#finished;
  }
}

/**
 * A {@link CarrierDial} that walks `steps` (pulled lazily, so a step may wait on the one directory read) until the
 * daemon ACCEPTS a session over a leg, then keeps that leg alive. A session that ended before acceptance hands the
 * shell the dial for a fresh session on the walk's next leg (`CarrierWalkSocket.onward`).
 */
export function walkingDial(
  deps: CarrierSocketDependencies,
  steps: () => AsyncIterable<WalkStep>,
  observer: WalkObserver,
  scope: WalkScope = UNSCOPED,
): CarrierDial {
  const walk = new Walk(steps, observer, scope);
  return events => new WalkingSocket(deps, walk, events).adapted;
}

/**
 * Where one session stands on its walk:
 * - `walking` — no leg has carried a frame yet: a leg that fails sent nothing, and the next is dialled under this
 *   same session;
 * - `carrying` — a leg carried the session's first frame and the handshake is under way on it: the session is bound
 *   to it, and a failure now ends this session UNSENT (the daemon never accepted it) so the shell opens a fresh one
 *   on the next leg — today's `RelayUnsentError`;
 * - `accepted` — the daemon accepted the session: the leg is the winner, and a failure is the session's.
 */
type Phase = 'walking' | 'carrying' | 'accepted';

class WalkingSocket implements RetirableSocket {
  readonly adapted: CarrierWalkSocket;
  #socket: RelayCarrierSocket | undefined;
  #method: ConnectionMethod = { kind: 'webrtc' };
  #phase: Phase = 'walking';
  /** Binds the leg being dialled to this session (its first frame, or a write before one). */
  #carryLeg: (() => void) | undefined;
  /** The acceptance deadline of the leg this session is bound to: armed until the daemon accepts. */
  #cancelAcceptance: (() => void) | undefined;
  /** This side closed the session (the shell, a retirement, or the heartbeat): nothing after it is a drop. */
  #closedHere = false;
  #ended = false;
  /** The session ended before acceptance on a leg that carried its frames: the walk may go on, once. */
  #unsent = false;
  #servingSince: number | undefined;
  #lastHeardAt: number;
  #pongDeadline: { readonly within: number; readonly cancel: () => void } | undefined;
  #forgiven = false;
  #stopKeepalive: (() => void) | undefined;
  readonly #untrack: () => void;

  constructor(
    private readonly deps: CarrierSocketDependencies,
    private readonly walk: Walk,
    private readonly events: CarrierSocketEvents,
  ) {
    this.#lastHeardAt = deps.now();
    this.adapted = {
      send: bytes => this.#carryOnSend()?.send(bytes),
      sendText: text => this.#carryOnSend()?.sendText(text),
      close: (code, reason) => this.#closeFromSession(code ?? 1000, reason ?? 'the browser closed this session'),
      accepted: () => this.#accept(),
      onward: () => this.#onward(),
    };
    this.#untrack = walk.scope.track(this);
    void this.#walk();
  }

  /** The router retired this walk's generation (an unpair, a re-pair, a new preference): close, saying why. */
  retire(reason: string): void {
    if (this.#ended) return;
    this.#closedHere = true;
    this.#unsent = false;
    this.#stop();
    this.#socket?.close(1000, reason);
    this.#end(1000, reason);
  }

  /**
   * The session wrote before any frame arrived. It does not today; if it ever does, the leg it wrote on is the
   * session's carrier from that byte on, because a byte that left cannot be replayed on another.
   */
  #carryOnSend(): RelayCarrierSocket | undefined {
    if (this.#phase === 'walking') this.#carryLeg?.();
    return this.#socket;
  }

  #retiredReason(): string | undefined {
    const reason = this.walk.scope.retired();
    if (reason !== undefined) this.retire(reason);
    return reason;
  }

  async #walk(): Promise<void> {
    try {
      for (;;) {
        // ASKED BEFORE EVERY ATTEMPT (today's `#assertCurrent`): an unpair or a new preference can land between any
        // two legs, and every leg after it would be dialled for a pairing that no longer exists.
        if (this.#ended || this.#phase !== 'walking' || this.#retiredReason() !== undefined) return;
        const step = await this.walk.next();
        if (this.#ended || this.#phase !== 'walking' || this.#retiredReason() !== undefined) return;
        if (step === undefined) break;
        if (step.kind === 'untried') {
          this.walk.observer.untried(step.method, step.detail);
          continue;
        }
        const carried = await this.#tryLeg(step.leg);
        if (carried || this.#ended) return;
      }
    } catch (error) {
      this.walk.failures.push({
        method: this.#method,
        code: RELAY_CLOSE_CODES.protocolError,
        reason: error instanceof Error ? error.message : String(error),
        opened: false,
      });
    }
    if (this.#ended || this.#phase !== 'walking' || this.#retiredReason() !== undefined) return;
    this.walk.finish();
    const close = this.walk.observer.exhausted(this.walk.failures);
    this.#end(close.code, close.reason);
  }

  /** Records one leg that did not carry a session the daemon accepted. */
  #legFailed(failure: LegFailure): void {
    if (this.walk.scope.retired() !== undefined) return;
    this.walk.failures.push(failure);
    this.walk.observer.failed(failure);
  }

  /** Dials one leg; resolves `true` once it carried the first frame (the session is bound to it), `false` before. */
  #tryLeg(leg: WalkLeg): Promise<boolean> {
    return new Promise<boolean>(resolve => {
      let socket: RelayCarrierSocket;
      this.#method = leg.method;
      try {
        socket = leg.open();
      } catch (error) {
        this.#legFailed({
          method: leg.method,
          code: RELAY_CLOSE_CODES.protocolError,
          reason: error instanceof Error ? error.message : String(error),
          opened: false,
        });
        resolve(false);
        return;
      }
      this.#socket = socket;
      let opened = false;
      let stage: 'dialling' | 'carrying' | 'over' = 'dialling';
      /** The walk moves past this leg: nothing it carried reached the session. */
      const passOver = (code: number, reason: string): void => {
        if (stage !== 'dialling') return;
        stage = 'over';
        cancelDeadline();
        if (!this.#ended) this.#legFailed({ method: leg.method, code, reason, opened });
        resolve(false);
      };
      // THE ACCEPTANCE DEADLINE (today's `driveRelaySession` `deadline`): it covers getting the session ACCEPTED, not
      // just a first frame — a carrier that only ever answers heartbeats has not opened a session.
      const cancelDeadline = once(this.deps, leg.deadlineMs, () => {
        if (stage === 'dialling') {
          socket.close(RELAY_CLOSE_CODES.heartbeatTimeout, 'no session');
          passOver(RELAY_CLOSE_CODES.heartbeatTimeout, 'the rendezvous did not open a session in time');
          return;
        }
        if (stage !== 'carrying' || this.#phase !== 'carrying' || !current()) return;
        this.#carrierEnded(RELAY_CLOSE_CODES.heartbeatTimeout, 'the rendezvous did not open a session in time', {
          close: 'no session',
        });
      });
      /** Only the leg the session is bound to speaks to it; a leg the walk moved past is closed and ignored. */
      const current = (): boolean => this.#socket === socket;
      const carry = (): void => {
        if (stage !== 'dialling') return;
        stage = 'carrying';
        this.#carryLeg = undefined;
        this.#phase = 'carrying';
        this.#cancelAcceptance = cancelDeadline;
        this.#keepalive();
        resolve(true);
      };
      this.#carryLeg = carry;
      const inbound = (): boolean => {
        if (stage === 'dialling') carry();
        return stage === 'carrying' && current() && !this.#ended;
      };
      socket.onOpen = () => {
        opened = true;
      };
      socket.onText = text => {
        if (!inbound()) return;
        this.#alive();
        this.events.onText(text);
      };
      socket.onBinary = bytes => {
        if (!inbound()) return;
        this.#alive();
        this.events.onBinary(bytes);
      };
      socket.onClose = (code, reason) => {
        if (stage === 'dialling') {
          passOver(code, reason);
          return;
        }
        if (stage !== 'carrying' || !current()) return;
        stage = 'over';
        this.#carrierEnded(code, reason);
      };
    });
  }

  /** The daemon accepted the session (the shell's `ready()` resolved): this leg is the session's, and the winner. */
  #accept(): void {
    if (this.#ended || this.#phase !== 'carrying') return;
    this.#cancelAcceptance?.();
    this.#cancelAcceptance = undefined;
    this.#phase = 'accepted';
    this.#servingSince = this.deps.now();
    // A retired generation publishes nothing: its session is being closed under it.
    if (this.walk.scope.retired() !== undefined) return;
    this.walk.observer.committed(this.#method);
  }

  /** The dial for a fresh session on the walk's next leg, when this session ended unsent and the walk is current. */
  #onward(): CarrierDial | undefined {
    if (!this.#unsent) return undefined;
    this.#unsent = false;
    if (this.walk.scope.retired() !== undefined || this.walk.finished()) return undefined;
    return events => new WalkingSocket(this.deps, this.walk, events).adapted;
  }

  /**
   * The session itself closed its socket. Before acceptance that is the session refusing what this leg carried (a
   * wrong daemon, a refused hello): nothing was sent, so the leg failed and the walk may go on. After, it is a close
   * this side made.
   */
  #closeFromSession(code: number, reason: string): void {
    if (this.#ended) return;
    const phase = this.#phase;
    this.#closedHere = true;
    this.#stop();
    this.#cancelAcceptance?.();
    this.#socket?.close(code, reason);
    if (phase === 'carrying') this.#unsentFailure(code, reason);
    this.#end(code, reason);
  }

  #unsentFailure(code: number, reason: string): void {
    this.#legFailed({ method: this.#method, code, reason, opened: true });
    this.#unsent = this.walk.scope.retired() === undefined;
  }

  /**
   * The carrier this session is bound to ended (it closed, missed its acceptance deadline, or stopped answering the
   * heartbeat). Before acceptance: unsent, the walk may go on. After: a drop, and the winner it was is forgotten
   * (today's `#walk` clears the stopped winner before reporting the lost request).
   */
  #carrierEnded(code: number, reason: string, options: { readonly close?: string } = {}): void {
    if (this.#ended) return;
    const phase = this.#phase;
    this.#stop();
    this.#cancelAcceptance?.();
    if (options.close !== undefined) {
      this.#socket?.close(code, options.close);
    }
    if (phase === 'carrying') this.#unsentFailure(code, reason);
    else if (phase === 'accepted' && !this.#closedHere) {
      this.#dropped(code, reason);
      if (this.walk.scope.retired() === undefined) this.walk.observer.lost?.(this.#method);
    }
    if (options.close !== undefined) this.#closedHere = true;
    this.#end(code, reason);
  }

  #keepalive(): void {
    let live = true;
    const tick = (): void => {
      if (!live) return;
      this.#ping(KEEPALIVE_DEADLINE_MS);
      this.deps.after(KEEPALIVE_INTERVAL_MS, tick);
    };
    this.deps.after(KEEPALIVE_INTERVAL_MS, tick);
    this.#stopKeepalive = () => {
      live = false;
    };
  }

  #ping(withinMs: number): void {
    this.#socket?.sendText(HEARTBEAT_REQUEST);
    this.#armDeadline(withinMs);
  }

  #armDeadline(withinMs: number): void {
    // A shorter wait replaces a longer one; a longer one never relaxes a shorter one already armed.
    if (this.#pongDeadline !== undefined && this.#pongDeadline.within <= withinMs) return;
    this.#pongDeadline?.cancel();
    const armedAt = this.deps.now();
    const cancel = once(this.deps, withinMs, () => {
      this.#pongDeadline = undefined;
      if (!this.#forgiven && this.deps.now() - armedAt - withinMs > HEARTBEAT_LATE_TOLERANCE_MS) {
        this.#forgiven = true;
        this.#ping(LIVENESS_CHECK_DEADLINE_MS);
        return;
      }
      const reason = `the carrier showed no sign of life for ${String(withinMs / 1_000)} s after a heartbeat`;
      this.#carrierEnded(RELAY_CLOSE_CODES.heartbeatTimeout, reason, { close: 'no heartbeat' });
    });
    this.#pongDeadline = { within: withinMs, cancel };
  }

  #alive(): void {
    this.#lastHeardAt = this.deps.now();
    this.#forgiven = false;
    this.#pongDeadline?.cancel();
    this.#pongDeadline = undefined;
  }

  #dropped(code: number, reason: string): void {
    const since = this.#servingSince;
    if (since === undefined) return;
    this.#servingSince = undefined;
    const now = this.deps.now();
    this.walk.observer.dropped?.(this.#method, {
      code,
      reason,
      livedMs: now - since,
      lastHeardMs: now - this.#lastHeardAt,
    });
  }

  #stop(): void {
    this.#stopKeepalive?.();
    this.#stopKeepalive = undefined;
    this.#pongDeadline?.cancel();
    this.#pongDeadline = undefined;
  }

  #end(code: number, reason: string): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#untrack();
    this.events.onClose(code, reason);
  }
}
