/**
 * The socket half of the relay carrier: one outbound WebSocket, redialled for as long as the daemon
 * runs.
 *
 * THE DAEMON DIALS. Nothing here listens. A rendezvous cannot reach a daemon on `127.0.0.1` and never
 * tries to; this adapter opens the connection outbound and the whole conversation happens on it.
 *
 * Three things belong to a socket rather than to the protocol, which is the reason this file exists
 * at all and the domain has none of them:
 *
 * - **Order.** Handling a frame is asynchronous — records are sealed and opened with real crypto —
 *   and a WebSocket does not wait. Every inbound message is threaded through one promise chain, so
 *   frame `n+1` is never handled before frame `n`. Without that the sequence discipline would end
 *   sessions the carrier delivered perfectly.
 * - **Liveness.** A ping every `heartbeatSeconds`, and a socket with no evidence of life for the
 *   grace window is dropped and redialled. No evidence means dead: waiting for a close that a
 *   suspended laptop will never send is how a daemon believes it holds a rendezvous slot it lost.
 * - **Patience.** A redial waits, because the rendezvous holds the incumbent's slot until its dead
 *   socket is swept and a faster redial is simply refused with `4409`.
 *
 * WHAT IT WILL NOT DO is present a carrier it does not have. `status()` reports `none` with the
 * sentence explaining why, `dialling` while there is no proved slot, and `carrying` only once the
 * rendezvous has answered the claim. A surface that showed "connected" for a socket in any other
 * state would be the third instance of this migration's most expensive bug.
 */

import type { DaemonIdentity, RelayCrypto } from '@ferretry/relay';
import { RELAY_CLOSE_CODES } from '@ferretry/relay';
import type { RelayApiDispatch, RelayDeviceDirectory, RelayLinkSocket } from '../../lib/relay/index.ts';
import {
  decideRelayCarrier,
  RELAY_HEARTBEAT_MS,
  type RelayCarrierDecision,
  RelayLink,
  relaySocketIsStale,
} from '../../lib/relay/index.ts';
import type { DaemonRelayConfig } from '../../lib/runtime/config.ts';

/** The subset of a WebSocket this carrier uses, so a test can supply one without a network. */
export interface RelayWebSocket {
  binaryType: string;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: Uint8Array | string): void;
  close(code?: number, reason?: string): void;
}

export type RelayWebSocketFactory = (url: string) => RelayWebSocket;

export interface BunRelayCarrierDependencies {
  readonly config: DaemonRelayConfig | undefined;
  readonly crypto: RelayCrypto;
  readonly identity: DaemonIdentity;
  readonly dispatch: RelayApiDispatch;
  readonly devices: RelayDeviceDirectory;
  readonly socketFactory?: RelayWebSocketFactory;
  readonly now?: () => number;
  /** How often this side pings. A seam, so the liveness sweep can be proved without a test that
   *  waits half a minute for one tick — production passes nothing and gets the protocol's cadence. */
  readonly heartbeatMs?: number;
}

export type RelayCarrierPhase = 'idle' | 'none' | 'dialling' | 'carrying' | 'stopped';

export interface RelayCarrierStatus {
  readonly phase: RelayCarrierPhase;
  /** Where it dials, when it dials anywhere. Never a guess and never a compiled default. */
  readonly relayUrl?: string;
  readonly sessions: number;
  /** Why there is no carrier, or the last refusal on the one there is. */
  readonly detail?: string;
}

const browserSocket: RelayWebSocketFactory = url => new WebSocket(url) as unknown as RelayWebSocket;

export class BunRelayCarrier {
  readonly #decision: RelayCarrierDecision;
  readonly #socketFactory: RelayWebSocketFactory;
  readonly #now: () => number;
  #phase: RelayCarrierPhase = 'idle';
  #socket: RelayWebSocket | undefined;
  #link: RelayLink | undefined;
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #redial: ReturnType<typeof setTimeout> | undefined;
  #lastSeen = 0;
  #inbox: Promise<void> = Promise.resolve();
  #detail: string | undefined;

  constructor(private readonly deps: BunRelayCarrierDependencies) {
    this.#decision = decideRelayCarrier(deps.config, deps.identity.daemonId);
    this.#socketFactory = deps.socketFactory ?? browserSocket;
    this.#now = deps.now ?? Date.now;
    if (this.#decision.kind === 'none') {
      this.#phase = 'none';
      this.#detail = this.#decision.reason;
    }
  }

