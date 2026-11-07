/**
 * Updating this machine's `codex`: `GET /v1/codex/update` and `POST /v1/codex/update`.
 *
 * THE `fleet` CAPABILITY, like the daemon's own update: reading is `use`, starting an update is `configure`. A remote
 * device also confirms with a passkey, and a ferret may never start one — it would be an agent replacing the program it
 * runs as. The gate is the daemon update's own, so the two acts can never be governed differently.
 *
 * The read is also when npm is asked for the newest version: opening the panel, or `fy harness codex status`, is the
 * only thing that ever asks.
 */
import { ApiError, type CallContext, jsonResponse, type RouteHandler } from '@ferretry/kernel/contract';
import { isFerretCall, STEP_UP_REQUIRED_CODE, type StepUpRequiredBody } from '@ferretry/core-gate/contract';
import type { z } from 'zod';
import {
  HARNESS_UPDATE_CODES,
  HarnessUpdateStartRequestSchema,
  type HarnessUpdateUnverifiedBodySchema,
} from '../../contract/index.ts';
import { HarnessUpdateRefusal, type HarnessUpdateSubsystem } from './update/service.ts';

/** The body a `harness_update_unverified` answer carries: what would be installed, and what Ferretry verified. */
type HarnessUpdateUnverifiedBody = z.infer<typeof HarnessUpdateUnverifiedBodySchema>;

/** The largest body this route has a use for: a version and a yes. */
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

/**
 * The start request, parsed at the boundary: a body that does not satisfy the schema never becomes a domain value,
 * and the caller is told which field was wrong without the submitted values coming back.
 */
async function readStart(call: CallContext): Promise<z.output<typeof HarnessUpdateStartRequestSchema>> {
  let text: string;
  try {
    text = await call.request.text(MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof Error && error.name === 'BodyTooLargeError') throw new ApiError(413, error.message, 'body_too_large');
    throw new ApiError(400, 'the request body could not be read', 'unreadable_body');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError(400, 'the request body is not valid JSON', 'invalid_json');
  }
  const result = HarnessUpdateStartRequestSchema.safeParse(parsed);
  if (result.success) return result.data;
  const detail = result.error.issues
    .map(issue => `${issue.path.join('.') === '' ? 'body' : issue.path.join('.')}: ${issue.message}`)
    .join('; ');
  throw new ApiError(400, `the request body is invalid — ${detail}`, 'invalid_request', result.error.issues);
}

/** Refuses a ferret, and a governed device that has not confirmed with a passkey. */
function ownerOnly(call: CallContext, act: string): ReturnType<typeof jsonResponse> | undefined {
  if (isFerretCall(call)) throw new ApiError(403, `a ferret cannot ${act}; the owner does`, 'forbidden');
  if (call.governance?.governed !== true || call.presentation?.freshStepUp === true) return undefined;
  return jsonResponse(
    {
      error: `to ${act} from this device, confirm with a passkey`,
      code: STEP_UP_REQUIRED_CODE,
      demand: { capability: 'fleet', axis: 'configure' },
    } satisfies StepUpRequiredBody,
    403,
  );
}

export function codexUpdateRoutes(subsystem: HarnessUpdateSubsystem): {
  readonly 'GET /v1/codex/update': RouteHandler;
  readonly 'POST /v1/codex/update': RouteHandler;
} {
  return {
    'GET /v1/codex/update': async () => jsonResponse(await subsystem.view()),
    'POST /v1/codex/update': async call => {
      const request = await readStart(call);
      const refused = ownerOnly(call, 'update the agent CLIs on this machine');
      if (refused !== undefined) return refused;
      let view: Awaited<ReturnType<HarnessUpdateSubsystem['start']>>;
      try {
        view = await subsystem.start(request);
      } catch (error) {
        return refuse(error);
      }
      if (call.governance?.governed === true) call.spendFreshStepUp?.();
      return jsonResponse(view, 202);
    },
  };
}
