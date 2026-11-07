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
import { ApiError, type ApiResponse, jsonResponse, type RouteHandler } from '@ferretry/kernel/contract';
import type { z } from 'zod';
import {
  CloneBundleSchema,
  CloneForgetRequestSchema,
  CloneForgetResultSchema,
  CloneKeysRecordRequestSchema,
  CloneKeysRecordResultSchema,
  CloneReviewRequestSchema,
  CloneReviewSchema,
  SetupScanSchema,
  ToolInstallRequestSchema,
  ToolInstallResultSchema,
} from '../../contract/index.ts';
import { FleetSetupRefusal, type FleetSetupService } from '../lib/service/setup-service.ts';
import { parseBody } from './body.ts';

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

/**
 * This subsystem's handlers, keyed by the manifest's route keys. Who may call, and what the audit log records, are
 * the manifest's descriptors now; a handler only does the work.
 */
export function fleetSetupRoutes(subsystem: FleetSetupSubsystem) {
  return {
    'GET /v1/runtimes/setup/scan': async () => await answer(SetupScanSchema, () => subsystem.scan()),
    'POST /v1/runtimes/machine/tools/install': async call => {
      const request = await parseBody(call.request, ToolInstallRequestSchema);
      return await answer(ToolInstallResultSchema, () => subsystem.installTools(request, call.governance));
    },
    'GET /v1/runtimes/export': async () => await answer(CloneBundleSchema, () => subsystem.exportBundle()),
    // A review reads this machine's own setup against a bundle and writes nothing; `person` because what it answers is
    // the diff of a configuration the caller is about to change.
    'POST /v1/runtimes/clone/review': async call => {
      const request = await parseBody(call.request, CloneReviewRequestSchema);
      return await answer(CloneReviewSchema, () => subsystem.reviewClone(request, call.governance));
    },
    // Forgetting writes the "last copied" record and nothing else: no copied item, no login, no secret.
    'POST /v1/runtimes/clone/forget': async call => {
      const request = await parseBody(call.request, CloneForgetRequestSchema);
      return await answer(CloneForgetResultSchema, async () => ({
        forgotten: await subsystem.forgetCloneSource(request.source),
      }));
    },
    // The sealed copy of the keys has landed here; this remembers when each side last changed them. It writes only
    // `keys` of the record (timestamps).
    'POST /v1/runtimes/clone/keys': async call => {
      const request = await parseBody(call.request, CloneKeysRecordRequestSchema);
      return await answer(CloneKeysRecordResultSchema, () => subsystem.recordCloneKeys(request));
    },
  } satisfies Record<string, RouteHandler>;
}
