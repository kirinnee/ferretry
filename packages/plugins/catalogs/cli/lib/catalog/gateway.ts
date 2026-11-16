import {
  type AddCatalogItemRequest,
  AddCatalogItemRequestSchema,
  type CatalogItemPreview,
  type CatalogItemPreviewRequest,
  CatalogItemPreviewRequestSchema,
  CatalogItemPreviewSchema,
  type CreateCatalogRequest,
  CreateCatalogRequestSchema,
  type DeletedCatalog,
  DeletedCatalogSchema,
  type ExportCatalogRequest,
  ExportCatalogRequestSchema,
  type OwnedCatalog,
  type OwnedCatalogList,
  OwnedCatalogListSchema,
  OwnedCatalogSchema,
  type OwnedSharedItem,
  type OwnedSharedItemList,
  OwnedSharedItemListSchema,
  OwnedSharedItemSchema,
  type PublishCatalogVersionRequest,
  PublishCatalogVersionRequestSchema,
  type PublishedCatalogItem,
  PublishedCatalogItemSchema,
  type SharedCatalogFile,
  SharedCatalogFileSchema,
  type UpdateCatalogRequest,
  UpdateCatalogRequestSchema,
  type WithdrawnCatalogItem,
  WithdrawnCatalogItemSchema,
} from '../../../contract/wire/index.ts';
import type { CatalogApiClient, ICatalogGateway } from './ports.ts';

/**
 * Speaks the owner's catalog routes through the shell's guarded client, validating each body and parsing each
 * response. Each call names its manifest route key, so the client checks it against this plugin's inventory entry.
 */
export class ClientCatalogGateway implements ICatalogGateway {
  constructor(private readonly client: CatalogApiClient) {}

  async list(options: { readonly sourceState: boolean } = { sourceState: false }): Promise<OwnedCatalogList> {
    return OwnedCatalogListSchema.parse(
      await this.client.call('GET /v1/catalogs', options.sourceState ? { query: { sourceState: '1' } } : {}),
    );
  }

  async listItems(): Promise<OwnedSharedItemList> {
    return OwnedSharedItemListSchema.parse(await this.client.call('GET /v1/catalog-items'));
  }

  async getItem(itemId: string): Promise<OwnedSharedItem> {
    return OwnedSharedItemSchema.parse(await this.client.call('GET /v1/catalog-items/:itemId', { params: { itemId } }));
  }

  async create(request: CreateCatalogRequest): Promise<OwnedCatalog> {
    const body = CreateCatalogRequestSchema.parse(request);
    return OwnedCatalogSchema.parse(await this.client.call('POST /v1/catalogs', { body }));
  }

  async update(catalogId: string, request: UpdateCatalogRequest): Promise<OwnedCatalog> {
    const body = UpdateCatalogRequestSchema.parse(request);
    return OwnedCatalogSchema.parse(
      await this.client.call('PATCH /v1/catalogs/:id', { params: { id: catalogId }, body }),
    );
  }

  async remove(catalogId: string): Promise<DeletedCatalog> {
    return DeletedCatalogSchema.parse(await this.client.call('DELETE /v1/catalogs/:id', { params: { id: catalogId } }));
  }

  async preview(catalogId: string, request: CatalogItemPreviewRequest): Promise<CatalogItemPreview> {
    const body = CatalogItemPreviewRequestSchema.parse(request);
    return CatalogItemPreviewSchema.parse(
      await this.client.call('POST /v1/catalogs/:id/items/preview', { params: { id: catalogId }, body }),
    );
  }

  async add(catalogId: string, request: AddCatalogItemRequest): Promise<PublishedCatalogItem> {
    const body = AddCatalogItemRequestSchema.parse(request);
    return PublishedCatalogItemSchema.parse(
      await this.client.call('POST /v1/catalogs/:id/items', { params: { id: catalogId }, body }),
    );
  }

  async publishVersion(
    catalogId: string,
    itemId: string,
    request: PublishCatalogVersionRequest,
  ): Promise<PublishedCatalogItem> {
    const body = PublishCatalogVersionRequestSchema.parse(request);
    return PublishedCatalogItemSchema.parse(
      await this.client.call('POST /v1/catalogs/:id/items/:itemId/versions', {
        params: { id: catalogId, itemId },
        body,
      }),
    );
  }

  async withdraw(catalogId: string, itemId: string): Promise<WithdrawnCatalogItem> {
    return WithdrawnCatalogItemSchema.parse(
      await this.client.call('DELETE /v1/catalogs/:id/items/:itemId', { params: { id: catalogId, itemId } }),
    );
  }

  async export(catalogId: string, request: ExportCatalogRequest): Promise<SharedCatalogFile> {
    const body = ExportCatalogRequestSchema.parse(request);
    return SharedCatalogFileSchema.parse(
      await this.client.call('POST /v1/catalogs/:id/export', { params: { id: catalogId }, body }),
    );
  }
}
