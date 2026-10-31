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
import type { CapabilityGuard, StepUpWitness } from './capability.ts';
import { authorizeRequest, presentedSession, recordSessionRefusal } from './dispatcher.ts';
import { ApiError } from './error.ts';
import type { ApiRequest, ApiResponse } from './http.ts';
import { errorResponse } from './responses.ts';
import type { RouteContext, ScopedRoute, WardenRemedyAuthorizer } from './route.ts';
import type { ApiRouter } from './router.ts';

/**
 * The witness a re-check of an ALREADY-OPEN stream reads: whatever device its session proved has
 * confirmed, because the upgrade being re-checked could not have been accepted otherwise. A caller with
 * no device still holds nothing — the boundary never asks a witness about one.
 */
const STANDING_STEP_UP: StepUpWitness = { held: () => true };

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
  /**
   * `permit` is the frame's last word: true while what it shows may still be shown. A transport with an
   * await between this call and the wire (the relay queues and seals) asks it again just before the
   * socket; one that writes synchronously has nothing to add and ignores it.
   */
  send(frame: string | Uint8Array, permit?: () => boolean): number | undefined;
  close(code: number, reason: string): void;
  bufferedBytes(): number;
}

/** Whatever drives one live socket, once the protocol has switched. */
export interface SocketHandler {
  /** Called once after the switch, before any client frame is delivered. */
  open(): Promise<void>;
  fromClient(frame: SocketFrame): void;
  /** The socket is gone — the peer closed it, it failed, or the daemon is shutting down. Called at
   *  most once per socket, and required to release every timer and viewer the handler holds.
   *  `ended` is the close the transport saw arrive, when it saw one; absent when the daemon ended it. */
  close(ended?: SocketEnded): void;
}

/**
 * How a socket ended, as the transport reported it — `1006` with an empty reason when the peer went away
 * without a close frame. A DIAGNOSTIC, never a decision: it is logged so a drop can be explained, and
 * nothing a handler releases may depend on it.
 */
export interface SocketEnded {
  readonly code: number;
  readonly reason: string;
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
  | {
      readonly outcome: 'accepted';
      readonly attach: SocketAttachment;
    }
  /** No socket route claims this path; it is an ordinary request/response one. */
  | { readonly outcome: 'unclaimed' }
  | { readonly outcome: 'refused'; readonly response: ApiResponse };

/** Decides one protocol switch, over the same authorization boundary the HTTP dispatcher uses. */
export class ApiSocketDispatcher {
  constructor(
    private readonly router: ApiRouter<SocketRoute>,
    private readonly credentials: ApiCredentials,
    /**
     * The operator's per-capability decision, over the SAME boundary the request/response dispatcher
     * uses. A terminal stream is the capability `terminal`, and a socket table that skipped this
     * check would be a hole straight through the feature: the daemon would refuse to CREATE a
     * terminal an operator had denied and then happily hand a browser the socket that drives one.
     */
    private readonly guard: CapabilityGuard,
    /**
     * The administrator's per-remedy decision, forwarded so the shared boundary really does enforce
     * warden scope the same way on both tables.
     *
     * NOTHING HERE IS EXPECTED TO DECLARE A REMEDY — a remedy is a destructive action on a session
     * and a protocol switch is not one. It is wired anyway because the alternative is a refusal that
     * names a fix nobody can perform: a socket route that declared one would be told the boundary
     * serving it must be wired with an authorizer, against a constructor that had nowhere to put
     * one. An unsatisfiable instruction is a worse state than either a served route or a declared
     * prohibition.
     */
    private readonly remedies?: WardenRemedyAuthorizer,
    /** Whose passkey step-up is live — the same witness the request/response table reads. */
    private readonly stepUps?: StepUpWitness,
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

  /**
   * Whether a stream this table accepted would still be accepted now, without accepting anything.
   *
   * A socket is authorized once, at its upgrade, and a stream can then run for hours. A narrowed grant
   * must reach the streams already open, so whoever carries one asks this again — on each lease renewal
   * and on each grant change — and ends the stream when the answer is no.
   *
   * The step-up is counted as STANDING here: it was spent on the upgrade that opened this stream, so a
   * stream outlives the confirmation that admitted it. Asking for a live one again would end every
   * remote terminal at the first renewal after its step-up lapsed. Everything else is re-decided —
   * the UNLOCK included: a stream whose device's unlock has lapsed ends at its next renewal, because
   * the unlock is what lets a device do anything at all (`docs/design/zero-trust.md` B6).
   */
  reauthorize(request: ApiRequest): boolean {
    const unlock = this.stepUps?.unlockRequired;
    const standing: StepUpWitness =
      unlock === undefined
        ? STANDING_STEP_UP
        : { held: () => true, unlockRequired: subject => unlock.call(this.stepUps, subject) };
    return (
      authorizeRequest(this.router, this.credentials, request, this.guard, this.remedies, standing).kind ===
      'authorized'
    );
  }

  async upgrade(request: ApiRequest): Promise<SocketUpgradeDecision> {
    const authorized = authorizeRequest(
      this.router,
      this.credentials,
      request,
      this.guard,
      this.remedies,
      this.stepUps,
      await presentedSession(this.router, this.credentials, request),
    );
    if (authorized.kind === 'unrouted') return { outcome: 'unclaimed' };
    if (authorized.kind === 'refused') {
      await recordSessionRefusal(this.credentials, authorized.sessionRefusal);
      return { outcome: 'refused', response: authorized.response };
    }
    try {
      // A paired device's stream is tracked by the SESSION that opened it, which ends it on revocation;
      // no plain-HTTP upgrade can carry a device at all any more.
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
