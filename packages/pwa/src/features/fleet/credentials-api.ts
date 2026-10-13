/**
 * The browser's half of the account model's credentials (docs/design/account-model.md §7):
 * `GET /v1/fleet/credentials` and the explicit `POST /v1/fleet/credentials/:id/check`.
 *
 * NOTHING HERE HOLDS A CREDENTIAL. A row is a status word, two usage windows, the runtimes that use the
 * login and what signing it out would do — the shared schema has no field a token or a digest could
 * occupy, and every answer is parsed through it.
 *
 * Signing a credential in goes through `startCredentialSignIn` (harness-login-api.ts); signing out and
 * labelling are reviewed changes, so neither is a call here.
 */

import {
  type FleetCredentialCheckRequest,
  FleetCredentialCheckRequestSchema,
  type FleetCredentialList,
  FleetCredentialListSchema,
  type FleetCredentialView,
  FleetCredentialViewSchema,
  OPERATOR_UNLOCK_HEADER,
} from '@ferretry/protocol';
import type { FleetClient } from './fleet-api.ts';

export const FLEET_CREDENTIALS_PATH = '/v1/fleet/credentials';

const unlockHeaders = (unlock: string | undefined): Record<string, string> =>
  unlock === undefined ? {} : { [OPERATOR_UNLOCK_HEADER]: unlock };

/** Every login on this machine, from what the daemon already knows. It calls no provider. */
export const readFleetCredentials = async (client: FleetClient, unlock?: string): Promise<FleetCredentialList> =>
  await client.request(FLEET_CREDENTIALS_PATH, FleetCredentialListSchema, { headers: unlockHeaders(unlock) });

/**
 * A person's **Check now** on one login. For Codex it is a refresh, so from off the machine it needs
 * the unlock in the header and the operator password for this one check, as a sign-in does.
 */
export const checkFleetCredential = async (
  client: FleetClient,
  credentialId: string,
  request: FleetCredentialCheckRequest = {},
  unlock?: string,
): Promise<FleetCredentialView> =>
  await client.request(
    `${FLEET_CREDENTIALS_PATH}/${encodeURIComponent(credentialId)}/check`,
    FleetCredentialViewSchema,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...unlockHeaders(unlock) },
      body: JSON.stringify(FleetCredentialCheckRequestSchema.parse(request)),
    },
  );
