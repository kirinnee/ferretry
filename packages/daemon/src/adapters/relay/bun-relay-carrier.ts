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
 *   sessions the carrier delivered perfectly. The chain waits for a frame to be HANDLED, never for
 *   the request it completed to be answered: that runs beside the frames behind it, or one slow
 *   route would hold up every session on the link.
 * - **Liveness.** A ping every {@link RELAY_KEEPALIVE_MS}, and a socket that has received NOTHING
 *   {@link RELAY_PONG_DEADLINE_MS} after one is dropped and redialled — a dead path is found within 30
 *   seconds, not 75. The older rule (no evidence of life for the grace window) stays as the backstop
 *   for a tick that fires late. No evidence means dead: waiting for a close that a suspended laptop
 *   will never send is how a daemon believes it holds a rendezvous slot it lost. A socket WE condemn
 *   is abandoned at once rather than awaiting a close handshake a dead path will never finish.
 * - **Persistence.** A redial never stops until `stop()`. The first is immediate (a Worker redeploy
 *   frees the slot with the socket), then jittered exponential backoff up to the configured ceiling;
 *   a redial faster than the rendezvous's sweep of a dead incumbent is refused with `4409` and simply
 *   becomes the next, longer attempt. The count resets only when the rendezvous accepts the claim.
 *   Every disconnect, attempt and recovery is logged, naming the relay's ORIGIN and never its path —
 *   the path carries the daemon's fingerprint.
 *
 * WHAT IT WILL NOT DO is present a carrier it does not have. `status()` reports `none` with the
 * sentence explaining why, `dialling` while there is no proved slot, and `carrying` only once the
 * rendezvous has answered the claim. A surface that showed "connected" for a socket in any other
 * state would be the third instance of this migration's most expensive bug.
 */

