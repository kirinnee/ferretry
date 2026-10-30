/**
 * WHICH CARRIER A DAEMON'S TRAFFIC IS ACTUALLY ON, AND THE BYTES GOING OVER IT.
 *
 * `docs/relay-protocol.md` §15 states the required behaviour: walk the carriers this
 * browser's CONNECTION PREFERENCE for the machine allows, in its order — Auto is
 * direct, WebRTC, the daemon's tunnel, then a relay with the hosted one last — and
 * always be able to say which carrier is live and why the others were passed over.
 * The preference only narrows the walk; it never reorders a kind's addresses, which
 * stay the daemon's, and a preference that leaves nothing to try is a stated failure,
 * never a silent fall back to a carrier the person excluded. Pairing does not come
 * through here and ignores the preference (`relay-pairing.ts`).
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
 * - An answer too large for the session (§14) arrives as the daemon's own `502`,
 *   never as a truncated body: a client that rendered half a session list would
 *   show a fleet that does not exist.
 */

import {
  DaemonCarriersViewSchema,
  FY_REQUEST_ID_HEADER,
  OLDER_APP_SENTENCE,
  OLDER_DAEMON_SENTENCE,
  RELAY_ACCESS_LEASE_ENDED_CLOSE_CODE,
  STEP_UP_REQUIRED_CODE,
  type StepUpDemand,
  StepUpRequiredBodySchema,
  UNLOCK_REQUIRED_CODE,
} from '@ferretry/protocol';
import {
  APP_SESSION_BYTES,
  CONNECTION_KINDS,
  type ConnectionChoice,
  type ConnectionMethod,
  type ConnectionProbe,
  type ConnectionSkip,
  carrierProbe,
  chooseConnection,
  connectionSocketUrl,
  describeConnectionMethod,
  HEARTBEAT_GRACE_SECONDS,
  MAX_PLAINTEXT_BYTES,
  type PrivateKeyHandle,
  parseDaemonId,
  publishedConnectionMethods,
  RELAY_CLOSE_CODES,
  SESSION_PROTOCOL_ID,
  toBase64Url,
} from '@ferretry/relay';
import type { CarrierDropLog, CarrierSessionEnd } from './carrier-drops.ts';
import {
  CARRIER_PREFERENCE_LABEL,
  type CarrierPreference,
  carrierOrder,
  DEFAULT_CARRIER_PREFERENCE,
} from './carrier-preference.ts';
import type { CarrierOutage, ConnectionHealthReporter } from './connection-health.ts';
import {
  type DaemonConnection,
  type DaemonId,
  daemonCarriers,
  hostedRelayFallbackCarrier,
  sameDaemonCarrier,
  sameDaemonConnection,
  type TunnelCarrier,
} from './daemon-connection.ts';
import { boundDaemonId } from './daemon-transport.ts';
import { DeviceKeyMissingError, DeviceKeyUnreadableError } from './device-keys.ts';
import { stepUpAct } from './grants.ts';
import type { KeyRotation } from './key-rotation.ts';
import { untilAborted } from './machine-deadline.ts';
import {
  RelayClientSession,
  type RelayClientSessionDependencies,
  type RelayClientSocket,
  RelaySessionError,
  type RelaySessionMode,
  type RelayStreamFrame,
  RelayStreamRefusedError,
  type RelayTunnelAnswer,
  type RelayTunnelClientMessage,
  type SessionDeviceClaim,
} from './relay-session.ts';
import { browserFetch, type DaemonFetch } from './runtime-models.ts';
import type { PromptOrigin } from './step-up-gate.ts';
import { noTunnelReason, TUNNEL_SWITCHED_OFF, type TunnelServiceState } from './tunnel-service.ts';

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

/**
 * THE MESSAGE SOCKET EVERY CARRIER HANDS THE SESSION, whatever carries the bytes underneath.
 *
 * A WebSocket to a daemon, a tunnel or a rendezvous is one of these (`browserRelayDial`); a WebRTC data
 * channel is another. The session above it is identical on all of them (§6, §7).
 *
 * A DIALER THAT RESOLVES ONE hands it over before delivering anything on it: the router installs its
 * handlers in the same turn the promise resolves, so a message delivered earlier would be lost.
 * `onOpen` is called once the channel can carry — after resolution even when it was already open
 * (a queued call is enough) — and `onClose` once when it ends, with a reason a person can read.
 */
export type CarrierSocket = RelayCarrierSocket;

/** What the WebRTC dialer is given for one attempt. */
export interface WebRtcDialContext {
  /** The paired machine: its fingerprint, its grant, and its published carriers. */
  readonly daemon: DaemonConnection;
  /**
   * The carriers that may INTRODUCE the two ends, in the order a walk would try them: the daemon's own
   * direct addresses and rendezvous, then the hosted relay when it published none. Signalling only —
   * §15 never lets the introduction carry the session's bytes. Never a tunnel: its listener serves the
   * session route and nothing else.
   */
  readonly introducers: readonly ConnectionMethod[];
  /**
   * One authenticated daemon request — signalling such as `POST /v1/webrtc/offer` — sent over the
   * {@link introducers} in order and nothing else: never WebRTC itself, never a tunnel. It rides the
   * request session this router already holds on an introducer, or opens one there, so a dialer never
   * opens a second session to the same rendezvous. Only a transport failure moves to the next
   * introducer, and a write whose session died after it left is not sent again; any answer, any
   * status, is returned as it came. Rejects when no introducer carried it.
   */
  readonly request: (path: string, init?: RequestInit) => Promise<Response>;
  /**
   * Aborted when this attempt is abandoned: the pairing was replaced or removed, or the person changed
   * this machine's connection preference. A dialer stops negotiating and rejects.
   */
  readonly signal: AbortSignal;
}

/**
 * Carriers that need more than a URL to dial, supplied by the composition root. A carrier with no
 * dialer in this build is passed over with {@link WEBRTC_UNAVAILABLE}, said out loud, and "WebRTC only"
 * with no dialer is a stated failure.
 */
export interface CarrierDialers {
  /** A peer-to-peer data channel to the daemon, or a rejection saying why none could be negotiated. */
  readonly webrtc?: (context: WebRtcDialContext) => Promise<CarrierSocket>;
}

/** Said for WebRTC wherever a walk would have tried it in a build that has no dialer. */
export const WEBRTC_UNAVAILABLE = 'WebRTC isn’t available in this build yet';

/** Said for "Relay only" when the daemon published no rendezvous and there is no hosted one to use. */
export const RELAY_UNAVAILABLE = 'there is no relay for this machine right now';

/** Cancels a repeating timer. Injected so no suite depends on wall-clock behaviour. */
export type RelayHeartbeatSchedule = (tick: () => void, intervalMilliseconds: number) => () => void;

const browserHeartbeat: RelayHeartbeatSchedule = (tick, interval) => {
  const handle = setInterval(tick, interval);
  return () => clearInterval(handle);
};

/** The page's monotonic clock, which a wall-clock change cannot make a deadline look late by. */
const monotonicNow = (): number => globalThis.performance.now();

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
 * WHY A SOCKET DID NOT WORK — DIRECT OR RELAYED — SAID IN TERMS A READER CAN ACT ON.
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
  // The same sentence serves a direct dial and a relay one, so it names neither: "the relay protocol"
  // and "rendezvous" told a phone dialling a daemon's own address about a carrier it never used.
  return opened
    ? `the connection to ${origin} was carrying this session and ended without a close frame`
    : `the browser could not open a connection to ${origin}. The address may not resolve, may refuse TLS, ` +
        'may be blocked on this network, or may not be serving this machine';
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

/**
 * The answer, as the `Response` every caller in this package already handles.
 *
 * A body that did not fit one record has already been reassembled from its parts by the session, so
 * there is no "too large" shape left to refuse here — the daemon answers an answer past the tunnel's
 * limit with its own `502`, and that is an ordinary response.
 */
export const relayResponse = (answer: RelayTunnelAnswer): Response => {
  const bodyless = BODYLESS_STATUSES.includes(answer.status);
  return new Response(bodyless ? null : answer.body, { status: answer.status, headers: answer.headers });
};

/* ---------- opening one relayed session ----------------------------------- */

export interface OpenRelaySessionOptions {
  readonly crypto: RelayClientSessionDependencies['crypto'];
  readonly dial: RelayDial;
  readonly daemon: DaemonConnection;
  /** Either carrier: a rendezvous, or the daemon's own address, which speaks the same session. */
  readonly method: ConnectionMethod;
  readonly heartbeat?: RelayHeartbeatSchedule;
  /**
   * What this session is for, including the device claim that proves it.
   *
   * A PAIRING session never comes through here: it has no `DaemonConnection` to be opened against —
   * there is no grant yet and no daemon in the registry — so it is dialled by `relay-pairing.ts`
   * instead. What does come through here is a request or a stream session, which have both.
   */
  readonly mode: RelaySessionMode;
  readonly onData?: RelayClientSessionDependencies['onData'];
  /** How long the session may take to be accepted. The heartbeat grace by default. */
  readonly deadlineMs?: number;
  /** Told when this session, once serving, is dropped under this browser. See {@link driveRelaySession}. */
  readonly onDropped?: (end: CarrierSessionEnd) => void;
  /** A monotonic clock for the keepalive and the drop report; the page's own by default. */
  readonly clock?: () => number;
}

/**
 * How long a DIRECT session may take to be accepted before the walk moves on to a rendezvous.
 *
 * The same reasoning as the pairing walk's direct leg, applied to every session. A daemon's published
 * direct address is often a private one, and from cellular those packets are DROPPED rather than
 * refused, so a socket to it neither opens nor fails — it waited out the whole heartbeat grace (45 s)
 * before the walk tried the relay, on every page load away from home. A reachable daemon keys a
 * session in three round trips, well inside this even across an ocean; past it, "this address is not
 * answering" is the more useful conclusion. A relay keeps the full grace: it is the last resort.
 */
export const DIRECT_SESSION_DEADLINE_MS = 4_000;

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
/**
 * WIRE ONE SOCKET TO ONE SESSION AND WAIT FOR THE ONE THING THAT SESSION IS FOR.
 *
 * Extracted so a pairing attempt and a request or stream session share it byte for byte rather than
 * carrying two copies of the deadline arithmetic. There is exactly one difference between the two
 * uses and it is `keepAlive`: a session that goes on to carry traffic keeps its heartbeat, while a
 * pairing session has stated its outcome and is about to be closed by the daemon, so leaving a
 * thirty-second interval armed behind it would keep a timer alive for a conversation that is over.
 */
/**
 * How often this side pings a live session: inside `heartbeatSeconds`, which §8 makes a ceiling
 * ("at least every"), so sending more often conforms.
 */
export const KEEPALIVE_INTERVAL_MS = 20_000;

/**
 * How long a ping may go unanswered before the socket is treated as dead.
 *
 * WHY THIS SIDE CHECKS AT ALL: a phone that sleeps, or a network that changes under it, can leave a
 * socket the browser still calls open while nothing reaches it. Nothing ever closes such a socket —
 * the far end evicts it, but the eviction cannot reach this tab — so without a deadline of its own
 * this browser kept sending requests into a socket that could never answer them. ANY inbound
 * message counts as life, not only the `fy-pong`.
 */
export const KEEPALIVE_DEADLINE_MS = 10_000;

/** The shorter deadline a liveness check uses when the browser says the network may have changed. */
export const LIVENESS_CHECK_DEADLINE_MS = 4_000;

/**
 * How late a heartbeat deadline may fire before the silence it measured is not believed.
 *
 * A TIMER THAT FIRED LATE DID NOT WATCH THE SOCKET. A phone that hides an installed app freezes the page
 * or throttles its timers to once a minute; on the way back every overdue timer and every queued message
 * is delivered, in an order the browser does not promise. A pong that arrived while the page was frozen
 * can still be queued BEHIND the deadline it answers, so a deadline that fires well past its time has
 * measured the freeze, not the carrier. It is forgiven ONCE: a fresh ping with the liveness-check
 * deadline, now on a running page — answered, and the session lives; silent again, and it is dead.
 */
export const HEARTBEAT_LATE_TOLERANCE_MS = 2_000;

/**
 * Asks one held session to prove it is alive within `deadlineMs`, or end. Registered by
 * {@link driveRelaySession} for every session it keeps alive; absent for one it does not.
 */
