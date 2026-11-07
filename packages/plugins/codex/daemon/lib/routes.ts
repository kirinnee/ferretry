/**
 * Updating this machine's `codex`: `GET /v1/codex/update` and `POST /v1/codex/update`.
 *
 * THE `fleet` CAPABILITY, like the daemon's own update: reading is `use`, starting an update is `configure`. A remote
 * device also confirms with a passkey, and a ferret may never start one — it would be an agent replacing the program it
 * runs as. The gate is the daemon update's own (Gate's `claimOwnerOnly`), so the acts can never be governed differently;
 * the proof is claimed before the update starts, so one proof admits one start.
 *
 * The read is also when npm is asked for the newest version: opening the panel, or `fy harness codex status`, is the
 * only thing that ever asks.
 */
import { ApiError, jsonResponse, parseBody, type RouteHandler } from '@ferretry/kernel/contract';
import { claimOwnerOnly } from '@ferretry/core-gate/contract';
import type { z } from 'zod';
import {
  HARNESS_UPDATE_CODES,
  HarnessUpdateStartRequestSchema,
  type HarnessUpdateUnverifiedBodySchema,
} from '../../contract/index.ts';
import { HarnessUpdateRefusal, type HarnessUpdateSubsystem } from './update/service.ts';

/** The body a `harness_update_unverified` answer carries: what would be installed, and what Ferretry verified. */
type HarnessUpdateUnverifiedBody = z.infer<typeof HarnessUpdateUnverifiedBodySchema>;

/** The largest body this route has a use for: a version and a yes (read through the kernel's `parseBody`). */
const MAX_BODY_BYTES = 4 * 1024;

/** A domain refusal as a 409. The unverified one is an ANSWER, because its body carries both versions. */
function refuse(error: unknown): ReturnType<typeof jsonResponse> {
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

export function codexUpdateRoutes(subsystem: HarnessUpdateSubsystem): {
  readonly 'GET /v1/codex/update': RouteHandler;
  readonly 'POST /v1/codex/update': RouteHandler;
} {
  return {
    'GET /v1/codex/update': async () => jsonResponse(await subsystem.view()),
    'POST /v1/codex/update': async call => {
      const request = await parseBody(call.request, HarnessUpdateStartRequestSchema, { maxBytes: MAX_BODY_BYTES });
      const refused = claimOwnerOnly(call, 'update the agent CLIs on this machine');
      if (refused !== undefined) return refused;
      let view: Awaited<ReturnType<HarnessUpdateSubsystem['start']>>;
      try {
        view = await subsystem.start(request);
      } catch (error) {
        return refuse(error);
      }
      return jsonResponse(view, 202);
    },
  };
}