import type { DaemonIdentity, RelayCrypto } from '@ferretry/relay';
import {
  decodeControlMessage,
  decodeFrame,
  FRAME_KINDS,
  parseHostedBandwidthRefusal,
  RELAY_CLOSE_CODES,
} from '@ferretry/relay';
import type { DeviceConnectionTracker } from '../../lib/pairing/index.ts';
import type { RelayMemberSessions } from '../../lib/relay/member-port.ts';
import type {
  AccessLeasePolicy,
  RelayApiDispatch,
  RelayDeviceDirectory,
  RelayLinkScheduler,
  RelayLinkSocket,
  RelayPairingRedeemer,
  RelayStreamDispatch,
} from '../../lib/relay/index.ts';
import {
  decideRelayCarrier,
  RELAY_CONNECT_DEADLINE_MS,
  RELAY_KEEPALIVE_MS,
  RELAY_PONG_DEADLINE_MS,
  RELAY_SILENCE_LIMIT_MS,
  type RelayCarrierDecision,
  RelayLink,
  type RelayLinkTimer,
  relayBandwidthRedialDelayMs,
  relayCapacityRedialDelayMs,
  relayDialUrl,
  relayRedialDelayMs,
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
  /** The daemon's ALREADY MOUNTED socket dispatcher. Handed over rather than rebuilt, so a relayed
   *  stream passes the same authorization boundary and capability guard a direct upgrade does. */
  readonly sockets: RelayStreamDispatch;
  readonly devices: RelayDeviceDirectory;
  readonly pairing: RelayPairingRedeemer;
  /** The member side, for sessions a share link's browser opens through the relay. */
  readonly members?: RelayMemberSessions;
  /** Where each relayed session's device is registered, so unpairing it ends the session. */
  readonly connections: DeviceConnectionTracker;
  readonly socketFactory?: RelayWebSocketFactory;
  /** A seam, so the pre-credential deadline can be proved without a test that waits ten seconds. */
  readonly scheduler?: RelayLinkScheduler;
  readonly now?: () => number;
  /** The redial jitter's source, in [0, 1). A seam so a test can prove both ends of the range. */
  readonly random?: () => number;
  /** Where disconnects, redial attempts and recoveries are said. One line each, relay origin only. */
  readonly log?: (line: string) => void;
  /** The lease and its cap; absent means the protocol's own. */
  readonly lease?: AccessLeasePolicy;
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

/** The runtime's own timer, as the one thing the domain wants from one: fire later, or do not. */
const runtimeScheduler: RelayLinkScheduler = {
  after: (milliseconds, action) => {
    const handle = setTimeout(action, milliseconds);
    return { cancel: () => clearTimeout(handle) };
  },
};

/** A close event as a person reads it: the code and the rendezvous's own reason, bounded. */
function describeClose(event: unknown): string {
  const { code, reason } = (event ?? {}) as { code?: unknown; reason?: unknown };
  const said = typeof reason === 'string' ? printable(reason) : '';
  return [typeof code === 'number' ? String(code) : 'no close code', said].filter(part => part !== '').join(' ');
}

/** The numeric close code a close event carried, or `undefined` when it had none. */
function closeCode(event: unknown): number | undefined {
  const { code } = (event ?? {}) as { code?: unknown };
  return typeof code === 'number' ? code : undefined;
}

/** How recent an in-band message must be to be blamed for a close. */
const IN_BAND_WINDOW_MS = 5_000;

/** A peer-supplied string as one printable line: a log line must not be forgeable or split. */
const printable = (value: string): string => value.replace(/\p{Cc}/gu, ' ').slice(0, 120);

const formatSeconds = (milliseconds: number): string => `${(Math.max(0, milliseconds) / 1_000).toFixed(1)}s`;

/**
 * The byte-ceiling refusal a close or the relay's in-band `error` carried, or `null`. The close
 * reason is the same sentence as the in-band one, so either is enough on its own.
 */
const bandwidthRefusal = (closed: string, said: string | undefined, now: number) => {
  const closePrefix = `${RELAY_CLOSE_CODES.hostedBandwidth} `;
  const saidPrefix = `error ${RELAY_CLOSE_CODES.hostedBandwidth} `;
  if (said?.startsWith(saidPrefix) === true) return parseHostedBandwidthRefusal(said.slice(saidPrefix.length), now);
  if (closed.startsWith(closePrefix)) return parseHostedBandwidthRefusal(closed.slice(closePrefix.length), now);
  return null;
};

const formatDelay = (milliseconds: number): string =>
  milliseconds < 1_000 ? `${milliseconds}ms` : formatSeconds(milliseconds);

export class BunRelayCarrier {
  readonly #decision: RelayCarrierDecision;
  readonly #socketFactory: RelayWebSocketFactory;
  readonly #now: () => number;
  #phase: RelayCarrierPhase = 'idle';
  #socket: RelayWebSocket | undefined;
  #link: RelayLink | undefined;
  readonly #scheduler: RelayLinkScheduler;
  readonly #random: () => number;
  #connectDeadline: RelayLinkTimer | undefined;
  #keepalive: RelayLinkTimer | undefined;
  #pongDeadline: RelayLinkTimer | undefined;
  #redial: RelayLinkTimer | undefined;
  #lastSeen = 0;
  /** Messages received on this socket, so "anything since the ping" is a comparison and not a clock. */
  #received = 0;
  /** Redials scheduled since the rendezvous last accepted a claim. */
  #attempts = 0;
  /** `4432` refusals in a row since the rendezvous last accepted a claim. */
  #capacityRefusals = 0;
  #offlineSince: number | undefined;
  #dialledAt = 0;
  /** The last `error`/`closed` the rendezvous sent in-band on this socket: it explains a refusal and
   *  THEN closes, so the close alone ("1006") would hide the relay's own words. */
  #inBand: { readonly text: string; readonly at: number } | undefined;
  #inbox: Promise<void> = Promise.resolve();
  /**
   * The `claim-handover` token (§5) the last socket that held this rendezvous was issued, kept only once
   * that socket has ended: it is what the NEXT claim offers as `replaces`, so the rendezvous can supersede
   * a socket it never heard close instead of refusing `4409` until its sweep. Cleared when the relay
   * refuses a claim for any reason but `4409`, and replaced by the new token when a claim is accepted.
   */
  #handover: string | undefined;
  #detail: string | undefined;
  #stopped = false;

  constructor(private readonly deps: BunRelayCarrierDependencies) {
    this.#decision = decideRelayCarrier(deps.config, deps.identity.daemonId);
    this.#socketFactory = deps.socketFactory ?? browserSocket;
    this.#now = deps.now ?? Date.now;
    this.#scheduler = deps.scheduler ?? runtimeScheduler;
    this.#random = deps.random ?? Math.random;
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
    if (this.#decision.kind === 'none' || this.#stopped) return;
    this.#dial();
  }

  /** Stop for good. A carrier that has been stopped never redials: the daemon is going away. */
  stop(): void {
    this.#stopped = true;
    this.#phase = 'stopped';
    this.#clearTimers();
    const socket = this.#socket;
    const link = this.#link;
    if (socket !== undefined) this.#detach(socket);
    this.#socket = undefined;
    this.#link = undefined;
    // THE LINK IS TOLD BEFORE THE SOCKET GOES. A relayed stream's handler owns a redraw timer and a
    // viewer slot armed against this link, and the API host's own `closeSockets` reaches only the
    // sockets it accepted — never these. Dropping the socket first would leave both firing at a peer
    // that is already gone, which is the exact failure the transport's own two-step shutdown exists
    // to prevent, reproduced on the carrier this daemon dialled.
    link?.close();
    socket?.close(1000, 'the daemon is shutting down');
  }

  #dial(): void {
    if (this.#decision.kind !== 'dial' || this.#stopped) return;
    this.#phase = 'dialling';
    const socket = this.#socketFactory(relayDialUrl(this.#decision.socketUrl));
    socket.binaryType = 'arraybuffer';
    this.#socket = socket;
    this.#lastSeen = this.#now();
    this.#received = 0;
    this.#dialledAt = this.#now();
    this.#inBand = undefined;
    const link = new RelayLink({
      crypto: this.deps.crypto,
      identity: this.deps.identity,
      relayHost: this.#decision.relayHost,
      socket: this.#linkSocket(socket),
      dispatch: this.deps.dispatch,
      sockets: this.deps.sockets,
      devices: this.deps.devices,
      pairing: this.deps.pairing,
      ...(this.deps.members === undefined ? {} : { members: this.deps.members }),
      connections: this.deps.connections,
      scheduler: this.#scheduler,
      clock: { now: () => this.#now() },
      ...(this.#handover === undefined ? {} : { replaces: this.#handover }),
      ...(this.deps.lease === undefined ? {} : { lease: this.deps.lease }),
    });
    this.#link = link;
    // A connect that neither opens nor fails (a black-holed route) would otherwise leave the daemon
    // "dialling" forever with no timer running, which is the one way "redial forever" could stop.
    this.#connectDeadline = this.#scheduler.after(RELAY_CONNECT_DEADLINE_MS, () => {
      if (!this.#live(socket, link)) return;
      this.#abandon(
        socket,
        link,
        'the rendezvous did not answer the connection, so the daemon dropped the socket',
        'no answer to the connection within the connect deadline',
        `the socket did not open within ${formatSeconds(RELAY_CONNECT_DEADLINE_MS)} — dropping it`,
      );
    });
    socket.onopen = () => {
      if (!this.#live(socket, link)) return;
      this.#connectDeadline?.cancel();
      this.#connectDeadline = undefined;
      this.#lastSeen = this.#now();
      this.#armKeepalive(socket, link);
    };
    socket.onmessage = event => this.#receive(socket, link, event.data);
    socket.onclose = event => this.#ended(socket, link, describeClose(event), closeCode(event));
    socket.onerror = () => this.#ended(socket, link, 'connection error');
  }

  /**
   * One inbound message, in order.
   *
   * A text frame is the heartbeat and nothing else. A binary frame is exactly one relay frame, and
   * the promise chain is what keeps two of them from being decrypted concurrently: the second record
   * of a session cannot be opened before the first, because the receive sequence advances inside the
   * handler.
   */
  #receive(socket: RelayWebSocket, link: RelayLink, data: unknown): void {
    if (!this.#live(socket, link)) return;
    this.#lastSeen = this.#now();
    this.#received += 1;
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
    if (bytes !== undefined) this.#noteInBand(bytes);
    if (bytes === undefined) {
      this.#detail = 'the carrier sent a message that is neither text nor bytes';
      socket.close(RELAY_CLOSE_CODES.protocolError, 'unsupported message type');
      return;
    }
    // A handler that threw has left this link in a state nobody can describe, so the socket goes
    // rather than carrying on: the redial below gets a fresh rendezvous slot and fresh keys. The same
    // is true of a failure while writing an answer, which arrives after the chain has moved on.
    const failed = (error: unknown): void => {
      if (!this.#live(socket, link)) return;
      this.#detail = `the relay link failed: ${error instanceof Error ? error.message : String(error)}`;
      socket.close(RELAY_CLOSE_CODES.relayInternal, 'the daemon could not carry this frame');
    };
    this.#inbox = this.#inbox
      .then(async () => {
        if (!this.#live(socket, link)) return;
        const receipt = await link.accept(bytes);
        receipt.settled.catch(failed);
        if (!this.#live(socket, link)) return;
        if (link.report().claimed) this.#carrying();
      })
      .catch(failed);
  }

  #armKeepalive(socket: RelayWebSocket, link: RelayLink): void {
    this.#keepalive = this.#scheduler.after(RELAY_KEEPALIVE_MS, () => this.#tick(socket, link));
  }

  #tick(socket: RelayWebSocket, link: RelayLink): void {
    if (!this.#live(socket, link)) return;
    if (relaySocketIsStale(this.#lastSeen, this.#now())) {
      this.#abandon(
        socket,
        link,
        'the rendezvous stopped answering, so the daemon dropped the socket',
        'no answer within the heartbeat deadline',
        `nothing received for ${formatSeconds(this.#now() - this.#lastSeen)} (limit ${formatSeconds(RELAY_SILENCE_LIMIT_MS)}) — dropping the socket`,
      );
      return;
    }
    link.heartbeat();
    // `fy-pong` proves the edge still holds the socket and nothing more: the auto-responder answers it
    // without consulting the rendezvous. So where the rendezvous speaks it, the same tick also asks the
    // rendezvous ITSELF whether this socket still holds the claim, and only `held` answers that.
    const probing = link.report().claimProbe;
    if (probing) link.probeClaim();
    const heard = this.#received;
    const held = link.report().held;
    this.#pongDeadline = this.#scheduler.after(RELAY_PONG_DEADLINE_MS, () => {
      if (!this.#live(socket, link)) return;
      if (this.#received === heard) {
        this.#abandon(
          socket,
          link,
          'the rendezvous stopped answering, so the daemon dropped the socket',
          'no answer within the heartbeat deadline',
          `no reply within ${formatSeconds(RELAY_PONG_DEADLINE_MS)} of the ping — dropping the socket`,
        );
        return;
      }
      if (probing && link.report().held === held) {
        this.#abandon(
          socket,
          link,
          'the rendezvous stopped confirming the claim, so the daemon dropped the socket to claim again',
          'the rendezvous did not confirm the claim',
          `the edge answered but the rendezvous did not confirm the claim within ${formatSeconds(RELAY_PONG_DEADLINE_MS)} — dropping the socket to claim again`,
        );
      }
    });
    this.#armKeepalive(socket, link);
  }

  /** Condemn a socket we believe dead: say so on the wire, and do not wait for an answer a dead path
   *  will never give. */
  #abandon(socket: RelayWebSocket, link: RelayLink, detail: string, why: string, liveness: string): void {
    this.#detail = detail;
    this.#say(`liveness: ${liveness}`);
    socket.close(RELAY_CLOSE_CODES.heartbeatTimeout, why);
    this.#ended(socket, link, `${RELAY_CLOSE_CODES.heartbeatTimeout} ${why}`);
  }

  /** The rendezvous accepted the claim: this is a carrier, and the backoff starts over. */
  #carrying(): void {
    if (this.#phase === 'carrying') return;
    this.#phase = 'carrying';
    this.#detail = undefined;
    this.#say(
      `connected — the rendezvous accepted the claim ${formatSeconds(this.#now() - this.#dialledAt)} after dialling`,
    );
    if (this.#offlineSince !== undefined && this.#decision.kind === 'dial') {
      const offline = formatSeconds(this.#now() - this.#offlineSince);
      const attempts = `${this.#attempts} attempt${this.#attempts === 1 ? '' : 's'}`;
      this.#say(`reconnected after ${attempts} (${offline} offline)`);
    }
    this.#attempts = 0;
    this.#offlineSince = undefined;
    this.#capacityRefusals = 0;
  }

  /** Remember what the rendezvous said in-band about this socket, for the disconnect line. */
  #noteInBand(bytes: Uint8Array): void {
    const decoded = decodeFrame(bytes);
    if (!decoded.ok || decoded.frame.kind !== FRAME_KINDS.control) return;
    const message = decodeControlMessage(decoded.frame.payload);
    if (message === null || (message.t !== 'error' && message.t !== 'closed')) return;
    this.#inBand = { text: `${message.t} ${message.code} ${printable(message.reason)}`, at: this.#now() };
  }

  /**
   * `code` is the close code the RENDEZVOUS sent, when it did: a socket this daemon condemned has none,
   * and neither has a transport that failed, so neither says anything about the token.
   */
  #ended(socket: RelayWebSocket, link: RelayLink, closed: string, code?: number): void {
    if (!this.#live(socket, link)) return;
    this.#keepHandover(link, code);
    this.#clearTimers();
    this.#detach(socket);
    this.#socket = undefined;
    this.#link = undefined;
    // Every session on that socket died with it — §9 says so, and reconnection is a NEW session
    // rather than a resumption — so whatever they were driving is released here rather than left
    // holding timers against a link the redial below is about to replace.
    link.close();
    this.#phase = 'dialling';
    if (this.#decision.kind !== 'dial') return;
    let how = closed;
    const said =
      this.#inBand !== undefined && this.#now() - this.#inBand.at <= IN_BAND_WINDOW_MS ? this.#inBand.text : undefined;
    if (said !== undefined) how = `${how}; the relay said: ${said}`;
    this.#detail ??= `the rendezvous connection ended (${how})`;
    this.#offlineSince ??= this.#now();
    if (closed.startsWith(`${RELAY_CLOSE_CODES.claimLost} `)) {
      // The socket was fine; the rendezvous had stopped naming it. Said on its own line because it is
      // the one disconnect that means "phones were being told this machine is gone".
      this.#say('liveness: the rendezvous no longer held this daemon’s claim — claiming again');
    }
    const capacity =
      closed.startsWith(`${RELAY_CLOSE_CODES.hostedCapacity} `) ||
      said?.startsWith(`error ${RELAY_CLOSE_CODES.hostedCapacity} `) === true;
    this.#capacityRefusals = capacity ? this.#capacityRefusals + 1 : 0;
    const bandwidth = capacity ? null : bandwidthRefusal(closed, said, this.#now());
    const delay = capacity
      ? relayCapacityRedialDelayMs(this.#capacityRefusals, this.#random())
      : bandwidth !== null
        ? relayBandwidthRedialDelayMs(bandwidth.resetsAt - this.#now(), this.#random())
        : relayRedialDelayMs(this.#attempts, this.#random(), this.#decision.reconnectMs);
    this.#attempts += 1;
    if (bandwidth !== null) {
      // An allowance is spent until a known instant, so the next try waits for it (or for the recheck
      // interval, in case the operator raises the ceiling first) instead of asking every few seconds.
      const whose = bandwidth.scope === 'daemon' ? 'this machine' : 'the whole relay';
      const span = bandwidth.window === 'day' ? 'today' : 'this minute';
      const resets = new Date(bandwidth.resetsAt).toISOString();
      this.#detail = `the hosted relay's data allowance for ${whose} is used up for ${span} (${how}); it resets at ${resets}`;
      this.#say(
        `refused: the hosted relay's data allowance for ${whose} is used up for ${span}, resetting at ${resets} — redial attempt ${this.#attempts} in ${formatDelay(delay)}`,
      );
    } else if (capacity) {
      // A ceiling is the relay's answer, not a broken path, so it is said as one: what was refused, and
      // that the next try is minutes away. One line per attempt is at most one a minute, because the
      // capacity schedule never waits less than that — the 2026-10-19 log had one every four seconds.
      this.#detail = `the hosted relay refused this daemon a connection slot (${how}); retrying every few minutes`;
      this.#say(
        `refused: the relay's per-daemon or account connection ceiling is full (${how}) — redial attempt ${this.#attempts} in ${formatDelay(delay)}`,
      );
    } else {
      this.#say(`disconnected (${how}) — redial attempt ${this.#attempts} in ${formatDelay(delay)}`);
    }
    this.#redial = this.#scheduler.after(delay, () => this.#dial());
  }

  /**
   * What the next claim may offer as `replaces`: this link's own token if the rendezvous issued one, else
   * the one already held — unless the rendezvous itself refused the claim with something other than `4409`,
   * which says the token is no use and must not be offered again.
   */
  #keepHandover(link: RelayLink, code: number | undefined): void {
    const issued = link.report().handover;
    const refused = code !== undefined && code >= 4000 && code <= 4999 && code !== RELAY_CLOSE_CODES.rendezvousClaimed;
    this.#handover = issued ?? (refused ? undefined : this.#handover);
  }

  /** One log line, naming the relay's origin and never the path that carries the fingerprint. */
  #say(line: string): void {
    if (this.#decision.kind !== 'dial') return;
    this.deps.log?.(`relay ${this.#decision.relayOrigin}: ${line}`);
  }

  /** Whether an asynchronous socket callback still belongs to the carrier that is alive now. */
  #live(socket: RelayWebSocket, link: RelayLink): boolean {
    return !this.#stopped && this.#socket === socket && this.#link === link;
  }

  /** A queued callback may still run, so detaching complements rather than replaces the live fence. */
  #detach(socket: RelayWebSocket): void {
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
  }

  #clearTimers(): void {
    this.#connectDeadline?.cancel();
    this.#keepalive?.cancel();
    this.#pongDeadline?.cancel();
    this.#redial?.cancel();
    this.#connectDeadline = undefined;
    this.#keepalive = undefined;
    this.#pongDeadline = undefined;
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