const livenessChecks = new WeakMap<RelayClientSession, (deadlineMs: number) => void>();

/**
 * Failures of a socket that never OPENED — the one fact about a carrier the browser does not withhold
 * (see {@link socketFailureReason}). Kept beside the error rather than read back out of its sentence,
 * so "no relay could even be reached" is decided from what happened and not from wording.
 */
const unopened = new WeakSet<object>();

/** Whether this failure came from a socket that never completed its handshake. */
export const socketNeverOpened = (reason: unknown): boolean =>
  typeof reason === 'object' && reason !== null && unopened.has(reason);

/** Run an immediate liveness check on one session: a ping now, and a close if nothing comes back. */
export const checkSessionLiveness = (session: RelayClientSession, deadlineMs = LIVENESS_CHECK_DEADLINE_MS): void =>
  livenessChecks.get(session)?.(deadlineMs);

export const driveRelaySession = async <T>({
  socket,
  session,
  heartbeat,
  settled,
  keepAlive,
  deadlineMs = HEARTBEAT_GRACE_SECONDS * 1_000,
  clock = monotonicNow,
  onDropped,
}: {
  readonly socket: RelayCarrierSocket;
  readonly session: RelayClientSession;
  readonly heartbeat: RelayHeartbeatSchedule;
  readonly settled: Promise<T>;
  readonly keepAlive: boolean;
  /** How long the session may take to settle. The heartbeat grace by default; shorter for a probe. */
  readonly deadlineMs?: number;
  /** A monotonic millisecond clock: how late a deadline fired, and how long the session lived. */
  readonly clock?: () => number;
  /**
   * Told once when a session that was SERVING ends without this browser asking — the carrier closed
   * under it, or its heartbeat went unanswered. Never for a dial that failed, a close this app made, or
   * a stream the daemon concluded. What `carrier-drops.ts` keeps.
   */
  readonly onDropped?: (end: CarrierSessionEnd) => void;
}): Promise<T> => {
  let opened = false;
  /** When the session started serving, once it has; a close before that is a failed dial, not a drop. */
  let servingSince: number | undefined;
  let lastHeardAt = clock();
  const timers = new Set<() => void>();
  const stop = (): void => {
    for (const cancel of timers) cancel();
    timers.clear();
    livenessChecks.delete(session);
  };
  /** A session that was serving ended under this browser: say so once, with what it measured. */
  const dropped = (code: number, reason: string): void => {
    if (servingSince === undefined) return;
    const now = clock();
    const since = servingSince;
    servingSince = undefined;
    onDropped?.({ code, reason, livedMs: now - since, lastHeardMs: now - lastHeardAt });
  };
  // The one unanswered ping, if any. Any inbound message disarms it — that is the evidence of life —
  // so a deadline that fires has, by construction, heard nothing since it was armed.
  let pongDeadline: { readonly within: number; readonly cancel: () => void } | undefined;
  /** Whether the last deadline was forgiven for firing late; cleared by any evidence of life. */
  let forgiven = false;
  const armDeadline = (withinMs: number): void => {
    // A shorter wait replaces a longer one — a liveness check under the regular ping — and a longer
    // one never relaxes a shorter one already armed.
    if (pongDeadline !== undefined && pongDeadline.within <= withinMs) return;
    if (pongDeadline !== undefined) {
      pongDeadline.cancel();
      timers.delete(pongDeadline.cancel);
    }
    const armedAt = clock();
    const cancel = heartbeat(() => {
      // A repeating schedule used once: the first tick is the deadline.
      cancel();
      timers.delete(cancel);
      pongDeadline = undefined;
      // Fired long after its time: the page was frozen or throttled, so this silence is the browser's,
      // not the carrier's. Ask again on a running page — see HEARTBEAT_LATE_TOLERANCE_MS.
      if (!forgiven && clock() - armedAt - withinMs > HEARTBEAT_LATE_TOLERANCE_MS) {
        forgiven = true;
        ping(LIVENESS_CHECK_DEADLINE_MS);
        return;
      }
      stop();
      const reason = `the carrier showed no sign of life for ${String(withinMs / 1_000)} s after a heartbeat`;
      dropped(RELAY_CLOSE_CODES.heartbeatTimeout, reason);
      session.carrierClosed(RELAY_CLOSE_CODES.heartbeatTimeout, reason);
      socket.close(RELAY_CLOSE_CODES.heartbeatTimeout, 'no heartbeat');
    }, withinMs);
    timers.add(cancel);
    pongDeadline = { within: withinMs, cancel };
  };
  const ping = (withinMs: number): void => {
    session.heartbeat();
    armDeadline(withinMs);
  };
  const alive = (): void => {
    lastHeardAt = clock();
    forgiven = false;
    if (pongDeadline === undefined) return;
    pongDeadline.cancel();
    timers.delete(pongDeadline.cancel);
    pongDeadline = undefined;
  };
  const deadline = heartbeat(() => {
    session.carrierClosed(RELAY_CLOSE_CODES.heartbeatTimeout, 'the rendezvous did not open a session in time');
    socket.close(RELAY_CLOSE_CODES.heartbeatTimeout, 'no session');
  }, deadlineMs);
  timers.add(deadline);
  socket.onOpen = () => {
    opened = true;
    timers.add(heartbeat(() => ping(KEEPALIVE_DEADLINE_MS), KEEPALIVE_INTERVAL_MS));
    livenessChecks.set(session, ping);
  };
  socket.onText = text => {
    alive();
    session.receiveText(text);
  };
  socket.onBinary = bytes => {
    alive();
    void session.receiveBinary(bytes);
  };
  socket.onClose = (code, reason) => {
    stop();
    // Only a session still serving or streaming was dropped: one this browser closed, or whose stream
    // the daemon concluded, has already left both states.
    if (session.live() || session.streaming()) dropped(code, reason);
    session.carrierClosed(code, reason);
  };
  try {
    const value = await settled;
    if (!keepAlive) {
      stop();
      return value;
    }
    servingSince = clock();
    // The deadline covered getting here and nothing after it; the heartbeat covers
    // the rest. Leaving it armed would close a working session.
    deadline();
    timers.delete(deadline);
    return value;
  } catch (reason) {
    stop();
    if (!opened && typeof reason === 'object' && reason !== null) unopened.add(reason);
    throw reason;
  }
};

/**
 * The daemon's own session address as a socket URL — or `null` for a fingerprint no session can check.
 *
 * The same address `connectionSocketUrl` would build for a direct carrier, composed in the CALL above
 * so the route-agreement gate can see that this app dials the daemon's direct session route.
 */
const directSessionUrl = (daemon: DaemonConnection, address: URL): string | null => {
  if (parseDaemonId(daemon.daemonId) === null) return null;
  address.protocol = address.protocol === 'https:' ? 'wss:' : 'ws:';
  return address.toString();
};

export const openRelaySession = async ({
  dial,
  method,
  ...options
}: OpenRelaySessionOptions): Promise<RelayClientSession> => {
  // A tunnel is dialled exactly as a direct address is: the daemon's own listener behind Cloudflare
  // serves the same client route, and nothing else (§15 "The daemon end").
  const url =
    method.kind === 'direct'
      ? directSessionUrl(
          options.daemon,
          new URL(`/v1/rendezvous/${encodeURIComponent(options.daemon.daemonId)}/client`, method.daemonUrl),
        )
      : connectionSocketUrl(method, options.daemon.daemonId, 'client');
  if (url === null) {
    // `connectionSocketUrl` refuses a fingerprint a session cannot be checked against, and a carrier
    // with no address of its own. That is a refusal, not an address to improvise around.
    throw new RelaySessionError('this daemon fingerprint cannot address a session', RELAY_CLOSE_CODES.protocolError);
  }
  return await openSessionOnSocket({ ...options, socket: dial(url) });
};

/** {@link openRelaySession} once a carrier has produced its socket — the part every carrier shares. */
export const openSessionOnSocket = async ({
  crypto,
  socket,
  daemon,
  heartbeat = browserHeartbeat,
  mode,
  onData,
  deadlineMs,
  onDropped,
  clock,
}: Omit<OpenRelaySessionOptions, 'dial' | 'method'> & {
  readonly socket: CarrierSocket;
}): Promise<RelayClientSession> => {
  const session = new RelayClientSession({
    crypto,
    daemonId: daemon.daemonId,
    mode,
    socket,
    ...(onData === undefined ? {} : { onData }),
  });
  return await driveRelaySession({
    socket,
    session,
    heartbeat,
    settled: session.ready(),
    keepAlive: true,
    ...(deadlineMs === undefined ? {} : { deadlineMs }),
    ...(onDropped === undefined ? {} : { onDropped }),
    ...(clock === undefined ? {} : { clock }),
  });
};

/* ---------- the router every daemon-bound request goes through ------------- */

/**
 * The key this browser proves one daemon's grant with, or nothing when it is gone.
 *
 * A port rather than the IndexedDB store itself, so the router never knows where keys live and a suite
 * can hand it one. `undefined` is answered with {@link DeviceKeyMissingError}: there is nothing a
 * second carrier could do about a key that is not here.
 */
export type DeviceKeyResolver = (daemonId: DaemonId) => Promise<PrivateKeyHandle | undefined>;

/**
 * Said when a daemon answers its public liveness route but not the session this app speaks.
 *
 * Final, like a sealed refusal: every other carrier reaches the same old machine.
 */
export class DaemonOutdatedError extends Error {
  constructor() {
    super(OLDER_DAEMON_SENTENCE);
    this.name = 'DaemonOutdatedError';
  }
}

/**
 * The mirror image: the daemon speaks a NEWER dialect than this copy of the app.
 *
 * Telling that person to update their machine sends them to fix the one side that is already current,
 * so this is its own class with its own sentence — the app is what needs reloading.
 */
export class AppOutdatedError extends Error {
  constructor() {
    super(OLDER_APP_SENTENCE);
    this.name = 'AppOutdatedError';
  }
}

/**
 * Said when this machine no longer accepts this browser's device: it was revoked, or it went unused for
 * longer than the machine allows. One sentence a person can act on, on either carrier — never "could not
 * reach", because the machine answered and said no.
 */
export const DEVICE_NOT_ACCEPTED_SENTENCE =
  'This machine no longer accepts this browser — it was removed, or went unused for too long. Pair it again to keep using it.';

/**
 * The daemon refused this device (`4403`), on every carrier that answered.
 *
 * Final for this pairing: no carrier and no retry changes a refusal of the key itself, and re-pairing
 * is the only repair. The router remembers it, so the panels of an open page stop dialling a daemon
 * that will only refuse them again (see {@link DaemonCarrierRouter.deviceRefused}).
 */
export class DeviceNotAcceptedError extends Error {
  constructor() {
    super(DEVICE_NOT_ACCEPTED_SENTENCE);
    this.name = 'DeviceNotAcceptedError';
  }
}

/**
 * NO CARRIER CARRIED THIS REQUEST — a transport outage, not anything the daemon said.
 *
 * Its own class so a caller can tell the two apart: a screen keeps its last good content through
 * one of these (the connection model is already retrying), while an answer — any status — is news.
 * The message is the walk's own sentence, unchanged, and `outage` is what the walk observed.
 *
 * `delivery` IS WHAT A WRITE'S CALLER NEEDS, and the two values are not symmetric. `unsent` is a
 * PROOF: no session carrying this request ever opened, on any attempt under its request id, so nothing
 * of it reached a daemon and sending it again cannot double it. `unknown` is the absence of that
 * proof: a session died AFTER the request left, and the daemon may hold it — a resend under a NEW id
 * could apply it twice, so a caller leaves it to the send ledger, which retries only what it proves
 * absent, under the ORIGINAL id.
 */
export class CarrierUnavailableError extends Error {
  /**
   * `true` when nothing was dialled at all because the daemon is reconnecting and the connection
   * model's loop is the only thing allowed to dial (see `ConnectionHealthReporter.dialAllowed`). Not a
   * new measurement, so it is not reported as one.
   */
  readonly deferred: boolean;

  constructor(
    message: string,
    readonly outage: CarrierOutage,
    readonly delivery: CarrierDelivery,
    options?: { readonly cause?: unknown; readonly deferred?: boolean },
  ) {
    super(message, options);
    this.name = 'CarrierUnavailableError';
    this.deferred = options?.deferred === true;
  }
}

