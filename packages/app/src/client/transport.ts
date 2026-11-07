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

export interface SocketListeners {
  readonly onFrame: (frame: string | Uint8Array) => void;
  readonly onClose: (reason: string) => void;
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
    /** The refusal's whole JSON body, for a route whose refusal carries a fact beside its sentence (a 409 naming
     *  the draft that holds the agent's box, or the send that was typed but never shown). */
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'DaemonCallError';
  }
}
