/**
 * The routes a person changes one login through (today's reviewed `credential.*` changes, owned by Logins).
 *
 * Staging holds a change and answers what applying it would do; applying consumes exactly that held change and
 * never reads a request body. Both are `fleet.configure` (in the manifest): a governed caller needs the live
 * passkey step-up before a login is added, labelled, switched, signed out or removed.
 */
import { ApiError, decodeParameter, jsonResponse, type RouteHandler } from '@ferretry/kernel/contract';
import { LoginChangeOutcomeSchema, LoginChangeSchema, LoginChangeViewSchema } from '../../../contract/index.ts';
import { LoginChangeError, type LoginChangeService } from '../changes/service.ts';
import { parseBody } from './body.ts';

export type LoginChangesSubsystem = Pick<LoginChangeService, 'stage' | 'view' | 'apply'>;

/** `404` for a change nobody holds, `409` for every other refusal: a client branches on the CODE. */
const refusal = (error: LoginChangeError): ApiError =>
  new ApiError(error.code === 'login_change_unknown' ? 404 : 409, error.message, error.code);

async function answer(work: () => Promise<unknown> | unknown, parse: (value: unknown) => unknown) {
  try {
    return jsonResponse(parse(await work()));
  } catch (error) {
    if (error instanceof LoginChangeError) throw refusal(error);
    throw error;
  }
}

const changeId = (params: ReadonlyMap<string, string>): string => {
  const id = decodeParameter(params.get('changeId') ?? '') ?? '';
  if (id === '') throw new ApiError(400, 'the change id in the path is not usable', 'bad_request');
  return id;
};

export function changeRoutes(subsystem: LoginChangesSubsystem) {
  return {
    'POST /v1/logins/changes': (async call =>
      await answer(
        async () => await subsystem.stage(await parseBody(call.request, LoginChangeSchema)),
        value => LoginChangeViewSchema.parse(value),
      )) satisfies RouteHandler,
    'GET /v1/logins/changes/:changeId': (async call =>
      await answer(
        () => subsystem.view(changeId(call.params)),
        value => LoginChangeViewSchema.parse(value),
      )) satisfies RouteHandler,
    'POST /v1/logins/changes/:changeId/apply': (async call =>
      await answer(
        async () => await subsystem.apply(changeId(call.params)),
        value => LoginChangeOutcomeSchema.parse(value),
      )) satisfies RouteHandler,
  };
}
