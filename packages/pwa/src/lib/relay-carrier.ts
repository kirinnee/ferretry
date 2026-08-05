/**
 * WHICH CARRIER A DAEMON'S TRAFFIC IS ACTUALLY ON, AND THE BYTES GOING OVER IT.
 *
 * `docs/relay-protocol.md` §1 states the required behaviour and it is not a
 * preference: try DIRECT first because it has fewer hops and fewer observers, fall
 * back to the hosted relay when direct does not work, and always be able to say
 * which carrier is live and why the other was passed over. Nothing here asks a
 * user to choose, and nothing here stores a choice — the order is
 * `connectionPreferenceOrder`'s, so a stored preference could only disagree with
 * the protocol.
 *
 * THE PROBE IS THE REQUEST ITSELF. There is deliberately no synthetic health
 * check: the first request a daemon receives is attempted over direct, and a
 * TRANSPORT failure — no route, refused, DNS, TLS, a timeout — is what "not
 * reachable" means. An HTTP status is not a probe failure; a daemon that answered
 * `503` is reachable and saying so. That distinction is the whole reason a relay
 * fallback does not fire on a daemon that is merely unhappy.
 *
 * A CARRIER THAT WON IS REMEMBERED FOR THE LIFE OF THAT CONNECTION, not persisted.
 * Re-probing direct on every request would cost a failed connection attempt per
 * call on exactly the network where the relay is needed; persisting the answer
 * would outlive the network that produced it. `sameDaemonConnection` is the fence:
 * a re-pair, a moved daemon address or a changed relay address starts over.
 *
 * FAIL CLOSED, IN THREE PLACES THAT HAVE EACH BEEN A BUG IN THIS REPOSITORY:
 *
 * - A rendezvous whose handshake does not verify is **not** a fallback that failed
 *   politely. It is refused and never downgraded to anything.
 * - No carrier working is an error naming every carrier tried and why. It is never
 *   an empty answer, a `503` this code made up, or a connection presented as live.
 * - `oversize` (§14) is surfaced as a refusal naming the size, never as a
 *   truncated body: a client that rendered half a session list would show a fleet
 *   that does not exist.
 */

import {
  type ConnectionChoice,
  type ConnectionMethod,
  type ConnectionProbe,
  chooseConnection,
  connectionSocketUrl,
  HEARTBEAT_GRACE_SECONDS,
  HEARTBEAT_SECONDS,
  RELAY_CLOSE_CODES,
} from '@ferretry/relay';
import { type DaemonConnection, type DaemonId, daemonCarriers, sameDaemonConnection } from './daemon-connection.ts';
import { browserFetch, type DaemonFetch } from './runtime-models.ts';
import {
  type RelayClientSessionDependencies,
  type RelayClientSocket,
  RelayClientSession,
  type RelayTunnelAnswer,
  type RelayTunnelClientMessage,
  RelaySessionError,
} from './relay-session.ts';

/* ---------- the socket adapter seam --------------------------------------- */

/**
 * The rendezvous socket, as the four things this carrier does with one.
 *
 * A port rather than a `WebSocket` so the session state machine is provable
 * without a browser, and so a suite can carry frames between two halves of a real
 * conversation in memory.
 */
export interface RelayCarrierSocket extends RelayClientSocket {
  onOpen: (() => void) | null;
  onText: ((text: string) => void) | null;
  onBinary: ((bytes: Uint8Array) => void) | null;
  onClose: ((code: number, reason: string) => void) | null;
}

export type RelayDial = (url: string) => RelayCarrierSocket;

/** Cancels a repeating timer. Injected so no suite depends on wall-clock behaviour. */
export type RelayHeartbeatSchedule = (tick: () => void, intervalMilliseconds: number) => () => void;

const browserHeartbeat: RelayHeartbeatSchedule = (tick, interval) => {
  const handle = setInterval(tick, interval);
  return () => clearInterval(handle);
};

/**
 * The code a browser uses for a socket that ended without a close frame.
 *
 * Named rather than written as a literal because this module must never report `0`:
 * `0` is not a WebSocket close code, it is the absence of one, and a surface that
 * printed `failed (0)` told its reader nothing they could act on. `1006` is the real
 * answer to "how did this end" — abnormally, with no frame — and it is the code the
 * browser itself supplies.
 */
