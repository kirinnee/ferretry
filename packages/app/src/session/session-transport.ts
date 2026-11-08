import type {
  DaemonTransport,
  RawEvent,
  SocketListeners,
  TransportAnswer,
  TransportRequest,
  TransportSocket,
} from '../client/transport.ts';
import {
  type DeviceKeyRotation,
  RelayClientSession,
  RelaySessionError,
  type RelayClientSessionDependencies,
  type RelayClientSocket,
  type RelayStreamFrame,
  type RelayTunnelAnswer,
  type SessionDeviceClaim,
} from './session-client.ts';
import { sharingIdenticalReads } from './shared-reads.ts';
import {
  fromBase64Url,
  MAX_PLAINTEXT_BYTES,
  type PrivateKeyHandle,
  RELAY_ACCESS_LEASE_ENDED_CLOSE_CODE,
  RELAY_CLOSE_CODES,
  type RelayCrypto,
  toBase64Url,
} from './wire/index.ts';

/**
 * THE SEALED SESSION, AS THE GENERATED CLIENT'S TRANSPORT (§9.6, §4.8). Every call is a `req` inside a sealed
 * request session; the event stream and every socket route are each their own stream session. The daemon is
 * proved against the fingerprint the pairing pinned before anything is sent, and the device proves its grant by
 * signing each session's transcript with its non-extractable key: nothing on the wire replays.
 *
 * WHICH CARRIER is Connections' choice (direct, WebRTC, tunnel, relay; §4.8): it hands the shell a {@link CarrierDial}
 * that opens one socket to wherever it decided. The shell never names an address and holds no global network
 * function; the socket factory is injected at the composition root.
 */

export interface CarrierSocketEvents {
  readonly onBinary: (bytes: Uint8Array) => void;
  readonly onText: (text: string) => void;
  readonly onClose: (code: number, reason: string) => void;
  /** This socket carries one live stream (an event or terminal stream), not request sessions. */
  readonly stream?: boolean;
}

/**
 * What a carrier that WALKS may add to the socket it hands one session. Both members are optional, so any plain
 * socket (the shell's own direct dial) is one, and a session over it behaves exactly as it always did.
 *
 * Today's rule (PWA `relay-carrier.ts`, `RelayUnsentError`): a session the daemon never accepted carried no request,
 * so even a write may try the next carrier, on a FRESH session — the old one's handshake belongs to the old carrier.
 * Only the session knows when the daemon accepted it, so it says so; only the carrier knows what is left to try.
 */
export interface CarrierWalkSocket extends RelayClientSocket {
  /** The daemon accepted the session on this socket (`ready()` resolved): this carrier carries. */
  accepted?(): void;
  /**
   * The session on this socket ended before the daemon accepted it. The dial for a fresh session on the walk's next
   * carrier, or `undefined` when there is none left (or the walk was retired).
   */
  onward?(): CarrierDial | undefined;
  /**
   * A request on the accepted session failed because the session ended under it (today's request path forgets the
   * remembered carrier then). A session that ended idle says nothing: the carrier is redialled first next time.
   */
  requestLost?(): void;
}

/** Opens one carrier socket for one session. */
export type CarrierDial = (events: CarrierSocketEvents) => CarrierWalkSocket;

/**
 * DEVICE-KEY ROTATION, THE SESSION LAYER'S PORT (`docs/design/zero-trust.md` B6; R248, R252). Access provides the one
 * implementation (its `KeyRotation`, beside its device claims); the session layer applies it, because only here are
 * the session that signs the proof and the request that carries it both in reach. Copied from today's
 * `DaemonCarrierRouter`: the unlock or step-up a due device sends carries a replacement key signed over the transcript
 * of the session carrying it, the answer settles that key, and a session the old key is refused on is tried ONCE with
 * the pending key, so a device whose answer was lost is never stranded.
 */
export interface RotatingSession {
  /** When the daemon wants this device's key replaced, or `undefined` when it asked for nothing. */
  rotateBy(): string | undefined;
  /** The NEW key's signature over this session's transcript. */
  signRotation(deviceId: string, newKey: PrivateKeyHandle, newPublicKey: string): Promise<DeviceKeyRotation>;
}

/** The part of a request a rotation reads and may amend: the body of an unlock or step-up. */
export interface RotationRequest {
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
}

/** A request, and whether it now carries a replacement key whose fate must be settled afterwards. */
export interface AmendedRotation<Request extends RotationRequest> {
  readonly request: Request;
  readonly rotated: boolean;
}

