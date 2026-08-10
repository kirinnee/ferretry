import { isLoopbackPeer } from '@ferretry/protocol';
import {
  type ApiBindOptions,
  type ApiRequest,
  type ApiResponse,
  type ApiServerHandle,
  type ApiServerPort,
  type ApiSurface,
  admitPendingSocketFrame,
  errorResponse,
  headersFrom,
  MAX_REQUEST_BODY_BYTES,
  queryFrom,
  readBoundedBody,
  SOCKET_CLOSES,
  SOCKET_MAX_FRAME_BYTES,
  type SocketAttachment,
  type SocketClose,
  type SocketDownstream,
  type SocketFrame,
  type SocketHandler,
} from '../../lib/api/index.ts';

/**
 * What one upgraded request carries into the socket handlers.
 *
 * It exists because the switch and the attachment are not the same moment: the protocol changes
 * synchronously inside `fetch`, while resolving the session, the terminal and the pane behind it is
 * asynchronous. This is the state that bridges the gap — the attachment still to be run, the frames
 * that arrived while it was running, and whether the peer has already gone.
 */
export interface HostSocketState {
  readonly attach: SocketAttachment;
  /** Frames delivered before the handler was attached, in arrival order. Bounded; see
   *  `admitPendingSocketFrame`. */
  readonly pending: SocketFrame[];
  handler?: SocketHandler;
  /** Set once the socket is gone, so an attachment that resolves afterwards is closed rather than
   *  installed against a peer that is no longer there. */
  closed: boolean;
}

/** The subset of a server WebSocket this adapter needs. Injected so the whole open/frame/close
 *  lifecycle can be driven without a real peer. */
export interface HostSocket {
  readonly data: HostSocketState;
  /** Bun reports the bytes it took, or a negative number when the peer has gone away. */
  send(frame: string | Uint8Array): number;
  close(code?: number, reason?: string): void;
  getBufferedAmount(): number;
}

/** The socket lifecycle, as the runtime calls it. */
export interface HostSocketHandlers {
  open(socket: HostSocket): void;
  message(socket: HostSocket, frame: string | Uint8Array): void;
  close(socket: HostSocket): void;
}

/**
 * The runtime's server, behind the two things this adapter needs from it: serve, and switch one
 * request's protocol. Injected so the translation from a `Request` to an `ApiRequest`, and the
 * refusal path when an upgrade cannot be honoured, are both exercisable without a real peer.
 */
export interface HttpServePort {
  serve(options: HostServeOptions): BoundHttpServer;
}

export interface HostServeOptions {
  readonly hostname: string;
  readonly port: number;
  /** Largest client frame the runtime may accept before closing the socket itself. */
  readonly maxFrameBytes: number;
  /** Largest request body the runtime may accept before answering 413 itself, without ever handing
   *  the daemon what it refused. */
  readonly maxBodyBytes: number;
  /** `undefined` means the request was upgraded and there is no response to send. */
  readonly fetch: (request: Request) => Promise<Response | undefined>;
  readonly websocket: HostSocketHandlers;
}

export interface BoundHttpServer {
  /** Optional because a unix-socket host reports neither; a TCP host always reports both. */
  readonly port?: number;
  readonly hostname?: string;
  requestIp(request: Request): string | undefined;
  /** Switches this request to the socket protocol, carrying `state` to the handlers. `false` when
   *  the runtime refused — a client that sent an `Upgrade` header it cannot actually honour. */
  upgrade(request: Request, state: HostSocketState): boolean;
  stop(closeActiveConnections?: boolean): Promise<void> | void;
}

/** Bun's `serve`, adapted to `HttpServePort`. */
export class BunHttpServe implements HttpServePort {
  serve(options: HostServeOptions): BoundHttpServer {
    const server = Bun.serve<HostSocketState>({
      hostname: options.hostname,
      port: options.port,
      // A scrape or a poll that goes quiet must not hold a connection open forever. WebSocket
      // connections are unaffected: they have their own idle handling, and Bun keeps them alive with
      // automatic pings, which a terminal stream nobody is typing into depends on.
      idleTimeout: 30,
      // The body cap, enforced by the runtime for the same reason as the frame cap below: Bun
      // refuses an oversized body itself, so the bytes are never buffered into this heap at all.
      // Bun's own default is 128 MiB — four times anything this API has a use for.
      maxRequestBodySize: options.maxBodyBytes,
      fetch: options.fetch,
      websocket: {
        // The frame cap, enforced by the runtime BEFORE the daemon ever holds the bytes. Bun closes
        // an oversized frame itself, which is the whole point: a cap applied in a handler is a cap
        // applied after the allocation it was meant to prevent.
        maxPayloadLength: options.maxFrameBytes,
        // Pane bytes are mostly short control sequences and a snapshot is sent ten times a second;
        // negotiating deflate would spend CPU per frame to compress what is already compact.
        perMessageDeflate: false,
        open: socket => options.websocket.open(socket),
        message: (socket, frame) => options.websocket.message(socket, frame),
        close: socket => options.websocket.close(socket),
      },
    });
    return {
      port: server.port,
      hostname: server.hostname,
      requestIp: request => server.requestIP(request)?.address,
      upgrade: (request, state) => server.upgrade(request, { data: state }),
      stop: (closeActiveConnections?: boolean) => server.stop(closeActiveConnections),
    };
  }
}

