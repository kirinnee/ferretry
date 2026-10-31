import { describe, it } from 'bun:test';
import should from 'should';
import type {
  CatalogInstall,
  CatalogInstalled,
  CatalogInstallList,
  CatalogInstallPreview,
  CatalogInstallPreviewRequest,
  CatalogInstallRemoved,
  CatalogInstallRequest,
  CatalogInstallScope,
} from '../../src/lib/catalog-install.ts';
import { BASE_URL, connectClient, jsonBodyOf } from './client-harness.ts';
import { captureError, jsonResponse, QueuedHttpTransport } from './fakes.ts';

const PUBLISHER = `fy_daemon_${'p'.repeat(43)}`;
const CATALOG_ID = `cat_${'c'.repeat(22)}`;
const ITEM_ID = `itm_${'i'.repeat(22)}`;
const INSTALL_ID = `cin_${'n'.repeat(22)}`;
const PREVIEW_ID = `cip_${'v'.repeat(22)}`;
const DIGEST = `sha256:${'a'.repeat(64)}`;
const AT = '2026-10-31T09:00:00.000Z';

const provenance = {
  publisher: PUBLISHER,
  publisherName: 'kirin-box',
  catalogId: CATALOG_ID,
  catalogName: "Kirin's catalog",
  itemId: ITEM_ID,
  kind: 'skill' as const,
  name: 'pdf-tools',
  version: 1,
  digest: DIGEST,
};

const request = (scope: CatalogInstallScope): CatalogInstallPreviewRequest => ({
  signedManifest: {
    manifest: {
      format: 'ferretry-catalog-manifest',
      version: 1,
      publisher: PUBLISHER,
      publisherName: 'kirin-box',
      catalogId: CATALOG_ID,
      name: "Kirin's catalog",
      description: '',
      visibility: 'members',
      revision: 1,
      issuedAt: AT,
      items: [
        {
          itemId: ITEM_ID,
          kind: 'skill',
          name: 'pdf-tools',
          summary: 'Split PDFs',
          version: 1,
          digest: DIGEST,
          size: 100,
          publishedAt: AT,
        },
      ],
      withdrawn: [],
    },
    spki: 'A'.repeat(59),
    sig: 'B'.repeat(86),
  },
  item: {
    format: 'ferretry-catalog-item',
    version: 1,
    publisher: PUBLISHER,
    catalogId: CATALOG_ID,
    itemId: ITEM_ID,
    itemVersion: 1,
    name: 'pdf-tools',
    summary: 'Split PDFs',
    kind: 'skill',
    skill: { files: [{ path: 'SKILL.md', content: '# pdf\n' }] },
  },
  target:
    scope === 'project'
      ? { scope: 'project', projectRoot: '/work/repo', harness: 'claude' }
      : { scope: 'runtime', runtime: 'claude-work', profile: 'work' },
});

const preview = (scope: CatalogInstallScope): CatalogInstallPreview => ({
  previewId: PREVIEW_ID as CatalogInstallPreview['previewId'],
  expiresAt: AT,
  provenance: provenance as CatalogInstallPreview['provenance'],
  publisher: {
    daemonId: PUBLISHER as CatalogInstallPreview['publisher']['daemonId'],
    name: 'kirin-box',
    firstSeen: true,
  },
  target: request(scope).target,
  destination: 'somewhere',
  review: [{ label: 'Skill file SKILL.md', text: '# pdf\n', document: true }],
  secrets: [{ placeholder: 'TOKEN', held: false }],
  warnings: [{ code: 'first-publisher', text: 'first' }],
});

const install = (scope: CatalogInstallScope): CatalogInstall => ({
  installId: INSTALL_ID as CatalogInstall['installId'],
  installedAt: AT,
  provenance: provenance as CatalogInstall['provenance'],
  target: request(scope).target,
  destination: 'somewhere',
  secretBindings: { TOKEN: null },
});

const apply: CatalogInstallRequest = {
  previewId: PREVIEW_ID as CatalogInstallRequest['previewId'],
  secretBindings: { TOKEN: null },
};

describe('FyApiClient catalog install methods', () => {
  for (const scope of ['project', 'runtime'] as const) {
    it(`previews a ${scope} install at its own literal route`, async () => {
      const transport = new QueuedHttpTransport(jsonResponse(preview(scope)));
      const client = await connectClient(transport);

      const actual = await client.previewCatalogInstall(scope, request(scope));

      should(actual).deepEqual(preview(scope));
      should(transport.calls[0]?.url).equal(`${BASE_URL}/v1/catalog-installs/${scope}/preview`);
      should(transport.calls[0]?.init.method).equal('POST');
      should(jsonBodyOf(transport)).deepEqual(request(scope));
    });

    it(`applies a ${scope} install at its own literal route`, async () => {
      const installed: CatalogInstalled = { install: install(scope), notes: ['note'] };
      const transport = new QueuedHttpTransport(jsonResponse(installed));
      const client = await connectClient(transport);

      const actual = await client.applyCatalogInstall(scope, apply);

      should(actual).deepEqual(installed);
      should(transport.calls[0]?.url).equal(`${BASE_URL}/v1/catalog-installs/${scope}`);
      should(transport.calls[0]?.init.method).equal('POST');
      should(jsonBodyOf(transport)).deepEqual(apply);
    });

    it(`removes a ${scope} install with DELETE on its own route`, async () => {
      const removed: CatalogInstallRemoved = {
        installId: INSTALL_ID as CatalogInstallRemoved['installId'],
        provenance: provenance as CatalogInstallRemoved['provenance'],
        destination: 'somewhere',
      };
      const transport = new QueuedHttpTransport(jsonResponse(removed));
      const client = await connectClient(transport);

      const actual = await client.removeCatalogInstall(scope, INSTALL_ID);

      should(actual).deepEqual(removed);
      should(transport.calls[0]?.url).equal(`${BASE_URL}/v1/catalog-installs/${scope}/${INSTALL_ID}`);
      should(transport.calls[0]?.init.method).equal('DELETE');
    });
  }

  it('lists installs with a GET', async () => {
    const list: CatalogInstallList = { installs: [install('project'), install('runtime')] };
    const transport = new QueuedHttpTransport(jsonResponse(list));
    const client = await connectClient(transport);

    const actual = await client.catalogInstalls();

    should(actual).deepEqual(list);
    should(transport.calls[0]?.url).equal(`${BASE_URL}/v1/catalog-installs`);
    should(transport.calls[0]?.init.method ?? 'GET').equal('GET');
  });

  it('refuses a malformed install id before any request is made', async () => {
    const transport = new QueuedHttpTransport();
    const client = await connectClient(transport);

    const error = await captureError(() =>
      Promise.resolve().then(() => client.removeCatalogInstall('project', '../x')),
    );

    should(error).be.an.Error();
    should(transport.calls).have.length(0);
  });
});
