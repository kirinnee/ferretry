/**
 * The protocol-switching half of the API surface.
 *
 * WHY IT EXISTS. `ApiResponse` is a status, some headers and a string body, so a route can answer a
 * question but can never be handed a peer to keep talking to. Terminal input and output are byte
 * frames on a socket — the protocol says so in as many words, giving raw bytes their own frame type
 * and reserving JSON for the resize control frame — so the streaming subsystem had nothing to mount
 * onto and stayed unreachable. This is the seam it mounts onto.
 *
 * Everything here is transport-free, exactly like `http.ts`: no `Request`, no `ServerWebSocket`, no
 * Bun. A socket route decides WHO may switch protocols and WHAT drives the socket afterwards, and an
 * adapter supplies the socket. That is what makes the whole upgrade, authorization and framing
 * surface exercisable in the unit tier without binding a port.
 */

import type { ApiCredentials } from './authentication.ts';
import { authorizeRequest } from './dispatcher.ts';
import { ApiError } from './error.ts';
import type { ApiRequest, ApiResponse } from './http.ts';
import { errorResponse } from './responses.ts';
import type { RouteContext, ScopedRoute } from './route.ts';
import type { ApiRouter } from './router.ts';

/** A client frame as the transport delivers it: text control JSON, or binary bytes. */
export type SocketFrame = string | ArrayBuffer | ArrayBufferView;

/**
 * Largest client frame the transport accepts before it closes the socket.
 *
 * Enforced by the TRANSPORT, not by a handler. A limit applied after the runtime has already
 * buffered the frame is a limit applied too late, and an unbounded frame is the out-of-memory class
 * this migration has now found twice. 64 KiB is the largest legitimate terminal input frame — one
 * paste — so a socket surface that ever needs more must raise this deliberately and say why.
 */
export const SOCKET_MAX_FRAME_BYTES = 64 * 1024;

/**
 * How many client frames may wait while the handler behind a socket is still being attached.
 *
 * The socket is live from the instant the protocol switches, but attaching its handler is
 * asynchronous — it resolves a session, a terminal and a pane. Frames arriving in that window must
 * be kept, or the first keystroke of every stream is lost, and they must be BOUNDED, or a client
 * that floods during the handshake grows the daemon's heap without limit. Sixteen frames of at most
 * {@link SOCKET_MAX_FRAME_BYTES} is a hard one-megabyte ceiling per socket.
 */
export const SOCKET_MAX_PENDING_FRAMES = 16;

/** Close codes and reasons the TRANSPORT itself produces. What a handler decides is its own. */
export const SOCKET_CLOSES = {
  /** The client filled the handshake queue before its handler could be attached. */
  handshakeOverflow: { code: 1009, reason: 'socket handshake queue exceeded' },
  /** The subsystem behind the socket refused after the switch, when no status can be sent. */
  unavailable: { code: 1011, reason: 'socket handler unavailable' },
  /**
   * The daemon is shutting down.
   *
   * `1001` ("going away") is what this means, and it is deliberately NOT used: Bun rewrites 1001 to
   * 1000 on the wire, so a client would be told a code the daemon never chose. Naming 1000 and
   * carrying the intent in the reason keeps the constant honest about what a viewer actually
   * receives. Verified against Bun 1.3.13; 1002, 1008, 1009, 1011 and 1013 all pass through intact.
   */
  shuttingDown: { code: 1000, reason: 'daemon shutting down' },
} as const;

export type SocketClose = (typeof SOCKET_CLOSES)[keyof typeof SOCKET_CLOSES];

export type SocketPendingDecision =
  | { readonly outcome: 'queued' }
  | { readonly outcome: 'rejected'; readonly close: SocketClose };

/** Admits one frame into the handshake queue, or refuses the socket for flooding it. */
export function admitPendingSocketFrame(pending: number): SocketPendingDecision {
  return pending >= SOCKET_MAX_PENDING_FRAMES
    ? { outcome: 'rejected', close: SOCKET_CLOSES.handshakeOverflow }
    : { outcome: 'queued' };
}

/**
 * One live socket, seen from the domain: bytes out, a close code at the end, and how much the
 * transport is still holding.
 *
 * `bufferedBytes` is not a convenience. It is the only honest input to a backpressure decision: a
 * handler that cannot see its own backlog can only keep queueing, which is how a slow reader turns
 * into unbounded daemon memory.
 */
export interface SocketDownstream {
  /** A negative result means the peer has gone away even though nothing threw. */
  send(frame: string | Uint8Array): number | undefined;
  close(code: number, reason: string): void;
  bufferedBytes(): number;
}

/** Whatever drives one live socket, once the protocol has switched. */
export interface SocketHandler {
  /** Called once after the switch, before any client frame is delivered. */
  open(): Promise<void>;
  fromClient(frame: SocketFrame): void;
  /** The socket is gone — the peer closed it, it failed, or the daemon is shutting down. Called at
   *  most once per socket, and required to release every timer and viewer the handler holds. */
  close(): void;
}

/** Binds an accepted upgrade to the socket it actually got. */
export type SocketAttachment = (downstream: SocketDownstream) => Promise<SocketHandler>;

/**
 * A route that answers a protocol switch instead of a response.
 *
 * `accept` runs BEFORE the switch, on the already authenticated and authorized request, and
 * everything a client could be told with a status code must be proven there. An upgrade that
 * succeeds and then immediately closes cannot say whether the terminal was missing, the session
 * was, or the daemon broke — so a `not_found` must be a 404 on the handshake, never a close frame.
 * Throwing `ApiError` from `accept` refuses the upgrade with exactly that status.
 */
export interface SocketRoute extends ScopedRoute {
  accept(context: RouteContext): Promise<SocketAttachment>;
}

export type SocketUpgradeDecision =
  | { readonly outcome: 'accepted'; readonly attach: SocketAttachment }
  /** No socket route claims this path; it is an ordinary request/response one. */
  | { readonly outcome: 'unclaimed' }
  | { readonly outcome: 'refused'; readonly response: ApiResponse };

/** Decides one protocol switch, over the same authorization boundary the HTTP dispatcher uses. */
export class ApiSocketDispatcher {
  constructor(
    private readonly router: ApiRouter<SocketRoute>,
    private readonly credentials: ApiCredentials,
  ) {}

  /**
   * Whether any socket route claims this path at all.
   *
   * Asked BEFORE {@link upgrade}, and deliberately before authentication, because a public HTTP
   * route that arrives with a stray `Upgrade: websocket` header — a proxy adds one, a client copies
   * a header set — must still be served as HTTP. Answering it 401 because a socket table it has
   * nothing to do with demands a token would break liveness scraping for no security gain.
   */
  claims(request: ApiRequest): boolean {
    return this.router.lookup(request.method, request.path).kind !== 'not-found';
  }

  async upgrade(request: ApiRequest): Promise<SocketUpgradeDecision> {
    const authorized = authorizeRequest(this.router, this.credentials, request);
    if (authorized.kind === 'unrouted') return { outcome: 'unclaimed' };
    if (authorized.kind === 'refused') return { outcome: 'refused', response: authorized.response };
    try {
      return { outcome: 'accepted', attach: await authorized.route.accept(authorized.context) };
    } catch (error) {
      // Same taxonomy as a route handler's: a refusal the subsystem named keeps its own status, and
      // anything else is the daemon's fault rather than the caller's.
      return {
        outcome: 'refused',
        response:
          error instanceof ApiError
            ? errorResponse(error.status, error.message, error.code)
            : errorResponse(500, 'the daemon failed to accept this socket', 'internal_error'),
      };
    }
  }
}
