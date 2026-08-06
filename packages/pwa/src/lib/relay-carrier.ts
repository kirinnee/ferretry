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
 * a re-pair or a moved daemon address starts over, and so does a winner the daemon
 * has since stopped publishing. THE DAEMON REPUBLISHING ITS ADDRESS SET IS NOT ONE
 * OF THOSE — a refresh that still names the winning carrier keeps it, and keeps the
 * session already open on it, because nothing about that path changed. A remembered
 * winner is also forgotten the moment it stops carrying, and the failure is reported
 * rather than replayed at the next address.
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
  carrierProbe,
  chooseConnection,
  connectionSocketUrl,
  HEARTBEAT_GRACE_SECONDS,
  HEARTBEAT_SECONDS,
  RELAY_CLOSE_CODES,
} from '@ferretry/relay';
import {
  type DaemonConnection,
  type DaemonId,
  daemonCarriers,
  hostedRelayFallbackCarrier,
  sameDaemonCarrier,
  sameDaemonConnection,
} from './daemon-connection.ts';
import {
  RelayClientSession,
  type RelayClientSessionDependencies,
  type RelayClientSocket,
  RelaySessionError,
  type RelayTunnelAnswer,
  type RelayTunnelClientMessage,
} from './relay-session.ts';
import { browserFetch, type DaemonFetch } from './runtime-models.ts';

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
  /**
   * THE ONE ADVERTISEMENT READ THIS DOCUMENT PERFORMED, as a last-resort address and nothing else.
   *
   * A FUNCTION RATHER THAN A VALUE because the answer arrives after this router does, and a promise
   * rather than a string because it must not be re-read: `relayUrl: null` is a kill switch, and a
   * router that asked again per request would both hammer the directory and hold two answers.
   *
   * It is awaited ONLY when a daemon has authored no rendezvous and every address it did author has
   * already failed — so a daemon with its own relay, and every direct-first attempt, never waits on
   * the directory at all. What comes back is dialled, never stored: see `hostedRelayFallbackCarrier`.
   */
  readonly hostedRelay?: () => Promise<string | undefined>;
}

interface CarrierEntry {
  readonly connection: DaemonConnection;
  choice: ConnectionChoice | undefined;
  readonly sessions: Map<string, Promise<RelayClientSession>>;
}

/**
 * Same daemon, same address, same grant — only the published carrier set moved.
 *
 * Deliberately NOT `sameDaemonConnection` with the carriers excused: that function is
 * the liveness fence and stays whole. This is the narrower question asked only after
 * it has already said no, and it separates the one difference a live session can
 * survive from every difference it may not.
 */
const carrierRefreshOnly = (left: DaemonConnection, right: DaemonConnection): boolean =>
  left.daemonId === right.daemonId && left.baseUrl === right.baseUrl && left.deviceToken === right.deviceToken;

/**
 * Said to a session that finished opening after the entry it was dialled for was replaced.
 *
 * It names all three causes because the dial cannot tell them apart from where it stands, and a
 * sentence that guessed one would be wrong two thirds of the time.
 */
const STALE_SESSION_REASON =
  'this daemon was re-paired, unpaired or republished while this rendezvous session was opening';

const transportFailure = (reason: unknown): string => {
  if (reason instanceof RelaySessionError) return `${reason.message} (${reason.code})`;
  return reason instanceof Error ? reason.message : String(reason);
};

/**
 * A carrier walk may only replay a request whose repeated application is safe.
 *
 * A rejected browser fetch says the response did not arrive; it does NOT prove
 * the daemon did not receive a mutation. Reads have no such ambiguity, so they
 * retain the direct-then-relay recovery path while a write is reported to its
 * caller to decide whether a retry is appropriate.
 */
