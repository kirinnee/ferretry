import {
  HARNESS_UPDATE_CODES,
  HarnessUpdateStartRequestSchema,
  type HarnessUpdateUnverifiedBody,
  type HarnessUpdateView,
} from '@ferretry/protocol';
import { parseBody } from '../../api/body.ts';
import { ApiError } from '../../api/error.ts';
import type { ApiResponse } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import { HarnessUpdateRefusal, type HarnessUpdateSubsystem } from '../../harness-update/index.ts';
import { ownerOnly } from './daemon-update.ts';

/**
 * Updating this machine's `claude` and `codex`: `GET /v1/harnesses/update` and
 * `POST /v1/harnesses/update` (docs/updating.md › "Updating Claude Code and Codex").
 *
 * THE `fleet` CAPABILITY, like the daemon's own update: reading is `use`, starting an update is
 * `configure`. A remote device also confirms with a passkey, and a ferret may never start one — it
 * would be an agent replacing the program it runs as. The gate is the daemon update's own
 * ({@link ownerOnly}), so the two acts can never be governed differently.
 *
 * The read is also when npm is asked for the newest version: opening the panel, or `fy harness status`,
 * is the only thing that ever asks.
 */

const USE = { capability: 'fleet', axis: 'use' } as const;
const CONFIGURE = { capability: 'fleet', axis: 'configure' } as const;

/** A domain refusal as a 409. The unverified one is an ANSWER, because its body carries both versions. */
function refuse(error: unknown): ApiResponse {
  if (!(error instanceof HarnessUpdateRefusal)) throw error;
  if (error.unverified !== undefined) {
    return jsonResponse(
      {
        error: error.message,
        code: HARNESS_UPDATE_CODES.unverified,
        ...error.unverified,
      } satisfies HarnessUpdateUnverifiedBody,
      409,
    );
  }
  throw new ApiError(409, error.message, error.code);
}

async function start(subsystem: HarnessUpdateSubsystem, context: RouteContext): Promise<ApiResponse> {
  const request = await parseBody(context.request, HarnessUpdateStartRequestSchema);
  const refused = ownerOnly(context, 'update the agent CLIs on this machine');
  if (refused !== undefined) return refused;
  let view: HarnessUpdateView;
  try {
    view = await subsystem.start(request);
  } catch (error) {
    return refuse(error);
  }
  if (context.governance?.governed === true) context.spendFreshStepUp?.();
  return jsonResponse(view, 202);
}

export function harnessUpdateRoutes(subsystem: HarnessUpdateSubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/harnesses/update',
      minimum: 'operator',
      caller: 'any',
      capability: USE,
      noStore: true,
      handle: async () => jsonResponse(await subsystem.view()),
    },
    {
      method: 'POST',
      path: '/v1/harnesses/update',
      minimum: 'operator',
      caller: 'person',
      capability: CONFIGURE,
      noStore: true,
      handle: async context => await start(subsystem, context),
    },
  ];
}
