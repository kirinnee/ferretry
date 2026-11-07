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
}

/** Opens one carrier socket for one session. */
export type CarrierDial = (events: CarrierSocketEvents) => RelayClientSocket;

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

function openSession(
  options: SessionTransportOptions,
  mode: RelayClientSessionDependencies['mode'],
  onData?: (frame: RelayStreamFrame) => void,
): RelayClientSession {
  let session: RelayClientSession | undefined;
  const socket = options.dial({
    onBinary: bytes => void session?.receiveBinary(bytes),
    onText: text => session?.receiveText(text),
    onClose: (code, reason) => session?.carrierClosed(code, reason),
  });
  session = new RelayClientSession({
    crypto: options.crypto,
    daemonId: options.daemonId,
    mode,
    socket,
    ...(onData === undefined ? {} : { onData }),
  });
  return session;
}

const pairs = (query: Readonly<Record<string, string>> | undefined): readonly (readonly [string, string])[] =>
  Object.entries(query ?? {});

export class SessionTransport implements DaemonTransport {
  readonly #options: SessionTransportOptions;
  readonly #reconnect = new Set<() => void>();
  #session: Promise<RelayClientSession> | undefined;
  #opened = 0;

  constructor(options: SessionTransportOptions) {
    this.#options = options;
  }

  /** The live request session, or a new one when the last ended (a lease ran out, the carrier dropped). */
  #requestSession(): Promise<RelayClientSession> {
    const current = this.#session;
    if (current !== undefined) {
      return current.then(session => (session.live() ? session : this.#fresh()));
    }
    return this.#fresh();
  }

  #fresh(): Promise<RelayClientSession> {
    const session = openSession(this.#options, { kind: 'auth', device: this.#options.device });
    const ready = session.ready();
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
      answer = await session.request(record, request.signal);
    } catch (reason) {
      // R244, copied from today's relay-carrier: a lapsed lease silently reopens a read ONCE.
      // A write may already have happened, and a revocation is final on every method.
      if (
        !(reason instanceof RelaySessionError) ||
        reason.code !== RELAY_ACCESS_LEASE_ENDED_CLOSE_CODE ||
        !['GET', 'HEAD'].includes(request.method.toUpperCase())
      )
        throw reason;
      const fresh = await this.#requestSession();
      answer = await fresh.request(record, request.signal);
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
    const session = openSession(
      this.#options,
      {
        kind: 'stream',
        device: this.#options.device,
        path: url.pathname,
        ...(query.length === 0 ? {} : { query }),
      },
      frame => listeners.onFrame(frame.kind === 'text' ? frame.text : frame.bytes),
    );
    const end = (reason: string): void => {
      if (closed) return;
      closed = true;
      listeners.onClose(reason);
    };
    session.onStreamClosed(closedWith => end(closedWith.reason));
    session.ready().catch((error: unknown) => end(error instanceof Error ? error.message : String(error)));
    return {
      send: frame =>
        session.sendStream(typeof frame === 'string' ? { kind: 'text', text: frame } : { kind: 'bytes', bytes: frame }),
      close: () => {
        if (closed) return;
        closed = true;
        session.closeStream();
      },
    };
  }

  onReconnect(listener: () => void): () => void {
    this.#reconnect.add(listener);
    return () => this.#reconnect.delete(listener);
  }

  close(): void {
    void this.#session?.then(session => session.close()).catch(() => {});
    this.#session = undefined;
  }
}

/** Base64url helpers re-exported for the composition root (an app-session id is 16 random bytes). */
export { fromBase64Url, toBase64Url };
