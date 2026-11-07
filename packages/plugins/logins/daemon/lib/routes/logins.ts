/**
 * The routes a browser reads this machine's logins through, and presses **Check now** on
 * (docs/design/account-model.md §7).
 *
 * The list is `fleet.use`; Check now and Test are `fleet.configure` (in the manifest): for Codex Check now is a
 * REFRESH, which rotates a single-use token, and Test spends the operator's key once, so a caller off this machine
 * needs a live passkey step-up exactly as a sign-in does. `noStore` on the status routes: a status is a statement
 * about now.
 */
import { ApiError, decodeParameter, jsonResponse, type RouteHandler } from '@ferretry/kernel/contract';
import {
  LoginCheckRequestSchema,
  LoginListSchema,
  LoginTestRequestSchema,
  LoginTestResultSchema,
  LoginViewSchema,
  ProviderPresetCatalogSchema,
} from '../../../contract/index.ts';
import { FleetCredentialRefusal, type FleetCredentialsService } from '../credentials/credentials-service.ts';
import { parseBody } from './body.ts';

/** Logins: status, usage, Check now, Test. Narrowed to the calls the routes make. */
export type LoginsSubsystem = Pick<FleetCredentialsService, 'list' | 'check' | 'test' | 'presets'>;

/** `404` for a login that does not exist, `409` for every other refusal, as the machine's own answer. */
const refusal = (error: FleetCredentialRefusal): ApiError =>
  new ApiError(error.code === 'fleet_credential_unknown' ? 404 : 409, error.message, error.code);

async function answer(work: () => Promise<unknown>, parse: (value: unknown) => unknown) {
  try {
    return jsonResponse(parse(await work()));
  } catch (error) {
    if (error instanceof FleetCredentialRefusal) throw refusal(error);
    throw error;
  }
}

const loginId = (params: ReadonlyMap<string, string>): string => {
  const id = decodeParameter(params.get('loginId') ?? '') ?? '';
  if (id === '') throw new ApiError(400, 'the login id in the path is not usable', 'bad_request');
  return id;
};

export function loginRoutes(subsystem: LoginsSubsystem) {
  return {
    'GET /v1/logins': (async () =>
      await answer(
        () => subsystem.list(),
        value => LoginListSchema.parse(value),
      )) satisfies RouteHandler,
    'POST /v1/logins/:loginId/check': (async call =>
      await answer(
        async () => {
          // An empty strict body: a field a client still sends is refused, not ignored.
          await parseBody(call.request, LoginCheckRequestSchema);
          return await subsystem.check(loginId(call.params), call.governance);
        },
        value => LoginViewSchema.parse(value),
      )) satisfies RouteHandler,
    // Test is Check now's twin for an environment login: it spends the operator's key once.
    'POST /v1/logins/:loginId/test': (async call =>
      await answer(
        async () => {
          const body = await parseBody(call.request, LoginTestRequestSchema);
          return await subsystem.test(
            loginId(call.params),
            { allowInference: body.allowInference === true },
            call.governance,
          );
        },
        value => LoginTestResultSchema.parse(value),
      )) satisfies RouteHandler,
    // The provider presets an environment login is made from. A preset names secrets only by the name they are
    // suggested to be kept under, so it is a `fleet.use` read.
    'GET /v1/logins/presets': (async () =>
      jsonResponse(ProviderPresetCatalogSchema.parse(await subsystem.presets()))) satisfies RouteHandler,
  };
}
