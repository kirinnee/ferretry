/**
 * The browser's half of the saved logins (`/v1/secrets/logins`).
 *
 * A VALUE TRAVELS IN ONLY. A password or a 2FA seed is sent on a put and never comes back: the list is
 * labels, what an entry matches, a username (plain) and WHICH secret fields exist. Nothing is cached at
 * module scope, because a login belongs to a machine.
 */

import {
  type IFyApiClient,
  type LoginEntryList,
  LoginEntryListSchema,
  type LoginEntrySummary,
  LoginEntrySummarySchema,
  type PutLoginEntryRequest,
  PutLoginEntryRequestSchema,
  RemovedLoginEntrySchema,
} from '@ferretry/protocol';

export type LoginClient = Pick<IFyApiClient, 'request'>;

const LOGINS_PATH = '/v1/secrets/logins';

const entryPath = (id: string): string => `${LOGINS_PATH}/${encodeURIComponent(id)}`;

export async function listLogins(client: LoginClient): Promise<LoginEntryList> {
  return await client.request(LOGINS_PATH, LoginEntryListSchema);
}

/** Creates the entry, or changes the parts named: a field left out is kept, `null` removes it. */
export async function putLogin(
  client: LoginClient,
  id: string,
  body: PutLoginEntryRequest,
): Promise<LoginEntrySummary> {
  return await client.request(entryPath(id), LoginEntrySummarySchema, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(PutLoginEntryRequestSchema.parse(body)),
  });
}

export async function renameLogin(client: LoginClient, id: string, to: string): Promise<LoginEntrySummary> {
  return await client.request(`${entryPath(id)}/rename`, LoginEntrySummarySchema, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to }),
  });
}

export async function removeLogin(client: LoginClient, id: string): Promise<void> {
  await client.request(entryPath(id), RemovedLoginEntrySchema, { method: 'DELETE' });
}

/** The owner's answer to one ferret recipe proposal; answers the login as it stands after. */
export async function decideRecipeProposal(
  client: LoginClient,
  id: string,
  proposalId: string,
  decision: 'approve' | 'decline',
): Promise<LoginEntrySummary> {
  return await client.request(
    `${entryPath(id)}/recipe/proposals/${encodeURIComponent(proposalId)}`,
    LoginEntrySummarySchema,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision }),
    },
  );
}