export interface SessionKeyRotation {
  /** Adds the replacement to an unlock or step-up when the session says it is due; anything else is untouched. */
  amend<Request extends RotationRequest>(
    session: RotatingSession,
    daemon: { readonly daemonId: string; readonly deviceId: string },
    request: Request,
  ): Promise<AmendedRotation<Request>>;
  /** The daemon answered a request that carried a rotation: promote the pending key on `keyRotated`, else discard. */
  settle(daemonId: string, answer: Pick<TransportAnswer, 'status' | 'body'>): Promise<void>;
  /** The pending key as a handle to sign a session with, or nothing when no rotation is in flight. */
  pending(daemonId: string): Promise<PrivateKeyHandle | undefined>;
  /** The old key was refused and the pending one opened a session: it is the key now. */
  promote(daemonId: string): Promise<void>;
  /** The pending key was refused too: the daemon never swapped. */
  discard(daemonId: string): Promise<void>;
}

/** A stream this side ends on purpose is a normal closure, never a drop. */
const NORMAL_CLOSE = 1000;
/**
 * The kernel's event BUS socket (`GET /v1/bus`, declared in the kernel manifest): one `{ name, payload }` frame per event
 * the caller's admission lets it discover. `/v1/events` is Ferrets' session journal stream and carries no plugin event.
 */
export const BUS_PATH = '/v1/bus';

/** `4403` is the one code that means this device is not accepted (today's `deviceRefusal`). */
const deviceRefusal = (reason: unknown): boolean =>
  reason instanceof RelaySessionError && reason.code === RELAY_CLOSE_CODES.authRejected;

export interface SessionTransportOptions {
  readonly crypto: RelayCrypto;
  /** The fingerprint the pairing pinned. */
  readonly daemonId: string;
  readonly device: SessionDeviceClaim;
  /**
   * Reads the device claim again for every session this transport opens (today's `#claim`, per session), so a key
   * a rotation promoted is the key the next session proves with. Absent, every session proves {@link device}.
   */
  readonly claim?: () => Promise<SessionDeviceClaim | undefined>;
  /** Access's device-key rotation ({@link SessionKeyRotation}); absent, this transport never rotates. */
  readonly rotation?: SessionKeyRotation;
  readonly dial: CarrierDial;
  /** The event stream route (the kernel's); frames are `{ name, payload }` JSON text, one event per frame. */
  readonly eventsPath?: string;
}

/**
 * Which request session carries a request: `bulk` for a body that has to travel in parts, `request` for everything
 * else (R532; moved from today's `requestLane`).
 *
 * A SESSION IS ONE CREDIT WINDOW AND ONE QUEUE, so a request waits behind every record queued ahead of it. A phone photo
 * is about eighty records; a few of them queued ahead of the fleet list's poll held it past its deadline, and a request
 * that misses its deadline retires the session it was on — the one carrying the uploads. Bodies that need parts
 * therefore share a session of their own, and the reads every panel polls never wait behind one.
 */
export type RequestLane = 'request' | 'bulk';

const requestLane = (body: string | undefined): RequestLane =>
  body !== undefined && body.length > MAX_PLAINTEXT_BYTES / 2 ? 'bulk' : 'request';

/** A body sent as JSON text; an answer read back as JSON when it parses, else kept as text. */
function encodeBody(body: unknown): string | undefined {
  if (body === undefined) return undefined;
  return typeof body === 'string' ? body : JSON.stringify(body);
}

