/**
 * The browser's half of the accounts (`/v1/accounts*`).
 *
 * A VALUE TRAVELS IN ONLY. A password is sent on a put and never comes back; a 2FA seed is not sent from here at all
 * (it is staged and committed by the shared automatic-codes panel, with a passkey). Every write is a person route.
 * Nothing is cached at module scope, because an account belongs to a machine.
 */

import {
  type AccountId,
  type AccountLookAlike,
  AccountLookAlikeSchema,
  AccountPairRequestSchema,
  type AccountSummary,
  AccountSummarySchema,
  type AddSignInRequest,
  AddSignInRequestSchema,
  type AddTwoFactorKeyRequest,
  AddTwoFactorKeyRequestSchema,
  type IFyApiClient,
  type PutAccountRequest,
  PutAccountRequestSchema,
  type PutSignInRequest,
  PutSignInRequestSchema,
  RemovedAccountSchema,
  RemovedSignInSchema,
  RemovedTwoFactorKeySchema,
  type SignInId,
  type SignInSummary,
  SignInSummarySchema,
  type TwoFactorId,
  type TwoFactorKeySummary,
  TwoFactorKeySummarySchema,
} from '@ferretry/protocol';
import { z } from 'zod';

export type AccountsClient = Pick<IFyApiClient, 'request'>;

const JSON_HEADERS = { 'content-type': 'application/json' } as const;
const account = (id: AccountId): string => `/v1/accounts/${encodeURIComponent(id)}`;
const signIn = (id: SignInId): string => `/v1/accounts/sign-ins/${encodeURIComponent(id)}`;

const send = (method: 'POST' | 'PUT' | 'PATCH', body: unknown): RequestInit => ({
  method,
  headers: JSON_HEADERS,
  body: JSON.stringify(body),
});

/** Create the account or change the parts named. The password goes in here and nothing answers with it. */
export async function putAccount(
  client: AccountsClient,
  id: AccountId,
  body: PutAccountRequest,
): Promise<AccountSummary> {
  return await client.request(account(id), AccountSummarySchema, send('PUT', PutAccountRequestSchema.parse(body)));
}

export async function removeAccount(client: AccountsClient, id: AccountId): Promise<void> {
  await client.request(account(id), RemovedAccountSchema, { method: 'DELETE' });
}

export async function addSignIn(client: AccountsClient, id: AccountId, body: AddSignInRequest): Promise<SignInSummary> {
  return await client.request(
    `${account(id)}/sign-ins`,
    SignInSummarySchema,
    send('POST', AddSignInRequestSchema.parse(body)),
  );
}

export async function putSignIn(client: AccountsClient, id: SignInId, body: PutSignInRequest): Promise<SignInSummary> {
  return await client.request(signIn(id), SignInSummarySchema, send('PUT', PutSignInRequestSchema.parse(body)));
}

export async function removeSignIn(client: AccountsClient, id: SignInId): Promise<void> {
  await client.request(signIn(id), RemovedSignInSchema, { method: 'DELETE' });
}

/** The owner's answer to one ferret recipe proposal. */
export async function decideProposal(
  client: AccountsClient,
  id: SignInId,
  proposalId: string,
  decision: 'approve' | 'decline',
): Promise<SignInSummary> {
  return await client.request(
    `${signIn(id)}/recipe/proposals/${encodeURIComponent(proposalId)}`,
    SignInSummarySchema,
    send('POST', { decision }),
  );
}

/** A 2FA key with no value: a label and its plain facts. A seed never goes through here. */
export async function addTwoFactorKey(
  client: AccountsClient,
  id: AccountId,
  body: AddTwoFactorKeyRequest,
): Promise<TwoFactorKeySummary> {
  return await client.request(
    `${account(id)}/factors`,
    TwoFactorKeySummarySchema,
    send('POST', AddTwoFactorKeyRequestSchema.parse(body)),
  );
}

/** Never needs a passkey: removing a key only narrows what this machine can do. */
export async function removeTwoFactorKey(client: AccountsClient, id: AccountId, key: TwoFactorId): Promise<void> {
  await client.request(`${account(id)}/factors/${encodeURIComponent(key)}`, RemovedTwoFactorKeySchema, {
    method: 'DELETE',
  });
}

/** Handles only: which accounts the daemon thinks are one. A daemon without the route answers an error, never "none". */
export async function readLookAlike(client: AccountsClient): Promise<AccountLookAlike> {
  return await client.request('/v1/accounts/look-alike', AccountLookAlikeSchema);
}

const PairSchema = z.unknown();

/** Fold `from` into `keep`: its sign-ins and 2FA keys move, and it goes. */
export async function mergeAccounts(client: AccountsClient, keep: AccountId, from: AccountId): Promise<void> {
  await client.request(`${account(keep)}/merge`, PairSchema, send('POST', AccountPairRequestSchema.parse({ from })));
}

/** Say these two are different accounts, so they stop being offered as one. */
export async function keepApart(client: AccountsClient, one: AccountId, other: AccountId): Promise<void> {
  await client.request(
    `${account(one)}/apart`,
    PairSchema,
    send('POST', AccountPairRequestSchema.parse({ from: other })),
  );
}