const ABNORMAL_CLOSURE = 1006;

/**
 * How long to wait for the close event the spec says always follows an error.
 *
 * "Fail the WebSocket connection" fires `error` and then `close`, so this timer
 * normally never reports anything — the close arrives first and the latch discards
 * it. It exists because the alternative to an unfired close is the 45-second
 * handshake deadline in `openRelaySession`, and a reader staring at a spinner for
 * three quarters of a minute over a failure the browser already knew about is the
 * "absent evidence presented as a pending result" shape this package keeps paying
 * for.
 */
const CLOSE_EVENT_GRACE_MS = 250;

/**
 * WHY A RENDEZVOUS SOCKET DID NOT WORK, SAID IN TERMS A READER CAN ACT ON.
 *
 * The browser withholds the cause of a WebSocket failure on purpose — a page that
 * could tell a refused TLS handshake from a 404 could port-scan the reader's
 * network. But it does not withhold everything, and the two facts it does give are
 * the two that matter: WHETHER THE HANDSHAKE EVER COMPLETED, and the close code.
 *
 * A socket that never opened did not reach this protocol at all: no frame was sent,
 * no rendezvous logic ran, and the failure is DNS, TLS, routing, or an upgrade the
 * far end answered with an ordinary HTTP response. `packages/relay`'s own worker is
 * built around that asymmetry — it ACCEPTS an upgrade it intends to refuse so it can
 * state a reason in a close frame — which means a socket that failed before opening
 * is, specifically, one that did not reach a conforming rendezvous.
 *
 * A socket that opened and then died without a close frame is the opposite: it was
 * carrying a session, and something on the path took it away.
 *
 * The rendezvous ORIGIN is named; the path is not. The path carries the daemon
 * fingerprint, and a fingerprint belongs on a pairing screen rather than in an error
 * a reader may paste into an issue.
 */
const socketFailureReason = (url: string, opened: boolean): string => {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    origin = 'the configured rendezvous';
  }
  return opened
    ? `the relay socket to ${origin} was carrying this session and ended without a close frame`
    : `the browser could not open a socket to ${origin}: the handshake never completed, so nothing reached the relay ` +
        'protocol. The address may not resolve, may refuse TLS, may be blocked on this network, or may not be a ' +
        'rendezvous serving this daemon — a relay that does not carry a fingerprint answers the upgrade with a plain 404';
};

/**
 * A browser WebSocket, adapted.
 *
 * `binaryType = 'arraybuffer'` is load-bearing: the default in browsers is `Blob`,
 * whose read is asynchronous, and a frame read out of order is a torn-down session
 * under §7's sequence rule rather than a latency problem.
 *
 * A SESSION ENDS EXACTLY ONCE. `error` and `close` both fire for a failed
 * connection, and the old adapter reported each of them separately — so the first
 * report was `error`'s invented `(0)` and the real code in the close event that
 * followed was thrown away. The latch here means the informative event wins:
 * `error` never reports a code of its own, it only starts the grace period in case
 * no close arrives.
 */
