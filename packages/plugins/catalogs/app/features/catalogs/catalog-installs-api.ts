/**
 * The browser's half of the install routes (docs/catalogs.md, "Installing"). Each scope has its own
 * routes because a project write and a runtime write are governed by different capabilities.
 *
 * The apply asks for a fresh passkey through the carrier on its own (`403 grant_step_up_required`).
 * Nothing here handles one.
 */

import {
  CATALOG_INSTALLS_PATH,
  type CatalogInstall,
  type CatalogInstallList,
  CatalogInstallListSchema,
  type CatalogInstallPrefsRequest,
  CatalogInstallPrefsRequestSchema,
  type CatalogInstallPreview,
  type CatalogInstallPreviewRequest,
  CatalogInstallPreviewRequestSchema,
  CatalogInstallPreviewSchema,
  type CatalogInstallRemoved,
  CatalogInstallRemovedSchema,
  type CatalogInstallRequest,
  CatalogInstallRequestSchema,
  CatalogInstallSchema,
  type CatalogInstallScope,
  type CatalogInstalled,
  CatalogInstalledSchema,
  catalogInstallPath,
  catalogInstallsPath,
} from '../../../contract/wire/index.ts';
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

/** Stay on a version or skip one. Touches no file, and asks for no passkey. */
export async function setCatalogInstallPrefs(
  client: CatalogClient,
  scope: CatalogInstallScope,
  installId: string,
  prefs: CatalogInstallPrefsRequest,
): Promise<CatalogInstall> {
  return await client.request(catalogInstallPath(scope, installId), CatalogInstallSchema, {
    method: 'PATCH',
    ...jsonBody(CatalogInstallPrefsRequestSchema.parse(prefs)),
  });
}
