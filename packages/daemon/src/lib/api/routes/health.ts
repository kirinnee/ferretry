import { SESSION_PROTOCOL_ID } from '@ferretry/relay';
import type { MillisecondClockPort } from '../../runtime/boot.ts';
import { daemonVersion } from '../../version.ts';
import { jsonResponse, noStore } from '../responses.ts';
import type { ApiRoute } from '../route.ts';

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
 */
export function healthRoutes(clock: MillisecondClockPort, startedAtMs: number): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/healthz',
      minimum: 'none',
      noStore: true,
      handle: async () =>
        noStore(
          jsonResponse({
            status: 'ok',
            version: daemonVersion,
            sessionProtocol: SESSION_PROTOCOL_ID,
            uptimeSeconds: Math.max(0, Math.round((clock.now() - startedAtMs) / 1_000)),
          }),
        ),
    },
  ];
}