export const browserRelayDial: RelayDial = url => {
  const socket = new WebSocket(url);
  socket.binaryType = 'arraybuffer';
  let opened = false;
  let ended = false;
  const adapted: RelayCarrierSocket = {
    onOpen: null,
    onText: null,
    onBinary: null,
    onClose: null,
    // Copied onto its own buffer: `send` will not take a view whose buffer might be
    // shared, and a frame handed in from anywhere else carries no proof that it is
    // not. One copy of at most 64 KiB per frame is the cheap half of that trade.
    send: bytes => socket.send(new Uint8Array(bytes).buffer),
    sendText: text => socket.send(text),
    close: (code, reason) => socket.close(code, reason),
  };
  const end = (code: number, reason: string): void => {
    if (ended) return;
    ended = true;
    adapted.onClose?.(code, reason);
  };
  socket.onopen = () => {
    opened = true;
    adapted.onOpen?.();
  };
  socket.onclose = event => {
    // A close frame the far end actually sent is the best answer there is, so it is
    // passed through untouched. Everything else is described rather than numbered at.
    const abnormal = event.code === ABNORMAL_CLOSURE || event.code === 0;
    end(abnormal ? ABNORMAL_CLOSURE : event.code, abnormal ? socketFailureReason(url, opened) : event.reason);
  };
  socket.onerror = () => {
    // Deliberately no report: the close event that follows carries the code, and a
    // report here would be the uninformative half of the pair winning the race.
    setTimeout(() => end(ABNORMAL_CLOSURE, socketFailureReason(url, opened)), CLOSE_EVENT_GRACE_MS);
  };
  socket.onmessage = event => {
    const data: unknown = event.data;
    if (typeof data === 'string') {
      adapted.onText?.(data);
      return;
    }
    if (data instanceof ArrayBuffer) {
      adapted.onBinary?.(new Uint8Array(data));
      return;
    }
    // Neither text nor a binary frame is not a message this protocol defines, and
    // guessing at it would mean feeding the session something it did not send. The
    // socket is closed as well as reported: a carrier improvising on this channel is
    // not one to keep listening to.
    socket.close(RELAY_CLOSE_CODES.protocolError, 'unknown message type');
    end(RELAY_CLOSE_CODES.protocolError, 'the relay socket delivered a message of an unknown type');
  };
  return adapted;
};

/* ---------- §14: one HTTP-shaped request, as a tunnel record --------------- */

/** A request body this tunnel can carry. §14 records are JSON, so the body is text. */
const bodyText = (body: RequestInit['body']): string | undefined => {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return body;
  // A stream, a Blob or FormData has no text this envelope can carry, and a
  // silently dropped body would be a request that means something else.
  throw new RelaySessionError('a relayed request body must be text', RELAY_CLOSE_CODES.protocolError);
};

/**
 * Turn a request built for the daemon's own address into the §14 record.
 *
 * `authorization` IS DROPPED, not carried and not overwritten. §14 refuses a
 * relayed request that brings its own credential: the grant is the device token
 * that opened the session, so a request cannot promote itself past what it arrived
 * under. Every request in this package is built by `daemonRequest`, which attaches
 * that same token as a bearer header, so dropping it here is removing a duplicate
 * rather than discarding a credential.
 */
export const relayTunnelRequest = (
  url: string,
  init: RequestInit = {},
): Omit<Extract<RelayTunnelClientMessage, { t: 'req' }>, 't' | 'id'> => {
  const target = new URL(url);
  const headers: Record<string, string> = {};
  for (const [name, value] of new Headers(init.headers)) {
    if (name === 'authorization') continue;
    headers[name] = value;
  }
  const query = [...target.searchParams].map(([name, value]) => [name, value] as const);
  const body = bodyText(init.body);
  return {
    method: (init.method ?? 'GET').toUpperCase(),
    path: target.pathname,
    ...(query.length === 0 ? {} : { query }),
    ...(Object.keys(headers).length === 0 ? {} : { headers }),
    ...(body === undefined ? {} : { body }),
  };
};

/** Statuses the `Response` constructor refuses a body for, because they have none. */
const BODYLESS_STATUSES: readonly number[] = [204, 205, 304];

/**
 * The answer exists and does not fit one record (§14).
 *
 * Its own error type, carrying the size, because there is no HTTP status that means
 * this and inventing one would be inventing a result. Paging or a chunked reply is
 * unbuilt work on both ends; this is what says so to a caller.
 */
export class RelayOversizeError extends Error {
  constructor(
    readonly status: number,
    readonly byteLength: number,
  ) {
    super(`the daemon’s answer is ${byteLength} bytes and does not fit one relay record`);
    this.name = 'RelayOversizeError';
  }
}

/**
 * The answer, as the `Response` every caller in this package already handles.
 *
 * `oversize` throws rather than returning anything: a client that turned it into a
 * `200` with an empty body would render a fleet that does not exist.
 */
export const relayResponse = (answer: RelayTunnelAnswer): Response => {
  if (answer.kind === 'oversize') throw new RelayOversizeError(answer.status, answer.byteLength);
  const bodyless = BODYLESS_STATUSES.includes(answer.status);
  return new Response(bodyless ? null : answer.body, { status: answer.status, headers: answer.headers });
};

/* ---------- opening one relayed session ----------------------------------- */

