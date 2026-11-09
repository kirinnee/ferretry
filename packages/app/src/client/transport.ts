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
  /** Leave on purpose. The code and reason travel to the daemon (a deliberate leave is never spelled as a drop). */
  close(code?: number, reason?: string): void;
}

export interface SocketListeners {
  /** The daemon accepted the stream: from here a frame sent reaches it (a frame sent before is dropped). */
  readonly onOpen?: () => void;
  readonly onFrame: (frame: string | Uint8Array) => void;
  /**
   * The stream ended. `code` is the close code the daemon (or the carrier) ended it with — it is THIS code a caller
   * decides to reconnect on (`1008` is a refusal, not a drop) — and is absent when the stream never opened.
   */
  readonly onClose: (reason: string, code?: number) => void;
}

export interface DaemonTransport {
  request(request: TransportRequest): Promise<TransportAnswer>;
  /**
   * Opens the daemon's event stream; every event is handed over raw. `onOpen` fires when the daemon accepted the
   * stream (the feed is live from there to `onClose`). Returns a cancel.
   */
  events(listener: (event: RawEvent) => void, onClose: (reason: string) => void, onOpen?: () => void): () => void;
  /** Opens one socket route (`GET /v1/.../stream`). */
  socket(path: string, listeners: SocketListeners): TransportSocket;
  /** Fires after a reconnect, before anything resumes: the client re-reads the inventory first (§9.6). */
  onReconnect(listener: () => void): () => void;
  /**
   * Ends every session this transport opened and every stream on it (R568). The shell calls it when the daemon is
   * unpaired, so nothing keeps a live session or a key after that. A transport that owns no session has none to end.
   */
  close?(): void;
}

/** A refused answer, thrown by the generated client. `code` is the daemon's machine code or `plugin_paused`. */
export class DaemonCallError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** The refusal's whole JSON body, for a route whose refusal carries a fact beside its sentence (a 409 naming
     *  the draft that holds the agent's box, the send that was typed but never shown, an in-flight inventory, a size). */
    readonly body?: unknown,
    /**
     * `true` when the call died on the CARRIER (the session closed, the rendezvous ended, a deadline passed) rather
     * than with an answer from the daemon (S12). A screen keeps its last good content through one, because the
     * connection model is already retrying; an answer, whatever its status, is news.
     */
    readonly carrier?: true,
    /** The failure this one stands for, kept so the original reason is never lost (S12). */
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'DaemonCallError';
  }
}

/** The machine code a carrier outage carries; no daemon says it. */
export const CARRIER_OUTAGE_CODE = 'carrier_outage';
/** The machine code a call carries when a session ended with the device-refused close (`4403`). */
export const DEVICE_REFUSED_CODE = 'device_refused';

/** Whether a failure is a carrier outage (S12): the call never got an answer. Total; reads one `cause` level too. */
export function isCarrierOutage(error: unknown): boolean {
  if (error instanceof DaemonCallError) return error.carrier === true;
  return error instanceof Error && error.cause instanceof DaemonCallError && error.cause.carrier === true;
}

/**
 * The close code the daemon ends a session with when it does not accept this device (the session wire's
 * `RELAY_CLOSE_CODES.authRejected`; a parity test pins the two together). The client layer reads it off a transport
 * failure without importing the wire.
 */
export const DEVICE_REFUSED_CLOSE_CODE = 4403;

/** Whether a transport failure is the daemon saying it no longer accepts this device (revoked, or unused for too long). */
export function isDeviceRefusal(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === 'RelaySessionError' &&
    (error as { readonly code?: unknown }).code === DEVICE_REFUSED_CLOSE_CODE
  );
}

/**
 * The session close codes that mean the CARRIER went away rather than the daemon answering (S12): the rendezvous had
 * no daemon on the route (`4404`), the claim timed out or was lost (`4402`, `4410`), the socket stopped answering
 * heartbeats (`4408`), it is full or the hosted relay is off, over capacity or over its bandwidth (`4429`, `4431`-`4433`),
 * a session ended with no sealed outcome (`4440`), its access lease ended (`4441`), or the rendezvous itself failed
 * (`4500`). A parity test pins each to the session wire. Anything else — `4426` (the daemon's own "update this app"),
 * the `4400`-class protocol and integrity codes, `4403` — is an ANSWER or a defect, not an outage.
 */
const CARRIER_GONE_CLOSE_CODES: ReadonlySet<number> = new Set([
  4402, 4404, 4408, 4410, 4429, 4431, 4432, 4433, 4440, 4441, 4500,
]);

/**
 * Whether a transport failure says the call died on the carrier before any answer (S12): a close with no outcome (a
 * browser close code, `1006` included, is below 4000), one of the carrier-gone close codes above, a request that was never
 * sent, or a machine read that gave up waiting. Total. Everything else (a refusal, a protocol error, a missing key, a
 * plain `Error`) is not an outage and keeps its own words.
 */
export function isCarrierGone(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'RelayRequestNotSentError' || error.name === 'MachineDeadlineError') return true;
  if (error.name !== 'RelaySessionError') return false;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === 'number' && (code < 4000 || CARRIER_GONE_CLOSE_CODES.has(code));
}