const replaySafe = (init: RequestInit): boolean => {
  const method = (init.method ?? 'GET').toUpperCase();
  return method === 'GET' || method === 'HEAD';
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
  readonly #connectedListeners = new Set<(daemon: DaemonConnection) => void>();
  readonly #network: DaemonFetch;
  readonly #dial: RelayDial;
  readonly #crypto: RelayClientSessionDependencies['crypto'];
  readonly #heartbeat: RelayHeartbeatSchedule | undefined;
  readonly #hostedRelay: () => Promise<string | undefined>;
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
    // No provider is direct-only, which is what a build with no relay directory honestly is.
    this.#hostedRelay = options.hostedRelay ?? (async () => undefined);
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

  /** Called once when a fresh carrier walk first receives any answer, including a 503. */
  onConnected(listener: (daemon: DaemonConnection) => void): () => void {
    this.#connectedListeners.add(listener);
    return () => this.#connectedListeners.delete(listener);
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
    for (const session of entry.sessions.values()) {
      void session.then(
        connected => connected.close('this daemon was re-paired or unpaired'),
        () => undefined,
      );
    }
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
   * A REMEMBERED WINNER THAT STOPS CARRYING IS FORGOTTEN AND THE FAILURE IS REPORTED
   * — this request is not replayed over another carrier inside the same call. The
   * walk cannot know whether the daemon received the attempt that just died: §9 says
   * frames in flight are gone, and a transport failure on a direct carrier says
   * nothing at all about whether the daemon applied the request. Re-sending it at the
   * next address would turn one `POST /v1/sessions` into two sessions on a daemon
   * that took the first. So the remembered choice is dropped and the caller is told;
   * the NEXT request begins the deterministic direct-then-relay walk with nothing
   * remembered, which is the recovery. Retrying is the caller's decision, exactly as
   * it already is for a relayed request whose session went away mid-flight.
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
    if (chosen?.ok === true) {
      try {
        return await this.#over(entry, chosen.method, url, init);
      } catch (reason) {
        if (reason instanceof RelayAnswerError) throw reason.cause;
        // The remembered carrier stopped carrying. Forget it — the next request walks
        // the set again — and report this failure rather than re-sending a request
        // whose fate on the daemon is unknown.
        entry.choice = undefined;
        this.#announce();
        throw reason;
      }
    }

    const probes: ConnectionProbe[] = [];
    for await (const method of this.#candidates(daemon)) {
      try {
        const response = await this.#over(entry, method, url, init);
        // WHETHER AN ATTEMPT ADVANCES THE WALK IS THE PROTOCOL'S RULE, not this
        // class's: `carrierProbe` reads an ANSWER — any status, `503` included — as
        // this carrier working, and only a transport failure as a reason to try the
        // next address. Spelling that out a second time here is how a client and its
        // own protocol come to disagree about what "reachable" means.
        this.#decide(entry, [...probes, carrierProbe(method, { kind: 'answered', status: response.status })]);
        return response;
      } catch (reason) {
        if (reason instanceof RelayAnswerError) throw reason.cause;
        probes.push(carrierProbe(method, { kind: 'transport-failure', detail: transportFailure(reason) }));
        // A direct fetch rejection can follow receipt of a POST/PUT/etc. Record its
        // failed probe for the same disclosure a completed walk produces, but do not
        // send that possibly-applied request to the next carrier.
        if (!replaySafe(init)) {
          this.#decide(entry, probes);
          throw reason;
        }
      }
    }
    this.#decide(entry, probes);
    throw new Error(entry.choice?.reason ?? 'no carrier is configured for this daemon');
  }

  /**
   * Every address this walk may try, in order: the daemon's own set, then the fallback.
   *
   * THE FALLBACK IS LAST AND IS REACHED ONLY BY EXHAUSTION. A daemon that authored a rendezvous is
   * answered entirely from its own set — the generator returns before the advertisement is even
   * awaited — so the directory cannot delay a direct-first attempt on the ordinary path. It is
   * dialled and never written down; `hostedRelayFallbackCarrier` owns why, and owns the fingerprint
   * and address rules it is held to.
   */
  async *#candidates(daemon: DaemonConnection): AsyncGenerator<ConnectionMethod> {
    const authored = daemonCarriers(daemon);
    yield* authored;
    if (authored.some(method => method.kind === 'relay')) return;
    const hosted = hostedRelayFallbackCarrier(daemon, await this.#hostedRelay());
    if (hosted !== undefined) yield hosted;
  }

  #entry(daemon: DaemonConnection): CarrierEntry {
    const current = this.#entries.get(daemon.daemonId);
    if (current !== undefined && sameDaemonConnection(current.connection, daemon)) return current;
    if (current !== undefined && carrierRefreshOnly(current.connection, daemon))
      return this.#refreshed(current, daemon);
    if (current !== undefined) this.clearDaemon(daemon.daemonId);
    const entry: CarrierEntry = { connection: daemon, choice: undefined, sessions: new Map() };
    this.#entries.set(daemon.daemonId, entry);
    return entry;
  }

  /**
   * The daemon republished its addresses. That is not a re-pair.
   *
   * A successful connection replaces the cached carrier set from `/v1/carriers`, so
   * the FIRST answer a daemon gives is routinely followed by a new connection object
   * for the same daemon, the same address and the same grant. Treated as a re-pair it
   * tore down the rendezvous session that had just carried that very read and closed
   * it saying the daemon "was re-paired or unpaired", which is a sentence about
   * something that did not happen — and on the network the relay exists for, the
   * replacement session costs a second handshake to arrive back where it started.
   *
   * WHAT IS KEPT IS ONLY WHAT THE NEW SET STILL NAMES. A session survives when its
   * rendezvous is still published, because nothing about that path changed: same
   * daemon, same device token, same relay URL, so an answer arriving on it is an
   * answer from the connection that asked. A rendezvous the daemon WITHDREW is closed
   * — saying so — and a relay winner no longer in the set is forgotten, which puts the
   * next request back at the top of the deterministic walk.
   *
   * ONE EXCEPTION, AND ONLY FOR A DIRECT WINNER: an address that is CARRYING THIS
   * CONNECTION's traffic is kept even when the replacement omits it. The two omissions
   * are not the same fact. A withdrawn relay is a decision — the daemon stopped dialling
   * that room and nothing is there — while a daemon publishes no direct entry when it
   * cannot EXPRESS one on the wire: a wildcard bind names no address, and a `publicUrl`
   * with a proxy path is not an origin a device may store. The daemon is still answering
   * on it, and this browser has the only proof of that there is. Dropping it would put a
   * reachable daemon behind a rendezvous, and a rendezvous that later goes away would
   * strand a device that could have talked to it all along.
   *
   * IT IS LIVE STATE AND NOTHING ELSE. Nothing is written to the cache, which stays
   * exactly what the daemon said; the moment this winner stops carrying, `send` forgets
   * it like any other, and the next walk sees only the daemon-authored set.
   *
   * The identity fence is untouched: a changed `daemonId`, `baseUrl` or device token
   * is not a refresh and never reaches here.
   */
  #refreshed(current: CarrierEntry, daemon: DaemonConnection): CarrierEntry {
    const carriers = daemonCarriers(daemon);
    const published = new Set(carriers.flatMap(method => (method.kind === 'relay' ? [method.relayUrl] : [])));
    const sessions = new Map<string, Promise<RelayClientSession>>();
    for (const [relayUrl, session] of current.sessions) {
      if (published.has(relayUrl)) {
        sessions.set(relayUrl, session);
        continue;
      }
      void session.then(
        // True of a rendezvous the daemon withdrew AND of a fallback it never published, which is
        // every session this branch can be holding.
        connected => connected.close('this rendezvous is not named in the carriers this daemon publishes'),
        () => undefined,
      );
    }
    const chosen = current.choice;
    const kept =
      chosen?.ok === true &&
      (carriers.some(method => sameDaemonCarrier(method, chosen.method)) || chosen.method.kind === 'direct')
        ? chosen
        : undefined;
    const entry: CarrierEntry = { connection: daemon, choice: kept, sessions };
    this.#entries.set(daemon.daemonId, entry);
    this.#announce();
    return entry;
  }

  #decide(entry: CarrierEntry, probes: readonly ConnectionProbe[]): void {
    // Initial requests may walk concurrently. Once one has an answer, that winner
    // is the connection's fact: a later walk that happened to lose direct and
    // reach a relay must still return its own response, but may not turn timing
    // into a relay preference for every request that follows.
    if (entry.choice?.ok === true) return;
    entry.choice = chooseConnection(probes);
    this.#announce();
    if (!entry.choice.ok) return;
    for (const listener of this.#connectedListeners) {
      try {
        listener(entry.connection);
      } catch {
        // Refresh and disclosure observers cannot turn a served request into a failure.
      }
    }
  }

  async #over(entry: CarrierEntry, method: ConnectionMethod, url: string, init: RequestInit): Promise<Response> {
    if (method.kind === 'direct') return await this.#network(directCarrierUrl(method, url), init);
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
   *
   * A SESSION THAT FINISHES OPENING INTO AN ENTRY NOBODY HOLDS IS CLOSED, NOT RETURNED.
   * A dial takes a handshake, and the entry it was started against can be replaced while
   * it runs — by a re-pair, an unpair, or a carrier refresh, all of which install a
   * different object. The socket would then be reachable from nothing: `clearDaemon` and
   * `#refreshed` walk the CURRENT entry's map, so a session recorded only in the
   * abandoned one is a live rendezvous holding this device's grant that no unpair can
   * ever close. A refresh that carried this exact opening promise across is the one case
   * where the entry moved and the session did not, and that session is tracked and fine.
   */
  async #session(
    entry: CarrierEntry,
    method: Extract<ConnectionMethod, { kind: 'relay' }>,
  ): Promise<RelayClientSession> {
    const existing = entry.sessions.get(method.relayUrl);
    if (existing !== undefined) {
      const current = await existing.catch(() => undefined);
      if (current?.live() === true) return current;
      entry.sessions.delete(method.relayUrl);
    }
    const opening = openRelaySession({
      crypto: this.#crypto,
      dial: this.#dial,
      daemon: entry.connection,
      method,
      ...(this.#heartbeat === undefined ? {} : { heartbeat: this.#heartbeat }),
    });
    entry.sessions.set(method.relayUrl, opening);
    let session: RelayClientSession;
    try {
      session = await opening;
    } catch (reason) {
      if (entry.sessions.get(method.relayUrl) === opening) entry.sessions.delete(method.relayUrl);
      throw reason;
    }
    const held = this.#entries.get(entry.connection.daemonId);
    if (held === entry || held?.sessions.get(method.relayUrl) === opening) return session;
    entry.sessions.delete(method.relayUrl);
    // `close` is idempotent, so a re-pair that already closed this promise's session and this
    // sentence do not fight; either way it ends, and the caller is told rather than handed a
    // session no unpair could reach.
    session.close(STALE_SESSION_REASON);
    throw new Error(STALE_SESSION_REASON);
  }

  #announce(): void {
    for (const listener of this.#listeners) listener();
  }
}

/** Re-targets one daemon-shaped request to a published direct carrier without changing the request path. */
export const directCarrierUrl = (method: Extract<ConnectionMethod, { kind: 'direct' }>, requestUrl: string): string => {
  const request = new URL(requestUrl);
  return new URL(`${request.pathname}${request.search}`, `${method.daemonUrl}/`).toString();
};

/** Marks a refusal that came from the DAEMON, so no other carrier is tried after it. */
class RelayAnswerError extends Error {
  constructor(override readonly cause: unknown) {
    super('the daemon refused a relayed request');
    this.name = 'RelayAnswerError';
  }
}
