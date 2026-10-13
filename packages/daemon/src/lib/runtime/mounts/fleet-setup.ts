/**
 * The routes a machine's setup is read and changed through (docs/design/account-model.md §4.3, §4.7,
 * §7, §10.3). The service is `fleet/setup-service.ts`; the import and the clone themselves are reviewed
 * changes staged at `/v1/fleet/changes`, which run its executors.
 *
 * ## All five are `fleet.configure`
 *
 * The scan reads the person's own harness setup — file names, server names, secret-looking key names —
 * and the export is everything a Clone copies, so neither is a `fleet.use` read even though both write
 * nothing. Installing a tool runs a package manager on this machine, and the migration moves logins:
 * each adds the per-change operator password for a caller the boundary says owes it. No answer carries
 * a credential or a secret value.
 *
 * ## `noStore` on all five
 *
 * Every answer is a statement about now: what is installed, what the host's setup says, what the dry
 * run would do.
 */
import {
  FleetCloneBundleSchema,
  FleetMigrationApplyRequestSchema,
  FleetMigrationOutcomeSchema,
  FleetMigrationViewSchema,
  FleetSetupScanSchema,
  FleetToolInstallRequestSchema,
  FleetToolInstallResultSchema,
} from '@ferretry/protocol';
import type { z } from 'zod';
import { parseBody } from '../../api/body.ts';
import { ApiError } from '../../api/error.ts';
import type { ApiResponse } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute } from '../../api/route.ts';
import { FleetSetupRefusal, type FleetSetupService } from '../../fleet/setup-service.ts';

/** First-run scan, tool install, the clone export and the migration. */
export type FleetSetupSubsystem = Pick<
  FleetSetupService,
  'scan' | 'installTools' | 'exportBundle' | 'migration' | 'migrate' | 'executors' | 'firstRunAtBoot'
>;

/** `403` for a caller who could not confirm; `409` for every other refusal, as the fleet's own answer. */
function refusal(error: FleetSetupRefusal): ApiError {
  return new ApiError(error.code === 'fleet_setup_unauthorized' ? 403 : 409, error.message, error.code);
}

async function answer<Schema extends z.ZodType>(schema: Schema, work: () => Promise<unknown>): Promise<ApiResponse> {
  try {
    return jsonResponse(schema.parse(await work()));
  } catch (error) {
    if (error instanceof FleetSetupRefusal) throw refusal(error);
    throw error;
  }
}

const CONFIGURE = { capability: 'fleet', axis: 'configure' } as const;

/** This subsystem's route table. */
export function fleetSetupRoutes(subsystem: FleetSetupSubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/fleet/setup/scan',
      minimum: 'operator',
      capability: CONFIGURE,
      noStore: true,
      handle: async () => await answer(FleetSetupScanSchema, () => subsystem.scan()),
    },
    {
      method: 'POST',
      path: '/v1/fleet/machine/tools/install',
      minimum: 'operator',
      capability: CONFIGURE,
      noStore: true,
      handle: async context => {
        const request = await parseBody(context.request, FleetToolInstallRequestSchema);
        return await answer(FleetToolInstallResultSchema, () => subsystem.installTools(request, context.governance));
      },
    },
    {
      method: 'GET',
      path: '/v1/fleet/export',
      minimum: 'operator',
      capability: CONFIGURE,
      noStore: true,
      handle: async () => await answer(FleetCloneBundleSchema, () => subsystem.exportBundle()),
    },
    {
      method: 'GET',
      path: '/v1/fleet/migration',
      minimum: 'operator',
      capability: CONFIGURE,
      noStore: true,
      handle: async () => await answer(FleetMigrationViewSchema, () => subsystem.migration()),
    },
    {
      method: 'POST',
      path: '/v1/fleet/migration/apply',
      minimum: 'operator',
      capability: CONFIGURE,
      noStore: true,
      handle: async context => {
        const request = await parseBody(context.request, FleetMigrationApplyRequestSchema);
        return await answer(FleetMigrationOutcomeSchema, () => subsystem.migrate(request, context.governance));
      },
    },
  ];
}
