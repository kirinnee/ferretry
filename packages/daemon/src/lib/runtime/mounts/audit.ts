import { AuditQuerySchema, AuditViewSchema } from '@ferretry/protocol';
import { parseQuery } from '../../api/body.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute } from '../../api/route.ts';
import type { AuditReading } from '../../audit/index.ts';

/** The read half of the security log. The write half is `AuditSink`, which no route exposes. */
export interface AuditSubsystem {
  recent(limit: number): Promise<AuditReading>;
}

/**
 * `GET /v1/audit` — who reached this machine and what they did, newest first.
 *
 * GOVERNED BY `pairing.use`, the same demand as the device list and its revoke. The log names
 * devices, and the person who may see which devices are paired — and remove one — is the person who
 * most needs to see what each of them has done. A warden token is refused by the `operator` minimum
 * for the reason it is refused the device list: a supervising session has no business learning which
 * phones its operator owns.
 *
 * `noStore`: the log is the live answer to "is somebody else in here", and a cached one is not.
 */
export function auditRoutes(subsystem: AuditSubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/audit',
      minimum: 'operator',
      capability: { capability: 'pairing', axis: 'use' },
      noStore: true,
      handle: async context => {
        const { limit } = parseQuery(context.request, AuditQuerySchema);
        return jsonResponse(AuditViewSchema.parse(await subsystem.recent(limit)));
      },
    },
  ];
}
