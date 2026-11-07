/**
 * WHAT GATE GOVERNS ON CATALOGS' MAIN ROUTES (Appendix D: G20, G170, G171), through the kernel test host: the real
 * daemon half, Gate's StandInAdmission deciding the descriptor, and Catalogs' own handlers deciding the rest.
 */
import { describe, expect, it } from 'bun:test';
import { STEP_UP_ACTS, STEP_UP_REQUIRED_CODE } from '@ferretry/core-gate/contract';
import manifest from '../../../manifest.ts';
import { catalogsFixture, makeCatalog, mcpServer } from '../../support/daemon-host.ts';

const ferret = { kind: 'ferret', id: 'F1936' } as const;
const device = { kind: 'device', holder: `fy_device_id_${'D'.repeat(22)}` } as const;
const PREVIEW_ID = `cip_${'p'.repeat(22)}`;
const INSTALL_ID = `cin_${'i'.repeat(22)}`;

const descriptor = (key: string) => {
  const route = manifest.actions.routes.find(entry => entry.key === key);
  if (route === undefined) throw new Error(`no route ${key}`);
  return route;
};

async function itemWithTwoVersions() {
  const servers = [mcpServer('pdf-tools')];
  const fx = await catalogsFixture({ mcp: servers });
  const catalog = await makeCatalog(fx);
  const source = { kind: 'mcp', mcp: 'pdf-tools' };
  const preview = await fx.host.request('POST', `/v1/catalogs/${catalog}/items/preview`, { body: { source } });
  if (preview.status !== 200) throw new Error(`preview ${preview.status} ${preview.body}`);
  const added = await fx.host.request('POST', `/v1/catalogs/${catalog}/items`, {
    body: { source, digest: preview.json<{ digest: string }>().digest },
  });
  if (added.status !== 201) throw new Error(`add ${added.status} ${added.body}`);
  const itemId = /"itemId":"(itm_[A-Za-z0-9_-]{22})"/u.exec(added.body)?.[1];
  if (itemId === undefined) throw new Error(`no item id in ${added.body}`);
  servers[0] = mcpServer('pdf-tools', ['-y', 'pdf-tools@2']);
  const next = await fx.host.request('POST', `/v1/catalog-items/${itemId}/versions/preview`, { body: {} });
  if (next.status !== 200) throw new Error(`version preview ${next.status} ${next.body}`);
  const published = await fx.host.request('POST', `/v1/catalog-items/${itemId}/versions`, {
    body: { digest: next.json<{ digest: string }>().digest },
  });
  if (published.status !== 201) throw new Error(`publish ${published.status} ${published.body}`);
  return { fx, itemId };
}

