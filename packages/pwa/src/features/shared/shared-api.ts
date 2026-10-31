/**
 * The browser's half of the member route table (`/v1/shared/*`, docs/relay-protocol.md §14). Every call
 * rides a member session; none of them is a device request. Error bodies are `{ error, code }`, so what
 * went wrong is `FyHttpError.code`, never a message to be parsed.
 */

import {
  PasskeyOptionsRequestSchema,
  type PasskeyRegistrationOptions,
  PasskeyRegistrationOptionsSchema,
  PasskeyViewSchema,
  type PasskeyView,
  SHARED_PATH,
  type SharedMe,
  SharedMeSchema,
  type SharedRedeemResponse,
  SharedRedeemRequestSchema,
  SharedRedeemResponseSchema,
  type SignedCatalogManifest,
  SignedCatalogManifestSchema,
  type SharedCatalogItem,
  SharedCatalogItemSchema,
  type StepUpOptions,
  StepUpOptionsSchema,
  type UnlockGranted,
  UnlockGrantedSchema,
} from '@ferretry/protocol';
import { z } from 'zod';
import type { MemberClient } from '../../lib/member-client.ts';
import type { AssertionWire, RegistrationWire } from '../../lib/passkeys.ts';

export type SharedClient = Pick<MemberClient, 'request'>;

const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const LeftSchema = z.strictObject({ keyId: z.string().min(1) });

export async function passkeyOptions(client: SharedClient, origin: string): Promise<PasskeyRegistrationOptions> {
  return await client.request(
    `${SHARED_PATH}/passkeys/options`,
    PasskeyRegistrationOptionsSchema,
    post(PasskeyOptionsRequestSchema.parse({ origin })),
  );
}

export async function registerPasskey(client: SharedClient, registration: RegistrationWire): Promise<PasskeyView> {
  return await client.request(`${SHARED_PATH}/passkeys`, PasskeyViewSchema, post(registration));
}

export async function unlockOptions(client: SharedClient, origin: string): Promise<StepUpOptions> {
  return await client.request(
    `${SHARED_PATH}/unlock/options`,
    StepUpOptionsSchema,
    post(PasskeyOptionsRequestSchema.parse({ origin })),
  );
}

export async function unlockMember(client: SharedClient, assertion: AssertionWire): Promise<UnlockGranted> {
  return await client.request(`${SHARED_PATH}/unlock`, UnlockGrantedSchema, post(assertion));
}

export async function readMe(client: SharedClient): Promise<SharedMe> {
  return await client.request(`${SHARED_PATH}/me`, SharedMeSchema);
}

export async function readSharedManifest(client: SharedClient, catalogId: string): Promise<SignedCatalogManifest> {
  return await client.request(
    `${SHARED_PATH}/catalogs/${encodeURIComponent(catalogId)}/manifest`,
    SignedCatalogManifestSchema,
  );
}

export async function readSharedItem(
  client: SharedClient,
  catalogId: string,
  itemId: string,
  version: number,
): Promise<SharedCatalogItem> {
  return await client.request(
    `${SHARED_PATH}/catalogs/${encodeURIComponent(catalogId)}/items/${encodeURIComponent(itemId)}/${version}`,
    SharedCatalogItemSchema,
  );
}

export async function redeemShare(client: SharedClient, code: string): Promise<SharedRedeemResponse> {
  return await client.request(
    `${SHARED_PATH}/redeem`,
    SharedRedeemResponseSchema,
    post(SharedRedeemRequestSchema.parse({ code })),
  );
}

/** Leaves this publisher. The answer is a `200`; the session closes `4440` right after it. */
export async function leavePublisher(client: SharedClient): Promise<void> {
  await client.request(`${SHARED_PATH}/me/keys/self`, LeftSchema, { method: 'DELETE' });
}
