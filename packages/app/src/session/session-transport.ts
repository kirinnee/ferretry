import type {
  DaemonTransport,
  RawEvent,
  SocketListeners,
  TransportAnswer,
  TransportRequest,
  TransportSocket,
} from '../client/transport.ts';
import {
  RelayClientSession,
  RelaySessionError,
  type RelayClientSessionDependencies,
  type RelayClientSocket,
  type RelayStreamFrame,
  type RelayTunnelAnswer,
  type SessionDeviceClaim,
} from './session-client.ts';
import { fromBase64Url, RELAY_ACCESS_LEASE_ENDED_CLOSE_CODE, type RelayCrypto, toBase64Url } from './wire/index.ts';

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

export interface SessionTransportOptions {
  readonly crypto: RelayCrypto;
  /** The fingerprint the pairing pinned. */
  readonly daemonId: string;
  readonly device: SessionDeviceClaim;
  readonly dial: CarrierDial;
  /** The event stream route (the kernel's); frames are `{ name, payload }` JSON text, one event per frame. */
  readonly eventsPath?: string;
}

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
  for (;;) {
    const opened = openSession(options, dial, mode);
    try {
      await opened.session.ready();
    } catch (reason) {
      const onward = opened.socket.onward?.();
      if (onward === undefined) throw reason;
      dial = onward;
      continue;
    }
    opened.socket.accepted?.();
    return opened;
  }
}

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
  #session: Promise<OpenedSession> | undefined;
  #opened = 0;

  constructor(options: SessionTransportOptions) {
    this.#options = options;
  }

  /** The live request session, or a new one when the last ended (a lease ran out, the carrier dropped). */
  #requestSession(): Promise<OpenedSession> {
    const current = this.#session;
    if (current !== undefined) {
      return current.then(opened => (opened.session.live() ? opened : this.#fresh()));
    }
    return this.#fresh();
  }

  #fresh(): Promise<OpenedSession> {
    const ready = acceptedSession(this.#options, { kind: 'auth', device: this.#options.device });
    this.#session = ready;
    ready.catch(() => {
      if (this.#session === ready) this.#session = undefined;
    });
    this.#opened += 1;
    // Every session after the first is a reconnect: the client re-reads the inventory before anything resumes.
    if (this.#opened > 1) ready.then(() => this.#announceReconnect()).catch(() => {});
    return ready;
  }

  #announceReconnect(): void {
    for (const listener of this.#reconnect) listener();
  }

  async request(request: TransportRequest): Promise<TransportAnswer> {
    const session = await this.#requestSession();
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
      const fresh = await this.#requestSession();
      try {
        answer = await fresh.session.request(record, request.signal);
      } catch (again) {
        lostUnder(fresh, again, request.signal);
        throw again;
      }
    }
    return { status: answer.status, headers: answer.headers, body: decodeBody(answer.body) };
  }

  events(listener: (event: RawEvent) => void, onClose: (reason: string) => void): () => void {
    const path = this.#options.eventsPath ?? '/v1/events';
    const stream = this.socket(path, {
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
    const end = (reason: string): void => {
      if (closed) return;
      closed = true;
      listeners.onClose(reason);
    };
    const mode: RelayClientSessionDependencies['mode'] = {
      kind: 'stream',
      device: this.#options.device,
      path: url.pathname,
      ...(query.length === 0 ? {} : { query }),
    };
    const onData = (frame: RelayStreamFrame): void =>
      listeners.onFrame(frame.kind === 'text' ? frame.text : frame.bytes);
    let session: RelayClientSession | undefined;
    // A stream the daemon never opened carried nothing (a stream session sends no data before `stream-opened`), so it
    // walks on to a fresh session over the carrier's next leg exactly as a request session does.
    const open = (dial: CarrierDial): void => {
      const opened = openSession(this.#options, dial, mode, onData);
      session = opened.session;
      opened.session.onStreamClosed(closedWith => end(closedWith.reason));
      opened.session.ready().then(
        () => opened.socket.accepted?.(),
        (error: unknown) => {
          if (closed) return;
          const onward = opened.socket.onward?.();
          if (onward !== undefined) {
            open(onward);
            return;
          }
          end(error instanceof Error ? error.message : String(error));
        },
      );
    };
    open(this.#options.dial);
    return {
      send: frame =>
        session?.sendStream(
          typeof frame === 'string' ? { kind: 'text', text: frame } : { kind: 'bytes', bytes: frame },
        ),
      close: () => {
        if (closed) return;
        closed = true;
        session?.closeStream();
      },
    };
  }

  onReconnect(listener: () => void): () => void {
    this.#reconnect.add(listener);
    return () => this.#reconnect.delete(listener);
  }

  close(): void {
    void this.#session?.then(opened => opened.session.close()).catch(() => {});
    this.#session = undefined;
  }
}

/** Base64url helpers re-exported for the composition root (an app-session id is 16 random bytes). */
export { fromBase64Url, toBase64Url };