export interface OpenRelaySessionOptions {
  readonly crypto: RelayClientSessionDependencies['crypto'];
  readonly dial: RelayDial;
  readonly daemon: DaemonConnection;
  readonly method: Extract<ConnectionMethod, { kind: 'relay' }>;
  readonly heartbeat?: RelayHeartbeatSchedule;
}

/**
 * Dial a rendezvous and return the session only once the daemon has accepted this
 * browser's device grant.
 *
 * Resolving any earlier would hand a caller a session that has proved nothing —
 * the whole point of §6's ordering is that the credential goes last.
 *
 * A CARRIER THAT NEITHER ANSWERS NOR CLOSES IS A REFUSAL, NOT A WAIT. §8 evicts a
 * socket with no evidence of life after `heartbeatSeconds × 1.5`, so a rendezvous
 * that has said nothing at all by then is one this browser will not get a session
 * from. Waiting past that point would leave a caller with a request that never
 * resolves and a screen that never says why — the "absent evidence read as a
 * benign result" shape this repository keeps paying for.
 */
export const openRelaySession = async ({
  crypto,
  dial,
  daemon,
  method,
  heartbeat = browserHeartbeat,
}: OpenRelaySessionOptions): Promise<RelayClientSession> => {
  const url = connectionSocketUrl(method, daemon.daemonId, 'client');
  if (url === null) {
    // `connectionSocketUrl` refuses a fingerprint a rendezvous cannot address. That
    // is a refusal, not an address to improvise around.
    throw new RelaySessionError('this daemon fingerprint cannot address a rendezvous', RELAY_CLOSE_CODES.protocolError);
  }
  const socket = dial(url);
  const session = new RelayClientSession({
    crypto,
    daemonId: daemon.daemonId,
    deviceToken: daemon.deviceToken,
    socket,
  });
  const timers = new Set<() => void>();
  const stop = (): void => {
    for (const cancel of timers) cancel();
    timers.clear();
  };
  const deadline = heartbeat(() => {
    session.carrierClosed(RELAY_CLOSE_CODES.heartbeatTimeout, 'the rendezvous did not open a session in time');
    socket.close(RELAY_CLOSE_CODES.heartbeatTimeout, 'no session');
  }, HEARTBEAT_GRACE_SECONDS * 1_000);
  timers.add(deadline);
  socket.onOpen = () => {
    timers.add(heartbeat(() => session.heartbeat(), HEARTBEAT_SECONDS * 1_000));
  };
  socket.onText = text => session.receiveText(text);
  socket.onBinary = bytes => void session.receiveBinary(bytes);
  socket.onClose = (code, reason) => {
    stop();
    session.carrierClosed(code, reason);
  };
  try {
    const ready = await session.ready();
    // The deadline covered getting here and nothing after it; the heartbeat covers
    // the rest. Leaving it armed would close a working session.
    deadline();
    timers.delete(deadline);
    return ready;
  } catch (reason) {
    stop();
    throw reason;
  }
};

/* ---------- the router every daemon-bound request goes through ------------- */

export interface DaemonCarrierRouterOptions {
  /** The real network, for the direct carrier and for anything not bound to a daemon. */
  readonly network?: DaemonFetch;
  readonly crypto: RelayClientSessionDependencies['crypto'];
  readonly dial?: RelayDial;
  readonly heartbeat?: RelayHeartbeatSchedule;
}

interface CarrierEntry {
  readonly connection: DaemonConnection;
  choice: ConnectionChoice | undefined;
  session: Promise<RelayClientSession> | undefined;
}

const transportFailure = (reason: unknown): string => {
  if (reason instanceof RelaySessionError) return `${reason.message} (${reason.code})`;
  return reason instanceof Error ? reason.message : String(reason);
};

/**
 * Every request for one daemon, on whichever carrier that daemon is reachable over.
 *
 * It is a `DaemonFetch`, so nothing downstream has to know a carrier exists: the
 * same `{ url, init }` a direct call built is either sent to that URL or translated
 * into a §14 record and sent through a rendezvous, and the caller gets a `Response`
 * either way.
 *
 * A REQUEST FOR AN ORIGIN NO PAIRED DAEMON OWNS GOES STRAIGHT TO THE NETWORK. That
 * is not a hole: the two calls in this app that are not bound to a paired daemon
 * are the pairing exchange itself and the relay advertisement, and neither can be
 * relayed. The pairing exchange in particular CANNOT be — a relayed session is
 * opened with the device grant pairing has not issued yet — which is a real
 * constraint recorded in the protocol document rather than worked around here.
 */
