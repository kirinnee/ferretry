/**
 * ONE SESSION'S SOCKET, WALKED ACROSS CARRIERS AND KEPT ALIVE — today's `driveRelaySession` and the walk loop of
 * `DaemonCarrierRouter.#walk` (PWA `lib/relay-carrier.ts`), moved below the shell's sealed session.
 *
 * WHY THE WALK CAN LIVE AT THE SOCKET. The shell's session sends NOTHING until the carrier's first frame (the
 * rendezvous `ready`) arrives: the hello is sent in answer to it, and a heartbeat reply only answers a ping. So a leg
 * that closed, or said nothing within its deadline, has carried no byte of the session — today's "a session that
 * never opened sent nothing, so even a write may try the next carrier" — and the next leg can be dialled under the
 * same session. The first frame COMMITS the leg: from then on a failure is the session's, never a reason to dial
 * elsewhere, because a request may already have left (today's "a write is not re-sent").
 *
 * A CARRIER THAT NEITHER ANSWERS NOR CLOSES IS A REFUSAL, NOT A WAIT: each leg has a deadline (4 s for a direct
 * address, whose packets a cellular network drops rather than refuses; the heartbeat grace for a relay).
 *
 * ONCE COMMITTED, THIS SIDE CHECKS THE CARRIER IS ALIVE: a ping every {@link KEEPALIVE_INTERVAL_MS}, and a socket that
 * then hears nothing for {@link KEEPALIVE_DEADLINE_MS} is closed as a heartbeat timeout. ANY inbound message is life.
 * A deadline that fired late measured a frozen page, not the carrier, and is forgiven once.
 */
