import {
  type CatalogInstalled,
  CatalogInstalledSchema,
  CatalogInstallIdSchema,
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
} from '../../../contract/wire/index.ts';
import type { CatalogInstallApiClient, ICatalogInstallGateway } from './ports.ts';

/**
 * Today's four installer calls of the protocol client, through the shell's guarded client. Each scope names its own
 * route key, as today each dialled its own literal path.
 */
export class ClientCatalogInstallGateway implements ICatalogInstallGateway {
  constructor(private readonly client: CatalogInstallApiClient) {}

  async previewCatalogInstall(
    scope: CatalogInstallScope,
    request: CatalogInstallPreviewRequest,
  ): Promise<CatalogInstallPreview> {
    const body = CatalogInstallPreviewRequestSchema.parse(request);
    return CatalogInstallPreviewSchema.parse(
      scope === 'project'
        ? await this.client.call('POST /v1/catalog-installs/project/preview', { body })
        : await this.client.call('POST /v1/catalog-installs/runtime/preview', { body }),
    );
  }

  async applyCatalogInstall(scope: CatalogInstallScope, request: CatalogInstallRequest): Promise<CatalogInstalled> {
    const body = CatalogInstallRequestSchema.parse(request);
    return CatalogInstalledSchema.parse(
      scope === 'project'
        ? await this.client.call('POST /v1/catalog-installs/project', { body })
        : await this.client.call('POST /v1/catalog-installs/runtime', { body }),
    );
  }

  async catalogInstalls(): Promise<CatalogInstallList> {
    return CatalogInstallListSchema.parse(await this.client.call('GET /v1/catalog-installs'));
  }

  async removeCatalogInstall(scope: CatalogInstallScope, installId: string): Promise<CatalogInstallRemoved> {
    const params = { installId: CatalogInstallIdSchema.parse(installId) };
    return CatalogInstallRemovedSchema.parse(
      scope === 'project'
        ? await this.client.call('DELETE /v1/catalog-installs/project/:installId', { params })
        : await this.client.call('DELETE /v1/catalog-installs/runtime/:installId', { params }),
    );
  }
}
