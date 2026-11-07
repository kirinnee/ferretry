/** Layouts' route handlers: parse, ask the service, answer. Refusals are final sentences with a code. */
import {
  ApiError,
  decodeParameter,
  errorResponse,
  jsonResponse,
  type ApiRequest,
  type CallContext,
  type PlainApiResponse,
} from '@ferretry/kernel/contract';
import type { z } from 'zod';
import {
  LAYOUT_CODES,
  LayoutIdSchema,
  LayoutSaveRequestSchema,
  LayoutSetRequestSchema,
  LayoutUseRequestSchema,
  ThemeUseRequestSchema,
} from '../../contract/index.ts';
import type { LayoutsService, Outcome, Refusal } from './service.ts';

const BODY_LIMIT = 16 * 1024;

async function bodyOf<S extends z.ZodType>(request: ApiRequest, schema: S): Promise<z.infer<S>> {
  const text = await request.text(BODY_LIMIT);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ApiError(400, 'the request body is not JSON', LAYOUT_CODES.invalid);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    throw new ApiError(
      422,
      'the request is not one this route takes',
      LAYOUT_CODES.invalid,
      parsed.error.issues.map(issue => ({ path: issue.path, message: issue.message })),
    );
  return parsed.data;
}

function refusalResponse(refusal: Refusal): PlainApiResponse {
  switch (refusal.kind) {
    case 'invalid':
      return errorResponse(422, 'that layout cannot be used', refusal.code, { issues: refusal.issues });
    case 'unknown':
      return errorResponse(404, refusal.sentence, refusal.code);
    case 'conflict':
      return errorResponse(409, refusal.sentence, refusal.code);
  }
}

const answer = <T>(outcome: Outcome<T>, ok: (value: T) => PlainApiResponse): PlainApiResponse =>
  outcome.ok ? ok(outcome.value) : refusalResponse(outcome.refusal);

function layoutIdOf(call: CallContext): string | undefined {
  const raw = call.params.get('layoutId');
  const decoded = raw === undefined ? undefined : decodeParameter(raw);
  const parsed = LayoutIdSchema.safeParse(decoded);
  return parsed.success ? parsed.data : undefined;
}

export function layoutsRoutes(service: LayoutsService) {
  return {
    'GET /v1/layouts': async () => jsonResponse(service.list()),
    'GET /v1/layouts/current': async () => jsonResponse(service.current()),
    'GET /v1/layouts/themes': async () => jsonResponse(service.themes()),
    'GET /v1/layouts/:layoutId': async (call: CallContext) => {
      const id = layoutIdOf(call);
      const layout = id === undefined ? undefined : service.layout(id);
      return layout === undefined
        ? errorResponse(404, 'there is no such layout', LAYOUT_CODES.unknown)
        : jsonResponse(layout);
    },
    'PATCH /v1/layouts/current': async (call: CallContext) => {
      const { changes } = await bodyOf(call.request, LayoutSetRequestSchema);
      return answer(await service.set(changes), current => jsonResponse({ current }));
    },
    'PUT /v1/layouts/current': async (call: CallContext) => {
      const { layout } = await bodyOf(call.request, LayoutUseRequestSchema);
      return answer(await service.use(layout), current => jsonResponse({ current }));
    },
    'PUT /v1/layouts/theme': async (call: CallContext) => {
      const { theme } = await bodyOf(call.request, ThemeUseRequestSchema);
      return answer(await service.useTheme(theme), current => jsonResponse({ current }));
    },
    'POST /v1/layouts/reset': async () => answer(await service.reset(), current => jsonResponse({ current })),
    'POST /v1/layouts': async (call: CallContext) => {
      const { id } = await bodyOf(call.request, LayoutSaveRequestSchema);
      return answer(await service.save(id), saved => jsonResponse(saved, 201));
    },
    'DELETE /v1/layouts/:layoutId': async (call: CallContext) => {
      const id = layoutIdOf(call);
      if (id === undefined) return errorResponse(404, 'there is no such layout', LAYOUT_CODES.unknown);
      return answer(await service.remove(id), removed => jsonResponse({ id: removed, removed: true }));
    },
  };
}
