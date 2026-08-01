/**
 * The third table of the API surface: routes that answer with the transport's own response.
 *
 * WHY IT EXISTS. `ApiResponse` is a status, some headers and a STRING body, and `ApiRequest` reads
 * its body as text and nothing else. A subsystem whose traffic is BYTES therefore has nothing to
 * mount onto — the same wall the socket table was built for, one step less extreme. Speech-to-text
 * is the case that forced it: `POST /v1/stt/transcribe` streams PCM or WAV in under a byte budget
 * that must refuse the body rather than buffer it, and a model file is served with an ETag, a
 * `Range` and a 304. Both are unrepresentable as a string, so `SttService` was constructed by the
 * composition root and reachable by nobody while `fy stt` spoke four routes to a daemon that
 * answered `unknown_route`.
 *
 * WHAT IT IS NOT. It is not an escape hatch from the authorization boundary. A raw route is a
 * {@link ScopedRoute} like every other, matched by the same {@link ApiRouter} and authorized by the
 * same {@link authorizeRequest} the HTTP and socket tables use — so it inherits "a route that says
 * nothing is admin-only by construction", and a subsystem cannot become reachable without a
 * reviewable line declaring who may reach it. The ONLY thing a raw route gets that an `ApiRoute`
 * does not is the bytes.
 *
 * WHY IT NAMES `Request` AND `Response` WHEN `http.ts` REFUSES TO. Those are the WHATWG Fetch
 * types, not a server's: they are constructible in memory, so the whole routing, authorization and
 * refusal surface here is still exercised in the unit tier without binding a port, which is the
 * property `http.ts`'s transport-freedom exists to protect. What is deliberately absent is any
 * mention of Bun, a socket, or a server — an adapter supplies those, exactly as it does for the
 * other two tables.
 */

import type { ApiCredentials } from './authentication.ts';
import { authorizeRequest } from './dispatcher.ts';
import { ApiError } from './error.ts';
import type { ApiRequest, ApiResponse } from './http.ts';
import { errorResponse } from './responses.ts';
import type { RouteContext, ScopedRoute } from './route.ts';
import type { ApiRouter } from './router.ts';

/**
 * A route that reads the request and writes the response itself.
 *
 * `serve` runs on the ALREADY authenticated and authorized request: `context` carries the same
 * parsed parameters and server-derived actor an `ApiRoute` handler receives, and `request` is the
 * untouched transport request the bytes are on. Throwing `ApiError` refuses with exactly that
 * status, so a subsystem's own refusal taxonomy survives the seam.
 */
export interface RawRoute extends ScopedRoute {
  serve(context: RouteContext, request: Request): Promise<Response>;
}

export type RawDecision =
  | { readonly kind: 'served'; readonly response: Response }
  /** No raw route claims this path; it is an ordinary request/response one. */
  | { readonly kind: 'unclaimed' }
  /** Refused before the subsystem was reached, in the transport-free shape the adapter renders. */
  | { readonly kind: 'refused'; readonly response: ApiResponse };

/** Serves the byte-shaped routes, over the same authorization boundary the HTTP dispatcher uses. */
export class ApiRawDispatcher {
  constructor(
    private readonly router: ApiRouter<RawRoute>,
    private readonly credentials: ApiCredentials,
  ) {}

  /**
   * Whether any raw route claims this path at all.
   *
   * Asked BEFORE {@link serve} and deliberately before authentication, for the same reason the
   * socket table asks it: a path this table does not own must fall through to the HTTP dispatcher
   * and be answered by ITS rules, including the public ones. A dispatcher that authenticated first
   * and fell through afterwards would make every public feed 401 for as long as this table existed.
   */
  claims(request: ApiRequest): boolean {
    return this.router.lookup(request.method, request.path).kind !== 'not-found';
  }

  async serve(request: ApiRequest, transport: Request): Promise<RawDecision> {
    const authorized = authorizeRequest(this.router, this.credentials, request);
    if (authorized.kind === 'unrouted') return { kind: 'unclaimed' };
    if (authorized.kind === 'refused') return { kind: 'refused', response: authorized.response };
    try {
      return { kind: 'served', response: await authorized.route.serve(authorized.context, transport) };
    } catch (error) {
      // The same taxonomy a route handler's failure gets: a refusal the subsystem named keeps its
      // own status, and anything else is the daemon's fault rather than the caller's.
      return {
        kind: 'refused',
        response:
          error instanceof ApiError
            ? errorResponse(error.status, error.message, error.code)
            : errorResponse(500, 'the daemon failed to handle this request', 'internal_error'),
      };
    }
  }
}
