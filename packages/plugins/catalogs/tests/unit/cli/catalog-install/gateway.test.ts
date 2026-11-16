import { describe, it } from 'bun:test';
import should from 'should';
import { ClientCatalogInstallGateway } from '../../../../cli/lib/catalog-install/gateway.ts';
import type { CatalogInstallApiClient } from '../../../../cli/lib/catalog-install/ports.ts';
import type { CatalogInstallPreviewRequest } from '../../../../contract/wire/index.ts';
import { catalogFileText, INSTALL_ID, installOf, previewOf, PREVIEW_ID, skillItem } from './support.ts';

type Call = { key: string; init: unknown };

/** A client that records each route call and answers with the queued body. */
function client(answer: unknown) {
  const calls: Call[] = [];
  const fake = {
    async call(key: string, init?: unknown) {
      calls.push({ key, init });
      return answer;
    },
  } as unknown as CatalogInstallApiClient;
  return { fake, calls };
}

const file = JSON.parse(catalogFileText([skillItem()]));
const previewRequest = (scope: 'project' | 'runtime'): CatalogInstallPreviewRequest => ({
  signedManifest: file.signedManifest,
  item: file.items[0],
  target:
    scope === 'project'
      ? { scope: 'project', projectRoot: '/work/repo', harness: 'claude' }
      : { scope: 'runtime', runtime: 'claude-work', profile: 'work' },
});

describe('ClientCatalogInstallGateway', () => {
  for (const scope of ['project', 'runtime'] as const) {
    it(`previews a ${scope} install through that scope's own route`, async () => {
      const { fake, calls } = client(previewOf());
      const result = await new ClientCatalogInstallGateway(fake).previewCatalogInstall(scope, previewRequest(scope));
      should(result.previewId).equal(PREVIEW_ID);
      should(calls.map(call => call.key)).eql([`POST /v1/catalog-installs/${scope}/preview`]);
    });

    it(`applies a ${scope} install through that scope's own route`, async () => {
      const { fake, calls } = client({ install: installOf(scope), notes: ['kept'] });
      const result = await new ClientCatalogInstallGateway(fake).applyCatalogInstall(scope, {
        previewId: PREVIEW_ID,
        secretBindings: {},
      });
      should(result.notes).eql(['kept']);
      should(calls.map(call => call.key)).eql([`POST /v1/catalog-installs/${scope}`]);
    });

    it(`removes a ${scope} install by id through that scope's own route`, async () => {
      const { fake, calls } = client({
        installId: INSTALL_ID,
        provenance: installOf(scope).provenance,
        destination: 'gone',
      });
      const result = await new ClientCatalogInstallGateway(fake).removeCatalogInstall(scope, INSTALL_ID);
      should(result.destination).equal('gone');
      should(calls).eql([
        { key: `DELETE /v1/catalog-installs/${scope}/:installId`, init: { params: { installId: INSTALL_ID } } },
      ]);
    });
  }

  it('lists what this machine installed', async () => {
    const { fake, calls } = client({ installs: [installOf('project')] });
    const result = await new ClientCatalogInstallGateway(fake).catalogInstalls();
    should(result.installs).have.length(1);
    should(calls.map(call => call.key)).eql(['GET /v1/catalog-installs']);
  });

  it('refuses a malformed install id before any call is made', async () => {
    const { fake, calls } = client({});
    await new ClientCatalogInstallGateway(fake).removeCatalogInstall('project', 'not-an-id').should.be.rejected();
    should(calls).have.length(0);
  });

  it('refuses a daemon answer that does not match the contract', async () => {
    const { fake } = client({ installs: 'nope' });
    await new ClientCatalogInstallGateway(fake).catalogInstalls().should.be.rejected();
  });
});
