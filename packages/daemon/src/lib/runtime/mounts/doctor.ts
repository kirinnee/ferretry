import { DoctorReportSchema, type DoctorReport } from '@ferretry/protocol';
import type { ApiRoute } from '../../api/route.ts';
import { jsonResponse } from '../../api/responses.ts';

/** A fresh host diagnosis; PATH can change after the daemon starts. */
export interface DoctorSubsystem {
  report(): Promise<DoctorReport>;
}

export function doctorRoutes(subsystem: DoctorSubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/doctor',
      scope: 'admin',
      minimum: 'operator',
      noStore: true,
      handle: async () => jsonResponse(DoctorReportSchema.parse(await subsystem.report())),
    },
  ];
}