/** Said when a caller's request finds its daemon reconnecting and is not dialled. */
export const DIAL_DEFERRED_REASON =
  'this machine is reconnecting, so nothing was dialled for this request; the connection retries on its own schedule';

/** Thrown where a session would have been dialled, and turned into a deferred outage by the caller. */
class RelayDialDeferred extends Error {
  constructor() {
    super(DIAL_DEFERRED_REASON);
    this.name = 'RelayDialDeferred';
  }
}

/** Who a dial is for: any caller, held to the connection model's gate, or the model's own attempt. */
type DialPolicy = 'gated' | 'probe';

/** Whether a request no carrier carried could have reached the daemon. See {@link CarrierUnavailableError}. */
export type CarrierDelivery = 'unsent' | 'unknown';

/**
 * How many request ids whose fate is unknown are remembered. The typed client retries one request
 * under one id a few times within a second, so this needs to outlive a retry burst, not a page.
 */
const UNKNOWN_FATES_REMEMBERED = 256;

/**
 * Whether a failure — or anything it wraps — is a carrier outage.
 *
 * Read through `cause` because the typed client wraps whatever its transport threw (`FyTransportError`
 * keeps the router's error as its cause), and a screen holding the client's error is exactly the one
 * that must tell an outage from an answer. Bounded, because a cause chain is data, not a promise.
 */
export const isCarrierOutage = (reason: unknown): boolean => carrierDelivery(reason) !== undefined;

/**
 * For a carrier outage — however deeply wrapped — whether the request may have reached the daemon;
 * `undefined` for anything that is not an outage. A composer reads this to decide between "not sent,
 * send it again" (`unsent`, proven) and "checking whether it arrived" (`unknown`).
 */
export const carrierDelivery = (reason: unknown): CarrierDelivery | undefined => {
  let current = reason;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    if (current instanceof CarrierUnavailableError) return current.delivery;
    current = current.cause;
  }
  return undefined;
};

/**
 * True only when nothing of this request left the browser: no session that could carry it opened, on
 * any attempt under its request id. The one case a composer may say "not sent — send it again".
 */
export const provenUnsent = (reason: unknown): boolean => carrierDelivery(reason) === 'unsent';

/** One carrier a walk tried, and the failure it met. */
interface CarrierFailureSeen {
  readonly method: ConnectionMethod;
  readonly reason: unknown;
  /** The session had opened, so the request may have left this browser. */
  readonly sent: boolean;
}

/** Close codes only a hosted rendezvous sends: a relay you deploy yourself has no switch or ceilings. */
const HOSTED_ONLY_CODES: ReadonlySet<number> = new Set([
  RELAY_CLOSE_CODES.hostedDisabled,
  RELAY_CLOSE_CODES.hostedCapacity,
  RELAY_CLOSE_CODES.hostedBandwidth,
]);

/**
 * The carrier a failure happened on, as a person should read it. Which relay is the hosted one is
 * otherwise known only by comparing its address with the one this device discovered, and a device
 * that has not discovered it (yet, or at all) would call Ferretry's relay "your own". A hosted-only
 * refusal is the relay saying what it is, so that answer wins.
 */
const failureMethod = (failure: CarrierFailureSeen): ConnectionMethod =>
  failure.method.kind === 'relay' &&
  failure.reason instanceof RelaySessionError &&
  HOSTED_ONLY_CODES.has(failure.reason.code)
    ? { ...failure.method, operator: 'hosted' }
    : failure.method;

/** What a walk observed, in the terms the connection model reads. */
const carrierOutage = (seen: readonly CarrierFailureSeen[]): CarrierOutage => {
  const relays = seen.filter(failure => failure.method.kind === 'relay');
  return {
    failures: seen.map(failure => ({
      label: describeConnectionMethod(failureMethod(failure)).label,
      detail: transportFailure(failure.reason),
    })),
    daemonAbsent: seen.some(
      failure => failure.reason instanceof RelaySessionError && failure.reason.code === RELAY_CLOSE_CODES.daemonAbsent,
    ),
    relaysNeverOpened: relays.length > 0 && relays.every(failure => socketNeverOpened(failure.reason)),
  };
};

/** A session the daemon closed with `4403`: this device is not accepted. */
const deviceRefusal = (reason: unknown): boolean =>
  reason instanceof RelaySessionError && reason.code === RELAY_CLOSE_CODES.authRejected;

/** Which end of a conversation is the older one. */
export type OutdatedSide = 'daemon' | 'app';

/** The error that tells a person to update the side that is actually old. */
export const outdatedError = (side: OutdatedSide): DaemonOutdatedError | AppOutdatedError =>
  side === 'app' ? new AppOutdatedError() : new DaemonOutdatedError();

/**
 * A session that ended because the two ends speak different dialects, and which end is old.
 *
 * The daemon's hello named `/1`, or it refused this one's in the words a `/1` daemon uses: the daemon is
 * old. It refused this hello in `OLDER_APP_SENTENCE`: the app is (`relay-session.ts` turns each into its
 * sentence). Anything else is `undefined`.
 */
export const outdatedRefusal = (reason: unknown): OutdatedSide | undefined => {
  if (!(reason instanceof RelaySessionError) || reason.code !== RELAY_CLOSE_CODES.versionUnsupported) return undefined;
  if (reason.message === OLDER_DAEMON_SENTENCE) return 'daemon';
  return reason.message === OLDER_APP_SENTENCE ? 'app' : undefined;
};

/** The dialect number in `ferretry-relay/<n>`, or `undefined` for anything else. */
const dialectNumber = (protocol: unknown): number | undefined => {
  if (typeof protocol !== 'string') return undefined;
  const match = /^ferretry-relay\/(\d+)$/u.exec(protocol);
  return match === null ? undefined : Number(match[1]);
};

/**
 * After a direct socket failed: is that a daemon on ANOTHER dialect rather than an absent one — and
 * which side is older?
 *
 * A browser cannot read why a WebSocket was refused, and a daemon on another dialect refuses the session
 * path the way any unknown route is refused. Its public liveness route still answers, though, and names
 * the dialect it speaks — which is a sentence a person can act on, where "could not connect" is not.
 *
 * THE DIRECTION IS READ, NEVER ASSUMED. A daemon naming a HIGHER dialect than this app is a machine
 * that was updated before the app was, and telling its owner to update the machine is the one advice
 * that cannot help. A lower number — or none at all, which is how a daemon from before the field
 * answers — is an old daemon. Anything else — no answer, a body that does not parse, the same dialect —
 * is `undefined`, because neither side is provably old.
 */
export const outdatedSide = async (network: DaemonFetch, daemonUrl: string): Promise<OutdatedSide | undefined> => {
  let body: unknown;
  try {
    // BOUNDED: the walk awaits this before trying the next carrier, and on a network that drops packets
    // to a private address an unbounded fetch held this machine's relay fallback for a TCP timeout.
    const response = await network(new URL('/healthz', `${daemonUrl}/`).toString(), {
      cache: 'no-store',
      credentials: 'omit',
      signal: AbortSignal.timeout(DIRECT_SESSION_DEADLINE_MS),
    });
    if (!response.ok) return undefined;
    body = await response.json();
  } catch {
    return undefined;
  }
  const answer = body as { readonly status?: unknown; readonly sessionProtocol?: unknown } | null;
  if (answer?.status !== 'ok' || answer.sessionProtocol === SESSION_PROTOCOL_ID) return undefined;
  const theirs = dialectNumber(answer.sessionProtocol);
  const ours = dialectNumber(SESSION_PROTOCOL_ID) ?? 0;
  return theirs !== undefined && theirs > ours ? 'app' : 'daemon';
};

export interface DaemonCarrierRouterOptions {
  /**
   * The real network — for the one liveness read that tells an old daemon from an absent one, and
   * for anything not bound to a daemon. NO daemon request goes over it: every one rides a session.
   */
  readonly network?: DaemonFetch;
  /** The device key for a daemon, read when a session opens. See {@link DeviceKeyResolver}. */
  readonly deviceKey: DeviceKeyResolver;
  /**
   * This running copy of the app, signed into every session's proof. Random per page load by default;
   * a step-up the daemon grants belongs to one of these and ends when the page does.
   */
  readonly appSession?: string;
  readonly crypto: RelayClientSessionDependencies['crypto'];
  readonly dial?: RelayDial;
  readonly heartbeat?: RelayHeartbeatSchedule;
  /**
   * Device-key rotation (`docs/design/zero-trust.md` B6). When present, a step-up sent once the daemon's
   * `rotateBy` has passed carries a replacement key signed against the session that carries it, and a
   * session the old key is refused on is tried once with the pending key. Absent means a router that
   * never rotates — which is every router built before this existed.
   */
  readonly rotation?: KeyRotation;
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
  /**
   * THIS BROWSER'S CONNECTION PREFERENCE FOR ONE MACHINE (§15 "The choice"), read at the start of every
   * walk. Absent is Relay (the default) for every machine. A change must be followed by {@link DaemonCarrierRouter.rewalk},
   * which forgets the winner the old preference chose.
   */
  readonly preference?: (daemonId: DaemonId) => CarrierPreference;
  /** Carriers that need more than a URL to dial. See {@link CarrierDialers}. */
  readonly dialers?: CarrierDialers;
  /**
   * The hosted tunnel service's one advertisement read, awaited ONLY when "Tunnel only" finds no tunnel
   * to dial, to say why. Absent is a build with no service: "not set up by the operator".
   */
  readonly tunnelService?: () => Promise<TunnelServiceState>;
  /**
   * Told the carrier set a TUNNEL LOOKUP read (§15, "Tunnel only"): what the daemon published, asked over
   * an introducer because no tunnel this browser knew could carry the question. The composition root
   * keeps it exactly as it keeps an ordinary refresh's. Absent keeps nothing, which costs only the next
   * walk a lookup of its own.
   */
  readonly learned?: (daemon: DaemonConnection, carriers: readonly ConnectionMethod[]) => void;
  /**
   * Where a held session this router opened is reported when it DROPS, and where the next session to
   * the same machine says it reconnected (`carrier-drops.ts`). Diagnostics only: nothing here decides.
   */
  readonly drops?: Pick<CarrierDropLog, 'dropped' | 'reconnected'>;
  /** The clock {@link TUNNEL_LOOKUP_REUSE_MS} is measured on. */
  readonly now?: () => number;
  /**
   * Whether the machine itself said its tunnel is switched off (`GET /v1/tunnel`, §15) — the reason
   * "Tunnel only" names before the service's, because it is the one a person can act on. Absent: nobody
   * has asked, and the service's reason stands.
   */
  readonly tunnelSwitchedOff?: (daemonId: DaemonId) => boolean;
  /**
   * Asked when the daemon refuses a request for want of a passkey step-up (`grant_step_up_required`):
   * `true` once the person has confirmed, and the request is then sent again ONCE. Absent means
   * nothing can ask, and the refusal is returned as it came. `origin` says whether a person started the
   * request: a read (`GET`, `HEAD`) is the page's own background work, anything else is a press.
   */
  readonly stepUp?: (daemon: DaemonConnection, act?: string, origin?: PromptOrigin) => Promise<boolean>;
  /**
   * Asked when the daemon answers `401 unlock_required`: this machine wants a passkey on opening and
   * this device has not given one. `true` once the person has confirmed, and the request is then sent
   * again ONCE. Absent means nothing can ask, and the refusal is returned as it came. `origin` as for
   * {@link stepUp}.
   */
  readonly unlockRequired?: (daemon: DaemonConnection, origin?: PromptOrigin) => Promise<boolean>;
  /**
   * Whether a person is at this device right now (`presence.ts`). A request sent while they are is
   * marked, and only marked requests keep the device from idling out on the daemon. Absent means
   * nobody can tell, and nothing is marked.
   */
  readonly presence?: () => boolean;
  /**
   * Told the outcome of every request and stream open: answered, no carrier, or a final refusal.
   * Absent means nobody is keeping score, which is every router built before it existed.
   */
  readonly health?: ConnectionHealthReporter;
  /**
   * How many request ids in doubt are remembered — {@link UNKNOWN_FATES_REMEMBERED} by default. It is a
   * parameter for the same reason a session's `maxRequestId` is: every id put in doubt costs a session
   * that died under it, and proving the oldest is forgotten at the real bound took hundreds of handshakes.
   */
  readonly unknownFatesRemembered?: number;
}

