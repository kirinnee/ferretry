/**
 * The browser's half of the grant routes.
 *
 * Every call takes a client rather than building one, and nothing here is cached at module scope. A
 * grant belongs to a MACHINE and one browser can be paired to several, so a view fetched for daemon A
 * must never be rendered as daemon B's — the same rule the secret store is written to, for the same
 * reason.
 *
 * ## THE UNLOCK TRAVELS IN A HEADER AND IS NEVER RETAINED HERE
 *
 * `changeGrants` takes it as an argument and forgets it. This module holds no field for it, so there
 * is nowhere for a token to outlive the call that used it, and no getter for anything to read one out
 * of. A URL is deliberately not an option: a query parameter reaches every proxy's access log, and an
 * unlock in a log outlives its five minutes.
 *
 * ## THERE IS NO PASSWORD SETTER
 *
 * `PUT /v1/grants/password` is a `host`-scope route: a paired device that could clear the password
 * could remove its own gate. It is absent from this module rather than present and unused, because a
 * method nobody may successfully call is an invitation to wire a control to it.
 */

import {
  type GrantsPatch,
  GrantsPatchSchema,
  type GrantsView,
  GrantsViewSchema,
  type GrantUnlockView,
  GrantUnlockRequestSchema,
  GrantUnlockViewSchema,
  type IFyApiClient,
  OPERATOR_UNLOCK_HEADER,
} from '@ferretry/protocol';

/** The only client capability the grant surface uses. */
export type GrantClient = Pick<IFyApiClient, 'request'>;

export const GRANTS_PATH = '/v1/grants';

/**
 * Reads the whole picture in ONE call.
 *
 * Not a probe per control: a UI that discovers its limits by watching calls fail cannot explain
 * anything before somebody clicks, and explaining before the click is the entire requirement.
 */
export async function readGrants(client: GrantClient): Promise<GrantsView> {
  return await client.request(GRANTS_PATH, GrantsViewSchema);
}

/**
 * Changes one or more axes, presenting an unlock only when the caller has one.
 *
 * The patch is PARTIAL by contract, so a screen changes the one answer a reader touched rather than
 * restating four it did not look at — restating them is how a stale tab silently reverts a decision
 * made in another one.
 */
export async function changeGrants(client: GrantClient, patch: GrantsPatch, unlock?: string): Promise<GrantsView> {
  return await client.request(GRANTS_PATH, GrantsViewSchema, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      ...(unlock === undefined ? {} : { [OPERATOR_UNLOCK_HEADER]: unlock }),
    },
    body: JSON.stringify(GrantsPatchSchema.parse(patch)),
  });
}

/** Spends one password attempt. The password travels in a body, never in a path or a query. */
export async function unlockGrants(client: GrantClient, password: string): Promise<GrantUnlockView> {
  return await client.request(`${GRANTS_PATH}/unlock`, GrantUnlockViewSchema, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(GrantUnlockRequestSchema.parse({ password })),
  });
}