function decodeBody(text: string): unknown {
  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

interface OpenedSession {
  readonly session: RelayClientSession;
  readonly socket: CarrierWalkSocket;
  /** The claim this session proved: the device id a rotation is signed for. */
  readonly device?: SessionDeviceClaim;
}

function openSession(
  options: SessionTransportOptions,
  dial: CarrierDial,
  mode: RelayClientSessionDependencies['mode'],
  onData?: (frame: RelayStreamFrame) => void,
): OpenedSession {
  let session: RelayClientSession | undefined;
  const socket = dial({
    onBinary: bytes => void session?.receiveBinary(bytes),
    onText: text => session?.receiveText(text),
    onClose: (code, reason) => session?.carrierClosed(code, reason),
    ...(mode.kind === 'stream' ? { stream: true } : {}),
  });
  session = new RelayClientSession({
    crypto: options.crypto,
    daemonId: options.daemonId,
    mode,
    socket,
    ...(onData === undefined ? {} : { onData }),
  });
  return { session, socket };
}

/**
 * A request session the daemon ACCEPTED, walking on to a fresh session over the carrier's next leg each time one ends
 * before acceptance (see {@link CarrierWalkSocket}). Nothing a request needs has left before acceptance, so the walk
 * is safe for a write too; once the daemon accepted, a failure is the session's and is never re-dialled here.
 */
async function acceptedSession(
  options: SessionTransportOptions,
  mode: RelayClientSessionDependencies['mode'],
): Promise<OpenedSession> {
  let dial = options.dial;
  // A refusal seen on ANY leg wins over a later leg's carrier failure (today's `refused ||= deviceRefusal(reason)`):
  // the leg that refused is the one the pending key (R252) must be tried on, and it only is when this walk ends in it.
  let refused: unknown;
  for (;;) {
    const opened = openSession(options, dial, mode);
    try {
      await opened.session.ready();
    } catch (reason) {
      if (refused === undefined && deviceRefusal(reason)) refused = reason;
      const onward = opened.socket.onward?.();
      if (onward === undefined) throw refused ?? reason;
      dial = onward;
      continue;
    }
    opened.socket.accepted?.();
    return opened;
  }
}

/** Said when the claim reader finds no key for this daemon any more (the pairing was removed under the transport). */
export const NO_DEVICE_KEY = 'this device no longer holds a key for this machine';

const pairs = (query: Readonly<Record<string, string>> | undefined): readonly (readonly [string, string])[] =>
  Object.entries(query ?? {});

/**
 * A request failed: when its session ended under it, the carrier lost it (today's request path, which then forgets the
 * remembered carrier). The caller's own abort, or a session still live (an answer), says nothing about the carrier.
 */
function lostUnder(opened: OpenedSession, reason: unknown, signal: AbortSignal | undefined): void {
  if (signal?.aborted === true && reason === signal.reason) return;
  if (opened.session.live()) return;
  opened.socket.requestLost?.();
}

export class SessionTransport implements DaemonTransport {
  readonly #options: SessionTransportOptions;
  readonly #reconnect = new Set<() => void>();
  /** One request session per lane (R532): the reads every panel polls, and the bodies that travel in parts. */
  readonly #sessions = new Map<RequestLane, Promise<OpenedSession>>();
  readonly #opened = new Map<RequestLane, number>();
  /** Every stream this transport opened and has not seen end, each as how to end it (R568). */
  readonly #streams = new Set<(reason: string) => void>();
  /** Identical reads in flight are sent once (R519). */
  readonly #sharing = sharingIdenticalReads(request => this.#send(request));

  constructor(options: SessionTransportOptions) {
    this.#options = options;
  }

  /** The lane's live request session, or a new one when the last ended (a lease ran out, the carrier dropped). */
  #requestSession(lane: RequestLane): Promise<OpenedSession> {
    const current = this.#sessions.get(lane);
    if (current !== undefined) {
      return current.then(opened => (opened.session.live() ? opened : this.#fresh(lane)));
    }
    return this.#fresh(lane);
  }

  /** The claim the next session proves: read again per session when a reader was given. */
  async #claim(): Promise<SessionDeviceClaim> {
    if (this.#options.claim === undefined) return this.#options.device;
    const claim = await this.#options.claim();
    if (claim === undefined) throw new Error(NO_DEVICE_KEY);
    return claim;
  }

  /**
   * Opens one request session with the device key, and with the PENDING key once if the daemon refuses the first
   * (R252). Copied from today's `DaemonCarrierRouter.#openKeyed`: `4403` is what an old key earns from a daemon that
   * already swapped after a rotation whose answer was lost, so a refusal is followed by exactly one more attempt with
   * the replacement this browser kept before it sent it — accepted, and that key is promoted; refused as well, and
   * the daemon never took it, so it is discarded. Any OTHER failure of the second attempt is a fact about the
   * carrier, not about the key, so the pending key is kept for the next session and the first failure is reported.
   */
  async #openKeyed(): Promise<OpenedSession> {
    const device = await this.#claim();
    try {
      return { ...(await acceptedSession(this.#options, { kind: 'auth', device })), device };
    } catch (refused) {
      const { rotation, daemonId } = this.#options;
      const pending = deviceRefusal(refused) ? await rotation?.pending(daemonId).catch(() => undefined) : undefined;
      if (rotation === undefined || pending === undefined) throw refused;
      const rotated = { ...device, key: pending };
      try {
        const opened = await acceptedSession(this.#options, { kind: 'auth', device: rotated });
        await rotation.promote(daemonId);
        return { ...opened, device: rotated };
      } catch (again) {
        if (deviceRefusal(again)) await rotation.discard(daemonId);
        throw refused;
      }
    }
  }

  #fresh(lane: RequestLane): Promise<OpenedSession> {
    const ready = this.#openKeyed();
    this.#sessions.set(lane, ready);
    ready.catch(() => {
      if (this.#sessions.get(lane) === ready) this.#sessions.delete(lane);
    });
    const opened = (this.#opened.get(lane) ?? 0) + 1;
    this.#opened.set(lane, opened);
    // Every session after a lane's first is a reconnect: the client re-reads the inventory before anything resumes.
    if (opened > 1) ready.then(() => this.#announceReconnect()).catch(() => {});
    return ready;
  }

  #announceReconnect(): void {
    for (const listener of this.#reconnect) listener();
  }

  request(given: TransportRequest): Promise<TransportAnswer> {
    return this.#sharing(given);
  }

  async #send(given: TransportRequest): Promise<TransportAnswer> {
    const lane = requestLane(encodeBody(given.body));
    const session = await this.#requestSession(lane);
    const rotation = this.#options.rotation;
    const daemon = { daemonId: this.#options.daemonId, deviceId: (session.device ?? this.#options.device).deviceId };
    // AMENDED HERE, on the session that will carry the request (R248), because the rotation proof signs THAT
    // session's transcript and the daemon refuses it on any other. Only a read is ever sent again on another session
    // below, and an unlock or a step-up is a POST, so the proof is never carried to another.
    const amended =
      rotation === undefined
        ? { request: given, rotated: false }
        : await rotation.amend(session.session, daemon, given);
    const request = amended.request;
    const body = encodeBody(request.body);
    const headers = {
      ...(request.body === undefined || typeof request.body === 'string' ? {} : { 'content-type': 'application/json' }),
      ...request.headers,
    };
    const record = {
      method: request.method,
      path: request.path,
      ...(request.query === undefined ? {} : { query: pairs(request.query) }),
      ...(Object.keys(headers).length === 0 ? {} : { headers }),
      ...(body === undefined ? {} : { body }),
    };
    let answer: RelayTunnelAnswer;
    try {
      answer = await session.session.request(record, request.signal);
    } catch (reason) {
      // R244, copied from today's relay-carrier: a lapsed lease silently reopens a read ONCE.
      // A write may already have happened, and a revocation is final on every method.
      if (
        !(reason instanceof RelaySessionError) ||
        reason.code !== RELAY_ACCESS_LEASE_ENDED_CLOSE_CODE ||
        !['GET', 'HEAD'].includes(request.method.toUpperCase())
      ) {
        lostUnder(session, reason, request.signal);
        throw reason;
      }
      const fresh = await this.#requestSession(lane);
      try {
        answer = await fresh.session.request(record, request.signal);
      } catch (again) {
        lostUnder(fresh, again, request.signal);
        throw again;
      }
    }
    const result = { status: answer.status, headers: answer.headers, body: decodeBody(answer.body) };
    // Only an ANSWER settles the pending key. A request that died without one leaves it pending, which is the
    // recovery: the daemon may have swapped and the answer is what was lost (R252, {@link #openKeyed}).
    if (amended.rotated) await rotation?.settle(daemon.daemonId, result);
    return result;
  }

  events(listener: (event: RawEvent) => void, onClose: (reason: string) => void, onOpen?: () => void): () => void {
    const path = this.#options.eventsPath ?? BUS_PATH;
    const stream = this.socket(path, {
      ...(onOpen === undefined ? {} : { onOpen }),
      onFrame: frame => {
        if (typeof frame !== 'string') return;
        let value: unknown;
        try {
          value = JSON.parse(frame);
        } catch {
          return;
        }
        if (typeof value !== 'object' || value === null) return;
        const { name, payload } = value as { name?: unknown; payload?: unknown };
        if (typeof name === 'string' && name.length <= 128) listener({ name, payload });
      },
      onClose,
    });
    return () => stream.close();
  }

  socket(path: string, listeners: SocketListeners): TransportSocket {
    const url = new URL(path, 'http://session.invalid');
    const query = [...url.searchParams.entries()];
    let closed = false;
    const end = (reason: string, code?: number): void => {
      if (closed) return;
      closed = true;
      this.#streams.delete(shutdown);
      listeners.onClose(reason, code);
    };
    // The transport closing ends this stream too (R568), and says so: the page did not ask for it.
    const shutdown = (reason: string): void => {
      if (closed) return;
      closed = true;
      this.#streams.delete(shutdown);
      leave(NORMAL_CLOSE, reason);
      listeners.onClose(reason, NORMAL_CLOSE);
    };
    this.#streams.add(shutdown);
    const mode = (device: SessionDeviceClaim): RelayClientSessionDependencies['mode'] => ({
      kind: 'stream',
      device,
      path: url.pathname,
      ...(query.length === 0 ? {} : { query }),
    });
    // A stream closed while its session was still OPENING must not survive the daemon accepting it (R568): a session that
    // is not yet streaming is ended outright (which aborts the handshake), and one that opens afterwards is ended the
    // moment it does ({@link open}). Only a session already carrying the stream says so on the wire.
    let streaming = false;
    const leave = (code?: number, reason?: string): void => {
      if (session === undefined) return;
      if (streaming) session.closeStream(code, reason);
      else session.close(reason);
    };
    const onData = (frame: RelayStreamFrame): void => {
      if (closed) return;
      listeners.onFrame(frame.kind === 'text' ? frame.text : frame.bytes);
    };
    // The close code a refused stream carried survives to the page (R567): a `4429` ceiling must not read as a drop.
    const failed = (error: unknown): void =>
      end(
        error instanceof Error ? error.message : String(error),
        error instanceof RelaySessionError ? error.code : undefined,
      );
    const { rotation, daemonId } = this.#options;
    let session: RelayClientSession | undefined;
    // A stream the daemon never opened carried nothing (a stream session sends no data before `stream-opened`), so it
    // walks on to a fresh session over the carrier's next leg exactly as a request session does. A stream the device
    // key is REFUSED on is tried once with the pending key, exactly as a request session is (R252, {@link #openKeyed}).
    const open = (dial: CarrierDial, device: SessionDeviceClaim, retry?: { readonly refused: unknown }): void => {
      const opened = openSession(this.#options, dial, mode(device), onData);
      session = opened.session;
      streaming = false;
      opened.session.onStreamClosed(closedWith => end(closedWith.reason, closedWith.code));
      opened.session.ready().then(
        () => {
          if (closed) {
            opened.session.close('the stream was closed before it opened');
            return;
          }
          streaming = true;
          opened.socket.accepted?.();
          if (retry !== undefined) void rotation?.promote(daemonId).catch(() => undefined);
          listeners.onOpen?.();
        },
        (error: unknown) => {
          if (closed) return;
          if (retry !== undefined) {
            const discarded = deviceRefusal(error) ? rotation?.discard(daemonId) : undefined;
            void Promise.resolve(discarded)
              .catch(() => undefined)
              .then(() => failed(retry.refused));
            return;
          }
          if (deviceRefusal(error) && rotation !== undefined) {
            void rotation
              .pending(daemonId)
              .catch(() => undefined)
              .then(pending => {
                if (closed) return;
                if (pending === undefined) failed(error);
                else open(this.#options.dial, { ...device, key: pending }, { refused: error });
              });
            return;
          }
          const onward = opened.socket.onward?.();
          if (onward !== undefined) {
            open(onward, device);
            return;
          }
          failed(error);
        },
      );
    };
    this.#claim().then(device => {
      if (!closed) open(this.#options.dial, device);
    }, failed);
    return {
      send: frame =>
        session?.sendStream(
          typeof frame === 'string' ? { kind: 'text', text: frame } : { kind: 'bytes', bytes: frame },
        ),
      close: (code, reason) => {
        if (closed) return;
        closed = true;
        this.#streams.delete(shutdown);
        leave(code, reason);
      },
    };
  }

  onReconnect(listener: () => void): () => void {
    this.#reconnect.add(listener);
    return () => this.#reconnect.delete(listener);
  }

  /** Ends every session this transport owns: each request lane's, and every stream it opened and none has ended (R568). */
  close(): void {
    for (const ready of this.#sessions.values()) void ready.then(opened => opened.session.close()).catch(() => {});
    this.#sessions.clear();
    for (const shutdown of [...this.#streams]) shutdown('the transport was closed');
  }
}

/** Base64url helpers re-exported for the composition root (an app-session id is 16 random bytes). */
export { fromBase64Url, toBase64Url };
