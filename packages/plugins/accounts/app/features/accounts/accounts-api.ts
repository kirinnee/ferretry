/**
 * The browser's half of the accounts (`/v1/accounts*`), through the plugin client by route key.
 *
 * A VALUE TRAVELS IN ONLY. A password is sent on a put and never comes back; a 2FA seed is not sent from here at all
 * (it is staged and committed by the shared automatic-codes panel, with a passkey). Every write is a person route.
 * Nothing is cached at module scope, because an account belongs to a machine. Every answer is parsed by its schema, as
 * today's `request(path, schema)` did.
 */
import { z } from 'zod';
import {
  type AccountId,
  type AccountList,
  AccountListSchema,
  type AccountLookAlike,
  AccountLookAlikeSchema,
  AccountPairRequestSchema,
  type AccountSummary,
  AccountSummarySchema,
  type AddSignInRequest,
  AddSignInRequestSchema,
  type AddTwoFactorKeyRequest,
  type PhoneApproval,
  type PhoneApprovalList,
  PhoneApprovalListSchema,
  AddTwoFactorKeyRequestSchema,
  type PutAccountDefaultRequest,
  PutAccountDefaultRequestSchema,
  type PutAccountDefaultResult,
  PutAccountDefaultResultSchema,
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
  type StageTwoFactorSeedRequest,
  StageTwoFactorSeedRequestSchema,
  type TwoFactorId,
  type TwoFactorKeySummary,
  TwoFactorKeySummarySchema,
  type TwoFactorSeedSaved,
  TwoFactorSeedSavedSchema,
  type TwoFactorSeedStaged,
  TwoFactorSeedStagedSchema,
  type TwoFactorSeedStageView,
  TwoFactorSeedStageViewSchema,
  type TwoFactorStageId,
} from '../../../contract/routes/index.ts';
import type { AccountsClient } from '../../shell.tsx';

export type { AccountsClient };

type Init = Parameters<AccountsClient['call']>[1];

/** One route by its manifest key, the answer parsed (today's `client.request(path, schema, init)`). */
async function ask<Schema extends z.ZodType>(
  client: AccountsClient,
  route: string,
  schema: Schema,
  init?: Init,
): Promise<z.infer<Schema>> {
  return schema.parse(await client.call(route, init));
}

/** Create the account or change the parts named. The password goes in here and nothing answers with it. */
export async function putAccount(
  client: AccountsClient,
  id: AccountId,
  body: PutAccountRequest,
): Promise<AccountSummary> {
  return await ask(client, 'PUT /v1/accounts/:id', AccountSummarySchema, {
    params: { id },
    body: PutAccountRequestSchema.parse(body),
  });
}

export async function removeAccount(client: AccountsClient, id: AccountId): Promise<void> {
  await ask(client, 'DELETE /v1/accounts/:id', RemovedAccountSchema, { params: { id } });
}

export async function addSignIn(client: AccountsClient, id: AccountId, body: AddSignInRequest): Promise<SignInSummary> {
  return await ask(client, 'POST /v1/accounts/:id/sign-ins', SignInSummarySchema, {
    params: { id },
    body: AddSignInRequestSchema.parse(body),
  });
}

export async function putSignIn(client: AccountsClient, id: SignInId, body: PutSignInRequest): Promise<SignInSummary> {
  return await ask(client, 'PUT /v1/accounts/sign-ins/:signIn', SignInSummarySchema, {
    params: { signIn: id },
    body: PutSignInRequestSchema.parse(body),
  });
}

export async function removeSignIn(client: AccountsClient, id: SignInId): Promise<void> {
  await ask(client, 'DELETE /v1/accounts/sign-ins/:signIn', RemovedSignInSchema, { params: { signIn: id } });
}

/** The owner's answer to one ferret recipe proposal. */
export async function decideProposal(
  client: AccountsClient,
  id: SignInId,
  proposalId: string,
  decision: 'approve' | 'decline',
): Promise<SignInSummary> {
  return await ask(client, 'POST /v1/accounts/sign-ins/:signIn/recipe/proposals/:proposalId', SignInSummarySchema, {
    params: { signIn: id, proposalId },
    body: { decision },
  });
}

/** A 2FA key with no value: a label and its plain facts. A seed never goes through here. */
export async function addTwoFactorKey(
  client: AccountsClient,
  id: AccountId,
  body: AddTwoFactorKeyRequest,
): Promise<TwoFactorKeySummary> {
  return await ask(client, 'POST /v1/accounts/:id/factors', TwoFactorKeySummarySchema, {
    params: { id },
    body: AddTwoFactorKeyRequestSchema.parse(body),
  });
}

