import {
  DaemonUpdateSettingsPatchSchema,
  DaemonUpdateStartRequestSchema,
  type DaemonUpdateView,
  STEP_UP_REQUIRED_CODE,
  type StepUpRequiredBody,
} from '@ferretry/protocol';
import { isAgentCaller } from '../../api/agent-caller.ts';
import { parseBody } from '../../api/body.ts';
import { ApiError } from '../../api/error.ts';
import type { ApiResponse } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import { DaemonUpdateRefusal, type DaemonUpdateSubsystem } from '../../update/index.ts';

/**
 * Updating this machine's daemon: `GET /v1/daemon/update`, `POST /v1/daemon/update` and
 * `PATCH /v1/daemon/update/settings` (docs/updating.md).
 *
 * THE `fleet` CAPABILITY, because the capability set is closed and an update restarts the daemon
 * every ferret runs under. Reading is `use`; starting an update or changing the setting is
 * `configure`.
 *
 * A REMOTE DEVICE ALSO CONFIRMS WITH A PASSKEY, for this act alone, like loosening a configuration
 * file: an update downloads and runs new code on the machine, which is at least as much as anything
 * that rule covers. Turning automatic install OFF never needs one — the safe direction is never
 * gated. `fy` at the machine is ungoverned, as everywhere. An agent may do neither: updating is the
 * owner's act.
 */

const USE = { capability: 'fleet', axis: 'use' } as const;
const CONFIGURE = { capability: 'fleet', axis: 'configure' } as const;

/**
 * The refusal for a governed caller with no fresh passkey proof, or `undefined` when it may go on. Shared
 * with the harness update (`harness-update.ts`): putting new code on the machine is the same act.
 */
export function ownerOnly(context: RouteContext, act: string): ApiResponse | undefined {
  if (isAgentCaller(context)) throw new ApiError(403, `a ferret cannot ${act}; the owner does`, 'forbidden');
  if (context.governance?.governed !== true || context.presentation?.freshStepUp === true) return undefined;
  return jsonResponse(
    {
      error: `to ${act} from this device, confirm with a passkey`,
      code: STEP_UP_REQUIRED_CODE,
      demand: CONFIGURE,
    } satisfies StepUpRequiredBody,
    403,
  );
}

/** Restates a domain refusal as a 409 carrying its code, so the app can say the right sentence. */
function refuse(error: unknown): never {
  if (!(error instanceof DaemonUpdateRefusal)) throw error;
  throw new ApiError(409, error.message, error.code);
}

async function start(subsystem: DaemonUpdateSubsystem, context: RouteContext): Promise<ApiResponse> {
  const request = await parseBody(context.request, DaemonUpdateStartRequestSchema);
  const refused = ownerOnly(context, 'update this machine');
  if (refused !== undefined) return refused;
  let view: DaemonUpdateView;
  try {
    view = await subsystem.start(request);
  } catch (error) {
    return refuse(error);
  }
  if (context.governance?.governed === true) context.spendFreshStepUp?.();
  return jsonResponse(view, 202);
}

async function settings(subsystem: DaemonUpdateSubsystem, context: RouteContext): Promise<ApiResponse> {
  const patch = await parseBody(context.request, DaemonUpdateSettingsPatchSchema);
  if (patch.autoInstall) {
    const refused = ownerOnly(context, 'turn on automatic updates');
    if (refused !== undefined) return refused;
  } else if (isAgentCaller(context)) {
    throw new ApiError(403, 'a ferret cannot change how this machine updates; the owner does', 'forbidden');
  }
  const view = await subsystem.setAutoInstall(patch.autoInstall);
  if (patch.autoInstall && context.governance?.governed === true) context.spendFreshStepUp?.();
  return jsonResponse(view);
}

export function daemonUpdateRoutes(subsystem: DaemonUpdateSubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/daemon/update',
      minimum: 'operator',
      caller: 'any',
      capability: USE,
      noStore: true,
      handle: async () => jsonResponse(await subsystem.view()),
    },
    {
      method: 'POST',
      path: '/v1/daemon/update',
      minimum: 'operator',
      caller: 'person',
      capability: CONFIGURE,
      noStore: true,
      handle: async context => await start(subsystem, context),
    },
    {
      method: 'PATCH',
      path: '/v1/daemon/update/settings',
      minimum: 'operator',
      caller: 'person',
      capability: CONFIGURE,
      noStore: true,
      handle: async context => await settings(subsystem, context),
    },
  ];
}
