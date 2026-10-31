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
  type PublishCatalogVersionRequest,
  PublishCatalogVersionRequestSchema,
  type PublishedCatalogItem,
  PublishedCatalogItemSchema,
  SHARED_CATALOGS_PATH,
  type SharedCatalogFile,
  SharedCatalogFileSchema,
  type UpdateCatalogRequest,
  UpdateCatalogRequestSchema,
  type WithdrawnCatalogItem,
  WithdrawnCatalogItemSchema,
} from '@ferretry/protocol';
import type { CatalogApiClient, ICatalogGateway } from './ports.ts';

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

/** One catalog, `/v1/catalogs/<id>`. Composed as literals so `route-agreement.sh` can read the address. */
export function catalogPath(catalogId: string): string {
  return `${SHARED_CATALOGS_PATH}/${encodeURIComponent(catalogId)}`;
}

export function catalogItemsPath(catalogId: string): string {
  return `${SHARED_CATALOGS_PATH}/${encodeURIComponent(catalogId)}/items`;
}

export function catalogItemPreviewPath(catalogId: string): string {
  return `${SHARED_CATALOGS_PATH}/${encodeURIComponent(catalogId)}/items/preview`;
}

export function catalogItemPath(catalogId: string, itemId: string): string {
  return `${SHARED_CATALOGS_PATH}/${encodeURIComponent(catalogId)}/items/${encodeURIComponent(itemId)}`;
}

export function catalogItemVersionsPath(catalogId: string, itemId: string): string {
  return `${SHARED_CATALOGS_PATH}/${encodeURIComponent(catalogId)}/items/${encodeURIComponent(itemId)}/versions`;
}

export function catalogExportPath(catalogId: string): string {
  return `${SHARED_CATALOGS_PATH}/${encodeURIComponent(catalogId)}/export`;
}

/** Speaks the owner's catalog routes through the protocol client, validating each body and parsing each response. */
export class ProtocolCatalogGateway implements ICatalogGateway {
  constructor(private readonly client: CatalogApiClient) {}

  async list(): Promise<OwnedCatalogList> {
    return await this.client.request(SHARED_CATALOGS_PATH, OwnedCatalogListSchema);
  }

  async create(request: CreateCatalogRequest): Promise<OwnedCatalog> {
    const body = CreateCatalogRequestSchema.parse(request);
    return await this.client.request(SHARED_CATALOGS_PATH, OwnedCatalogSchema, jsonPost(body));
  }

  async update(catalogId: string, request: UpdateCatalogRequest): Promise<OwnedCatalog> {
    const body = UpdateCatalogRequestSchema.parse(request);
    return await this.client.request(catalogPath(catalogId), OwnedCatalogSchema, jsonPatch(body));
  }

  async remove(catalogId: string): Promise<DeletedCatalog> {
    return await this.client.request(catalogPath(catalogId), DeletedCatalogSchema, { method: 'DELETE' });
  }

  async preview(catalogId: string, request: CatalogItemPreviewRequest): Promise<CatalogItemPreview> {
    const body = CatalogItemPreviewRequestSchema.parse(request);
    return await this.client.request(catalogItemPreviewPath(catalogId), CatalogItemPreviewSchema, jsonPost(body));
  }

  async add(catalogId: string, request: AddCatalogItemRequest): Promise<PublishedCatalogItem> {
    const body = AddCatalogItemRequestSchema.parse(request);
    return await this.client.request(catalogItemsPath(catalogId), PublishedCatalogItemSchema, jsonPost(body));
  }

  async publishVersion(
    catalogId: string,
    itemId: string,
    request: PublishCatalogVersionRequest,
  ): Promise<PublishedCatalogItem> {
    const body = PublishCatalogVersionRequestSchema.parse(request);
    return await this.client.request(
      catalogItemVersionsPath(catalogId, itemId),
      PublishedCatalogItemSchema,
      jsonPost(body),
    );
  }

  async withdraw(catalogId: string, itemId: string): Promise<WithdrawnCatalogItem> {
    return await this.client.request(catalogItemPath(catalogId, itemId), WithdrawnCatalogItemSchema, {
      method: 'DELETE',
    });
  }

  async export(catalogId: string, request: ExportCatalogRequest): Promise<SharedCatalogFile> {
    const body = ExportCatalogRequestSchema.parse(request);
    return await this.client.request(catalogExportPath(catalogId), SharedCatalogFileSchema, jsonPost(body));
  }
}
