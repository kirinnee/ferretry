import { describe, it } from 'bun:test';
import should from 'should';
import type { CatalogInstallScope } from '../../src/lib/catalog-install.ts';
import type {
  LocalMcpInstall,
  LocalMcpInstalled,
  LocalMcpInstallList,
  LocalMcpInstallRequest,
  LocalMcpPreview,
  LocalMcpPreviewRequest,
  LocalMcpRemoved,
} from '../../src/lib/local-mcp-install.ts';
import { BASE_URL, connectClient, jsonBodyOf } from './client-harness.ts';
import { captureError, jsonResponse, QueuedHttpTransport } from './fakes.ts';

const INSTALL_ID = `lmi_${'n'.repeat(22)}`;
const PREVIEW_ID = `lmp_${'v'.repeat(22)}`;
const AT = '2026-11-02T09:00:00.000Z';
const origin = {
  kind: 'account' as const,
  owner: 'claude-work',
  harness: 'claude' as const,
  scope: 'user' as const,
  id: 'a'.repeat(24),
};
const provenance = {
  publisher: `fy_daemon_${'0'.repeat(43)}`,
  publisherName: 'This machine',
  catalogId: `cat_${'0'.repeat(22)}`,
  catalogName: 'MCP servers on this machine',
  itemId: `itm_${'i'.repeat(22)}`,
  kind: 'mcp' as const,
  name: 'demo',
  version: 1,
  digest: `sha256:${'a'.repeat(64)}`,
};

const target = (scope: CatalogInstallScope): LocalMcpPreviewRequest['target'] =>
  scope === 'project'
    ? { scope: 'project', projectRoot: '/work/repo', harness: 'claude' }
    : { scope: 'runtime', runtime: 'claude-work', profile: 'work' };

const request = (scope: CatalogInstallScope): LocalMcpPreviewRequest => ({
  source: { id: origin.id },
  target: target(scope),
});

const preview = (scope: CatalogInstallScope): LocalMcpPreview => ({
  previewId: PREVIEW_ID as LocalMcpPreview['previewId'],
  expiresAt: AT,
  name: 'demo',
  origin,
  provenance: provenance as LocalMcpPreview['provenance'],
  target: target(scope),
  destination: 'somewhere',
  review: [{ label: 'Starts', text: 'npx demo', document: false }],
  secrets: [{ placeholder: 'API_TOKEN', held: true }],
  skipped: [],
  warnings: [],
});

const install = (scope: CatalogInstallScope): LocalMcpInstall => ({
  installId: INSTALL_ID as LocalMcpInstall['installId'],
  installedAt: AT,
  name: 'demo',
  origin,
  target: target(scope),
  destination: 'somewhere',
  secretBindings: { API_TOKEN: 'MY_TOKEN' },
});

const apply: LocalMcpInstallRequest = {
  previewId: PREVIEW_ID as LocalMcpInstallRequest['previewId'],
  secretBindings: { API_TOKEN: 'MY_TOKEN' },
};

describe('FyApiClient local MCP install methods', () => {
  for (const scope of ['project', 'runtime'] as const) {
    it(`previews a ${scope} copy at its own literal route`, async () => {
      const transport = new QueuedHttpTransport(jsonResponse(preview(scope)));
      const client = await connectClient(transport);

      const actual = await client.previewLocalMcpInstall(scope, request(scope));

      should(actual).deepEqual(preview(scope));
      should(transport.calls[0]?.url).equal(`${BASE_URL}/v1/mcp-installs/local/${scope}/preview`);
      should(transport.calls[0]?.init.method).equal('POST');
      should(jsonBodyOf(transport)).deepEqual(request(scope));
    });

    it(`applies a ${scope} copy at its own literal route`, async () => {
      const installed: LocalMcpInstalled = { install: install(scope), notes: ['note'] };
      const transport = new QueuedHttpTransport(jsonResponse(installed));
      const client = await connectClient(transport);

      const actual = await client.applyLocalMcpInstall(scope, apply);

      should(actual).deepEqual(installed);
      should(transport.calls[0]?.url).equal(`${BASE_URL}/v1/mcp-installs/local/${scope}`);
      should(transport.calls[0]?.init.method).equal('POST');
      should(jsonBodyOf(transport)).deepEqual(apply);
    });

    it(`removes a ${scope} copy with DELETE on its own route`, async () => {
      const removed: LocalMcpRemoved = {
        installId: INSTALL_ID as LocalMcpRemoved['installId'],
        name: 'demo',
        destination: 'somewhere',
      };
      const transport = new QueuedHttpTransport(jsonResponse(removed));
      const client = await connectClient(transport);

      const actual = await client.removeLocalMcpInstall(scope, INSTALL_ID);

      should(actual).deepEqual(removed);
      should(transport.calls[0]?.url).equal(`${BASE_URL}/v1/mcp-installs/local/${scope}/${INSTALL_ID}`);
      should(transport.calls[0]?.init.method).equal('DELETE');
    });
  }

  it('lists copies with a GET', async () => {
    const list: LocalMcpInstallList = { installs: [install('project'), install('runtime')] };
    const transport = new QueuedHttpTransport(jsonResponse(list));
    const client = await connectClient(transport);

    const actual = await client.localMcpInstalls();

    should(actual).deepEqual(list);
    should(transport.calls[0]?.url).equal(`${BASE_URL}/v1/mcp-installs/local`);
    should(transport.calls[0]?.init.method ?? 'GET').equal('GET');
  });

  it('refuses a malformed install id before any request is made', async () => {
    const transport = new QueuedHttpTransport();
    const client = await connectClient(transport);

    const error = await captureError(() =>
      Promise.resolve().then(() => client.removeLocalMcpInstall('project', '../x')),
    );

    should(error).be.an.Error();
    should(transport.calls).have.length(0);
  });
});
