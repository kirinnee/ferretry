import type { MillisecondClockPort } from '../../runtime/readiness.ts';
import { daemonVersion } from '../../version.ts';
import { jsonResponse, noStore } from '../responses.ts';
import type { ApiRoute } from '../route.ts';

/**
 * Liveness.
 *
 * Two paths answer it, and both are deliberate. `/healthz` is the conventional name every process
 * supervisor and metrics agent already probes, and `/v1/health` is what the daemon's own
 * already-running detection reaches for before it binds — a mismatch there means two daemons race
 * for the same address, so it is worth serving under both names rather than being tidy.
 *
 * Public, and answering without touching any subsystem: a liveness probe that can be made to fail
 * by a slow dependency reports the wrong thing, and one that needs a token cannot be used by the
 * supervisor that has to restart the daemon holding it.
 */
export function healthRoutes(clock: MillisecondClockPort, startedAtMs: number): readonly ApiRoute[] {
  const handle = async () =>
    noStore(
      jsonResponse({
        status: 'ok',
        version: daemonVersion,
        uptimeSeconds: Math.max(0, Math.round((clock.now() - startedAtMs) / 1_000)),
      }),
    );
  return [
    { method: 'GET', path: '/healthz', scope: 'public', noStore: true, handle },
    { method: 'GET', path: '/v1/health', scope: 'public', noStore: true, handle },
  ];
}