/**
 * One live rendezvous session this router is holding, and which rendezvous it is on.
 *
 * THE RENDEZVOUS IS STORED BESIDE THE SESSION RATHER THAN BEING THE KEY, and that is the change one
 * session per stream forced. There used to be exactly one session per rendezvous, so the address was
 * a sufficient key; §14 now has a tab hold a request session, an event stream and a terminal stream
 * on the SAME rendezvous at once, so the key has to distinguish jobs while the teardown rules still
 * ask about the address.
 */
interface CarrierSession {
  /** The carrier this session is on: a rendezvous URL, or the daemon's own direct address. */
  readonly address: string;
  readonly session: Promise<RelayClientSession>;
}

/** Where one carrier lives, as the key its sessions are held under. */
const carrierAddress = (method: ConnectionMethod): string => {
  if (method.kind === 'direct') return `direct ${method.daemonUrl}`;
  if (method.kind === 'webrtc') return 'webrtc';
  if (method.kind === 'tunnel') return `tunnel ${method.tunnelUrl}`;
  return method.relayUrl;
};

/**
 * A winner the daemon's republished set can never name, and so is not withdrawn by omitting it.
 *
 * A direct address the daemon cannot express on the wire (see `#refreshed`), and WebRTC, which no
 * daemon publishes at all — dropping it on every `/v1/carriers` refresh would tear down the very
 * channel that just carried the refresh.
 */
const outlivesRepublish = (method: ConnectionMethod): boolean => method.kind === 'direct' || method.kind === 'webrtc';

/** WebRTC has no address; this is the one value of its kind. */
const WEBRTC: ConnectionMethod = { kind: 'webrtc' };

/** The carriers that may introduce two ends for WebRTC: everything addressed except a tunnel. */
const introducer = (method: ConnectionMethod): boolean => method.kind === 'direct' || method.kind === 'relay';

/**
 * How long one tunnel lookup's answer stands before a walk may ask again.
 *
 * Every panel of an open page walks on its own, and under "Tunnel only" with the tunnel down each of
 * those walks would otherwise send its own question over the relay. One answer per half minute is
 * enough to notice a re-provisioned hostname and few enough that an outage costs the relay nothing.
 */
export const TUNNEL_LOOKUP_REUSE_MS = 30_000;

/** The deadline on one lookup, so a walk waiting on it is never held by a question nobody answers. */
export const TUNNEL_LOOKUP_TIMEOUT_MS = 10_000;

/** Said when a carrier-control request has neither a direct address nor a relay to travel. */
export const CONTROL_UNREACHABLE =
  'neither this machine’s own address nor a relay reaches it, so its tunnel can only be switched at the machine';

/** One tunnel lookup: when it was asked, and what it found — a tunnel, or nothing. */
interface TunnelLookup {
  readonly at: number;
  readonly answer: Promise<TunnelCarrier | undefined>;
}

/**
 * One thing a walk may do next: try a carrier, or state why one was passed over without being tried.
 */
interface WalkCandidate {
  readonly method: ConnectionMethod;
  /** Set when this carrier is passed over untried; the sentence is why. */
  readonly untried?: string;
}

/**
 * One walk's preference, and — when the preference leaves nothing to try — why, in a sentence that
 * names the preference. `why` is written by `#candidates` as it discovers it.
 */
interface WalkPlan {
  readonly preference: CarrierPreference;
  why?: string;
}

interface CarrierEntry {
  readonly connection: DaemonConnection;
  /**
   * Aborted when this entry is abandoned for good — unpaired, re-paired, or re-walked under a new
   * preference — so a dial still negotiating (WebRTC) stops. A carrier refresh carries it across,
   * because it carries the sessions across too.
   */
  readonly retired: AbortController;
  choice: ConnectionChoice | undefined;
  /**
   * The daemon refused this device (`4403`). Sticky for this pairing: a re-pair or an unpair replaces
   * the entry, which is the only thing that clears it, and a reload asks the daemon again.
   */
  refused: boolean;
  /** The last tunnel lookup for this daemon, reused for {@link TUNNEL_LOOKUP_REUSE_MS}. */
  tunnelLookup: TunnelLookup | undefined;
  /**
   * EVERY SESSION THIS ROUTER HOLDS FOR THIS DAEMON — request, stream, all of them.
   *
   * §14 makes this a conformance rule rather than a housekeeping preference: "every session a client
   * holds for a daemon — request, stream or pairing — must be owned by the same structure that
   * unpairing and carrier-set replacement tear down. A stream session outside that structure is a
   * live socket presenting a device grant that revoking the pairing can no longer reach from the
   * device's side."
   *
   * So a stream session is registered HERE and nowhere else. `clearDaemon` and `#refreshed` walk this
   * map, and a session they cannot see is one an unpair can never close.
   */
  readonly sessions: Map<string, CarrierSession>;
}

/**
 * One stream to open: the daemon's own route, exactly as a direct upgrade would address it.
 *
 * NO TICKET, AND THAT IS A REFUSAL RATHER THAN AN OMISSION. §14: "Single-use socket tickets exist
 * because a browser cannot attach a header to a WebSocket; here the credential is the record, so
 * there is nothing for a ticket to do. `ticket` or `token` in a stream's `query` is refused with
 * `4400` … A client must also not BUY a ticket it means to spend here." So a caller decides not to
 * mint one before it calls this, not after.
 */
export interface RelayStreamRequest {
  readonly path: string;
  readonly query?: readonly (readonly [string, string])[];
  readonly onData: (frame: RelayStreamFrame) => void;
}

/** The request session's key. One per rendezvous, because §14 gives a request session no identity. */
const requestSessionKey = (address: string): string => `request ${address}`;

/**
 * Which request session carries a request: `bulk` for a body that has to travel in parts, `request`
 * for everything else.
 *
 * A SESSION IS ONE CREDIT WINDOW AND ONE QUEUE, so a request waits behind every record queued ahead of
 * it. A phone photo is about eighty records; a few of them queued ahead of the fleet list's poll held
 * it past its deadline, and a request that misses its deadline retires the session it was on — the
 * one carrying the uploads. Bodies that need parts therefore share a session of their own, and the
 * reads every panel polls never wait behind one.
 */
export type RequestLane = 'request' | 'bulk';

export const requestLane = (body: string | undefined): RequestLane =>
  body !== undefined && body.length > MAX_PLAINTEXT_BYTES / 2 ? 'bulk' : 'request';

const laneSessionKey = (lane: RequestLane, address: string): string =>
  lane === 'request' ? requestSessionKey(address) : `bulk ${address}`;

/**
 * A stream session's key: one per CALL, because §14 gives each stream its own session.
 *
 * The ordinal is what stops two callers of the same route sharing one session — `openStream` names
 * the three silent failures sharing produces. The address, path and query stay in the key so a
 * reader of this map can still see what a session is for.
 */
const streamSessionKey = (
  address: string,
  path: string,
  query: readonly (readonly [string, string])[],
  ordinal: number,
): string => `stream ${String(ordinal)} ${address} ${path} ${query.map(pair => pair.join('=')).join('&')}`;

/**
 * Same daemon, same address, same grant — only the published carrier set moved.
 *
 * Deliberately NOT `sameDaemonConnection` with the carriers excused: that function is
 * the liveness fence and stays whole. This is the narrower question asked only after
 * it has already said no, and it separates the one difference a live session can
 * survive from every difference it may not.
 */
const carrierRefreshOnly = (left: DaemonConnection, right: DaemonConnection): boolean =>
  left.daemonId === right.daemonId && left.baseUrl === right.baseUrl && left.deviceId === right.deviceId;

/**
 * Said to a session that finished opening after the entry it was dialled for was replaced.
 *
 * It names all three causes because the dial cannot tell them apart from where it stands, and a
 * sentence that guessed one would be wrong two thirds of the time.
 */
const STALE_SESSION_REASON =
  'this daemon was re-paired, unpaired or republished while this rendezvous session was opening';

/**
 * Said to the CALLER when a walk is refused, which is a different moment and a wider one.
 *
 * The check that produces it runs before every attempt, so it fires with no rendezvous session in
 * sight — a direct attempt that was still pending, or a pairing cleared before the first candidate was
 * even tried. Naming a session there would describe something that does not exist; what is true in
 * every case is that the request was in flight and is not being carried any further.
 */
const STALE_WALK_REASON =
  'this daemon was re-paired, unpaired or republished, or its connection preference changed, while this request was in flight, so it was not carried to another carrier';

/** Said to every session a preference change ends. */
const PREFERENCE_CHANGED_REASON = 'the connection preference for this machine changed';

/**
 * MARKS THE ONE FAILURE THAT ENDS A WALK WITHOUT SAYING ANYTHING ABOUT AN ADDRESS.
 *
 * A transport failure is a fact about a carrier and is the reason to try the next one. This is a fact
 * about the WALK: the pairing it was issued against has been cleared or replaced, so the connection it
 * is holding — a device grant that may already be revoked, a base URL that may have moved, a carrier
 * set the daemon has since corrected — is not one this browser may dial anything with.
 *
 * It is a distinct class rather than a plain `Error` precisely so it cannot be mistaken for one: as a
 * plain error it was caught as a transport failure, and a replay-safe request went on to dial every
 * remaining relay, and then the hosted fallback, on behalf of a pairing that no longer existed.
 */
class RelayStaleEntryError extends Error {
  constructor(message = STALE_WALK_REASON) {
    super(message);
    this.name = 'RelayStaleEntryError';
  }
}

/**
 * Whether a failure on a carrier is about the CARRIER — and so an outage a retry may cure.
 *
 * A stale walk and an unreadable device key are facts about this browser's pairing, and the daemon's
 * refusal of a stream is an answer; none of them is a carrier that stopped carrying.
 */
const transportLike = (reason: unknown): boolean =>
  !(
    reason instanceof RelayStaleEntryError ||
    reason instanceof DeviceKeyMissingError ||
    reason instanceof DeviceKeyUnreadableError ||
    reason instanceof RelayStreamRefusedError ||
    (reason instanceof RelaySessionError && reason.code === RELAY_CLOSE_CODES.rendezvousBusy)
  );

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

