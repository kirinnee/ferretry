import {
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
} from '../../../contract/wire/index.ts';
import type { ISharingGateway, SharingApiClient } from './ports.ts';

/** Speaks the owner's sharing routes through the shell's guarded client, validating each body and parsing each response. */
export class ClientSharingGateway implements ISharingGateway {
  constructor(private readonly client: SharingApiClient) {}

  async mint(request: CatalogShareMintRequest): Promise<CatalogShareMintResponse> {
    const body = CatalogShareMintRequestSchema.parse(request);
    return CatalogShareMintResponseSchema.parse(await this.client.call('POST /v1/catalog-shares', { body }));
  }

  async shares(): Promise<CatalogShareList> {
    return CatalogShareListSchema.parse(await this.client.call('GET /v1/catalog-shares'));
  }

  async endShare(shareId: string): Promise<CatalogShareView> {
    return CatalogShareViewSchema.parse(
      await this.client.call('DELETE /v1/catalog-shares/:shareId', { params: { shareId } }),
    );
  }

  async members(): Promise<CatalogMemberList> {
    return CatalogMemberListSchema.parse(await this.client.call('GET /v1/catalog-members'));
  }

  async renameMember(memberId: string, label: string): Promise<CatalogMemberView> {
    const body = CatalogMemberRenameRequestSchema.parse({ label });
    return CatalogMemberViewSchema.parse(
      await this.client.call('PATCH /v1/catalog-members/:memberId', { params: { memberId }, body }),
    );
  }

  async revokeMember(memberId: string): Promise<CatalogMemberRevoked> {
    return CatalogMemberRevokedSchema.parse(
      await this.client.call('DELETE /v1/catalog-members/:memberId', { params: { memberId } }),
    );
  }

  async removeKey(memberId: string, keyId: string): Promise<CatalogMemberKeyRemoved> {
    return CatalogMemberKeyRemovedSchema.parse(
      await this.client.call('DELETE /v1/catalog-members/:memberId/keys/:keyId', { params: { memberId, keyId } }),
    );
  }

  async removeCatalog(memberId: string, catalogId: string): Promise<CatalogMemberCatalogRemoved> {
    return CatalogMemberCatalogRemovedSchema.parse(
      await this.client.call('DELETE /v1/catalog-members/:memberId/catalogs/:catalogId', {
        params: { memberId, catalogId },
      }),
    );
  }
}