/**
 * Serves an `ApiSurface` — request/response routes and protocol switches — over one bound address.
 *
 * Everything transport-shaped lives here: reading the peer address, lowercasing header names,
 * flattening the query string, turning the domain's `ApiResponse` back into a `Response`, and owning
 * the set of live sockets so shutdown can end every one of them. Neither dispatcher ever sees a
 * socket, which is why the entire routing, authorization and upgrade surface is unit-testable.
 */
export class BunApiServer implements ApiServerPort {
  constructor(
    private readonly http: HttpServePort = new BunHttpServe(),
    /**
     * The runtime's own request-body ceiling.
     *
     * Injected for one reason: a case that had to send the shipped ceiling to prove the refusal would
     * be measuring the machine it runs on rather than the bound. Nothing in the daemon passes it.
     */
    private readonly maxBodyBytes: number = MAX_REQUEST_BODY_BYTES,
  ) {}

  async listen(surface: ApiSurface, options: ApiBindOptions): Promise<ApiServerHandle> {
    const sockets = new HostSocketRegistry();
    const server = this.http.serve({
      hostname: options.host,
      port: options.port,
      maxFrameBytes: SOCKET_MAX_FRAME_BYTES,
      maxBodyBytes: this.maxBodyBytes,
      fetch: async (request: Request) => {
        const apiRequest = toApiRequest(request, server.requestIp(request), options.directLoopbackIsPrivileged);
        const presentedOrigin = request.headers.get('origin');
        const origin =
          presentedOrigin === null || presentedOrigin === new URL(request.url).origin ? null : presentedOrigin;
        if (origin !== null && !surface.corsOrigins.includes(origin)) return corsRefusal();
        const preflight = origin === null ? undefined : corsPreflight(request, origin);
        if (preflight !== undefined) return preflight;
        const respond = (response: Response): Response => (origin === null ? response : corsResponse(response, origin));
        // `claims` is asked before `upgrade`, and deliberately before authentication, so a public
        // HTTP route that arrives with a stray `Upgrade` header is still served as HTTP rather than
        // judged against a socket table it has nothing to do with.
        const upgrade =
          wantsSocket(request) && surface.sockets.claims(apiRequest)
            ? await surface.sockets.upgrade(apiRequest)
            : undefined;
        if (upgrade?.outcome === 'accepted')
          return server.upgrade(request, { attach: upgrade.attach, pending: [], closed: false })
            ? undefined
            : respond(toResponse(errorResponse(400, 'the websocket upgrade failed', 'upgrade_failed')));
        if (upgrade?.outcome === 'refused') return respond(toResponse(upgrade.response));
        return respond(toResponse(await surface.http.dispatch(apiRequest)));
      },
      websocket: {
        open: socket => sockets.opened(socket),
        message: (socket, frame) => sockets.received(socket, frame),
        close: socket => sockets.ended(socket),
      },
    });
    // Bun's declared types make these optional for the unix-socket case; a TCP `serve` always
    // reports both, and falling back to what was requested beats handing a client `undefined`.
    const port = server.port ?? options.port;
    const hostname = server.hostname ?? options.host;
    return {
      // Bracketed for IPv6, so the URL a client is handed is one it can actually parse.
      url: `http://${hostname.includes(':') ? `[${hostname}]` : hostname}:${port}`,
      port,
      closeSockets: () => sockets.closeAll(),
      stop: async () => {
        // `true` closes connections still open: a daemon shutting down must not be held up by a
        // scraper's keep-alive or by a viewer that stopped reading.
        //
        // The result is AWAITED ONLY WHEN IT CAN SETTLE. Bun 1.3.13 releases the address
        // synchronously but never resolves this promise once the server itself has closed a
        // WebSocket — verified against an out-of-process client that received the close frame and
        // exited, after which another process binds the port immediately. Awaiting a promise that
        // cannot settle would hang shutdown forever, which is a far worse failure than not learning
        // the exact instant the last byte drained.
        if (sockets.closedAnySocket) void server.stop(true);
        else await server.stop(true);
      },
    };
  }
}

