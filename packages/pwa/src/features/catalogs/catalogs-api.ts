/**
 * The browser's half of the catalog routes this machine serves (docs/catalogs.md, "The publisher
 * side"). Every call takes a client and nothing is cached at module scope: a catalog belongs to a
 * MACHINE and one browser is paired with several.
 *
 * Writes that need a passkey ask for it through the carrier on their own (`403 grant_step_up_required`
 * is turned into the app's one prompt and the request is sent again), so nothing here handles one.
 */

import {
  type AddCatalogItemRequest,
  AddCatalogItemRequestSchema,
  type CatalogItemPreview,
  type CatalogItemPreviewRequest,
  CatalogItemPreviewRequestSchema,
  CatalogItemPreviewSchema,
  CreateCatalogRequestSchema,
  DeletedCatalogSchema,
  type ExportCatalogRequest,
  ExportCatalogRequestSchema,
  type IFyApiClient,
  type OwnedCatalog,
  type OwnedCatalogList,
  OwnedCatalogListSchema,
  OwnedCatalogSchema,
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
import type { DaemonConnection } from '../../lib/daemon-connection.ts';

/** The only client capability the catalog surfaces use. */
export type CatalogClient = Pick<IFyApiClient, 'request'>;

const jsonBody = (body: unknown): RequestInit => ({
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const catalogPath = (catalogId: string): string => `${SHARED_CATALOGS_PATH}/${encodeURIComponent(catalogId)}`;

/**
 * Every catalog on this machine. `sourceState` re-reads each source to say whether it changed, so only
 * the detail view asks for it; the list does not touch a single source.
 */
export async function listCatalogs(
  client: CatalogClient,
  options?: { sourceState?: boolean },
): Promise<OwnedCatalogList> {
  const path = options?.sourceState === true ? `${SHARED_CATALOGS_PATH}?sourceState=1` : SHARED_CATALOGS_PATH;
  return await client.request(path, OwnedCatalogListSchema);
}

export async function createCatalog(client: CatalogClient, name: string): Promise<OwnedCatalog> {
  return await client.request(SHARED_CATALOGS_PATH, OwnedCatalogSchema, {
    method: 'POST',
    ...jsonBody(CreateCatalogRequestSchema.parse({ name })),
  });
}

export async function updateCatalog(
  client: CatalogClient,
  catalogId: string,
  change: UpdateCatalogRequest,
): Promise<OwnedCatalog> {
  return await client.request(catalogPath(catalogId), OwnedCatalogSchema, {
    method: 'PATCH',
    ...jsonBody(UpdateCatalogRequestSchema.parse(change)),
  });
}

export async function deleteCatalog(client: CatalogClient, catalogId: string): Promise<void> {
  await client.request(catalogPath(catalogId), DeletedCatalogSchema, { method: 'DELETE' });
}

/** What would be frozen, read from the source as it is now. Writes nothing. */
export async function previewCatalogItem(
  client: CatalogClient,
  catalogId: string,
  request: CatalogItemPreviewRequest,
): Promise<CatalogItemPreview> {
  return await client.request(`${catalogPath(catalogId)}/items/preview`, CatalogItemPreviewSchema, {
    method: 'POST',
    ...jsonBody(CatalogItemPreviewRequestSchema.parse(request)),
  });
}

/** The first version of an item, only if its source still hashes to the previewed digest. */
export async function addCatalogItem(
  client: CatalogClient,
  catalogId: string,
  request: AddCatalogItemRequest,
): Promise<PublishedCatalogItem> {
  return await client.request(`${catalogPath(catalogId)}/items`, PublishedCatalogItemSchema, {
    method: 'POST',
    ...jsonBody(AddCatalogItemRequestSchema.parse(request)),
  });
}

/** The next version of an item, only if its source still hashes to the previewed digest. */
export async function publishCatalogVersion(
  client: CatalogClient,
  catalogId: string,
  itemId: string,
  digest: string,
): Promise<PublishedCatalogItem> {
  return await client.request(
    `${catalogPath(catalogId)}/items/${encodeURIComponent(itemId)}/versions`,
    PublishedCatalogItemSchema,
    { method: 'POST', ...jsonBody(PublishCatalogVersionRequestSchema.parse({ digest })) },
  );
}

export async function withdrawCatalogItem(
  client: CatalogClient,
  catalogId: string,
  itemId: string,
): Promise<WithdrawnCatalogItem> {
  return await client.request(
    `${catalogPath(catalogId)}/items/${encodeURIComponent(itemId)}`,
    WithdrawnCatalogItemSchema,
    { method: 'DELETE' },
  );
}

/** The signed catalog file. The daemon signs it as itself, so this is the passkey-gated call. */
export async function exportCatalog(
  client: CatalogClient,
  catalogId: string,
  request: ExportCatalogRequest = {},
): Promise<SharedCatalogFile> {
  return await client.request(`${catalogPath(catalogId)}/export`, SharedCatalogFileSchema, {
    method: 'POST',
    ...jsonBody(ExportCatalogRequestSchema.parse(request)),
  });
}

/** Makes the client for one machine. A catalog belongs to a machine, so the connection is an argument. */
export type CatalogClientFactory = (connection: DaemonConnection) => Promise<CatalogClient>;
