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
 * - An answer too large for the session (§14) arrives as the daemon's own `502`,
 *   never as a truncated body: a client that rendered half a session list would
 *   show a fleet that does not exist.
 */

import {
  OLDER_APP_SENTENCE,
  OLDER_DAEMON_SENTENCE,
  UNLOCK_REQUIRED_CODE,
  RELAY_ACCESS_LEASE_ENDED_CLOSE_CODE,
  STEP_UP_REQUIRED_CODE,
  type StepUpDemand,
  StepUpRequiredBodySchema,
} from '@ferretry/protocol';
import {
  APP_SESSION_BYTES,
  type ConnectionChoice,
  type ConnectionMethod,
  type ConnectionProbe,
  carrierProbe,
  chooseConnection,
  connectionSocketUrl,
  HEARTBEAT_GRACE_SECONDS,
  HEARTBEAT_SECONDS,
  type PrivateKeyHandle,
  parseDaemonId,
  RELAY_CLOSE_CODES,
  SESSION_PROTOCOL_ID,
  toBase64Url,
} from '@ferretry/relay';
import {
  type DaemonConnection,
  type DaemonId,
  daemonCarriers,
  hostedRelayFallbackCarrier,
  sameDaemonCarrier,
  sameDaemonConnection,
} from './daemon-connection.ts';
import { DeviceKeyMissingError, DeviceKeyUnreadableError } from './device-keys.ts';
import type { KeyRotation } from './key-rotation.ts';
import { stepUpAct } from './grants.ts';
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
/**
 * WIRE ONE SOCKET TO ONE SESSION AND WAIT FOR THE ONE THING THAT SESSION IS FOR.
 *
 * Extracted so a pairing attempt and a request or stream session share it byte for byte rather than
 * carrying two copies of the deadline arithmetic. There is exactly one difference between the two
 * uses and it is `keepAlive`: a session that goes on to carry traffic keeps its heartbeat, while a
 * pairing session has stated its outcome and is about to be closed by the daemon, so leaving a
 * thirty-second interval armed behind it would keep a timer alive for a conversation that is over.
 */