/** Whether this request is asking to switch protocols. */
function wantsSocket(request: Request): boolean {
  return request.headers.get('upgrade')?.toLowerCase() === 'websocket';
}

function toResponse(response: ApiResponse): Response {
  return new Response(response.body, { status: response.status, headers: Object.fromEntries(response.headers) });
}

const CORS_METHODS = new Set(['DELETE', 'GET', 'PATCH', 'POST']);
const CORS_REQUEST_HEADERS = new Set([
  'authorization',
  'content-type',
  'range',
  'x-ferretry-client',
  'x-ferretry-session-id',
  'x-fy-board-capability',
  'x-fy-request-id',
  'x-fy-version',
]);
const CORS_EXPOSE_HEADERS = 'accept-ranges, content-range, etag, x-ferretry-version';

/** Refuses a browser origin before any route can observe or spend its request. */
function corsRefusal(): Response {
  const response = toResponse(errorResponse(403, 'origin not allowed', 'origin_not_allowed'));
  response.headers.set('vary', 'Origin');
  return response;
}

/** Answers the browser's unauthenticated permission probe without weakening route authentication. */
function corsPreflight(request: Request, origin: string): Response | undefined {
  const requestedMethod = request.headers.get('access-control-request-method')?.trim().toUpperCase();
  if (request.method !== 'OPTIONS' || requestedMethod === undefined) return undefined;
  const requestedHeaders = (request.headers.get('access-control-request-headers') ?? '')
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(value => value !== '');
  if (!CORS_METHODS.has(requestedMethod) || requestedHeaders.some(header => !CORS_REQUEST_HEADERS.has(header))) {
    const response = toResponse(errorResponse(403, 'CORS preflight refused', 'cors_preflight_refused'));
    response.headers.set('vary', 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers');
    return response;
  }
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': origin,
      'access-control-allow-credentials': 'true',
      'access-control-allow-methods': requestedMethod,
      'access-control-allow-headers': requestedHeaders.join(', '),
      'access-control-max-age': '600',
      vary: 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
    },
  });
}