export class DaemonCarrierRouter {
  readonly #entries = new Map<DaemonId, CarrierEntry>();
  readonly #listeners = new Set<() => void>();
  readonly #network: DaemonFetch;
  readonly #dial: RelayDial;
  readonly #crypto: RelayClientSessionDependencies['crypto'];
  readonly #heartbeat: RelayHeartbeatSchedule | undefined;
  #lookup: (origin: string) => DaemonConnection | undefined = () => undefined;

  /**
   * THE INJECTED NETWORK IS DETACHED FROM ITS RECEIVER EXACTLY ONCE, HERE.
   *
   * `this.#network(url, init)` is a member call, and a member call passes the holder
   * as `this`. Handed a WebIDL builtin that is a refusal —
   * `Failed to execute 'fetch' on 'Window': Illegal invocation` — thrown before a
   * byte leaves the tab, so every paired daemon reads as unreachable at once. It has
   * shipped twice: PR #223 through a transport, and this router through
   * `network: fetch` handed in by the composition root, which is why the arrow
   * DEFAULT below never helped — the default is not what ran.
   *
   * So the field holds a closure rather than the caller's value. An arrow has no
   * receiver of its own and calls the injected function as a plain call, which means
   * the shape of what a caller passes stops mattering to this class. That is the
   * "not harmful" half; `scripts/validate/fetch-binding.sh` and the single
   * `browserFetch` spelling are the "not possible" half, and both are deliberate —
   * one contract cannot be the only thing standing between a browser and a product
   * that does not connect.
   */
  constructor(options: DaemonCarrierRouterOptions) {
    const injected = options.network;
    this.#network = injected === undefined ? browserFetch : (input, init) => injected(input, init);
    this.#dial = options.dial ?? browserRelayDial;
    this.#crypto = options.crypto;
    this.#heartbeat = options.heartbeat;
  }