describe('Gate on the catalog routes', () => {
  it('G20 should let a ferret read only the current version of an item; older versions and changes are the owner’s', async () => {
    // Arrange
    const { fx, itemId } = await itemWithTwoVersions();

    // Act
    const current = await fx.host.request('GET', `/v1/catalog-items/${itemId}/versions/2`, { as: ferret });
    const older = await fx.host.request('GET', `/v1/catalog-items/${itemId}/versions/1`, { as: ferret });
    const changes = await fx.host.request('GET', `/v1/catalog-items/${itemId}/changes`, {
      as: ferret,
      query: { from: '1', to: '2' },
    });
    const ownerOlder = await fx.host.request('GET', `/v1/catalog-items/${itemId}/versions/1`);
    const ownerChanges = await fx.host.request('GET', `/v1/catalog-items/${itemId}/changes`, {
      query: { from: '1', to: '2' },
    });

    // Assert
    expect(current.status).toBe(200);
    expect(older.status).toBe(403);
    expect(changes.status).toBe(403);
    expect(older.body).toContain('only the current version');
    expect(ownerOlder.status).toBe(200);
    expect(ownerChanges.status).toBe(200);
  });

  it('G170 should make a preview use and an apply configure, and claim one fresh catalog-install proof per apply, never given back', async () => {
    // Arrange
    const fx = await catalogsFixture();
    fx.callers.device.stepUp = true;

    // Act — no proof held; then one proof, spent by an apply that fails afterwards
    const refused = await fx.host.request('POST', '/v1/catalog-installs/project', {
      as: device,
      body: { previewId: PREVIEW_ID, secretBindings: {} },
    });
    fx.callers.fresh.add(STEP_UP_ACTS.catalogInstall);
    const spent = await fx.host.request('POST', '/v1/catalog-installs/runtime', {
      as: device,
      body: { previewId: PREVIEW_ID, secretBindings: {} },
    });
    const again = await fx.host.request('POST', '/v1/catalog-installs/runtime', {
      as: device,
      body: { previewId: PREVIEW_ID, secretBindings: {} },
    });
    const owner = await fx.host.request('POST', '/v1/catalog-installs/project', {
      body: { previewId: PREVIEW_ID, secretBindings: {} },
    });

    // Assert — the descriptors
    for (const scope of ['project', 'runtime']) {
      expect(descriptor(`POST /v1/catalog-installs/${scope}/preview`).capability?.axis).toBe('use');
      expect(descriptor(`POST /v1/catalog-installs/${scope}`).capability?.axis).toBe('configure');
    }
    // Assert — the claim
    expect(refused.status).toBe(403);
    expect(refused.json<{ code: string; demand: { act: string } }>()).toMatchObject({
      code: STEP_UP_REQUIRED_CODE,
      demand: { act: JSON.parse(JSON.stringify(STEP_UP_ACTS.catalogInstall)) },
    });
    expect(spent.status).not.toBe(403);
    expect(again.status).toBe(403);
    expect(fx.callers.claims.map(claim => [claim.act, claim.granted])).toEqual([
      [STEP_UP_ACTS.catalogInstall, false],
      [STEP_UP_ACTS.catalogInstall, true],
      [STEP_UP_ACTS.catalogInstall, false],
    ]);
    expect(owner.status).not.toBe(403);
  });

  it('G171 should ask no passkey of a replaceEdited preview, a remove or a Stay/Skip, and refuse a ferret install and remove', async () => {
    // Arrange
    const fx = await catalogsFixture();
    fx.callers.device.stepUp = true;
    const preview = {
      signedManifest: { manifest: {}, spki: 'x', sig: 'x' },
      item: {},
      target: { scope: 'project', projectRoot: '/work' },
      replaceEdited: true,
    };

    // Act
    const previewed = await fx.host.request('POST', '/v1/catalog-installs/project/preview', {
      as: device,
      body: preview,
    });
    const removed = await fx.host.request('DELETE', `/v1/catalog-installs/project/${INSTALL_ID}`, { as: device });
    const stayed = await fx.host.request('PATCH', `/v1/catalog-installs/runtime/${INSTALL_ID}`, {
      as: device,
      body: { hold: true },
    });
    const ferretList = await fx.host.request('GET', '/v1/catalog-installs', { as: ferret });
    const ferretPreview = await fx.host.request('POST', '/v1/catalog-installs/project/preview', {
      as: ferret,
      body: preview,
    });
    const ferretInstall = await fx.host.request('POST', '/v1/catalog-installs/project', {
      as: ferret,
      body: { previewId: PREVIEW_ID, secretBindings: {} },
    });
    const ferretRemove = await fx.host.request('DELETE', `/v1/catalog-installs/project/${INSTALL_ID}`, { as: ferret });

    // Assert — no passkey was asked of any of them
    expect(fx.callers.claims).toEqual([]);
    for (const answer of [previewed, removed, stayed]) expect(answer.body).not.toContain(STEP_UP_REQUIRED_CODE);
    expect(ferretList.status).toBe(200);
    expect(ferretPreview.status).not.toBe(403);
    expect(ferretInstall.status).toBe(403);
    expect(ferretRemove.status).toBe(403);
  });
});
