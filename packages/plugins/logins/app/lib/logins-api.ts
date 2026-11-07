/**
 * The app's half of the logins: `GET /v1/logins`, the explicit `POST /v1/logins/:loginId/check` and `…/test`, and
 * `GET /v1/logins/presets`.
 *
 * NOTHING HERE HOLDS A CREDENTIAL. A row is a status word, two usage windows, the runtimes that use the login and what
 * signing it out would do — the shared schema has no field a token or a digest could occupy, and every answer is
 * parsed through it. Signing a login in goes through `harness-login-api.ts`.
 */

import {
  type LoginList,
  LoginListSchema,
  type LoginTestRequest,
  LoginTestRequestSchema,
  type LoginTestResult,
  LoginTestResultSchema,
  type LoginView,
  LoginViewSchema,
  type ProviderPresetCatalog,
  ProviderPresetCatalogSchema,
} from '../../contract/index.ts';
import type { LoginsClient } from './client.ts';

export const ROUTES = {
  list: 'GET /v1/logins',
  check: 'POST /v1/logins/:loginId/check',
  test: 'POST /v1/logins/:loginId/test',
  presets: 'GET /v1/logins/presets',
} as const;

/** Every login on this machine, from what the daemon already knows. It calls no provider. */
export const readLogins = async (client: LoginsClient): Promise<LoginList> =>
  LoginListSchema.parse(await client.call(ROUTES.list));

/** A person's **Check now** on one login. For Codex it is a refresh. */
export const checkLogin = async (client: LoginsClient, loginId: string): Promise<LoginView> =>
  LoginViewSchema.parse(await client.call(ROUTES.check, { params: { loginId }, body: {} }));

/** The provider presets an environment login is made from. A preset names secrets, never holds one. */
export const readPresets = async (client: LoginsClient): Promise<ProviderPresetCatalog> =>
  ProviderPresetCatalogSchema.parse(await client.call(ROUTES.presets));

/**
 * A person's **Test** of an environment login: one request, the cheapest its provider allows. A provider with no free
 * read is tested with one token, and only when `allowInference` says the person agreed to it.
 */
export const testLogin = async (
  client: LoginsClient,
  loginId: string,
  request: LoginTestRequest = {},
): Promise<LoginTestResult> =>
  LoginTestResultSchema.parse(
    await client.call(ROUTES.test, { params: { loginId }, body: LoginTestRequestSchema.parse(request) }),
  );