/** An abort that is a deadline passing (`AbortSignal.timeout`), as opposed to a caller cancelling. */
const isTimeoutReason = (reason: unknown): boolean => reason instanceof Error && reason.name === 'TimeoutError';

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
  readonly #drops: Pick<CarrierDropLog, 'dropped' | 'reconnected'> | undefined;
  readonly #hostedRelay: () => Promise<string | undefined>;
  readonly #preference: (daemonId: DaemonId) => CarrierPreference;
  readonly #dialers: CarrierDialers;
  readonly #tunnelService: () => Promise<TunnelServiceState>;
  readonly #learned: (daemon: DaemonConnection, carriers: readonly ConnectionMethod[]) => void;
  readonly #now: () => number;
  readonly #tunnelSwitchedOff: (daemonId: DaemonId) => boolean;
  readonly #deviceKey: DeviceKeyResolver;
  readonly #appSession: string;
  readonly #stepUp: DaemonCarrierRouterOptions['stepUp'];
  readonly #unlockRequired: DaemonCarrierRouterOptions['unlockRequired'];
  readonly #presence: () => boolean;
  readonly #rotation: KeyRotation | undefined;
  readonly #health: ConnectionHealthReporter | undefined;
  /** Request ids a session died under after they left — see {@link CarrierUnavailableError}'s `delivery`. */
  readonly #unknownFates = new Set<string>();
  readonly #unknownFatesRemembered: number;
  /** Per-call ordinal for stream session keys. Never reused, so no two streams can collide. */
  #streams = 0;
  #paired: () => readonly DaemonConnection[] = () => [];

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
    this.#drops = options.drops;
    // No provider is direct-only, which is what a build with no relay directory honestly is.
    this.#hostedRelay = options.hostedRelay ?? (async () => undefined);
    this.#preference = options.preference ?? (() => DEFAULT_CARRIER_PREFERENCE);
    this.#dialers = options.dialers ?? {};
    this.#tunnelService = options.tunnelService ?? (async () => 'unavailable');
    this.#learned = options.learned ?? (() => undefined);
    this.#now = options.now ?? Date.now;
    this.#tunnelSwitchedOff = options.tunnelSwitchedOff ?? (() => false);
    this.#deviceKey = options.deviceKey;
    this.#appSession = options.appSession ?? toBase64Url(options.crypto.randomBytes(APP_SESSION_BYTES));
    this.#stepUp = options.stepUp;
    this.#unlockRequired = options.unlockRequired;
    this.#presence = options.presence ?? (() => false);
    this.#rotation = options.rotation;
    this.#health = options.health;
    this.#unknownFatesRemembered = options.unknownFatesRemembered ?? UNKNOWN_FATES_REMEMBERED;
  }

  /**
   * Who is paired, read at call time so a request can be routed to the daemon that owns it.
   *
   * Supplied by the composition root from the pairing registry, because the router
   * must not hold its own copy of who is paired: a second copy is how a request
   * keeps going to a daemon that has been unpaired.
   */
  resolvePaired(paired: () => readonly DaemonConnection[]): void {
    this.#paired = paired;
  }

  /**
   * The paired daemon a request is for — BY ITS IDENTITY, never by its address alone.
   *
   * An origin names an address and two machines can share one: every daemon paired over the hosted
   * relay announces its own loopback address. Resolving by origin alone picked whichever pairing
   * was listed first — the newest — so every request for an older machine went to the newest one, and
   * every screen showed both machines as the one added last. A request built by `daemonRequest` names
   * its daemon (`boundDaemonId`), and that name decides.
   *
   * A bound request whose daemon is not paired at that address is no pairing's request: it goes to the
   * plain network as any unpaired address always has — no session, so no grant is presented — and never
   * to another pairing that happens to share the address. An UNBOUND request is routed by origin only
   * while one pairing owns it; when several do, it is refused — guessing is how one machine's answers
   * came to be shown under another's name.
   */
  #owner(origin: string, init: RequestInit | undefined): DaemonConnection | undefined {
    const sharing = this.#paired().filter(daemon => daemon.baseUrl === origin);
    const bound = boundDaemonId(init);
    if (bound !== undefined) return sharing.find(daemon => daemon.daemonId === bound);
    if (sharing.length > 1)
      throw new Error(
        `${String(sharing.length)} paired machines share ${origin}, and this request does not say which one it is for`,
      );
    return sharing[0];
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

  /**
   * Whether this daemon refused this browser's device. A screen reads it to say "pair again" once,
   * instead of every panel saying it could not reach a machine that answered.
   */
  deviceRefused(daemonId: DaemonId): boolean {
    return this.#entries.get(daemonId)?.refused === true;
  }

  /**
   * The carrier a request has been MEASURED on, or nothing.
   *
   * `undefined` covers both "no walk has finished yet" and "the last walk found nothing", and the
   * two are deliberately one answer here: a caller asking which kind of stream to open has no use
   * for a carrier that did not carry anything. Read per call rather than captured, because a carrier
   * is a measurement and the answer when a stream reconnects is not the answer when it first opened.
   */
  activeMethod(daemonId: DaemonId): ConnectionMethod | undefined {
    const chosen = this.#entries.get(daemonId)?.choice;
    return chosen?.ok === true ? chosen.method : undefined;
  }

  /**
   * ONE LIVE STREAM, ON WHICHEVER CARRIER REACHES THIS DAEMON.
   *
   * §14 gives a stream its own session — "the socket IS the session, so the session layer already
   * owns the stream's ordering, its flow control, its teardown and its cancellation" — and the
   * alternative it names as rejected is the one this method must not quietly reintroduce: multiplexed
   * onto the request session, thirty-two outstanding terminal frames would starve and then KILL the
   * fleet requests underneath them.
   *
   * IT IS THE ONLY WAY A DEVICE OPENS A STREAM NOW, on either carrier. A direct carrier used to be a
   * plain WebSocket bought with a ticket; a paired device has no ticket to buy any more, so a direct
   * stream is a stream session on the daemon's own address. When a request has already measured a
   * carrier this opens on it; when none has, it walks the set exactly as a request does — direct
   * first, then each rendezvous — because opening a stream changes nothing on the daemon until it is
   * accepted, so trying the next carrier after a transport failure is safe.
   *
   * A REFUSAL IS NOT A CARRIER TO REPLACE. The daemon's own `stream-refused` is an answer, and §14
   * requires the rendezvous's session-ceiling refusal to be "rendered with its reason … rather than
   * surfacing as a stream that never opens", so both are thrown intact for the caller to say out loud.
   *
   * A STREAM SESSION IS NEVER SHARED BETWEEN TWO CALLERS, and that is the protocol's rule rather than
   * a convenience. `RelayClientSession` takes ONE `onData` at construction, so a second caller would
   * receive no frames at all, and either caller's `closeStream` would conclude the session for BOTH.
   * So every call opens its own session and the key carries a per-call ordinal to say so. The REQUEST
   * session is still shared, because it genuinely has no per-caller state: its answers are routed by
   * the `id` the caller minted, so two callers on one request session cannot receive each other's.
   */
  async openStream(daemon: DaemonConnection, request: RelayStreamRequest): Promise<RelayClientSession> {
    try {
      const session = await this.#openStream(daemon, request);
      this.#health?.answered(daemon.daemonId);
      return session;
    } catch (reason) {
      // The daemon's own refusal of a stream is an answer: it is reachable and said no.
      if (reason instanceof RelayStreamRefusedError) this.#health?.answered(daemon.daemonId);
      else this.#reportFailure(daemon.daemonId, reason);
      throw reason;
    }
  }

  async #openStream(daemon: DaemonConnection, request: RelayStreamRequest): Promise<RelayClientSession> {
    const entry = this.#entry(daemon);
    if (entry.refused) throw new DeviceNotAcceptedError();
    const chosen = entry.choice;
    if (chosen?.ok === true) {
      try {
        return await this.#streamOn(entry, chosen.method, request);
      } catch (reason) {
        if (reason instanceof RelayDialDeferred) throw this.#deferred(null);
        if (deviceRefusal(reason)) throw this.#refuse(entry);
        if (!transportLike(reason)) throw reason;
        // Said as an outage so the connection model retries, and left as the remembered winner: the
        // next REQUEST is what walks again, and streams follow whatever it measures.
        throw this.#unavailable(entry, [{ method: chosen.method, reason, sent: false }], null, reason);
      }
    }
    const probes: ConnectionProbe[] = [];
    const seen: CarrierFailureSeen[] = [];
    let outdated: OutdatedSide | undefined;
    let refused = false;
    const plan = this.#plan(daemon);
    for await (const { method, untried } of this.#candidates(entry, plan)) {
      this.#assertCurrent(entry);
      if (untried !== undefined) {
        probes.push(untriedProbe(method, untried));
        continue;
      }
      try {
        const session = await this.#streamOn(entry, method, request);
        this.#decide(entry, [...probes, carrierProbe(method, { kind: 'answered', status: 101 })], plan);
        return session;
      } catch (reason) {
        if (reason instanceof RelayDialDeferred) throw this.#deferred(null);
        if (
          reason instanceof RelayStaleEntryError ||
          reason instanceof DeviceKeyMissingError ||
          reason instanceof DeviceKeyUnreadableError ||
          reason instanceof RelayStreamRefusedError ||
          (reason instanceof RelaySessionError && reason.code === RELAY_CLOSE_CODES.rendezvousBusy)
        )
          throw reason;
        probes.push(carrierProbe(method, { kind: 'transport-failure', detail: transportFailure(reason) }));
        // A stream open carries no request a daemon could apply twice, so it is never "sent".
        seen.push({ method, reason, sent: false });
        refused ||= deviceRefusal(reason);
        outdated ??= await this.#looksOutdated(method, reason);
      }
    }
    this.#decide(entry, probes, plan);
    if (refused) throw this.#refuse(entry);
    if (outdated !== undefined) throw outdatedError(outdated);
    throw this.#unavailable(entry, seen, null);
  }

  /**
   * PROVE EVERY HELD SESSION IS ALIVE, NOW: a ping on each, and a short deadline.
   *
   * For the moments the browser says the network may have changed under it — back online, back in
   * the foreground, a different network. A phone that wakes holding a socket the far end evicted
   * minutes ago would otherwise find out only at its next regular ping, up to half a minute later;
   * this makes it a few seconds, and a dead session ends the way any other dead session does.
   */
  checkLiveness(): void {
    for (const entry of this.#entries.values()) {
      for (const held of entry.sessions.values()) {
        void held.session.then(
          session => checkSessionLiveness(session),
          () => undefined,
        );
      }
    }
  }

  /** Unpair and re-pair invalidation: a carrier is live state, never durable. */
  clearDaemon(daemonId: DaemonId): void {
    const entry = this.#entries.get(daemonId);
    if (entry === undefined) return;
    this.#entries.delete(daemonId);
    this.#retire(entry, 'this daemon was re-paired or unpaired');
    this.#announce();
  }

  /**
   * THE CONNECTION PREFERENCE FOR THIS MACHINE CHANGED: forget the winner and walk again.
   *
   * The remembered winner was chosen under the old preference, and keeping it would go on carrying
   * traffic over a carrier the person may just have excluded — so the entry is REPLACED rather than
   * edited. Every session on it is closed, saying why, which ends any stream on it so its owner reopens
   * on the new walk; a walk still in flight finds its entry gone and stops rather than deciding a
   * winner under the old preference. The pairing itself — and a device refusal, which no preference
   * changes — is kept. Nothing is dialled here: the next request, or the caller's probe, walks.
   */
  rewalk(daemonId: DaemonId): void {
    const entry = this.#entries.get(daemonId);
    if (entry === undefined) return;
    this.#entries.set(daemonId, {
      connection: entry.connection,
      retired: new AbortController(),
      choice: undefined,
      refused: entry.refused,
      // A new preference asks afresh: a lookup made under the old one may have been skipped or stale.
      tunnelLookup: undefined,
      sessions: new Map(),
    });
    this.#retire(entry, PREFERENCE_CHANGED_REASON);
    this.#announce();
  }

  /** Ends everything an abandoned entry holds, and any dial it still has negotiating. */
  #retire(entry: CarrierEntry, reason: string): void {
    entry.retired.abort(new Error(reason));
    for (const held of entry.sessions.values()) {
      void held.session.then(
        connected => connected.close(reason),
        () => undefined,
      );
    }
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
    if (input instanceof Request) return await this.#network(input, init);
    const daemon = this.#owner(origin, init);
    if (daemon === undefined) return await this.#network(input, init);
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
   * A REMEMBERED WINNER THAT STOPS CARRYING IS FORGOTTEN, and what happens next depends
   * on whether asking twice is safe. A READ (`GET`, `HEAD`) walks the set again inside
   * the same call: it changes nothing on the daemon, and a relay redeployed under a
   * live page is exactly the failure a second walk cures. A WRITE is reported and not
   * replayed: the walk cannot know whether the daemon received the attempt that just
   * died — §9 says frames in flight are gone, and a transport failure on a direct
   * carrier says nothing at all about whether the daemon applied the request — and
   * re-sending it would turn one `POST /v1/sessions` into two sessions on a daemon
   * that took the first. Retrying a write is the caller's decision (the send ledger
   * proves where a send went), exactly as it is for a relayed request whose session
   * went away mid-flight.
   *
   * NOTHING CARRYING IS A {@link CarrierUnavailableError}, never a plain `Error`, so a
   * caller can tell a transport outage from a daemon answer, and every outcome is told to
   * the connection model (`health`), which is what retries an outage on its own.
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
    return await this.#confirmed(daemon, init, async () => await this.#sendOnce(daemon, url, init));
  }

  /**
   * A CARRIER-CONTROL REQUEST — `GET` or `PUT /v1/tunnel` (§15) — over the carriers that introduce,
   * whatever this device's preference is, and never over the tunnel or WebRTC.
   *
   * Two reasons, both structural. Under "Tunnel only" with the tunnel switched off there is nothing the
   * preference allows that could carry the request to switch it ON — the person would be asked to turn
   * on a tunnel over the tunnel they are turning on. And switching it OFF over itself would end the
   * connection carrying the answer. So these ride the daemon's direct address or a rendezvous, exactly as
   * WebRTC signalling and the tunnel lookup do: one request about how this device reaches the machine,
   * inside a device-authenticated session, never the person's own work. It decides nothing — no winner
   * is remembered — and a passkey it needs is asked for as any press's is.
   */
  async control(daemon: DaemonConnection, url: string, init: RequestInit = {}): Promise<Response> {
    return await this.#confirmed(daemon, init, async () => {
      const entry = this.#entry(daemon);
      if (entry.refused) throw new DeviceNotAcceptedError();
      const target = new URL(url);
      return await this.#introduce(
        entry,
        await this.#introducers(entry),
        `${target.pathname}${target.search}`,
        init,
        CONTROL_UNREACHABLE,
      );
    });
  }

  /**
   * One request, asked again once after the person gives the passkey the daemon wanted — an unlock on
   * opening, then a step-up for the act. `once` is the whole attempt, so a resend travels as the first did.
   */
  async #confirmed(daemon: DaemonConnection, init: RequestInit, once: () => Promise<Response>): Promise<Response> {
    let response = await once();
    // A READ IS THE PAGE'S OWN WORK, so a passkey it needs waits for its machine to be on screen; anything
    // else is a press, and asks at once.
    const origin = requestOrigin(init);
    // PRESENCE COMES FIRST: while this machine wants a passkey on opening it answers every request `401
    // unlock_required`, so nothing else it says can be read yet. One prompt, one resend; a dismissed
    // prompt returns the refusal unchanged, and a second refusal is the answer.
    const confirmUnlock = this.#unlockRequired;
    if (
      confirmUnlock !== undefined &&
      response.status === 401 &&
      (await answersWithCode(response, UNLOCK_REQUIRED_CODE))
    ) {
      // The wait honours the caller's own signal: a background read for a machine that is not on screen
      // waits for it to be opened, and a caller that stopped waiting (its deadline, an unmount) must get
      // its refusal back rather than stay parked behind an unlock nobody is going to give.
      if (!(await untilAborted(confirmUnlock(daemon, origin), init.signal, false))) return response;
      response = await once();
    }
    // A PASSKEY STEP-UP IS A PAUSE, NOT A FAILURE. The daemon allowed the act and wants its owner to
    // confirm; once they have, the same request is sent again exactly once — its body is text, so it
    // can be — and a dismissed prompt returns the refusal unchanged for the caller to say.
    const ask = this.#stepUp;
    if (ask === undefined || response.status !== 403) return response;
    const demand = await stepUpDemand(response);
    if (demand === undefined) return response;
    // The act the daemon NAMED, or nothing: an unparseable demand still asks, and the prompt says "this change".
    const act = demand === null ? undefined : stepUpAct(demand);
    if (!(await ask(daemon, act, origin))) return response;
    return await once();
  }

  /**
   * THE CONNECTION MODEL'S OWN ATTEMPT: one request that may dial while the daemon is reconnecting.
   *
   * Everything else waits for it — see {@link CarrierUnavailableError.deferred}. It asks no passkey
   * prompt of anybody, because nobody pressed anything: a `401`/`403` is simply an answer.
   */
  async probe(daemon: DaemonConnection, url: string, init: RequestInit = {}): Promise<Response> {
    return await this.#sendOnce(daemon, url, init, 'probe');
  }

  async #sendOnce(
    daemon: DaemonConnection,
    url: string,
    init: RequestInit,
    dial: DialPolicy = 'gated',
  ): Promise<Response> {
    try {
      const response = await this.#walk(daemon, url, init, dial);
      this.#health?.answered(daemon.daemonId);
      return response;
    } catch (reason) {
      this.#reportFailure(daemon.daemonId, reason);
      throw reason;
    }
  }

  /** Tells the connection model what a failure was: an outage, a final refusal, or neither. */
  #reportFailure(daemonId: DaemonId, reason: unknown): void {
    if (reason instanceof CarrierUnavailableError) {
      if (!reason.deferred) this.#health?.outage(daemonId, reason.outage);
      return;
    }
    if (
      reason instanceof DeviceNotAcceptedError ||
      reason instanceof DaemonOutdatedError ||
      reason instanceof AppOutdatedError
    )
      this.#health?.settled(daemonId);
  }

  /** A request that was not dialled for: proven unsent, unless its id is already in doubt. */
  #deferred(requestId: string | null): CarrierUnavailableError {
    const doubted = requestId !== null && this.#unknownFates.has(requestId);
    return new CarrierUnavailableError(
      DIAL_DEFERRED_REASON,
      { failures: [], daemonAbsent: false, relaysNeverOpened: false },
      doubted ? 'unknown' : 'unsent',
      { deferred: true },
    );
  }

  /**
   * The error a request no carrier carried throws: in the failure's own words when one failure ended
   * it (`cause`), in the walk's sentence when the walk ran out.
   *
   * DELIVERY IS DECIDED ACROSS ATTEMPTS, NOT ONE. The typed client retries a request under the SAME
   * request id and keeps only the last failure, so an attempt that died after leaving, followed by one
   * that never opened, would otherwise read as proven unsent. Any id that has ever been in doubt stays
   * in doubt.
   */
  #unavailable(
    entry: CarrierEntry,
    seen: readonly CarrierFailureSeen[],
    requestId: string | null,
    ...cause: [unknown?]
  ): CarrierUnavailableError {
    const doubted = seen.some(failure => failure.sent) || (requestId !== null && this.#unknownFates.has(requestId));
    if (doubted && requestId !== null) {
      this.#unknownFates.delete(requestId);
      this.#unknownFates.add(requestId);
      if (this.#unknownFates.size > this.#unknownFatesRemembered) {
        const [oldest] = this.#unknownFates;
        this.#unknownFates.delete(oldest as string);
      }
    }
    const delivery: CarrierDelivery = doubted ? 'unknown' : 'unsent';
    if (cause.length === 0)
      return new CarrierUnavailableError(
        entry.choice?.reason ?? 'no carrier is configured for this daemon',
        carrierOutage(seen),
        delivery,
      );
    const [reason] = cause;
    return new CarrierUnavailableError(
      reason instanceof Error ? reason.message : String(reason),
      carrierOutage(seen),
      delivery,
      { cause: reason },
    );
  }

  async #walk(daemon: DaemonConnection, url: string, init: RequestInit, dial: DialPolicy): Promise<Response> {
    const entry = this.#entry(daemon);
    // A REFUSED DEVICE DIALS NOTHING. Every panel of an open page retries its own reads, and each try
    // was a fresh socket the daemon admitted and refused — enough of them spent the per-address upgrade
    // budget, so the person's own attempt to pair again failed at the upgrade. Nothing a socket could
    // carry would change the answer; re-pairing replaces this entry and is the way out.
    if (entry.refused) throw new DeviceNotAcceptedError();
    const requestId = new Headers(init.headers).get(FY_REQUEST_ID_HEADER);
    const seen: CarrierFailureSeen[] = [];
    const chosen = entry.choice;
    if (chosen?.ok === true) {
      try {
        return await this.#over(entry, chosen.method, url, init, dial);
      } catch (thrown) {
        if (thrown instanceof RelayAnswerError) throw thrown.cause;
        const unsent = thrown instanceof RelayUnsentError;
        const reason = unsent ? thrown.cause : thrown;
        if (reason instanceof RelayDialDeferred) {
          // The winner's session is gone and this caller may not replace it: the model's attempt will.
          entry.choice = undefined;
          this.#announce();
          throw this.#deferred(requestId);
        }
        // The remembered carrier stopped carrying. Forget it — the next request walks
        // the set again — and report this failure rather than re-sending a request
        // whose fate on the daemon is unknown.
        if (deviceRefusal(reason)) throw this.#refuse(entry);
        entry.choice = undefined;
        this.#announce();
        // A READ IS ASKED AGAIN, AT ONCE, BY A FRESH WALK. Asking twice cannot change anything on the
        // daemon, and the alternative is the caller's panel painting an error for a relay that was
        // redeployed under it while direct, or the relay's next socket, would have answered.
        // A WRITE IS NOT: its fate on the daemon is unknown, so it is reported, never re-sent.
        if (!transportLike(reason)) throw reason;
        seen.push({ method: chosen.method, reason, sent: !unsent });
        if (!replaySafe(init)) throw this.#unavailable(entry, seen, requestId, reason);
      }
    }

    const probes: ConnectionProbe[] = [];
    let outdated: OutdatedSide | undefined;
    let refused = false;
    const plan = this.#plan(daemon);
    for await (const { method, untried } of this.#candidates(entry, plan)) {
      // ASKED BEFORE EVERY ATTEMPT, not once at the top: a walk takes as long as its failures do, and
      // an unpair, a re-pair or a republish can land between any two of them. Every address below
      // would be dialled with THIS walk's `DaemonConnection` — the old base URL, the old device grant,
      // the withdrawn rendezvous — which is the one thing a cleared pairing must never do again.
      this.#assertCurrent(entry);
      if (untried !== undefined) {
        probes.push(untriedProbe(method, untried));
        continue;
      }
      try {
        const response = await this.#over(entry, method, url, init, dial);
        // WHETHER AN ATTEMPT ADVANCES THE WALK IS THE PROTOCOL'S RULE, not this
        // class's: `carrierProbe` reads an ANSWER — any status, `503` included — as
        // this carrier working, and only a transport failure as a reason to try the
        // next address. Spelling that out a second time here is how a client and its
        // own protocol come to disagree about what "reachable" means.
        this.#decide(entry, [...probes, carrierProbe(method, { kind: 'answered', status: response.status })], plan);
        return response;
      } catch (thrown) {
        if (thrown instanceof RelayAnswerError) throw thrown.cause;
        // A session that never opened sent nothing, so even a write may try the next carrier.
        const unsent = thrown instanceof RelayUnsentError;
        const reason = unsent ? thrown.cause : thrown;
        if (reason instanceof RelayDialDeferred) throw this.#deferred(requestId);
        // A STALE ENTRY IS NOT A TRANSPORT FAILURE AND MUST NOT ADVANCE THE WALK. It says nothing about
        // whether this address works; it says this walk no longer describes a pairing that exists, so
        // every remaining candidate would be dialled with a credential and a set that were replaced.
        if (reason instanceof RelayStaleEntryError) throw reason;
        if (reason instanceof DeviceKeyMissingError || reason instanceof DeviceKeyUnreadableError) throw reason;
        // A SESSION THAT OPENED REACHED THE DAEMON. Its later failure still advances the walk, but it is
        // not the carrier being unreachable, and saying so blamed a tunnel that carried every frame.
        probes.push(
          carrierProbe(method, {
            kind: 'transport-failure',
            detail: transportFailure(reason),
            ...(unsent ? {} : { connected: true as const }),
          }),
        );
        seen.push({ method, reason, sent: !unsent });
        refused ||= deviceRefusal(reason);
        outdated ??= await this.#looksOutdated(method, reason);
        // A session that died AFTER the request left can follow receipt of a POST/PUT/etc. Record
        // its failed probe for the same disclosure a completed walk produces, but do not send that
        // possibly-applied request to the next carrier. One whose session never opened was never
        // sent anywhere, and walking on with it is the whole point of a fallback.
        if (!unsent && !replaySafe(init)) {
          this.#decide(entry, probes, plan);
          throw this.#unavailable(entry, seen, requestId, reason);
        }
      }
    }
    this.#decide(entry, probes, plan);
    if (refused) throw this.#refuse(entry);
    if (outdated !== undefined) throw outdatedError(outdated);
    throw this.#unavailable(entry, seen, requestId);
  }

  /** This walk's preference, read once at its start so one walk never mixes two. */
  #plan(daemon: DaemonConnection): WalkPlan {
    return { preference: this.#preference(daemon.daemonId) };
  }

  /**
   * Every carrier this walk may try, in the preference's order (`carrierOrder`): the daemon's own
   * addresses of each kind in the daemon's order, WebRTC through its dialer, and the hosted relay last.
   *
   * THE FALLBACK IS LAST AND IS REACHED ONLY BY EXHAUSTION, and only by a preference that walks relays
   * at all (Auto, Relay only). A daemon that authored a rendezvous is answered entirely from its own
   * set — the advertisement is never awaited — so the directory cannot delay a direct-first attempt on
   * the ordinary path. It is dialled and never written down; `hostedRelayFallbackCarrier` owns why,
   * and owns the fingerprint and address rules it is held to.
   *
   * A TUNNEL IS TRIED WHEN THE DAEMON PUBLISHED ONE (§15) — the last one this browser was told, kept
   * across reloads. Under "Tunnel only", when there is none or the one kept did not carry, the daemon is
   * ASKED ({@link #lookupTunnel}) before the walk gives up: a hostname re-provisioned since, or a tunnel
   * this browser never heard of, is dialled straight away. Only when that finds nothing either is the
   * service advertisement read, to say which of the two reasons applies. Nothing here is awaited
   * before a kept tunnel is tried, so a lookup never holds up a connect that a cached address can make.
   *
   * WEBRTC WITH NO DIALER IS PASSED OVER, NOT HIDDEN: it is yielded `untried` so the choice names it.
   */
  async *#candidates(entry: CarrierEntry, plan: WalkPlan): AsyncGenerator<WalkCandidate> {
    const daemon = entry.connection;
    const authored = daemonCarriers(daemon);
    for (const kind of carrierOrder(plan.preference)) {
      if (kind === 'webrtc') {
        if (this.#dialers.webrtc !== undefined) yield { method: WEBRTC };
        else {
          plan.why = WEBRTC_UNAVAILABLE;
          yield { method: WEBRTC, untried: WEBRTC_UNAVAILABLE };
        }
        continue;
      }
      const ofKind = authored.filter(method => method.kind === kind);
      for (const method of ofKind) yield { method };
      if (kind === 'tunnel') {
        if (plan.preference !== 'tunnel') continue;
        const learned = await this.#lookupTunnel(entry);
        if (learned !== undefined && !ofKind.some(method => sameDaemonCarrier(method, learned))) {
          yield { method: learned };
          continue;
        }
        if (ofKind.length === 0)
          plan.why = this.#tunnelSwitchedOff(daemon.daemonId)
            ? TUNNEL_SWITCHED_OFF
            : noTunnelReason(await this.#tunnelService());
        continue;
      }
      if (ofKind.length > 0 || kind === 'direct') continue;
      const hosted = hostedRelayFallbackCarrier(daemon, await this.#hostedRelay());
      if (hosted !== undefined) yield { method: hosted };
      else plan.why = RELAY_UNAVAILABLE;
    }
  }

  /**
   * Is this walk still describing a pairing this router holds?
   *
   * The entry is the walk's whole identity: its connection, its remembered choice and its live
   * sessions. `clearDaemon` replaces it with nothing and `#entry` replaces it on a re-pair or a
   * republish, and in every one of those cases the object a walk captured is an orphan — carrying a
   * device grant that may have been revoked and a carrier set the daemon has already corrected.
   */
  #assertCurrent(entry: CarrierEntry): void {
    if (this.#entries.get(entry.connection.daemonId) === entry) return;
    throw new RelayStaleEntryError();
  }

  #entry(daemon: DaemonConnection): CarrierEntry {
    const current = this.#entries.get(daemon.daemonId);
    if (current !== undefined && sameDaemonConnection(current.connection, daemon)) return current;
    if (current !== undefined && carrierRefreshOnly(current.connection, daemon))
      return this.#refreshed(current, daemon);
    if (current !== undefined) this.clearDaemon(daemon.daemonId);
    const entry: CarrierEntry = {
      connection: daemon,
      retired: new AbortController(),
      choice: undefined,
      refused: false,
      tunnelLookup: undefined,
      sessions: new Map(),
    };
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
    const published = new Set(carriers.map(carrierAddress));
    const winner = current.choice?.ok === true ? carrierAddress(current.choice.method) : undefined;
    const sessions = new Map<string, CarrierSession>();
    for (const [key, held] of current.sessions) {
      // A direct or WebRTC winner's own sessions stay for the reason the winner itself stays (below).
      if (
        published.has(held.address) ||
        (held.address === winner && current.choice?.ok === true && outlivesRepublish(current.choice.method))
      ) {
        sessions.set(key, held);
        continue;
      }
      void held.session.then(
        // True of a rendezvous the daemon withdrew AND of a fallback it never published, which is
        // every session this branch can be holding.
        connected => connected.close('this rendezvous is not named in the carriers this daemon publishes'),
        () => undefined,
      );
    }
    const chosen = current.choice;
    const kept =
      chosen?.ok === true &&
      (carriers.some(method => sameDaemonCarrier(method, chosen.method)) || outlivesRepublish(chosen.method))
        ? chosen
        : undefined;
    const entry: CarrierEntry = {
      connection: daemon,
      retired: current.retired,
      choice: kept,
      refused: current.refused,
      tunnelLookup: current.tunnelLookup,
      sessions,
    };
    this.#entries.set(daemon.daemonId, entry);
    this.#announce();
    return entry;
  }

  #decide(entry: CarrierEntry, probes: readonly ConnectionProbe[], plan: WalkPlan): void {
    // Initial requests may walk concurrently. Once one has an answer, that winner
    // is the connection's fact: a later walk that happened to lose direct and
    // reach a relay must still return its own response, but may not turn timing
    // into a relay preference for every request that follows.
    if (entry.choice?.ok === true) return;
    entry.choice = choiceFor(probes, plan);
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

  async #over(
    entry: CarrierEntry,
    method: ConnectionMethod,
    url: string,
    init: RequestInit,
    dial: DialPolicy,
  ): Promise<Response> {
    const lane = requestLane(typeof init.body === 'string' ? init.body : undefined);
    const session = await this.#session(entry, method, dial, lane).catch((reason: unknown) => {
      throw new RelayUnsentError(reason);
    });
    // AMENDED HERE, on the session that will carry the request, because the rotation proof signs THAT
    // session's transcript and the daemon refuses it on any other. A session found dead below is
    // replaced for a read only, and a step-up is a POST, so the proof is never carried to another.
    const amended = (await this.#rotation?.amend(session, entry.connection, url, init)) ?? { init, rotated: false };
    const record = {
      ...relayTunnelRequest(url, amended.init),
      ...(this.#presence() ? { presence: true as const } : {}),
    };
    const signal = init.signal ?? undefined;
    // A DEADLINE THAT PASSED BEFORE THE REQUEST LEFT says nothing about this session: the time went on the
    // walk and the handshake, and the daemon was never asked. Retiring the session for it threw away a
    // working one — and on a link whose handshake outlasts the deadline, every request opened a session
    // only to close it unused. The caller still gets its own abort, and nothing was sent anywhere.
    try {
      signal?.throwIfAborted();
    } catch (reason) {
      throw new RelayAnswerError(reason);
    }
    try {
      const response = relayResponse(await session.request(record, signal));
      // Only an ANSWER settles the pending key. A request that died without one leaves it pending,
      // which is the recovery: the daemon may have swapped and the answer is what was lost.
      if (amended.rotated) await this.#rotation?.settle(entry.connection.daemonId, response);
      return response;
    } catch (reason) {
      // THE CALLER'S DEADLINE PASSED WITH NO ANSWER, and that says something about THIS session: the
      // relay's edge answers the keepalive by itself, so a session whose daemon end went quiet — a Mac
      // that slept, a link that half-closed — still looks alive from here. It is retired so the next
      // request opens a fresh one instead of queueing behind the same silence. The abort is the
      // caller's own word for what happened, so it is what the caller gets back.
      if (signal?.aborted === true && reason === signal.reason) {
        if (isTimeoutReason(reason)) session.close('the daemon did not answer a request in time on this session');
        throw new RelayAnswerError(reason);
      }
      // A LEASE THAT RAN OUT IS NOT A CARRIER THAT FAILED. The device slept through its renewal — a
      // frozen tab, a laptop lid — and the daemon ended the session; a read is simply asked again on a
      // fresh one, silently. A write is not, for the reason every write is not replayed.
      if (
        reason instanceof RelaySessionError &&
        reason.code === RELAY_ACCESS_LEASE_ENDED_CLOSE_CODE &&
        replaySafe(init)
      ) {
        const fresh = await this.#session(entry, method, dial, lane);
        return relayResponse(await fresh.request(record, signal));
      }
      // The carrier failed under this request, so another carrier may be tried — and
      // the request itself is LOST rather than retried on this one: §9 says frames in
      // flight are gone and known to be gone, so re-requesting is the caller's call.
      if (!session.live()) throw reason;
      // The daemon ANSWERED. A `409`, a refused body — that is a result, and
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
    method: ConnectionMethod,
    dial: DialPolicy,
    lane: RequestLane = 'request',
  ): Promise<RelayClientSession> {
    const address = carrierAddress(method);
    return await this.#hold(
      entry,
      laneSessionKey(lane, address),
      address,
      async () => this.#openKeyed(entry, method, device => ({ kind: 'auth', device })),
      dial,
    );
  }

  /** One stream session on one carrier, held where unpairing can reach it, evicted when it ends. */
  async #streamOn(
    entry: CarrierEntry,
    method: ConnectionMethod,
    request: RelayStreamRequest,
  ): Promise<RelayClientSession> {
    const address = carrierAddress(method);
    const query = request.query ?? [];
    this.#streams += 1;
    const key = streamSessionKey(address, request.path, query, this.#streams);
    const session = await this.#hold(
      entry,
      key,
      address,
      async () =>
        this.#openKeyed(
          entry,
          method,
          device => ({
            kind: 'stream',
            device,
            path: request.path,
            ...(query.length === 0 ? {} : { query }),
          }),
          request.onData,
        ),
      'gated',
    );
    // EVICTED WHEN IT CONCLUDES, not when something happens to ask for the same key again — and with
    // a per-call key nothing ever does, so without this the map would gain one dead entry for every
    // terminal ever attached over the life of a pairing. A carrier-only refresh replaces `entry`
    // while carrying this exact held value into the new map, so eviction resolves the authoritative
    // entry at close time. Identity is the fence: an old close can never delete a newer occupant.
    const held = entry.sessions.get(key);
    session.onStreamClosed(() => {
      const sessions = this.#entries.get(entry.connection.daemonId)?.sessions;
      if (held !== undefined && sessions?.get(key) === held) sessions.delete(key);
    });
    return session;
  }

  /**
   * Opens one session with the device key, and with the PENDING key once if the daemon refuses the first.
   *
   * `4403` is the one code that means this device is not accepted — and after a rotation whose answer
   * was lost it is also what an old key earns from a daemon that already swapped. So a refusal is
   * followed by exactly one more attempt, with the replacement the browser kept before it sent it:
   * accepted, and that key is promoted; refused as well, and the daemon never took it, so it is
   * discarded. Any OTHER failure of the second attempt is a fact about the carrier, not about the key,
   * so the pending key is kept for the next session and the failure is reported as it was.
   */
  async #openKeyed(
    entry: CarrierEntry,
    method: ConnectionMethod,
    mode: (device: SessionDeviceClaim) => RelaySessionMode,
    onData?: RelayStreamRequest['onData'],
  ): Promise<RelayClientSession> {
    const device = await this.#claim(entry);
    const daemonId = entry.connection.daemonId;
    const drops = this.#drops;
    const open = async (claim: SessionDeviceClaim): Promise<RelayClientSession> => {
      const sessionMode = mode(claim);
      const options = {
        crypto: this.#crypto,
        daemon: entry.connection,
        ...(this.#heartbeat === undefined ? {} : { heartbeat: this.#heartbeat }),
        mode: sessionMode,
        ...(onData === undefined ? {} : { onData }),
        ...(drops === undefined
          ? {}
          : {
              onDropped: (end: CarrierSessionEnd) =>
                drops.dropped(daemonId, method.kind, sessionMode.kind === 'stream' ? 'stream' : 'requests', end),
            }),
        // Only a relay keeps the full heartbeat grace: it is the last resort. Every carrier before it
        // gets the direct acceptance deadline, so a carrier that neither answers nor refuses costs
        // seconds before the walk moves on (§15: a tunnel is dialled like a direct session).
        ...(method.kind === 'relay' ? {} : { deadlineMs: DIRECT_SESSION_DEADLINE_MS }),
      };
      const session =
        method.kind === 'webrtc'
          ? await openSessionOnSocket({ ...options, socket: await this.#webrtc(entry) })
          : await openRelaySession({ ...options, dial: this.#dial, method });
      // A drop still waiting for its reconnect learns how long it waited (`carrier-drops.ts`).
      drops?.reconnected(daemonId);
      return session;
    };
    try {
      return await open(device);
    } catch (refused) {
      const rotation = this.#rotation;
      const pending = deviceRefusal(refused) ? await rotation?.pending(daemonId).catch(() => undefined) : undefined;
      if (rotation === undefined || pending === undefined) throw refused;
      try {
        const session = await open({ ...device, key: pending });
        await rotation.promote(daemonId);
        return session;
      } catch (again) {
        if (deviceRefusal(again)) await rotation.discard(daemonId);
        throw refused;
      }
    }
  }

  /**
   * A WebRTC data channel for this entry's daemon, from the composition root's dialer.
   *
   * Only reached when a dialer exists — `#candidates` passes WebRTC over otherwise. The introducers are
   * the walk's own addressed carriers minus the tunnel, with the hosted relay when the daemon authored
   * none, so the dialer never has to rediscover what this router already knows.
   */
  async #webrtc(entry: CarrierEntry): Promise<CarrierSocket> {
    const dialer = this.#dialers.webrtc as NonNullable<CarrierDialers['webrtc']>;
    const introducers = await this.#introducers(entry);
    return await dialer({
      daemon: entry.connection,
      introducers,
      request: async (path, init = {}) => await this.#introduce(entry, introducers, path, init),
      signal: entry.retired.signal,
    });
  }

  /**
   * WHERE IS THIS DAEMON'S TUNNEL NOW? Asked of the daemon itself, over an introducer (§15, "Tunnel only").
   *
   * "Tunnel only" has nothing else to ask: a tunnel this browser lost, or one the daemon re-provisioned
   * under a new hostname, can only be learned from a connection, and the preference allows no other. So
   * this is ONE `GET /v1/carriers` over the daemon's direct address or a rendezvous — the carriers that
   * already introduce WebRTC — inside an ordinary device-authenticated session, and never the person's
   * own requests. The answer is the daemon's, end to end: no relay can put a hostname in it.
   *
   * Asked once per {@link TUNNEL_LOOKUP_REUSE_MS}, joined while in flight, and never thrown: a lookup that
   * fails answers nothing, and a tunnel this browser already keeps is not dropped because of it — what
   * the read learned is handed to {@link DaemonCarrierRouterOptions.learned}, which owns what is kept.
   */
  async #lookupTunnel(entry: CarrierEntry): Promise<TunnelCarrier | undefined> {
    const now = this.#now();
    const held = entry.tunnelLookup;
    if (held !== undefined && now - held.at < TUNNEL_LOOKUP_REUSE_MS) return await held.answer;
    const answer = this.#readTunnel(entry).catch(() => undefined);
    entry.tunnelLookup = { at: now, answer };
    return await answer;
  }

  async #readTunnel(entry: CarrierEntry): Promise<TunnelCarrier | undefined> {
    const introducers = await this.#introducers(entry);
    const response = await this.#introduce(entry, introducers, '/v1/carriers', {
      cache: 'no-store',
      signal: AbortSignal.timeout(TUNNEL_LOOKUP_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    const view = DaemonCarriersViewSchema.safeParse(await response.json().catch(() => undefined));
    if (!view.success) return undefined;
    const carriers = publishedConnectionMethods(view.data.carriers, await this.#hostedRelay());
    this.#learned(entry.connection, carriers);
    return carriers.find((method): method is TunnelCarrier => method.kind === 'tunnel');
  }

  /** The walk's own addressed carriers minus the tunnel, with the hosted relay when the daemon authored none. */
  async #introducers(entry: CarrierEntry): Promise<readonly ConnectionMethod[]> {
    const authored = daemonCarriers(entry.connection).filter(introducer);
    const hosted = authored.some(method => method.kind === 'relay')
      ? undefined
      : hostedRelayFallbackCarrier(entry.connection, await this.#hostedRelay());
    return hosted === undefined ? authored : [...authored, hosted];
  }

  /**
   * A signalling request over the introducers only — {@link WebRtcDialContext.request}.
   *
   * It is part of a WebRTC attempt the walk already admitted, so it dials as the model's own attempt
   * would rather than waiting on the reconnect gate, and it decides nothing: an introducer that carried
   * signalling is not the connection's carrier.
   */
  async #introduce(
    entry: CarrierEntry,
    introducers: readonly ConnectionMethod[],
    path: string,
    init: RequestInit,
    none = 'no carrier can introduce WebRTC to this machine',
  ): Promise<Response> {
    const url = new URL(path, entry.connection.baseUrl).toString();
    let failure: unknown = new Error(none);
    for (const method of introducers) {
      this.#assertCurrent(entry);
      try {
        return await this.#over(entry, method, url, init, 'probe');
      } catch (thrown) {
        if (thrown instanceof RelayAnswerError) throw thrown.cause;
        const unsent = thrown instanceof RelayUnsentError;
        failure = unsent ? thrown.cause : thrown;
        if (!unsent && !replaySafe(init)) throw failure;
      }
    }
    throw failure;
  }

  /**
   * Which grant this browser holds on this daemon, the key that proves it, and this page's session.
   *
   * Read per session rather than cached: a key removed by an unpair, or by the person clearing site
   * data, must stop opening sessions the moment it is gone.
   */
  async #claim(entry: CarrierEntry): Promise<SessionDeviceClaim> {
    const key = await this.#deviceKey(entry.connection.daemonId).catch((reason: unknown) => {
      throw new DeviceKeyUnreadableError(reason);
    });
    if (key === undefined) throw new DeviceKeyMissingError();
    return { deviceId: entry.connection.deviceId, key, appSession: this.#appSession };
  }

  /**
   * Whether a failed carrier LOOKS like a daemon on another dialect, and which side is old — a SIGNAL for the end of the walk, never a
   * verdict that stops it.
   *
   * Both signals are unauthenticated: the liveness route is read over plaintext, and the refusal an
   * old daemon gives a new hello arrives before any key is checked. So anybody on the direct path —
   * or simply an older daemon at the same private address on another network — could produce one.
   * Read as final, that let them stop the walk short of a rendezvous that works and tell the owner to
   * re-pair. Read as a signal, it only chooses the sentence when NOTHING worked.
   */
  async #looksOutdated(method: ConnectionMethod, reason: unknown): Promise<OutdatedSide | undefined> {
    const refused = outdatedRefusal(reason);
    if (refused !== undefined || method.kind !== 'direct') return refused;
    return await outdatedSide(this.#network, method.daemonUrl);
  }

  /**
   * Open, register and fence one session, whatever job it is for.
   *
   * Extracted from the request path unchanged so a stream session inherits every rule it already
   * enforced — the reuse-while-live check, the removal of a dial that failed, and above all the
   * stale-entry fence below. A second implementation of any of those would be a second place for a
   * live rendezvous holding this device's grant to escape an unpair.
   */
  async #hold(
    entry: CarrierEntry,
    key: string,
    address: string,
    open: () => Promise<RelayClientSession>,
    dial: DialPolicy,
  ): Promise<RelayClientSession> {
    const existing = entry.sessions.get(key);
    if (existing !== undefined) {
      const current = await existing.session.catch(() => undefined);
      if (current?.live() === true || current?.streaming() === true) return current;
      entry.sessions.delete(key);
    }
    // THE ONE PLACE A SESSION IS DIALLED, so the one place the reconnect gate stands. A session that is
    // already live is used above whatever the gate says; only a NEW dial waits for the model's attempt.
    if (dial === 'gated' && this.#health?.dialAllowed(entry.connection.daemonId) === false)
      throw new RelayDialDeferred();
    const opening = open();
    entry.sessions.set(key, { address, session: opening });
    let session: RelayClientSession;
    try {
      session = await opening;
    } catch (reason) {
      if (entry.sessions.get(key)?.session === opening) entry.sessions.delete(key);
      throw reason;
    }
    const held = this.#entries.get(entry.connection.daemonId);
    if (held === entry || held?.sessions.get(key)?.session === opening) return session;
    entry.sessions.delete(key);
    // `close` is idempotent, so a re-pair that already closed this promise's session and this
    // sentence do not fight; either way it ends, and the caller is told rather than handed a
    // session no unpair could reach.
    session.close(STALE_SESSION_REASON);
    // The MARKED error, so the walk stops here instead of reading this as one address that did not
    // work and dialling the next one with the same replaced pairing. It carries the session sentence
    // rather than the walk's, because here a session really was opening and really has been ended.
    throw new RelayStaleEntryError(STALE_SESSION_REASON);
  }

  /**
   * Remembers that this daemon refused this device, and hands back the error that says so.
   *
   * A REFUSAL IS A SIGNAL UNTIL THE WALK IS OVER, like an outdated dialect: the close travels unsealed,
   * so a carrier could forge one. It decides the outcome only when no carrier carried the request — and a
   * carrier able to forge it on the only path that works could as well have dropped the traffic.
   */
  #refuse(entry: CarrierEntry): DeviceNotAcceptedError {
    if (!entry.refused) {
      entry.refused = true;
      entry.choice = undefined;
      this.#announce();
    }
    return new DeviceNotAcceptedError();
  }

  #announce(): void {
    for (const listener of this.#listeners) listener();
  }
}

