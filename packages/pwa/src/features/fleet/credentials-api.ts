/**
 * The browser's half of the account model's credentials (docs/design/account-model.md §7):
 * `GET /v1/fleet/credentials` and the explicit `POST /v1/fleet/credentials/:id/check`.
 *
 * NOTHING HERE HOLDS A CREDENTIAL. A row is a status word, two usage windows, the runtimes that use the
 * login and what signing it out would do — the shared schema has no field a token or a digest could
 * occupy, and every answer is parsed through it.
 *
 * Signing a credential in goes through `startCredentialSignIn` (harness-login-api.ts); signing out and
 * labelling are reviewed changes, so neither is a call here. An environment login's secrets go in
 * through the secret store (`putSecret`), never through anything here (docs/provider-presets.md).
 */

import {
  FLEET_PRESETS_PATH,
  type FleetCredentialCheckRequest,
  FleetCredentialCheckRequestSchema,
  type FleetCredentialList,
  FleetCredentialListSchema,
  type FleetCredentialTestRequest,
  FleetCredentialTestRequestSchema,
  type FleetCredentialTestResult,
  FleetCredentialTestResultSchema,
  type FleetCredentialView,
  FleetCredentialViewSchema,
  type FleetProviderPresetCatalog,
  FleetProviderPresetCatalogSchema,
} from '@ferretry/protocol';
import type { FleetClient } from './fleet-client.ts';

export const FLEET_CREDENTIALS_PATH = '/v1/fleet/credentials';

/** Every login on this machine, from what the daemon already knows. It calls no provider. */
export const readFleetCredentials = async (client: FleetClient): Promise<FleetCredentialList> =>
  await client.request(FLEET_CREDENTIALS_PATH, FleetCredentialListSchema);

/** A person's **Check now** on one login. For Codex it is a refresh. */
export const checkFleetCredential = async (
  client: FleetClient,
  credentialId: string,
  request: FleetCredentialCheckRequest = {},
): Promise<FleetCredentialView> =>
  await client.request(
    `${FLEET_CREDENTIALS_PATH}/${encodeURIComponent(credentialId)}/check`,
    FleetCredentialViewSchema,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(FleetCredentialCheckRequestSchema.parse(request)),
    },
  );

/** The provider presets an environment login is made from. A preset names secrets, never holds one. */
export const readFleetPresets = async (client: FleetClient): Promise<FleetProviderPresetCatalog> =>
  await client.request(FLEET_PRESETS_PATH, FleetProviderPresetCatalogSchema);

/**
 * A person's **Test** of an environment login: one request, the cheapest its provider allows. A
 * provider with no free read is tested with one token, and only when `allowInference` says the person
 * agreed to it.
 */
export const testFleetCredential = async (
  client: FleetClient,
  credentialId: string,
  request: FleetCredentialTestRequest = {},
): Promise<FleetCredentialTestResult> =>
  await client.request(
    `${FLEET_CREDENTIALS_PATH}/${encodeURIComponent(credentialId)}/test`,
    FleetCredentialTestResultSchema,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(FleetCredentialTestRequestSchema.parse(request)),
    },
  );
