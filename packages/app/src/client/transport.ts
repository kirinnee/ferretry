/**
 * THE ONE WAY THE APP REACHES A DAEMON (§9.6): a sealed session, opened by the session client
 * (`src/session/`), carried by whichever carrier Connections chose. Everything above this port is the generated
 * per-daemon client; nothing in the app sends a byte to a daemon any other way, so the hash guard in front of this
 * port cannot be walked around.
 *
 * There is no global network function anywhere in this package: the session client is constructed with an injected
 * socket factory at the composition root.
 */

export interface TransportRequest {
  readonly method: string;
  /** The concrete path, parameters already substituted and encoded. */
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
  /** Answer with the body exactly as the daemon sent it — text, never decoded as JSON — for a route that carries a capture. */
  readonly raw?: boolean;
}

export interface TransportAnswer {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  /** The parsed JSON body, or the text when the answer is not JSON. */
  readonly body: unknown;
}

/** One event as it came off the daemon's event stream: a name and an UNPARSED payload. */
export interface RawEvent {
  readonly name: string;
  readonly payload: unknown;
}

/** A live stream (an event stream, a terminal, a page). Bytes or text frames in, frames out. */
export interface TransportSocket {
  send(frame: string | Uint8Array): void;
  close(): void;
}

/**
 * What a carrier knows about how a socket ended, beyond the words. Every field is optional: a socket that never
 * reached the daemon (a paused plugin, a carrier that could not dial) carries none.
 */
export interface SocketCloseDetail {
  /** The stream's OWN close code (`1000` a deliberate end, `1008`/`1009` the daemon's verdict on this viewer), never the session's. */
  readonly code?: number;
  /** The status the daemon refused the open with: final for this attempt, never a reason to reconnect. */
  readonly refusedStatus?: number;
  /** The refusal's body, as the daemon sent it. */
  readonly body?: string;
}

export interface SocketListeners {
  readonly onFrame: (frame: string | Uint8Array) => void;
  /** Fires once the daemon has accepted the stream, and not before; a socket that never opens never calls it. */
  readonly onOpen?: () => void;
  readonly onClose: (reason: string, detail?: SocketCloseDetail) => void;
}

export interface DaemonTransport {
  request(request: TransportRequest): Promise<TransportAnswer>;
  /** Opens the daemon's event stream; every event is handed over raw. Returns a cancel. */
  events(listener: (event: RawEvent) => void, onClose: (reason: string) => void): () => void;
  /** Opens one socket route (`GET /v1/.../stream`). */
  socket(path: string, listeners: SocketListeners): TransportSocket;
  /** Fires after a reconnect, before anything resumes: the client re-reads the inventory first (§9.6). */
  onReconnect(listener: () => void): () => void;
}

/** A refused answer, thrown by the generated client. `code` is the daemon's machine code or `plugin_paused`. */
export class DaemonCallError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DaemonCallError';
  }
}