/** A carrier passed over without being tried, and why. */
const untriedProbe = (method: ConnectionMethod, detail: string): ConnectionProbe => ({
  method,
  reachable: false,
  detail,
  untried: true,
});

/**
 * A carrier that won AFTER WebRTC was tried and failed carries WebRTC's own sentence as the reason a
 * faster one is not carrying (`docs/relay-protocol.md` §16, "What the browser shows") — "WebRTC could
 * not find a direct path in 8 s…", the daemon's refusal, or a daemon too old to offer it. A WebRTC that
 * was never tried (no dialer in this build, a preference that left it out) is no fallback at all.
 */
const withWebRtcFallbackReason = (chosen: ConnectionChoice & { readonly ok: true }): ConnectionChoice => {
  const rank = (kind: ConnectionMethod['kind']): number => CONNECTION_KINDS.indexOf(kind);
  const missed = chosen.passedOver.find(skip => skip.method.kind === 'webrtc' && skip.untried !== true);
  if (missed === undefined || rank(chosen.method.kind) <= rank('webrtc')) return chosen;
  return { ...chosen, fallbackReason: missed.detail };
};

/**
 * The choice a walk ends with.
 *
 * WHEN THE PREFERENCE LEFT NOTHING TO TRY, the sentence names the preference and the reason — "Tunnel
 * only: this machine has no tunnel yet." — rather than the protocol's generic one, because the person
 * chose that narrowing and is owed the reason it carries nothing. Anything actually tried is said in
 * `chooseConnection`'s words, unchanged.
 */