import {
  type CarrierDial,
  type CarrierSocketEvents,
  HEARTBEAT_GRACE_SECONDS,
  HEARTBEAT_REQUEST,
  RELAY_CLOSE_CODES,
  type RelayClientSocket,
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

/** What one leg came to before the session committed or the walk moved on. */
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
  /** A leg failed before the session began; the walk tries the next. */
  failed(failure: LegFailure): void;
  /** A leg carried the session's first frame: this is the session's carrier now. */
  committed(method: ConnectionMethod): void;
  /** Every leg failed (or there were none): the session ends with this close. */
  exhausted(failures: readonly LegFailure[]): { readonly code: number; readonly reason: string };
  /** A committed session's carrier ended under this browser (not a close this side made). */
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
 * A {@link CarrierDial} that walks `steps` (pulled lazily, so a step may wait on the one directory read) until a leg
 * carries the session's first frame, then keeps that leg alive.
 */
export function walkingDial(
  deps: CarrierSocketDependencies,
  steps: () => AsyncIterable<WalkStep>,
  observer: WalkObserver,
): CarrierDial {
  return events => new WalkingSocket(deps, steps(), observer, events).adapted;
}

class WalkingSocket {
  readonly adapted: RelayClientSocket;
  #socket: RelayCarrierSocket | undefined;
  #committed: ConnectionMethod | undefined;
  /** This side closed the session (the shell, or the heartbeat): nothing after it is a drop. */
  #closedHere = false;
  #ended = false;
  readonly #failures: LegFailure[] = [];
  #servingSince: number | undefined;
  #lastHeardAt: number;
  #pongDeadline: { readonly within: number; readonly cancel: () => void } | undefined;
  #forgiven = false;
  #stopKeepalive: (() => void) | undefined;

  constructor(
    private readonly deps: CarrierSocketDependencies,
    private readonly steps: AsyncIterable<WalkStep>,
    private readonly observer: WalkObserver,
    private readonly events: CarrierSocketEvents,
  ) {
    this.#lastHeardAt = deps.now();
    this.adapted = {
      send: bytes => this.#commitOnSend()?.send(bytes),
      sendText: text => this.#commitOnSend()?.sendText(text),
      close: (code, reason) => {
        this.#closedHere = true;
        this.#stop();
        this.#socket?.close(code, reason);
        this.#end(code ?? 1000, reason ?? 'the browser closed this session');
      },
    };
    void this.#walk();
  }

  /**
   * The session wrote before any frame arrived. It does not today; if it ever does, the leg it wrote on is the
   * session's carrier from that byte on, because a byte that left cannot be replayed on another.
   */
  #commitOnSend(): RelayCarrierSocket | undefined {
    const socket = this.#socket;
    if (socket !== undefined && this.#committed === undefined) this.#commit(this.#legMethod);
    return socket;
  }

  #legMethod: ConnectionMethod = { kind: 'webrtc' };

  async #walk(): Promise<void> {
    try {
      for await (const step of this.steps) {
        if (this.#ended || this.#committed !== undefined) return;
        if (step.kind === 'untried') {
          this.observer.untried(step.method, step.detail);
          continue;
        }
        const carried = await this.#tryLeg(step.leg);
        if (carried || this.#ended) return;
      }
    } catch (error) {
      this.#failures.push({
        method: this.#legMethod,
        code: RELAY_CLOSE_CODES.protocolError,
        reason: error instanceof Error ? error.message : String(error),
        opened: false,
      });
    }
    if (this.#ended || this.#committed !== undefined) return;
    const close = this.observer.exhausted(this.#failures);
    this.#end(close.code, close.reason);
  }

  /** Dials one leg; resolves `true` once it carried the first frame, `false` when it failed before. */
  #tryLeg(leg: WalkLeg): Promise<boolean> {
    return new Promise<boolean>(resolve => {
      let socket: RelayCarrierSocket;
      try {
        socket = leg.open();
      } catch (error) {
        const failure = {
          method: leg.method,
          code: RELAY_CLOSE_CODES.protocolError,
          reason: error instanceof Error ? error.message : String(error),
          opened: false,
        };
        this.#failures.push(failure);
        this.observer.failed(failure);
        resolve(false);
        return;
      }
      this.#socket = socket;
      this.#legMethod = leg.method;
      let opened = false;
      let settled = false;
      const fail = (code: number, reason: string): void => {
        if (settled) return;
        settled = true;
        cancelDeadline();
        const failure = { method: leg.method, code, reason, opened };
        this.#failures.push(failure);
        this.observer.failed(failure);
        resolve(false);
      };
      const cancelDeadline = once(this.deps, leg.deadlineMs, () => {
        if (settled || this.#committed !== undefined) return;
        socket.close(RELAY_CLOSE_CODES.heartbeatTimeout, 'no session');
        fail(RELAY_CLOSE_CODES.heartbeatTimeout, 'the rendezvous did not open a session in time');
      });
      /** Only the leg the session committed to speaks to it; a leg the walk moved past is closed and ignored. */
      const current = (): boolean => this.#socket === socket;
      const first = (): boolean => {
        if (settled) return current() && this.#committed !== undefined;
        settled = true;
        cancelDeadline();
        this.#commit(leg.method);
        resolve(true);
        return true;
      };
      socket.onOpen = () => {
        opened = true;
      };
      socket.onText = text => {
        if (!first()) return;
        this.#alive();
        this.events.onText(text);
      };
      socket.onBinary = bytes => {
        if (!first()) return;
        this.#alive();
        this.events.onBinary(bytes);
      };
      socket.onClose = (code, reason) => {
        if (!settled) {
          fail(code, reason);
          return;
        }
        if (!current() || this.#committed === undefined) return;
        this.#stop();
        if (!this.#closedHere) this.#dropped(code, reason);
        this.#end(code, reason);
      };
    });
  }

  #commit(method: ConnectionMethod): void {
    if (this.#committed !== undefined) return;
    this.#committed = method;
    this.#servingSince = this.deps.now();
    this.observer.committed(method);
    this.#keepalive();
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
      this.#stop();
      const reason = `the carrier showed no sign of life for ${String(withinMs / 1_000)} s after a heartbeat`;
      this.#dropped(RELAY_CLOSE_CODES.heartbeatTimeout, reason);
      this.#closedHere = true;
      this.#socket?.close(RELAY_CLOSE_CODES.heartbeatTimeout, 'no heartbeat');
      this.#end(RELAY_CLOSE_CODES.heartbeatTimeout, reason);
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
    const method = this.#committed;
    if (since === undefined || method === undefined) return;
    this.#servingSince = undefined;
    const now = this.deps.now();
    this.observer.dropped?.(method, { code, reason, livedMs: now - since, lastHeardMs: now - this.#lastHeardAt });
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
    this.events.onClose(code, reason);
  }
}
