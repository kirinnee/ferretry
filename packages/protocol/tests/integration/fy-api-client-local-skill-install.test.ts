import { describe, it } from 'bun:test';
import should from 'should';
import type { CatalogInstallScope } from '../../src/lib/catalog-install.ts';
import type {
  LocalSkillInstall,
  LocalSkillInstalled,
  LocalSkillInstallList,
  LocalSkillInstallRequest,
  LocalSkillPreview,
  LocalSkillPreviewRequest,
  LocalSkillRemoved,
} from '../../src/lib/local-skill-install.ts';
import { BASE_URL, connectClient, jsonBodyOf } from './client-harness.ts';
import { captureError, jsonResponse, QueuedHttpTransport } from './fakes.ts';

const INSTALL_ID = `lsi_${'n'.repeat(22)}`;
const PREVIEW_ID = `lsp_${'v'.repeat(22)}`;
const AT = '2026-11-02T09:00:00.000Z';
const origin = {
  kind: 'account' as const,
  owner: 'claude-work',
  harness: 'claude' as const,
  path: '/home/me/.claude/skills/demo/SKILL.md',
};
const provenance = {
  publisher: `fy_daemon_${'0'.repeat(43)}`,
  publisherName: 'This machine',
  catalogId: `cat_${'0'.repeat(22)}`,
  catalogName: 'Skills on this machine',
  itemId: `itm_${'i'.repeat(22)}`,
  kind: 'skill' as const,
  name: 'demo',
  version: 1,
  digest: `sha256:${'a'.repeat(64)}`,
};

const target = (scope: CatalogInstallScope): LocalSkillPreviewRequest['target'] =>
  scope === 'project'
    ? { scope: 'project', projectRoot: '/work/repo', harness: 'claude' }
    : { scope: 'runtime', runtime: 'claude-work', profile: 'work' };

const request = (scope: CatalogInstallScope): LocalSkillPreviewRequest => ({
  source: { path: origin.path },
  target: target(scope),
});

const preview = (scope: CatalogInstallScope): LocalSkillPreview => ({
  previewId: PREVIEW_ID as LocalSkillPreview['previewId'],
  expiresAt: AT,
  name: 'demo',
  origin,
  provenance: provenance as LocalSkillPreview['provenance'],
  target: target(scope),
  destination: 'somewhere',
  review: [{ label: 'Skill file SKILL.md', text: '# demo\n', document: true }],
  skipped: [],
  warnings: [],
});

const install = (scope: CatalogInstallScope): LocalSkillInstall => ({
  installId: INSTALL_ID as LocalSkillInstall['installId'],
  installedAt: AT,
  name: 'demo',
  origin,
  target: target(scope),
  destination: 'somewhere',
  files: [{ path: 'SKILL.md', sha256: 'a'.repeat(64) }],
});

const apply: LocalSkillInstallRequest = { previewId: PREVIEW_ID as LocalSkillInstallRequest['previewId'] };

describe('FyApiClient local skill install methods', () => {
  for (const scope of ['project', 'runtime'] as const) {
    it(`previews a ${scope} copy at its own literal route`, async () => {
      const transport = new QueuedHttpTransport(jsonResponse(preview(scope)));
      const client = await connectClient(transport);

      const actual = await client.previewLocalSkillInstall(scope, request(scope));

      should(actual).deepEqual(preview(scope));
      should(transport.calls[0]?.url).equal(`${BASE_URL}/v1/skill-installs/local/${scope}/preview`);
      should(transport.calls[0]?.init.method).equal('POST');
      should(jsonBodyOf(transport)).deepEqual(request(scope));
    });

    it(`applies a ${scope} copy at its own literal route`, async () => {
      const installed: LocalSkillInstalled = { install: install(scope), notes: ['note'] };
      const transport = new QueuedHttpTransport(jsonResponse(installed));
      const client = await connectClient(transport);

      const actual = await client.applyLocalSkillInstall(scope, apply);

      should(actual).deepEqual(installed);
      should(transport.calls[0]?.url).equal(`${BASE_URL}/v1/skill-installs/local/${scope}`);
      should(transport.calls[0]?.init.method).equal('POST');
      should(jsonBodyOf(transport)).deepEqual(apply);
    });

    it(`removes a ${scope} copy with DELETE on its own route`, async () => {
      const removed: LocalSkillRemoved = {
        installId: INSTALL_ID as LocalSkillRemoved['installId'],
        name: 'demo',
        destination: 'somewhere',
      };
      const transport = new QueuedHttpTransport(jsonResponse(removed));
      const client = await connectClient(transport);

      const actual = await client.removeLocalSkillInstall(scope, INSTALL_ID);

      should(actual).deepEqual(removed);
      should(transport.calls[0]?.url).equal(`${BASE_URL}/v1/skill-installs/local/${scope}/${INSTALL_ID}`);
      should(transport.calls[0]?.init.method).equal('DELETE');
    });
  }

  it('lists copies with a GET', async () => {
    const list: LocalSkillInstallList = { installs: [install('project'), install('runtime')] };
    const transport = new QueuedHttpTransport(jsonResponse(list));
    const client = await connectClient(transport);

    const actual = await client.localSkillInstalls();

    should(actual).deepEqual(list);
    should(transport.calls[0]?.url).equal(`${BASE_URL}/v1/skill-installs/local`);
    should(transport.calls[0]?.init.method ?? 'GET').equal('GET');
  });

  it('refuses a malformed install id before any request is made', async () => {
    const transport = new QueuedHttpTransport();
    const client = await connectClient(transport);

    const error = await captureError(() =>
      Promise.resolve().then(() => client.removeLocalSkillInstall('project', '../x')),
    );

    should(error).be.an.Error();
    should(transport.calls).have.length(0);
  });
});
