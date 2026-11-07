/**
 * The three routes (`GET /v1/onboarding`, `POST /v1/onboarding/steps/:plugin/:stepId`, `POST /v1/onboarding/reset`).
 * Thin: parse, call the service, shape the answer. A route returns step titles, ids and states, never a credential.
 */
import {
  ApiError,
  decodeParameter,
  errorResponse,
  jsonResponse,
  textResponse,
  KERNEL_REFUSALS,
  type ApiResponse,
  type CallContext,
  type RouteHandler,
} from '@ferretry/kernel/contract';
import { ONBOARDING_CODES, StepAnswerRequestSchema, type OnboardingApi } from '../../contract/index.ts';
import { ProgressDamaged } from '../lib/service.ts';

/** A damaged `progress.json` is answered as the kernel answers any damaged store (§9.3), never as an empty run. */
async function guarded(run: () => Promise<ApiResponse>): Promise<ApiResponse> {
  try {
    return await run();
  } catch (error: unknown) {
    if (error instanceof ProgressDamaged)
      return errorResponse(KERNEL_REFUSALS.storeDamaged.status, error.sentence, KERNEL_REFUSALS.storeDamaged.code);
    throw error;
  }
}

async function bodyOf(call: CallContext): Promise<unknown> {
  const text = await call.request.text();
  try {
    return text === '' ? {} : JSON.parse(text);
  } catch {
    throw new ApiError(400, 'The request body is not JSON.');
  }
}

export function onboardingRoutes(api: OnboardingApi) {
  const view: RouteHandler = () => guarded(async () => jsonResponse(await api.view()));

  const answer: RouteHandler = call =>
    guarded(async () => {
      const plugin = decodeParameter(call.params.get('plugin') ?? '');
      const step = decodeParameter(call.params.get('stepId') ?? '');
      if (plugin === undefined || step === undefined) throw new ApiError(400, 'The step in the path is not valid.');
      const parsed = StepAnswerRequestSchema.safeParse(await bodyOf(call));
      if (!parsed.success)
        throw new ApiError(
          400,
          'The answer must be { "state": "found" | "done" | "later" | "skipped" }.',
          undefined,
          parsed.error.issues.map(issue => ({ path: issue.path, message: issue.message })),
        );
      const recorded = await api.answer(plugin, step, parsed.data);
      if (recorded === undefined)
        return errorResponse(404, `There is no first-run step ${plugin}:${step}.`, ONBOARDING_CODES.unknownStep);
      return jsonResponse(recorded);
    });

  const reset: RouteHandler = () =>
    guarded(async () => {
      await api.reset();
      return textResponse('', 204);
    });

  return {
    'GET /v1/onboarding': view,
    'POST /v1/onboarding/steps/:plugin/:stepId': answer,
    'POST /v1/onboarding/reset': reset,
  } as const;
}
