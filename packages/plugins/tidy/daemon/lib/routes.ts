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
  TidyPlanRequestSchema,
  TidyPlanSchema,
  type TidyPlanRequest,
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
  /** Whether the ferret is one this machine knows. */
  known(ferret: NonNullable<ReturnType<typeof ferretOf>>): Promise<boolean>;
}

/** The plan's optional body: empty is allowed (a ferret asking about itself); anything else must be the one field. */
async function planRequest(request: ApiRequest): Promise<TidyPlanRequest> {
  let text: string;
  try {
    text = await request.text(BODY_LIMIT);
  } catch {
    throw new ApiError(400, 'the request body could not be read', 'unreadable_body');
  }
  if (text.trim() === '') return {};
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ApiError(400, 'the request body is not JSON', 'invalid_json');
  }
  const parsed = TidyPlanRequestSchema.safeParse(raw);
  if (!parsed.success)
    throw new ApiError(
      422,
      'the request is not one this route takes',
      'invalid_request',
      parsed.error.issues.map(issue => ({ path: issue.path, message: issue.message })),
    );
  return parsed.data;
}

/**
 * The plan is a read of ONE ferret's work. A ferret's own credential decides whose: itself, and naming any other ferret is
 * refused, so a ferret cannot ask for another's plan. A caller that is not a ferret (the owner at the machine, a paired
 * device) has no work of its own, so it must name the ferret to tidy (v4's `--session`) and is refused with how to when it
 * does not.
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
      const requested = await planRequest(call.request);
      const own = ferretOf(call);
      if (own !== undefined && requested.ferret !== undefined && requested.ferret !== own)
        throw new ApiError(
          403,
          'fy tidy: a ferret tidies only its own work; the owner names another ferret with --ferret <id>',
          TIDY_CODES.notYours,
        );
      const ferret = own ?? requested.ferret;
      if (ferret === undefined)
        throw new ApiError(
          403,
          'fy tidy tidies the work of one ferret: run it inside that ferret’s own pane, or name it with --ferret <id>',
          TIDY_CODES.forbidden,
        );
      if (own === undefined && !(await planner.known(ferret)))
        throw new ApiError(404, `no ferret ${ferret} on this machine`, TIDY_CODES.unknownFerret);
      const result = await planner.plan(ferret);
      if (!result.ok)
        throw new ApiError(503, `the tidy plan could not be read: ${result.message}`, TIDY_CODES.unavailable);
      return jsonResponse(TidyPlanSchema.parse(result.plan));
    },
  } satisfies Record<string, RouteHandler>;
}
