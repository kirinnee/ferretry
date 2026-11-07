/** Tidy's route handlers: parse, ask the service, answer. Copied from today's `scratch-gc.ts` and `tidy.ts` mounts. */
import {
  ApiError,
  type ApiRequest,
  type CallContext,
  jsonResponse,
  type RouteHandler,
} from '@ferretry/kernel/contract';
import { ferretOf } from '@ferretry/core-gate/contract';
import {
  SCRATCH_CODES,
  ScratchPlanListSchema,
  ScratchSweepRequestSchema,
  ScratchSweepViewSchema,
  TIDY_CODES,
  TidyPlanSchema,
} from '../../contract/index.ts';
import type { ScratchCollector } from './scratch-collector.ts';
import type { TidyPlanResult } from './service.ts';

const BODY_LIMIT = 4 * 1024;
const DEFAULT_LIMIT = 20;

function requestedLimit(request: ApiRequest): number {
  for (const [name] of request.query) {
    if (name !== 'limit') throw new ApiError(400, `unknown gc parameter ${name}`, SCRATCH_CODES.unknownParameter);
  }
  const raw = request.query.get('limit')?.[0];
  if (raw === undefined) return DEFAULT_LIMIT;
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new ApiError(400, 'gc limit must be a positive whole number', SCRATCH_CODES.invalidLimit);
  return limit;
}

async function sweepRequest(request: ApiRequest): Promise<{ readonly force: boolean }> {
  let raw: unknown;
  try {
    raw = JSON.parse(await request.text(BODY_LIMIT));
  } catch {
    throw new ApiError(400, 'the request body is not JSON', 'invalid_json');
  }
  const parsed = ScratchSweepRequestSchema.safeParse(raw);
  if (!parsed.success)
    throw new ApiError(
      422,
      'the request is not one this route takes',
      'invalid_request',
      parsed.error.issues.map(issue => ({ path: issue.path, message: issue.message })),
    );
  return parsed.data;
}

/** What a plan route needs from the service. */
export interface TidyPlanner {
  plan(ferret: NonNullable<ReturnType<typeof ferretOf>>): Promise<TidyPlanResult>;
}

/**
 * The plan is a read, and a read of ONE ferret's own work: the ferret is the caller's own credential's, never a field of
 * the request, so a ferret cannot ask for another's plan. The owner and the admin token with no ferret have no work of
 * their own to tidy and are refused with the way to do it by hand.
 */
export function tidyRoutes(collector: ScratchCollector, planner: TidyPlanner) {
  return {
    'GET /v1/gc': async (call: CallContext) =>
      jsonResponse(ScratchPlanListSchema.parse(await collector.plan(requestedLimit(call.request)))),
    'POST /v1/gc': async (call: CallContext) => {
      const { force } = await sweepRequest(call.request);
      return jsonResponse(ScratchSweepViewSchema.parse(await collector.sweep(force)));
    },
    'POST /v1/tidy/plan': async (call: CallContext) => {
      const ferret = ferretOf(call);
      if (ferret === undefined)
        throw new ApiError(
          403,
          'fy tidy tidies the work of the ferret that runs it; run it inside a ferret’s own pane',
          TIDY_CODES.forbidden,
        );
      const result = await planner.plan(ferret);
      if (!result.ok)
        throw new ApiError(503, `the tidy plan could not be read: ${result.message}`, TIDY_CODES.unavailable);
      return jsonResponse(TidyPlanSchema.parse(result.plan));
    },
  } satisfies Record<string, RouteHandler>;
}
