/**
 * The browser's half of the grant routes.
 *
 * Every call takes a client rather than building one, and nothing here is cached at module scope. A
 * grant belongs to a MACHINE and one browser can be paired to several, so a view fetched for daemon A
 * must never be rendered as daemon B's — the same rule the secret store is written to, for the same
 * reason.
 *
 * ## THERE IS NO CREDENTIAL TO CARRY
 *
 * A governed caller's dangerous act needs a passkey step-up, and the carrier asks for it and resends
 * the request itself (`DaemonCarrierRouter.send`). So `changeGrants` sends exactly the patch and nothing
 * else: no header, no token, no confirmation field — nothing here for a credential to leak from.
 */

import {
  type GrantsPatch,
  GrantsPatchSchema,
  type GrantsView,
  GrantsViewSchema,
  type IFyApiClient,
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
 * Changes one or more axes.
 *
 * The patch is PARTIAL by contract, so a screen changes the one answer a reader touched rather than
 * restating four it did not look at — restating them is how a stale tab silently reverts a decision
 * made in another one.
 */
export async function changeGrants(client: GrantClient, patch: GrantsPatch): Promise<GrantsView> {
  return await client.request(GRANTS_PATH, GrantsViewSchema, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(GrantsPatchSchema.parse(patch)),
  });
}
