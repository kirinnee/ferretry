/** Shells' route handlers: parse, ask the service, answer. Refusals are final sentences with a code. */
import {
  ApiError,
  type ApiRequest,
  type CallContext,
  decodeParameter,
  errorResponse,
  jsonResponse,
  type PlainApiResponse,
} from '@ferretry/kernel/contract';
import type { z } from 'zod';
import { SHELL_CODES, ShellAddRequestSchema, ShellNameSchema, ShellRelockRequestSchema } from '../../contract/index.ts';
import type { Outcome, ShellsService } from './service.ts';

const BODY_LIMIT = 16 * 1024;

async function bodyOf<S extends z.ZodType>(request: ApiRequest, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = JSON.parse(await request.text(BODY_LIMIT));
  } catch {
    throw new ApiError(400, 'the request body is not JSON', SHELL_CODES.invalid);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    throw new ApiError(
      422,
      'the request is not one this route takes',
      SHELL_CODES.invalid,
      parsed.error.issues.map(issue => ({ path: issue.path, message: issue.message })),
    );
  return parsed.data;
}

const answer = <T>(outcome: Outcome<T>, ok: (value: T) => PlainApiResponse): PlainApiResponse =>
  outcome.ok
    ? ok(outcome.value)
    : errorResponse(outcome.refusal.status, outcome.refusal.sentence, outcome.refusal.code);

function nameOf(call: CallContext) {
  const raw = call.params.get('name');
  const decoded = raw === undefined ? undefined : decodeParameter(raw);
  const parsed = ShellNameSchema.safeParse(decoded);
  return parsed.success ? parsed.data : undefined;
}

const unknown = (): PlainApiResponse => errorResponse(404, 'there is no such shell', SHELL_CODES.unknown);

export function shellsRoutes(service: ShellsService) {
  const named =
    (act: (name: ReturnType<typeof ShellNameSchema.parse>) => Promise<PlainApiResponse>) =>
    async (call: CallContext): Promise<PlainApiResponse> => {
      const name = nameOf(call);
      return name === undefined ? unknown() : await act(name);
    };
  return {
    'GET /v1/shells': async () => jsonResponse({ shells: await service.list() }),
    'GET /v1/shells/nix': async () => jsonResponse(await service.nix()),
    'GET /v1/shells/:name': named(async name => {
      const detail = await service.get(name);
      return detail === undefined ? unknown() : jsonResponse(detail);
    }),
    'POST /v1/shells/preview': async (call: CallContext) =>
      answer(await service.preview(await bodyOf(call.request, ShellAddRequestSchema)), preview =>
        jsonResponse(preview),
      ),
    'POST /v1/shells': async (call: CallContext) => {
      const request = await bodyOf(call.request, ShellAddRequestSchema);
      return answer(await service.add(request), added =>
        jsonResponse(
          { name: request.name, lock: added.lock, ...(added.held === undefined ? {} : { held: added.held }) },
          added.held === undefined ? 201 : 202,
        ),
      );
    },
    'POST /v1/shells/:name/relock': async (call: CallContext) => {
      const name = nameOf(call);
      if (name === undefined) return unknown();
      const request = await bodyOf(call.request, ShellRelockRequestSchema);
      return answer(await service.relock(name, request), preview =>
        jsonResponse(preview, preview.held === undefined ? 200 : 202),
      );
    },
    'POST /v1/shells/:name/build': named(async name =>
      answer(await service.build(name), result => jsonResponse(result)),
    ),
    'DELETE /v1/shells/:name': named(async name =>
      answer(await service.remove(name), removed => jsonResponse({ name: removed, removed: true })),
    ),
  };
}