  /** The address this daemon is reachable at, or the reason it is reachable only directly. */
  status(): RelayCarrierStatus {
    const report = this.#link?.report();
    return {
      phase: this.#phase,
      ...(this.#decision.kind === 'dial' ? { relayUrl: this.#decision.socketUrl } : {}),
      sessions: report?.sessions ?? 0,
      ...((report?.lastRefusal ?? this.#detail) !== undefined
        ? { detail: report?.lastRefusal ?? (this.#detail as string) }
        : {}),
    };
  }

  /** Begin dialling, or return having done nothing because there is nothing to dial. */
  start(): void {
    if (this.#decision.kind === 'none' || this.#phase === 'stopped') return;
    this.#dial();
  }

  /** Stop for good. A carrier that has been stopped never redials: the daemon is going away. */
  stop(): void {
    this.#phase = 'stopped';
    this.#clearTimers();
    const socket = this.#socket;
    this.#socket = undefined;
    this.#link = undefined;
    socket?.close(1000, 'the daemon is shutting down');
  }

  #dial(): void {
    if (this.#decision.kind !== 'dial') return;
    this.#phase = 'dialling';
    const socket = this.#socketFactory(this.#decision.socketUrl);
    socket.binaryType = 'arraybuffer';
    this.#socket = socket;
    this.#lastSeen = this.#now();
    const link = new RelayLink({
      crypto: this.deps.crypto,
      identity: this.deps.identity,
      relayHost: this.#decision.relayHost,
      socket: this.#linkSocket(socket),
      dispatch: this.deps.dispatch,
      devices: this.deps.devices,
    });
    this.#link = link;
    socket.onopen = () => {
      this.#lastSeen = this.#now();
      this.#heartbeat = setInterval(() => this.#tick(link), this.deps.heartbeatMs ?? RELAY_HEARTBEAT_MS);
    };
    socket.onmessage = event => this.#receive(link, event.data);
    socket.onclose = () => this.#ended();
    socket.onerror = () => this.#ended();
  }

  /**
   * One inbound message, in order.
   *
   * A text frame is the heartbeat and nothing else. A binary frame is exactly one relay frame, and
   * the promise chain is what keeps two of them from being decrypted concurrently: the second record
   * of a session cannot be opened before the first, because the receive sequence advances inside the
   * handler.
   */
  #receive(link: RelayLink, data: unknown): void {
    this.#lastSeen = this.#now();
    if (typeof data === 'string') {
      link.receiveText(data);
      return;
    }
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : data instanceof Uint8Array
          ? data
          : /* A carrier sending neither text nor bytes is not speaking this protocol. */ undefined;
    if (bytes === undefined) {
      this.#detail = 'the carrier sent a message that is neither text nor bytes';
      this.#socket?.close(RELAY_CLOSE_CODES.protocolError, 'unsupported message type');
      return;
    }
    this.#inbox = this.#inbox
      .then(async () => {
        await link.receiveBinary(bytes);
        if (link.report().claimed) this.#phase = 'carrying';
      })
      // A handler that threw has left this link in a state nobody can describe, so the socket goes
      // rather than carrying on: the redial below gets a fresh rendezvous slot and fresh keys.
      .catch((error: unknown) => {
        this.#detail = `the relay link failed: ${error instanceof Error ? error.message : String(error)}`;
        this.#socket?.close(RELAY_CLOSE_CODES.relayInternal, 'the daemon could not carry this frame');
      });
  }

  #tick(link: RelayLink): void {
    if (relaySocketIsStale(this.#lastSeen, this.#now())) {
      this.#detail = 'the rendezvous stopped answering, so the daemon dropped the socket';
      this.#socket?.close(RELAY_CLOSE_CODES.heartbeatTimeout, 'no answer within the heartbeat grace window');
      return;
    }
    link.heartbeat();
  }

  #ended(): void {
    if (this.#phase === 'stopped') return;
    this.#clearTimers();
    this.#socket = undefined;
    this.#phase = 'dialling';
    if (this.#decision.kind !== 'dial') return;
    this.#redial = setTimeout(() => this.#dial(), this.#decision.reconnectMs);
  }

  #clearTimers(): void {
    if (this.#heartbeat !== undefined) clearInterval(this.#heartbeat);
    if (this.#redial !== undefined) clearTimeout(this.#redial);
    this.#heartbeat = undefined;
    this.#redial = undefined;
  }

  /** The link's view of the socket. Every write goes through here, so a closed socket cannot be
   *  written to by a handler that has not noticed yet. */
  #linkSocket(socket: RelayWebSocket): RelayLinkSocket {
    return {
      send: bytes => {
        if (this.#socket === socket) socket.send(bytes);
      },
      sendText: text => {
        if (this.#socket === socket) socket.send(text);
      },
      close: (code, reason) => {
        if (this.#socket === socket) socket.close(code, reason);
      },
    };
  }
}