export const driveRelaySession = async <T>({
  socket,
  session,
  heartbeat,
  settled,
  keepAlive,
  deadlineMs = HEARTBEAT_GRACE_SECONDS * 1_000,
}: {
  readonly socket: RelayCarrierSocket;
  readonly session: RelayClientSession;
  readonly heartbeat: RelayHeartbeatSchedule;
  readonly settled: Promise<T>;
  readonly keepAlive: boolean;
  /** How long the session may take to settle. The heartbeat grace by default; shorter for a probe. */
  readonly deadlineMs?: number;
}): Promise<T> => {
  const timers = new Set<() => void>();
  const stop = (): void => {
    for (const cancel of timers) cancel();
    timers.clear();
  };
  const deadline = heartbeat(() => {
    session.carrierClosed(RELAY_CLOSE_CODES.heartbeatTimeout, 'the rendezvous did not open a session in time');
    socket.close(RELAY_CLOSE_CODES.heartbeatTimeout, 'no session');
  }, deadlineMs);
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
    const value = await settled;
    if (!keepAlive) {
      stop();
      return value;
    }
    // The deadline covered getting here and nothing after it; the heartbeat covers
    // the rest. Leaving it armed would close a working session.
    deadline();
    timers.delete(deadline);
    return value;
  } catch (reason) {
    stop();
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
  crypto,
  dial,
  daemon,
  method,
  heartbeat = browserHeartbeat,
  mode,
  onData,
}: OpenRelaySessionOptions): Promise<RelayClientSession> => {
  const url =
    method.kind === 'direct'
      ? directSessionUrl(
          daemon,
          new URL(`/v1/rendezvous/${encodeURIComponent(daemon.daemonId)}/client`, method.daemonUrl),
        )
      : connectionSocketUrl(method, daemon.daemonId, 'client');
  if (url === null) {
    // `connectionSocketUrl` refuses a fingerprint a session cannot be checked against. That
    // is a refusal, not an address to improvise around.
    throw new RelaySessionError('this daemon fingerprint cannot address a session', RELAY_CLOSE_CODES.protocolError);
  }
  const socket = dial(url);
  const session = new RelayClientSession({
    crypto,
    daemonId: daemon.daemonId,
    mode,
    socket,
    ...(onData === undefined ? {} : { onData }),
  });
  return await driveRelaySession({ socket, session, heartbeat, settled: session.ready(), keepAlive: true });
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
    const response = await network(new URL('/healthz', `${daemonUrl}/`).toString(), {
      cache: 'no-store',
      credentials: 'omit',
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
   * Asked when the daemon refuses a request for want of a passkey step-up (`grant_step_up_required`):
   * `true` once the person has confirmed, and the request is then sent again ONCE. Absent means
   * nothing can ask, and the refusal is returned as it came.
   */
  readonly stepUp?: (daemon: DaemonConnection, act?: string) => Promise<boolean>;
  /**
   * Asked when the daemon answers `401 unlock_required`: this machine wants a passkey on opening and
   * this device has not given one. `true` once the person has confirmed, and the request is then sent
   * again ONCE. Absent means nothing can ask, and the refusal is returned as it came.
   */
  readonly unlockRequired?: (daemon: DaemonConnection) => Promise<boolean>;
  /**
   * Whether a person is at this device right now (`presence.ts`). A request sent while they are is
   * marked, and only marked requests keep the device from idling out on the daemon. Absent means
   * nobody can tell, and nothing is marked.
   */
  readonly presence?: () => boolean;
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
const carrierAddress = (method: ConnectionMethod): string =>
  method.kind === 'direct' ? `direct ${method.daemonUrl}` : method.relayUrl;

interface CarrierEntry {
  readonly connection: DaemonConnection;
  choice: ConnectionChoice | undefined;
  /**
   * The daemon refused this device (`4403`). Sticky for this pairing: a re-pair or an unpair replaces
   * the entry, which is the only thing that clears it, and a reload asks the daemon again.
   */
  refused: boolean;
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
  'this daemon was re-paired, unpaired or republished while this request was in flight, so it was not carried to another carrier';

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
  readonly #deviceKey: DeviceKeyResolver;
  readonly #appSession: string;
  readonly #stepUp: ((daemon: DaemonConnection, act?: string) => Promise<boolean>) | undefined;
  readonly #unlockRequired: ((daemon: DaemonConnection) => Promise<boolean>) | undefined;
  readonly #presence: () => boolean;
  readonly #rotation: KeyRotation | undefined;
  /** Per-call ordinal for stream session keys. Never reused, so no two streams can collide. */
  #streams = 0;
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
    this.#deviceKey = options.deviceKey;
    this.#appSession = options.appSession ?? toBase64Url(options.crypto.randomBytes(APP_SESSION_BYTES));
    this.#stepUp = options.stepUp;
    this.#unlockRequired = options.unlockRequired;
    this.#presence = options.presence ?? (() => false);
    this.#rotation = options.rotation;
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
    const entry = this.#entry(daemon);
    if (entry.refused) throw new DeviceNotAcceptedError();
    const chosen = entry.choice;
    if (chosen?.ok === true) {
      try {
        return await this.#streamOn(entry, chosen.method, request);
      } catch (reason) {
        throw deviceRefusal(reason) ? this.#refuse(entry) : reason;
      }
    }
    const probes: ConnectionProbe[] = [];
    let outdated: OutdatedSide | undefined;
    let refused = false;
    for await (const method of this.#candidates(daemon)) {
      this.#assertCurrent(entry);
      try {
        const session = await this.#streamOn(entry, method, request);
        this.#decide(entry, [...probes, carrierProbe(method, { kind: 'answered', status: 101 })]);
        return session;
      } catch (reason) {
        if (
          reason instanceof RelayStaleEntryError ||
          reason instanceof DeviceKeyMissingError ||
          reason instanceof DeviceKeyUnreadableError ||
          reason instanceof RelayStreamRefusedError ||
          (reason instanceof RelaySessionError && reason.code === RELAY_CLOSE_CODES.rendezvousBusy)
        )
          throw reason;
        probes.push(carrierProbe(method, { kind: 'transport-failure', detail: transportFailure(reason) }));
        refused ||= deviceRefusal(reason);
        outdated ??= await this.#looksOutdated(method, reason);
      }
    }
    this.#decide(entry, probes);
    if (refused) throw this.#refuse(entry);
    if (outdated !== undefined) throw outdatedError(outdated);
    throw new Error(entry.choice?.reason ?? 'no carrier is configured for this daemon');
  }

  /** Unpair and re-pair invalidation: a carrier is live state, never durable. */
  clearDaemon(daemonId: DaemonId): void {
    const entry = this.#entries.get(daemonId);
    if (entry === undefined) return;
    this.#entries.delete(daemonId);
    for (const held of entry.sessions.values()) {
      void held.session.then(
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
    let response = await this.#sendOnce(daemon, url, init);
    // PRESENCE COMES FIRST: while this machine wants a passkey on opening it answers every request `401
    // unlock_required`, so nothing else it says can be read yet. One prompt, one resend; a dismissed
    // prompt returns the refusal unchanged, and a second refusal is the answer.
    const confirmUnlock = this.#unlockRequired;
    if (
      confirmUnlock !== undefined &&
      response.status === 401 &&
      (await answersWithCode(response, UNLOCK_REQUIRED_CODE))
    ) {
      if (!(await confirmUnlock(daemon))) return response;
      response = await this.#sendOnce(daemon, url, init);
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
    if (!(await ask(daemon, act))) return response;
    return await this.#sendOnce(daemon, url, init);
  }

  async #sendOnce(daemon: DaemonConnection, url: string, init: RequestInit): Promise<Response> {
    const entry = this.#entry(daemon);
    // A REFUSED DEVICE DIALS NOTHING. Every panel of an open page retries its own reads, and each try
    // was a fresh socket the daemon admitted and refused — enough of them spent the per-address upgrade
    // budget, so the person's own attempt to pair again failed at the upgrade. Nothing a socket could
    // carry would change the answer; re-pairing replaces this entry and is the way out.
    if (entry.refused) throw new DeviceNotAcceptedError();
    const chosen = entry.choice;
    if (chosen?.ok === true) {
      try {
        return await this.#over(entry, chosen.method, url, init);
      } catch (thrown) {
        if (thrown instanceof RelayAnswerError) throw thrown.cause;
        const reason = thrown instanceof RelayUnsentError ? thrown.cause : thrown;
        // The remembered carrier stopped carrying. Forget it — the next request walks
        // the set again — and report this failure rather than re-sending a request
        // whose fate on the daemon is unknown.
        if (deviceRefusal(reason)) throw this.#refuse(entry);
        entry.choice = undefined;
        this.#announce();
        throw reason;
      }
    }

    const probes: ConnectionProbe[] = [];
    let outdated: OutdatedSide | undefined;
    let refused = false;
    for await (const method of this.#candidates(daemon)) {
      // ASKED BEFORE EVERY ATTEMPT, not once at the top: a walk takes as long as its failures do, and
      // an unpair, a re-pair or a republish can land between any two of them. Every address below
      // would be dialled with THIS walk's `DaemonConnection` — the old base URL, the old device grant,
      // the withdrawn rendezvous — which is the one thing a cleared pairing must never do again.
      this.#assertCurrent(entry);
      try {
        const response = await this.#over(entry, method, url, init);
        // WHETHER AN ATTEMPT ADVANCES THE WALK IS THE PROTOCOL'S RULE, not this
        // class's: `carrierProbe` reads an ANSWER — any status, `503` included — as
        // this carrier working, and only a transport failure as a reason to try the
        // next address. Spelling that out a second time here is how a client and its
        // own protocol come to disagree about what "reachable" means.
        this.#decide(entry, [...probes, carrierProbe(method, { kind: 'answered', status: response.status })]);
        return response;
      } catch (thrown) {
        if (thrown instanceof RelayAnswerError) throw thrown.cause;
        // A session that never opened sent nothing, so even a write may try the next carrier.
        const unsent = thrown instanceof RelayUnsentError;
        const reason = unsent ? thrown.cause : thrown;
        // A STALE ENTRY IS NOT A TRANSPORT FAILURE AND MUST NOT ADVANCE THE WALK. It says nothing about
        // whether this address works; it says this walk no longer describes a pairing that exists, so
        // every remaining candidate would be dialled with a credential and a set that were replaced.
        if (reason instanceof RelayStaleEntryError) throw reason;
        if (reason instanceof DeviceKeyMissingError || reason instanceof DeviceKeyUnreadableError) throw reason;
        probes.push(carrierProbe(method, { kind: 'transport-failure', detail: transportFailure(reason) }));
        refused ||= deviceRefusal(reason);
        outdated ??= await this.#looksOutdated(method, reason);
        // A session that died AFTER the request left can follow receipt of a POST/PUT/etc. Record
        // its failed probe for the same disclosure a completed walk produces, but do not send that
        // possibly-applied request to the next carrier. One whose session never opened was never
        // sent anywhere, and walking on with it is the whole point of a fallback.
        if (!unsent && !replaySafe(init)) {
          this.#decide(entry, probes);
          throw reason;
        }
      }
    }
    this.#decide(entry, probes);
    if (refused) throw this.#refuse(entry);
    if (outdated !== undefined) throw outdatedError(outdated);
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
    const entry: CarrierEntry = { connection: daemon, choice: undefined, refused: false, sessions: new Map() };
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
      // A direct winner's own sessions stay for the reason the winner itself stays (below).
      if (published.has(held.address) || (held.address === winner && held.address.startsWith('direct '))) {
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
      (carriers.some(method => sameDaemonCarrier(method, chosen.method)) || chosen.method.kind === 'direct')
        ? chosen
        : undefined;
    const entry: CarrierEntry = { connection: daemon, choice: kept, refused: current.refused, sessions };
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
    const session = await this.#session(entry, method).catch((reason: unknown) => {
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
    try {
      const response = relayResponse(await session.request(record));
      // Only an ANSWER settles the pending key. A request that died without one leaves it pending,
      // which is the recovery: the daemon may have swapped and the answer is what was lost.
      if (amended.rotated) await this.#rotation?.settle(entry.connection.daemonId, response);
      return response;
    } catch (reason) {
      // A LEASE THAT RAN OUT IS NOT A CARRIER THAT FAILED. The device slept through its renewal — a
      // frozen tab, a laptop lid — and the daemon ended the session; a read is simply asked again on a
      // fresh one, silently. A write is not, for the reason every write is not replayed.
      if (
        reason instanceof RelaySessionError &&
        reason.code === RELAY_ACCESS_LEASE_ENDED_CLOSE_CODE &&
        replaySafe(init)
      ) {
        const fresh = await this.#session(entry, method);
        return relayResponse(await fresh.request(record));
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
  async #session(entry: CarrierEntry, method: ConnectionMethod): Promise<RelayClientSession> {
    const address = carrierAddress(method);
    return await this.#hold(entry, requestSessionKey(address), address, async () =>
      this.#openKeyed(entry, method, device => ({ kind: 'auth', device })),
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
    const session = await this.#hold(entry, key, address, async () =>
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
    const open = async (claim: SessionDeviceClaim): Promise<RelayClientSession> =>
      await openRelaySession({
        crypto: this.#crypto,
        dial: this.#dial,
        daemon: entry.connection,
        method,
        ...(this.#heartbeat === undefined ? {} : { heartbeat: this.#heartbeat }),
        mode: mode(claim),
        ...(onData === undefined ? {} : { onData }),
      });
    try {
      return await open(device);
    } catch (refused) {
      const rotation = this.#rotation;
      const daemonId = entry.connection.daemonId;
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
  ): Promise<RelayClientSession> {
    const existing = entry.sessions.get(key);
    if (existing !== undefined) {
      const current = await existing.session.catch(() => undefined);
      if (current?.live() === true || current?.streaming() === true) return current;
      entry.sessions.delete(key);
    }
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
