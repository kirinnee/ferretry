import { AuditQuerySchema, AuditViewSchema } from '@ferretry/protocol';
import { parseQuery } from '../../api/body.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute } from '../../api/route.ts';
import type { AuditReading } from '../../audit/index.ts';

/** The read half of the security log. The write half is `AuditSink`, which no route exposes. */
export interface AuditSubsystem {
  recent(limit: number, keptOffset: number): Promise<AuditReading>;
  /**
   * Closes every fold window that has run its length. The composition root calls it on a timer, so a
   * burst that stops is still written down — see `AuditLog.flush`.
   */
  flush(): Promise<void>;
}

/**
 * `GET /v1/audit` — who reached this machine and what they did, newest first.
 *
 * THE KEPT RECORDS ARE THEIR OWN LIST. Pairings, revocations and every other change to who may reach
 * this machine come back in `kept`, paged by `keptOffset`, beside the recent activity in `records`
 * — never interleaved with it, because two hundred newer attaches would otherwise push the one pairing
 * that matters off every reader's page.
 *
 * GOVERNED BY `pairing.configure`, NOT `pairing.use`. The log is not only the device list: it says
 * which secrets were used and stored, which terminals were typed into, which settings moved and who
 * failed to pair from where. `pairing.use` is what every paired phone needs to enrol for push and to
 * see its siblings, so gating the log there would hand that whole history to any device an operator
 * merely let manage pairing. `configure` is the axis an operator narrows when a device should use a
 * capability without administering it, so a device trusted only to use pairing reads none of this.
 * Filtering records by the capabilities the caller holds was the alternative; it was not taken
 * because a filtered log reads as a complete one — the reader could not tell what was withheld.
 * A warden token is refused by the `operator` minimum: a supervising session has no business
 * learning which phones its operator owns.
 *
 * `noStore`: the log is the live answer to "is somebody else in here", and a cached one is not.
 */
export function auditRoutes(subsystem: AuditSubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/audit',
      minimum: 'operator',
      caller: 'any',
      capability: { capability: 'pairing', axis: 'configure' },
      noStore: true,
      handle: async context => {
        const { limit, keptOffset } = parseQuery(context.request, AuditQuerySchema);
        return jsonResponse(AuditViewSchema.parse(await subsystem.recent(limit, keptOffset)));
      },
    },
  ];
}
