/**
 * The browser's half of the input bridge: read the open requests, deliver one, cancel one.
 *
 * Every call goes through a connection-bound client and nothing is cached at module scope: a request
 * belongs to one machine's session. The deliver body is the only place a value travels, padded, and this
 * module never keeps it. The carrier-routed client answers a step-up refusal itself (it asks for a passkey
 * and sends the request again), so a deliver that needs one needs no code here.
 */

import {
  type AccountId,
  type AccountList,
  AccountListSchema,
  type IFyApiClient,
  type InputDeliverBody,
  InputDeliverBodySchema,
  type InputDeliverResult,
  InputDeliverResultSchema,
  type InputRequest,
  type InputRequestList,
  InputRequestListSchema,
  type InputShot,
  InputShotSchema,
  type PhoneApproval,
  type PhoneApprovalList,
  PhoneApprovalListSchema,
  type PutAccountDefaultRequest,
  PutAccountDefaultRequestSchema,
  type PutAccountDefaultResult,
  PutAccountDefaultResultSchema,
  type StageTwoFactorSeedRequest,
  StageTwoFactorSeedRequestSchema,
  type TwoFactorSeedSaved,
  TwoFactorSeedSavedSchema,
  type TwoFactorSeedStaged,
  TwoFactorSeedStagedSchema,
  type TwoFactorSeedStageView,
  TwoFactorSeedStageViewSchema,
  type TwoFactorStageId,
} from '@ferretry/protocol';
import { z } from 'zod';

export type InputClient = Pick<IFyApiClient, 'request'>;

const sessionPath = (sessionId: string): string => `/v1/sessions/${encodeURIComponent(sessionId)}/input-requests`;

async function listSessionInputRequests(client: InputClient, sessionId: string): Promise<InputRequestList> {
  return await client.request(sessionPath(sessionId), InputRequestListSchema);
}

/** The request an `input` agenda item points at, or `undefined` once the daemon no longer lists it. */
export async function readInputRequest(
  client: InputClient,
  sessionId: string,
  requestId: string,
): Promise<InputRequest | undefined> {
  const { requests } = await listSessionInputRequests(client, sessionId);
  return requests.find(request => request.id === requestId);
}

export async function deliverInput(
  client: InputClient,
  request: Pick<InputRequest, 'id' | 'sessionId'>,
  body: InputDeliverBody,
): Promise<InputDeliverResult> {
  return await client.request(
    `${sessionPath(request.sessionId)}/${encodeURIComponent(request.id)}/deliver`,
    InputDeliverResultSchema,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(InputDeliverBodySchema.parse(body)),
    },
  );
}

/** The picture of a page request's fields, taken before anything was typed. Only a request marked `pictured` has one. */
export async function readInputShot(
  client: InputClient,
  request: Pick<InputRequest, 'id' | 'sessionId'>,
): Promise<InputShot> {
  return await client.request(
    `${sessionPath(request.sessionId)}/${encodeURIComponent(request.id)}/shot`,
    InputShotSchema,
    { method: 'GET' },
  );
}

/**
 * The owner's own act, after a hand-tap: make this account the default for a project (`PUT /v1/accounts/defaults`).
 * A ferret cannot make this call. The line is in effect at once, as the owner's own act (a paired device is
 * asked for its passkey by the carrier client).
 */
export async function putAccountDefault(
  client: InputClient,
  body: PutAccountDefaultRequest,
): Promise<PutAccountDefaultResult> {
  return await client.request('/v1/accounts/defaults', PutAccountDefaultResultSchema, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(PutAccountDefaultRequestSchema.parse(body)),
  });
}

export async function cancelInput(client: InputClient, request: Pick<InputRequest, 'id' | 'sessionId'>): Promise<void> {
  await client.request(`${sessionPath(request.sessionId)}/${encodeURIComponent(request.id)}/cancel`, z.unknown(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
}

/** The approve-on-phone cards still waiting (owner only). Nothing is cached: the daemon is the only source of a number. */
export async function listPhoneApprovals(client: InputClient): Promise<PhoneApprovalList> {
  return await client.request('/v1/phone-approvals', PhoneApprovalListSchema, { method: 'GET' });
}

/** "Not me — stop": the only answer a card gives. There is no route that says the owner approved. */
export async function refusePhoneApproval(
  client: InputClient,
  approval: Pick<PhoneApproval, 'id' | 'sessionId'>,
): Promise<void> {
  await client.request(
    `/v1/sessions/${encodeURIComponent(approval.sessionId)}/phone-approvals/${encodeURIComponent(approval.id)}/refuse`,
    z.unknown(),
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
  );
}

/** `GET /v1/accounts`: the owner's accounts, for the places a pasted 2FA key is checked against. */
export async function readAccounts(client: InputClient): Promise<AccountList> {
  return await client.request('/v1/accounts', AccountListSchema, { method: 'GET' });
}

const seedPath = (account: AccountId): string => `/v1/accounts/${encodeURIComponent(account)}/factors/seed`;

/** Step one: the daemon reads the pasted key again and holds it in memory only. Nothing is saved yet. */
export async function stageSeed(
  client: InputClient,
  account: AccountId,
  body: StageTwoFactorSeedRequest,
): Promise<TwoFactorSeedStaged> {
  return await client.request(seedPath(account), TwoFactorSeedStagedSchema, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(StageTwoFactorSeedRequestSchema.parse(body)),
  });
}

/** Where one staged save stands (`waiting`, `saved`, `dropped`, `expired`): never the key. A paired device may read any stage. */
export async function readSeedStage(
  client: InputClient,
  account: AccountId | undefined,
  stage: TwoFactorStageId,
): Promise<TwoFactorSeedStageView> {
  // A card from this daemon names no account (its handle is often the label and username): the stage says which.
  if (account === undefined)
    return await client.request(`/v1/accounts/seed-stages/${encodeURIComponent(stage)}`, TwoFactorSeedStageViewSchema, {
      method: 'GET',
    });
  return await client.request(`${seedPath(account)}/${encodeURIComponent(stage)}`, TwoFactorSeedStageViewSchema, {
    method: 'GET',
  });
}

/** Step two: no body. The passkey proof for this one stage is what the daemon checks. */
export async function commitSeed(
  client: InputClient,
  account: AccountId,
  stage: TwoFactorStageId,
): Promise<TwoFactorSeedSaved> {
  return await client.request(`${seedPath(account)}/${encodeURIComponent(stage)}/commit`, TwoFactorSeedSavedSchema, {
    method: 'POST',
  });
}

/** Forget a staged key (the passkey was dismissed): never needs a passkey, because it narrows. */
export async function dropSeed(client: InputClient, account: AccountId, stage: TwoFactorStageId): Promise<void> {
  await client.request(`${seedPath(account)}/${encodeURIComponent(stage)}`, DroppedSchema, { method: 'DELETE' });
}

const DroppedSchema = z.object({ stage: z.string(), dropped: z.literal(true) });
