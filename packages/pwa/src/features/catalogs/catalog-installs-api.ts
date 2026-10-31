/**
 * The browser's half of the install routes (docs/catalogs.md, "Installing"). Each scope has its own
 * routes because a project write and a runtime write are governed by different capabilities.
 *
 * The apply asks for a fresh passkey through the carrier on its own (`403 grant_step_up_required`).
 * Nothing here handles one.
 */

import {
  CATALOG_INSTALLS_PATH,
  type CatalogInstallList,
  CatalogInstallListSchema,
  type CatalogInstallPreview,
  type CatalogInstallPreviewRequest,
  CatalogInstallPreviewRequestSchema,
  CatalogInstallPreviewSchema,
  type CatalogInstallRemoved,
  CatalogInstallRemovedSchema,
  type CatalogInstallRequest,
  CatalogInstallRequestSchema,
  type CatalogInstallScope,
  type CatalogInstalled,
  CatalogInstalledSchema,
  catalogInstallsPath,
} from '@ferretry/protocol';
import type { CatalogClient } from './catalogs-api.ts';

const jsonBody = (body: unknown): RequestInit => ({
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/** Reads and verifies the item for this target. Writes nothing. */
export async function previewCatalogInstall(
  client: CatalogClient,
  scope: CatalogInstallScope,
  request: CatalogInstallPreviewRequest,
): Promise<CatalogInstallPreview> {
  return await client.request(catalogInstallsPath(scope, true), CatalogInstallPreviewSchema, {
    method: 'POST',
    ...jsonBody(CatalogInstallPreviewRequestSchema.parse(request)),
  });
}

/** Applies exactly one preview with the person's choice for every secret. */
export async function applyCatalogInstall(
  client: CatalogClient,
  scope: CatalogInstallScope,
  request: CatalogInstallRequest,
): Promise<CatalogInstalled> {
  return await client.request(catalogInstallsPath(scope), CatalogInstalledSchema, {
    method: 'POST',
    ...jsonBody(CatalogInstallRequestSchema.parse(request)),
  });
}

export async function listCatalogInstalls(client: CatalogClient): Promise<CatalogInstallList> {
  return await client.request(CATALOG_INSTALLS_PATH, CatalogInstallListSchema);
}

export async function removeCatalogInstall(
  client: CatalogClient,
  scope: CatalogInstallScope,
  installId: string,
): Promise<CatalogInstallRemoved> {
  return await client.request(
    `${catalogInstallsPath(scope)}/${encodeURIComponent(installId)}`,
    CatalogInstallRemovedSchema,
    { method: 'DELETE' },
  );
}