/** Never needs a passkey: removing a key only narrows what this machine can do. */
export async function removeTwoFactorKey(client: AccountsClient, id: AccountId, key: TwoFactorId): Promise<void> {
  await ask(client, 'DELETE /v1/accounts/:id/factors/:factor', RemovedTwoFactorKeySchema, {
    params: { id, factor: key },
  });
}

/** Handles only: which accounts the daemon thinks are one. A daemon without the route answers an error, never "none". */
export async function readLookAlike(client: AccountsClient): Promise<AccountLookAlike> {
  return await ask(client, 'GET /v1/accounts/look-alike', AccountLookAlikeSchema);
}

const PairSchema = z.unknown();

/** Fold `from` into `keep`: its sign-ins and 2FA keys move, and it goes. */
export async function mergeAccounts(client: AccountsClient, keep: AccountId, from: AccountId): Promise<void> {
  await ask(client, 'POST /v1/accounts/:id/merge', PairSchema, {
    params: { id: keep },
    body: AccountPairRequestSchema.parse({ from }),
  });
}

/** Say these two are different accounts, so they stop being offered as one. */
export async function keepApart(client: AccountsClient, one: AccountId, other: AccountId): Promise<void> {
  await ask(client, 'POST /v1/accounts/:id/apart', PairSchema, {
    params: { id: one },
    body: AccountPairRequestSchema.parse({ from: other }),
  });
}

// ─── today's `lib/input-api.ts` calls the accounts screens and the seed card make ────────────────────────────────

export async function readAccounts(client: AccountsClient): Promise<AccountList> {
  return await ask(client, 'GET /v1/accounts', AccountListSchema);
}

export async function putAccountDefault(
  client: AccountsClient,
  body: PutAccountDefaultRequest,
): Promise<PutAccountDefaultResult> {
  return await ask(client, 'PUT /v1/accounts/defaults', PutAccountDefaultResultSchema, {
    body: PutAccountDefaultRequestSchema.parse(body),
  });
}

/** Seals a pasted key in the daemon's memory until a passkey commits it (S89); the value goes in once, never back. */
export async function stageSeed(
  client: AccountsClient,
  account: AccountId,
  body: StageTwoFactorSeedRequest,
): Promise<TwoFactorSeedStaged> {
  return await ask(client, 'POST /v1/accounts/:id/factors/seed', TwoFactorSeedStagedSchema, {
    params: { id: account },
    body: StageTwoFactorSeedRequestSchema.parse(body),
  });
}

export async function commitSeed(
  client: AccountsClient,
  account: AccountId,
  stage: TwoFactorStageId,
): Promise<TwoFactorSeedSaved> {
  return await ask(client, 'POST /v1/accounts/:id/factors/seed/:stage/commit', TwoFactorSeedSavedSchema, {
    params: { id: account, stage },
  });
}

const DroppedSchema = z.object({ stage: z.string(), dropped: z.literal(true) });

export async function dropSeed(client: AccountsClient, account: AccountId, stage: TwoFactorStageId): Promise<void> {
  await ask(client, 'DELETE /v1/accounts/:id/factors/seed/:stage', DroppedSchema, { params: { id: account, stage } });
}

export async function readSeedStage(
  client: AccountsClient,
  account: AccountId | undefined,
  stage: TwoFactorStageId,
): Promise<TwoFactorSeedStageView> {
  // A card from this daemon names no account (its handle is often the label and username): the stage says which.
  if (account === undefined)
    return await ask(client, 'GET /v1/accounts/seed-stages/:stage', TwoFactorSeedStageViewSchema, {
      params: { stage },
    });
  return await ask(client, 'GET /v1/accounts/:id/factors/seed/:stage', TwoFactorSeedStageViewSchema, {
    params: { id: account, stage },
  });
}

// ─── the approve-on-phone card (today's `lib/input-api.ts`) ──────────────────────────────────────────────────────

/** The approve-on-phone cards still waiting (owner only). Nothing is cached: the daemon is the only source of a number. */
export async function listPhoneApprovals(client: AccountsClient): Promise<PhoneApprovalList> {
  return await ask(client, 'GET /v1/phone-approvals', PhoneApprovalListSchema);
}

/** "Not me — stop": the only answer a card gives. There is no route that says the owner approved. */
export async function refusePhoneApproval(
  client: AccountsClient,
  approval: Pick<PhoneApproval, 'id' | 'sessionId'>,
): Promise<void> {
  await ask(client, 'POST /v1/ferrets/:ferretId/phone-approvals/:approvalId/refuse', z.unknown(), {
    params: { ferretId: approval.sessionId, approvalId: approval.id },
    body: {},
  });
}
