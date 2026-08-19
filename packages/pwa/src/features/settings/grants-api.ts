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
 * ## THE PASSWORD SETTER EXISTS, AND ONLY WHERE IT CAN SUCCEED
 *
 * `PUT /v1/grants/password` is refused to every caller that did not ARRIVE on the host — the route is
 * `privilegedOnly`, so a relayed hop is refused whatever credential it carries — and a local browser is
 * a paired device, so the daemon also wants an unlock before it will move an existing password. Both
 * halves are the daemon's, and `passwordControlState` in `src/lib/grants.ts` is where a screen reads
 * them so a control is never rendered somewhere it would fail on press.
 *
 * The password TRAVELS IN A BODY, exactly like the unlock below, and for the same reason: a query
 * parameter reaches every proxy's access log and would outlive the five minutes it is worth. Nothing
 * here retains it, echoes it or logs it, and there is no reader for it anywhere in this system — the
 * response is a single boolean saying whether one is now set, which is the entire disclosure.
 *
 * THERE IS NO REMOVAL TO SPELL. This surface once sent an absent password to mean "remove it"; the
 * protocol schema now requires the field, because a removal revokes no paired device and would leave
 * this machine with devices paired and nothing gating them.
 */

import {
  GrantPasswordRequestSchema,
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

/**
 * Whether a password is set, which is all this route ever answers.
 *
 * DERIVED FROM `GrantsViewSchema` rather than declared, so the one field this response shares with the
 * grant view cannot come to mean two things. `fy`'s own gateway derives it the same way from the same
 * owner (`packages/cli/src/lib/grants/gateway.ts`), which is what keeps the two clients agreeing.
 */
const PasswordOutcomeSchema = GrantsViewSchema.pick({ passwordSet: true });

/**
 * Sets or replaces the operator password. There is no call that removes one.
 *
 * The unlock goes in the same header a grant change uses, because replacing an existing password is a
 * privileged change and the daemon asks a local browser to prove the current one first. It is passed in
 * and forgotten, exactly as `changeGrants` treats it.
 */
export async function setOperatorPassword(client: GrantClient, password: string, unlock?: string): Promise<boolean> {
  const outcome = await client.request(`${GRANTS_PATH}/password`, PasswordOutcomeSchema, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      ...(unlock === undefined ? {} : { [OPERATOR_UNLOCK_HEADER]: unlock }),
    },
    body: JSON.stringify(GrantPasswordRequestSchema.parse({ password })),
  });
  return outcome.passwordSet;
}

/** Spends one password attempt. The password travels in a body, never in a path or a query. */
export async function unlockGrants(client: GrantClient, password: string): Promise<GrantUnlockView> {
  return await client.request(`${GRANTS_PATH}/unlock`, GrantUnlockViewSchema, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(GrantUnlockRequestSchema.parse({ password })),
  });
}
