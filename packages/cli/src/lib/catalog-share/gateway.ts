import {
  CATALOG_MEMBERS_PATH,
  CATALOG_SHARES_PATH,
  type CatalogMemberCatalogRemoved,
  CatalogMemberCatalogRemovedSchema,
  type CatalogMemberKeyRemoved,
  CatalogMemberKeyRemovedSchema,
  type CatalogMemberList,
  CatalogMemberListSchema,
  CatalogMemberRenameRequestSchema,
  type CatalogMemberRevoked,
  CatalogMemberRevokedSchema,
  type CatalogMemberView,
  CatalogMemberViewSchema,
  type CatalogShareList,
  CatalogShareListSchema,
  type CatalogShareMintRequest,
  CatalogShareMintRequestSchema,
  type CatalogShareMintResponse,
  CatalogShareMintResponseSchema,
  type CatalogShareView,
  CatalogShareViewSchema,
} from '@ferretry/protocol';
import type { ISharingGateway, SharingApiClient } from './ports.ts';

const jsonPost = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const jsonPatch = (body: unknown): RequestInit => ({
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/** One share, `/v1/catalog-shares/<id>`. Composed as literals so `route-agreement.sh` can read the address. */
export function catalogSharePath(shareId: string): string {
  return `${CATALOG_SHARES_PATH}/${encodeURIComponent(shareId)}`;
}

export function catalogMemberPath(memberId: string): string {
  return `${CATALOG_MEMBERS_PATH}/${encodeURIComponent(memberId)}`;
}

export function catalogMemberKeyPath(memberId: string, keyId: string): string {
  return `${CATALOG_MEMBERS_PATH}/${encodeURIComponent(memberId)}/keys/${encodeURIComponent(keyId)}`;
}

export function catalogMemberCatalogPath(memberId: string, catalogId: string): string {
  return `${CATALOG_MEMBERS_PATH}/${encodeURIComponent(memberId)}/catalogs/${encodeURIComponent(catalogId)}`;
}

/** Speaks the owner's sharing routes through the protocol client, validating each body and parsing each response. */
export class ProtocolSharingGateway implements ISharingGateway {
  constructor(private readonly client: SharingApiClient) {}

  async mint(request: CatalogShareMintRequest): Promise<CatalogShareMintResponse> {
    const body = CatalogShareMintRequestSchema.parse(request);
    return await this.client.request(CATALOG_SHARES_PATH, CatalogShareMintResponseSchema, jsonPost(body));
  }

  async shares(): Promise<CatalogShareList> {
    return await this.client.request(CATALOG_SHARES_PATH, CatalogShareListSchema);
  }

  async endShare(shareId: string): Promise<CatalogShareView> {
    return await this.client.request(catalogSharePath(shareId), CatalogShareViewSchema, { method: 'DELETE' });
  }

  async members(): Promise<CatalogMemberList> {
    return await this.client.request(CATALOG_MEMBERS_PATH, CatalogMemberListSchema);
  }

  async renameMember(memberId: string, label: string): Promise<CatalogMemberView> {
    const body = CatalogMemberRenameRequestSchema.parse({ label });
    return await this.client.request(catalogMemberPath(memberId), CatalogMemberViewSchema, jsonPatch(body));
  }

  async revokeMember(memberId: string): Promise<CatalogMemberRevoked> {
    return await this.client.request(catalogMemberPath(memberId), CatalogMemberRevokedSchema, { method: 'DELETE' });
  }

  async removeKey(memberId: string, keyId: string): Promise<CatalogMemberKeyRemoved> {
    return await this.client.request(catalogMemberKeyPath(memberId, keyId), CatalogMemberKeyRemovedSchema, {
      method: 'DELETE',
    });
  }

  async removeCatalog(memberId: string, catalogId: string): Promise<CatalogMemberCatalogRemoved> {
    return await this.client.request(catalogMemberCatalogPath(memberId, catalogId), CatalogMemberCatalogRemovedSchema, {
      method: 'DELETE',
    });
  }
}
