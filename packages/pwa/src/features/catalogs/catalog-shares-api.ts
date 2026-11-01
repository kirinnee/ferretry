/**
 * The browser's half of the owner's sharing routes (docs/catalogs.md § Members, "Owner routes").
 *
 * Every call takes a client and nothing is kept at module scope. Minting needs a fresh passkey for the act
 * `share-catalog`; the carrier asks for it on its own when the daemon answers `403 grant_step_up_required`
 * and sends the request again, so nothing here handles one.
 *
 * THE MINT'S ANSWER HOLDS THE CODE AND THE LINK. It is returned to the one caller that asked and goes no
 * further than that caller's component state: this module logs, stores and caches nothing.
 */

import {
  CATALOG_MEMBERS_PATH,
  CATALOG_SHARES_PATH,
  type CatalogMemberCatalogRemoved,
  CatalogMemberCatalogRemovedSchema,
  type CatalogMemberKeyRemoved,
  CatalogMemberKeyRemovedSchema,
  type CatalogMemberList,
  CatalogMemberListSchema,
  type CatalogMemberRevoked,
  CatalogMemberRevokedSchema,
  type CatalogShareList,
  CatalogShareListSchema,
  type CatalogShareMintRequest,
  CatalogShareMintRequestSchema,
  type CatalogShareMintResponse,
  CatalogShareMintResponseSchema,
  type CatalogShareView,
  CatalogShareViewSchema,
} from '@ferretry/protocol';
import type { CatalogClient } from './catalogs-api.ts';

const sharePath = (shareId: string): string => `${CATALOG_SHARES_PATH}/${encodeURIComponent(shareId)}`;

const memberPath = (memberId: string): string => `${CATALOG_MEMBERS_PATH}/${encodeURIComponent(memberId)}`;

/** Makes one share. The code and link are in the answer and nowhere else, ever. */
export async function mintShare(
  client: CatalogClient,
  request: CatalogShareMintRequest,
): Promise<CatalogShareMintResponse> {
  return await client.request(CATALOG_SHARES_PATH, CatalogShareMintResponseSchema, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(CatalogShareMintRequestSchema.parse(request)),
  });
}

/** Every live share, then the most recent ended ones. No row carries a code. */
export async function listShares(client: CatalogClient): Promise<CatalogShareList> {
  return await client.request(CATALOG_SHARES_PATH, CatalogShareListSchema);
}

/** Ends a code now. A person who already joined with it stays. */
export async function endShare(client: CatalogClient, shareId: string): Promise<CatalogShareView> {
  return await client.request(sharePath(shareId), CatalogShareViewSchema, { method: 'DELETE' });
}

/** Every person, the catalogs they may read, and each of their browsers. */
export async function listMembers(client: CatalogClient): Promise<CatalogMemberList> {
  return await client.request(CATALOG_MEMBERS_PATH, CatalogMemberListSchema);
}

/** Removes one browser of a person. Their other browsers keep working. */
export async function removeMemberBrowser(
  client: CatalogClient,
  memberId: string,
  keyId: string,
): Promise<CatalogMemberKeyRemoved> {
  return await client.request(
    `${memberPath(memberId)}/keys/${encodeURIComponent(keyId)}`,
    CatalogMemberKeyRemovedSchema,
    { method: 'DELETE' },
  );
}

/** Takes one catalog away from a person. Their other catalogs stay. */
export async function takeAwayCatalog(
  client: CatalogClient,
  memberId: string,
  catalogId: string,
): Promise<CatalogMemberCatalogRemoved> {
  return await client.request(
    `${memberPath(memberId)}/catalogs/${encodeURIComponent(catalogId)}`,
    CatalogMemberCatalogRemovedSchema,
    { method: 'DELETE' },
  );
}

/** Removes a person with every browser, and ends the codes made for them. */
export async function revokeMember(client: CatalogClient, memberId: string): Promise<CatalogMemberRevoked> {
  return await client.request(memberPath(memberId), CatalogMemberRevokedSchema, { method: 'DELETE' });
}