  /**
   * How a URL is resolved back to the daemon that owns it.
   *
   * Supplied by the composition root from the pairing registry, because the router
   * must not hold its own copy of who is paired: a second copy is how a request
   * keeps going to a daemon that has been unpaired.
   */
  resolveByOrigin(lookup: (origin: string) => DaemonConnection | undefined): void {
    this.#lookup = lookup;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** What carried this daemon's traffic, and why the alternatives did not. */
  choice(daemonId: DaemonId): ConnectionChoice | undefined {
    return this.#entries.get(daemonId)?.choice;
  }

  /** Unpair and re-pair invalidation: a carrier is live state, never durable. */
  clearDaemon(daemonId: DaemonId): void {
    const entry = this.#entries.get(daemonId);
    if (entry === undefined) return;
    this.#entries.delete(daemonId);
    void entry.session?.then(
      session => session.close('this daemon was re-paired or unpaired'),
      () => undefined,
    );
    this.#announce();
  }

  /** The `DaemonFetch` the composition root hands to every daemon-bound caller. */
  readonly fetch: DaemonFetch = async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      return await this.#network(input, init);
    }
    const daemon = this.#lookup(origin);
    if (daemon === undefined || input instanceof Request) return await this.#network(input, init);
    return await this.send(daemon, url, init ?? {});
  };

  /**
   * One request, over the first carrier that carries it.
   *
   * Direct is attempted first — every time, on a fresh connection — and only a
   * TRANSPORT failure moves on. Once a carrier has ANSWERED, it keeps the traffic
   * for the life of this connection: that is the `ok === true` short-circuit, and it
   * is what stops a browser on the network the relay exists for paying a failed
   * direct connection on every single call.
   *
   * A ROUND OF FAILURES IS NOT REMEMBERED, and this used to be two bugs at once. The
   * refused carriers were accumulated on the shared entry rather than kept to the
   * request that tried them, so:
   *
   * - Concurrent requests — which is every app load — each appended their own copy,
   *   and the disclosure listed `Direct` twice and `Hosted relay` twice for one
   *   daemon. A reader seeing a carrier named four times reasonably concludes the
   *   screen is broken, which is a bad way to learn their firewall changed.
   * - A daemon that had failed on every carrier once could never be retried. The loop
   *   skipped everything already on the list, so the entry was poisoned for the life
   *   of the pairing: coming back onto the right network, or the relay coming back
   *   up, changed nothing until a re-pair. A transient failure presented as a
   *   permanent one.
   *
   * So the probe list is a LOCAL, and it lives exactly as long as the attempt that
   * built it. Nothing is lost by that: a round in which no carrier worked served no
   * request, so there is no answer to keep and re-probing next time is the only
   * behaviour that can ever recover.
   */
  async send(daemon: DaemonConnection, url: string, init: RequestInit = {}): Promise<Response> {
    const entry = this.#entry(daemon);
    const chosen = entry.choice;
    if (chosen?.ok === true) return await this.#over(entry, chosen.method, url, init);

    const probes: ConnectionProbe[] = [];
    for (const method of daemonCarriers(daemon)) {
      try {
        const response = await this.#over(entry, method, url, init);
        this.#decide(entry, [...probes, { method, reachable: true }]);
        return response;
      } catch (reason) {
        if (reason instanceof RelayAnswerError) throw reason.cause;
        probes.push({ method, reachable: false, detail: transportFailure(reason) });
      }
    }
    this.#decide(entry, probes);
    throw new Error(entry.choice?.reason ?? 'no carrier is configured for this daemon');
  }

  #entry(daemon: DaemonConnection): CarrierEntry {
    const current = this.#entries.get(daemon.daemonId);
    if (current !== undefined && sameDaemonConnection(current.connection, daemon)) return current;
    if (current !== undefined) this.clearDaemon(daemon.daemonId);
    const entry: CarrierEntry = { connection: daemon, choice: undefined, session: undefined };
    this.#entries.set(daemon.daemonId, entry);
    return entry;
  }

  #decide(entry: CarrierEntry, probes: readonly ConnectionProbe[]): void {
    entry.choice = chooseConnection(probes);
    this.#announce();
  }

  async #over(entry: CarrierEntry, method: ConnectionMethod, url: string, init: RequestInit): Promise<Response> {
    if (method.kind === 'direct') return await this.#network(url, init);
    const session = await this.#session(entry, method);
    try {
      return relayResponse(await session.request(relayTunnelRequest(url, init)));
    } catch (reason) {
      // The carrier failed under this request, so another carrier may be tried — and
      // the request itself is LOST rather than retried on this one: §9 says frames in
      // flight are gone and known to be gone, so re-requesting is the caller's call.
      if (!session.live()) throw reason;
      // The daemon ANSWERED. A `409`, an `oversize` refusal — that is a result, and
      // trying another carrier after it would silently re-send a mutation.
      throw new RelayAnswerError(reason);
    }
  }

  /**
   * The live session for this connection, re-dialled when the last one is gone.
   *
   * §9 is explicit that reconnection is not resumption: a session is bound to its
   * sockets, and when one drops the session is over. So a dead session is replaced
   * rather than revived, and the replacement has new keys and a new identifier.
   * Reusing a dead one would be a request that can never be answered.
   */
  async #session(
    entry: CarrierEntry,
    method: Extract<ConnectionMethod, { kind: 'relay' }>,
  ): Promise<RelayClientSession> {
    const existing = entry.session;
    if (existing !== undefined) {
      const current = await existing.catch(() => undefined);
      if (current?.live() === true) return current;
      entry.session = undefined;
    }
    const opening = openRelaySession({
      crypto: this.#crypto,
      dial: this.#dial,
      daemon: entry.connection,
      method,
      ...(this.#heartbeat === undefined ? {} : { heartbeat: this.#heartbeat }),
    });
    entry.session = opening;
    try {
      return await opening;
    } catch (reason) {
      entry.session = undefined;
      throw reason;
    }
  }

  #announce(): void {
    for (const listener of this.#listeners) listener();
  }
}

/** Marks a refusal that came from the DAEMON, so no other carrier is tried after it. */
class RelayAnswerError extends Error {
  constructor(override readonly cause: unknown) {
    super('the daemon refused a relayed request');
    this.name = 'RelayAnswerError';
  }
}
