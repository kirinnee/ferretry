/**
 * The routes a machine's setup is read and changed through (docs/design/account-model.md §4.3, §4.7,
 * §7). The service is `fleet/setup-service.ts`; the import and the clone themselves are reviewed
 * changes staged at `/v1/fleet/proposals`, which run its executors.
 *
 * ## All three are `fleet.configure`
 *
 * The scan reads the person's own harness setup — file names, server names, secret-looking key names —
 * and the export is everything a Clone copies, so neither is a `fleet.use` read even though both write
 * nothing. Installing a tool runs a package manager on this machine, which is a `fleet.configure` act
 * a caller off this host makes only behind the passkey step-up. No answer carries
 * a credential or a secret value.
 *
 * ## `noStore` on all three
 *
 * Every answer is a statement about now: what is installed, and what the host's setup says.
 */
import {
  FleetCloneBundleSchema,
  FleetCloneForgetRequestSchema,
  FleetCloneForgetResultSchema,
  FleetCloneKeysRecordRequestSchema,
  FleetCloneKeysRecordResultSchema,
  FleetCloneReviewRequestSchema,
  FleetCloneReviewSchema,
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
import { FleetSetupRefusal, type FleetSetupService } from '../lib/service/setup-service.ts';

/** First-run scan, tool install, the clone export and the clone review. */
export type FleetSetupSubsystem = Pick<
  FleetSetupService,
  'scan' | 'installTools' | 'exportBundle' | 'reviewClone' | 'forgetCloneSource' | 'recordCloneKeys' | 'executors'
>;

/** `403` for a caller the grants refuse; `409` for every other refusal, as the fleet's own answer. */
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
      caller: 'any',
      capability: CONFIGURE,
      noStore: true,
      handle: async () => await answer(FleetSetupScanSchema, () => subsystem.scan()),
    },
    {
      method: 'POST',
      path: '/v1/fleet/machine/tools/install',
      minimum: 'operator',
      caller: 'person',
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
      caller: 'any',
      capability: CONFIGURE,
      noStore: true,
      handle: async () => await answer(FleetCloneBundleSchema, () => subsystem.exportBundle()),
    },
    {
      // A review reads this machine's own setup against a bundle and writes nothing; `person` because what
      // it answers is the diff of a configuration the caller is about to change.
      method: 'POST',
      path: '/v1/fleet/clone/review',
      minimum: 'operator',
      caller: 'person',
      capability: CONFIGURE,
      noStore: true,
      handle: async context => {
        const request = await parseBody(context.request, FleetCloneReviewRequestSchema);
        return await answer(FleetCloneReviewSchema, () => subsystem.reviewClone(request, context.governance));
      },
    },
    {
      // Forgetting writes the "last copied" record and nothing else: no copied item, no login, no secret.
      // `person` for the same reason the review is: it changes what a copy will do next.
      method: 'POST',
      path: '/v1/fleet/clone/forget',
      minimum: 'operator',
      caller: 'person',
      capability: CONFIGURE,
      noStore: true,
      handle: async context => {
        const request = await parseBody(context.request, FleetCloneForgetRequestSchema);
        return await answer(FleetCloneForgetResultSchema, async () => ({
          forgotten: await subsystem.forgetCloneSource(request.source),
        }));
      },
    },
    {
      // The sealed copy of the keys has landed here; this remembers when each side last changed them. It
      // writes only `keys` of the record (timestamps), and person-only like the review it follows.
      method: 'POST',
      path: '/v1/fleet/clone/keys',
      minimum: 'operator',
      caller: 'person',
      capability: CONFIGURE,
      noStore: true,
      handle: async context => {
        const request = await parseBody(context.request, FleetCloneKeysRecordRequestSchema);
        return await answer(FleetCloneKeysRecordResultSchema, () => subsystem.recordCloneKeys(request));
      },
    },
  ];
}
