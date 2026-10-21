import type { ApiRequest, ApiResponse } from '../api/http.ts';
import { errorResponse, noStore } from '../api/responses.ts';
import { type DaemonLivenessSource, livenessResponse, livenessView } from '../api/routes/health.ts';
import type { ApiHttpDispatch, ApiSocketGate } from '../api/server.ts';
import type { SocketUpgradeDecision } from '../api/socket.ts';
import type { MillisecondClockPort } from './boot.ts';

/** The code a client reads to tell "still booting, ask again" from every other refusal. */
export const DAEMON_STARTING_CODE = 'daemon_starting';

/**
 * The surface a daemon binds BEFORE its subsystems exist, and keeps serving once they do.
 *
 * WHY THE ADDRESS IS BOUND FIRST. The boot used to bind last — after the state home, the pairing
 * identity, the analytics index, every subsystem, the grants and a full first self-check — so on a
 * fleet with large transcripts the address stayed closed for twenty seconds every boot, and for as long
 * as any one step took when one stalled. Nothing outside the process could tell that from a crash: a
 * service manager said "running", the port refused, and `fy daemon status` could only say "the API is
 * unavailable". Bound first, the daemon answers `/healthz` from the moment it owns the address, and
 * names the step it is on.
 *
 * WHAT IT ANSWERS BEFORE {@link mount}. `GET /healthz` is the real liveness answer, served from the
 * same function the mounted route uses. Everything else — `/v1/health` included — is a 503 carrying
 * {@link DAEMON_STARTING_CODE}, the step and a `retry-after`, because answering a route from a subsystem
 * that does not exist yet would be inventing a reading. No socket is claimed, so an upgrade request gets
 * that same 503 rather than a half-switched protocol.
 *
 * THE AUTHORIZATION BOUNDARY IS UNCHANGED. Before mounting there is exactly one reachable answer, and it
 * is the public one; after mounting every request goes to the dispatcher the boot built, exactly as it
 * would have had that dispatcher been bound directly.
 */
export class StagedApiSurface {
  #mounted: { readonly http: ApiHttpDispatch; readonly sockets: ApiSocketGate } | undefined;

  constructor(
    private readonly clock: MillisecondClockPort,
    private readonly startedAtMs: number,
    private readonly liveness: DaemonLivenessSource,
  ) {}

  /** Hands every request from now on to the boot's own dispatchers. */
  mount(http: ApiHttpDispatch, sockets: ApiSocketGate): void {
    this.#mounted = { http, sockets };
  }

  get mounted(): boolean {
    return this.#mounted !== undefined;
  }

  readonly http: ApiHttpDispatch = {
    dispatch: async (request: ApiRequest): Promise<ApiResponse> => {
      const mounted = this.#mounted;
      if (mounted !== undefined) return await mounted.http.dispatch(request);
      if (request.method === 'GET' && request.path === '/healthz')
        return livenessResponse(this.clock, this.startedAtMs, this.liveness);
      return this.starting();
    },
  };

  readonly sockets: ApiSocketGate = {
    claims: (request: ApiRequest): boolean => this.#mounted?.sockets.claims(request) ?? false,
    upgrade: async (request: ApiRequest): Promise<SocketUpgradeDecision> => {
      const mounted = this.#mounted;
      if (mounted !== undefined) return await mounted.sockets.upgrade(request);
      return { outcome: 'refused', response: this.starting() };
    },
  };

  private starting(): ApiResponse {
    const view = livenessView(this.clock, this.startedAtMs, this.liveness);
    const step = view.boot?.step ?? 'starting';
    const response = noStore(
      errorResponse(503, `the daemon is starting (${step}); ask again shortly`, DAEMON_STARTING_CODE, {
        boot: view.boot,
      }),
    );
    const headers = new Map(response.headers);
    headers.set('retry-after', '2');
    return { ...response, headers };
  }
}