const choiceFor = (probes: readonly ConnectionProbe[], plan: WalkPlan): ConnectionChoice => {
  const chosen = chooseConnection(probes);
  if (chosen.ok) return withWebRtcFallbackReason(chosen);
  const nothingTried = probes.every(probe => probe.untried === true);
  if (plan.why === undefined || plan.preference === 'auto' || !nothingTried) return chosen;
  const passedOver: readonly ConnectionSkip[] = chosen.passedOver;
  return { ok: false, reason: `${CARRIER_PREFERENCE_LABEL[plan.preference]}: ${plan.why}.`, passedOver };
};

/** A read (`GET`, `HEAD`) is background work; any other method is something a person pressed. */
const requestOrigin = (init: RequestInit): PromptOrigin => {
  const method = (init.method ?? 'GET').toUpperCase();
  return method === 'GET' || method === 'HEAD' ? 'background' : 'explicit';
};

/** Whether a refusal carries this `code`. Read from a copy; the body stays. */
const answersWithCode = async (response: Response, code: string): Promise<boolean> => {
  try {
    const body = (await response.clone().json()) as { readonly code?: unknown } | null;
    return body?.code === code;
  } catch {
    return false;
  }
};

/**
 * Whether a refusal is the daemon asking for a passkey step-up, and for which demand. Read from a copy;
 * the body stays.
 *
 * `undefined` is not a step-up at all; `null` is one whose demand did not parse (an older daemon names
 * none), which still asks.
 */
const stepUpDemand = async (response: Response): Promise<StepUpDemand | null | undefined> => {
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    return undefined;
  }
  const named = StepUpRequiredBodySchema.safeParse(body);
  if (named.success) return named.data.demand;
  const code = typeof body === 'object' && body !== null ? (body as { readonly code?: unknown }).code : undefined;
  return code === STEP_UP_REQUIRED_CODE ? null : undefined;
};

/** Marks a failure to OPEN a session: nothing of the request left this browser, whatever it was. */
class RelayUnsentError extends Error {
  constructor(override readonly cause: unknown) {
    super('no session opened to carry this request');
    this.name = 'RelayUnsentError';
  }
}

/** Marks a refusal that came from the DAEMON, so no other carrier is tried after it. */
class RelayAnswerError extends Error {
  constructor(override readonly cause: unknown) {
    super('the daemon refused a relayed request');
    this.name = 'RelayAnswerError';
  }
}