/** Makes an allowed response readable to the exact configured credentialed browser origin. */
function corsResponse(response: Response, origin: string): Response {
  const headers = new Headers(response.headers);
  headers.set('access-control-allow-origin', origin);
  headers.set('access-control-allow-credentials', 'true');
  headers.set('access-control-expose-headers', CORS_EXPOSE_HEADERS);
  const vary = headers.get('vary');
  if (vary === null || !vary.split(',').some(value => value.trim().toLowerCase() === 'origin'))
    headers.set('vary', vary === null ? 'Origin' : `${vary}, Origin`);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * The sockets one bound host owns.
 *
 * A class rather than free functions because two facts have to be shared across the whole lifecycle:
 * which sockets are still attached, so shutdown can reach every one of them, and whether this host
 * has ever closed one ITSELF — which is what decides how `stop` may wait. See `closedAnySocket`.
 */
class HostSocketRegistry {
  private readonly live = new Set<HostSocket>();
  private closedHere = false;

  /**
   * Whether this host has closed a socket on its own initiative rather than letting the peer or the
   * runtime do it.
   *
   * It exists for one reason: Bun 1.3.13's `server.stop(true)` never resolves afterwards, so a
   * shutdown that awaited it would hang forever. See the note at the `stop` that reads this.
   */
  get closedAnySocket(): boolean {
    return this.closedHere;
  }

  /**
   * Runs the accepted attachment against the socket it actually got, then replays whatever arrived
   * while that was in flight.
   *
   * A socket whose peer left before the attachment resolved gets its handler closed immediately
   * rather than installed: the handler holds a timer and a viewer slot, and with no socket left to
   * report a close, nothing would ever release either.
   */
  opened(socket: HostSocket): void {
    this.live.add(socket);
    const state = socket.data;
    void state
      .attach(downstreamFor(socket))
      .then(async handler => {
        if (state.closed) {
          handler.close();
          return;
        }
        state.handler = handler;
        await handler.open();
        for (const frame of state.pending.splice(0)) handler.fromClient(frame);
      })
      .catch(() => {
        if (state.closed) return;
        // The switch has already happened, so there is no status left to send: the socket is closed
        // with a reason instead. `finish` goes FIRST so a handler that was installed and then failed
        // is released exactly once — closing the socket calls the runtime's own close callback, which
        // would otherwise release the same handler a second time.
        finish(socket);
        this.close(socket, SOCKET_CLOSES.unavailable);
      });
  }

  /** One client frame. Frames arriving before the handler is attached are held, bounded. */
  received(socket: HostSocket, frame: string | Uint8Array): void {
    const state = socket.data;
    if (state.handler !== undefined) {
      state.handler.fromClient(frame);
      return;
    }
    const decision = admitPendingSocketFrame(state.pending.length);
    if (decision.outcome === 'rejected') {
      this.close(socket, decision.close);
      return;
    }
    // Copied: the runtime owns the buffer it handed over and may reuse it before the frame is
    // replayed.
    state.pending.push(typeof frame === 'string' ? frame : frame.slice());
  }

  /** The peer, or the runtime, ended this socket. */
  ended(socket: HostSocket): void {
    this.live.delete(socket);
    finish(socket);
  }

  /** Ends every socket still attached, telling each handler to release what it holds first. */
  closeAll(): void {
    for (const socket of this.live) {
      finish(socket);
      this.close(socket, SOCKET_CLOSES.shuttingDown);
    }
    this.live.clear();
  }

  private close(socket: HostSocket, close: SocketClose): void {
    this.closedHere = true;
    socket.close(close.code, close.reason);
  }
}

/** One live socket, as the domain sees it. */
function downstreamFor(socket: HostSocket): SocketDownstream {
  return {
    send: bytes => socket.send(bytes),
    close: (code, reason) => socket.close(code, reason),
    bufferedBytes: () => socket.getBufferedAmount(),
  };
}

/** Ends the handler behind one socket. Idempotent, because `close` arrives once from the peer and
 *  once from daemon shutdown and a handler must not be told twice. */
function finish(socket: HostSocket): void {
  const state = socket.data;
  if (state.closed) return;
  state.closed = true;
  state.pending.length = 0;
  state.handler?.close();
}

/** Translates a runtime `Request` into the transport-free shape the domain routes on. */
export function toApiRequest(
  request: Request,
  remoteAddress: string | undefined,
  directLoopbackIsPrivileged = false,
): ApiRequest {
  const url = new URL(request.url);
  return {
    method: request.method,
    // `URL.pathname` is the raw, still-percent-encoded path, which is what the router must match.
    path: url.pathname,
    query: queryFrom(url.searchParams),
    headers: headersFrom(Object.fromEntries(request.headers)),
    clientAddress: remoteAddress,
    loopback: remoteAddress !== undefined && isLoopbackPeer(remoteAddress),
    privilegedLoopback: directLoopbackIsPrivileged && remoteAddress !== undefined && isLoopbackPeer(remoteAddress),
    // The runtime's own abort, passed through rather than re-derived: it is what a disconnect actually
    // fires, and a handler that walks a tree needs to hear it from the transport that noticed.
    signal: request.signal,
    // Both reads stay LAZY — nothing here touches the body until a route asks for it, so a body-less
    // route and a protocol switch each pay nothing. A bounded read goes piece by piece rather than
    // through `request.text()`, because that call is the allocation the bound exists to prevent.
    text: async limitBytes =>
      limitBytes === undefined
        ? await request.text()
        : await readBoundedBody(
            {
              declaredLength: request.headers.get('content-length') ?? undefined,
              chunks: () => bodyChunks(request.body),
              // Cancelling the body is what actually reaches the peer: it closes the request stream, so
              // a sender that declared more than it may send stops sending rather than filling a
              // connection the daemon has already answered on.
              discard: async () => await request.body?.cancel(),
            },
            limitBytes,
          ),
  };
}

/**
 * One body's pieces, as the runtime delivers them.
 *
 * Read through the stream's own reader rather than `for await (const piece of body)`: a
 * `ReadableStream` is not declared async-iterable, and the reader is the form every runtime agrees
 * on. A request with no body yields nothing at all, which is how a route with an optional body still
 * reads as the empty string.
 *
 * The lock is released however the loop ends, including a refusal mid-upload — and RELEASED rather
 * than cancelled, because releasing it is what lets `readBoundedBody` cancel the body itself. Stopping
 * a refused sender belongs to whoever refused; this only stops reading.
 */
async function* bodyChunks(body: ReadableStream<Uint8Array> | null): AsyncIterable<Uint8Array> {
  if (body === null) return;
  const reader = body.getReader();
  try {
    for (;;) {
      const piece = await reader.read();
      if (piece.done) return;
      yield piece.value;
    }
  } finally {
    reader.releaseLock();
  }
}
