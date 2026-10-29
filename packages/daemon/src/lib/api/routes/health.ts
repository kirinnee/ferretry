import type { LivenessView } from '@ferretry/protocol';
import { SESSION_PROTOCOL_ID } from '@ferretry/relay';
import type { MillisecondClockPort } from '../../runtime/boot.ts';
import type { BootSnapshot, EventLoopView, LoopStall } from '../../runtime/liveness.ts';
import { daemonVersion } from '../../version.ts';
import type { ApiResponse } from '../http.ts';
import { jsonResponse, noStore } from '../responses.ts';
import type { ApiRoute } from '../route.ts';

/**
 * What the liveness answer reports beyond "this process answered".
 *
 * OPTIONAL, so a route table built without a running boot — every route test — still answers the
 * three-field body it always did. The composition root always supplies it.
 */
export interface DaemonLivenessSource {
  readonly pid: number;
  boot(): BootSnapshot;
  loop(): EventLoopView;
}

const seconds = (milliseconds: number): number => Math.max(0, Math.round(milliseconds / 1_000));

type LoopStallView = NonNullable<NonNullable<LivenessView['eventLoop']>['lastStall']>;

const stallView = (stall: LoopStall): LoopStallView => ({
  at: new Date(stall.atMs).toISOString(),
  durationMs: stall.durationMs,
  during: [...stall.during],
  innermost: [...stall.innermost],
  stacks: stall.stacks.map(({ stack, share }) => ({ stack, share })),
  ...(stall.cause === undefined ? {} : { cause: stall.cause }),
  ...(stall.io === undefined ? {} : { io: { ...stall.io } }),
});

/** The liveness body, shared by the mounted route and the boot-time surface that serves it alone. */
export function livenessView(
  clock: MillisecondClockPort,
  startedAtMs: number,
  source: DaemonLivenessSource | undefined,
): LivenessView {
  const boot = source?.boot();
  const loop = source?.loop();
  return {
    status: boot?.phase === 'starting' ? 'starting' : 'ok',
    version: daemonVersion,
    sessionProtocol: SESSION_PROTOCOL_ID,
    uptimeSeconds: seconds(clock.now() - startedAtMs),
    ...(source === undefined ? {} : { pid: source.pid }),
    ...(boot === undefined
      ? {}
      : {
          boot: {
            phase: boot.phase,
            step: boot.step,
            stepElapsedSeconds: seconds(boot.stepElapsedMs),
            elapsedSeconds: seconds(boot.bootElapsedMs),
          },
        }),
    ...(loop === undefined
      ? {}
      : {
          eventLoop: {
            lagMs: loop.lagMs,
            maxLagMs: loop.maxLagMs,
            stalls: loop.stalls,
            ...(loop.lastStall === undefined ? {} : { lastStall: stallView(loop.lastStall) }),
            ...(loop.worstStall === undefined ? {} : { worstStall: stallView(loop.worstStall) }),
            ...(loop.io === undefined ? {} : { io: { ...loop.io } }),
          },
        }),
  };
}

/**
 * The liveness answer as a response: never cached, because its whole value is that it is current.
 *
 * A STARTING DAEMON ANSWERS 503 WITH THE FULL BODY. The body is what a person and `fy daemon status`
 * read — the step and how long it has taken — while the status code keeps every existing caller that
 * waits for `/healthz` to be OK waiting until the routes it is about to call actually exist. A 200 here
 * during boot would turn each of those waits into a race against a 503 on the very next request.
 */
export function livenessResponse(
  clock: MillisecondClockPort,
  startedAtMs: number,
  source: DaemonLivenessSource | undefined,
): ApiResponse {
  const view = livenessView(clock, startedAtMs, source);
  if (view.status === 'ok') return noStore(jsonResponse(view));
  return noStore(jsonResponse(view, 503, { 'retry-after': '2' }));
}

/**
 * Liveness.
 *
 * `/healthz` is the conventional name every process supervisor and metrics agent already probes, and
 * it is the whole of this route table. Public, and answering without touching any subsystem: a
 * liveness probe that can be made to fail by a slow dependency reports the wrong thing, and one that
 * needs a token cannot be used by the supervisor that has to restart the daemon holding it.
 *
 * `/v1/health` USED to be a second name for this same body, and that was the defect: the protocol
 * declares `/v1/health` as the daemon's full `HealthView`, so the CLI parsed this three-field
 * liveness answer against that schema, failed, and reported a serving daemon as unreachable. It now
 * belongs to `runtime/mounts/health.ts`, over the self-check that can actually answer it — still
 * public, because the daemon commands must probe it before any token exists.
 *
 * Two paths remain because they answer different questions. This one is a LIVENESS answer that
 * touches no subsystem, so it cannot be made to fail by a slow dependency; the mounted one reads the
 * session index and the self-check ledger. The daemon's own already-running detection probes the
 * latter (see `healthEndpoint`), where a real report is strictly better evidence than a literal.
 *
 * `sessionProtocol` IS HOW AN APP TELLS "OLD MACHINE" FROM "NO MACHINE". A browser cannot read why a
 * WebSocket failed, so an app whose session socket was refused asks this public route once: a daemon
 * that answers without the dialect the app speaks is a daemon that needs updating, and the app can
 * say so in words instead of reporting a connection error (`docs/design/zero-trust.md` A9).
 *
 * `boot` AND `eventLoop` ARE WHY THIS ROUTE IS SERVED BEFORE ANY OTHER. The daemon binds its address
 * first and answers this one path while the rest of the boot runs (see `StagedApiSurface`), so a daemon
 * that takes a minute to reconcile says `starting` and names the step instead of refusing connections,
 * and a daemon whose loop has been stalling says how badly and during what.
 */
export function healthRoutes(
  clock: MillisecondClockPort,
  startedAtMs: number,
  liveness?: DaemonLivenessSource,
): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/healthz',
      minimum: 'none',
      noStore: true,
      handle: async () => livenessResponse(clock, startedAtMs, liveness),
    },
  ];
}
