/**
 * The Catalogs-owned R rows for installs: review a signed catalog item, apply what was reviewed, list what is
 * installed, change its update choices and remove it, into a PROJECT (`.mcp.json` in a known project folder) and into a
 * RUNTIME profile. Driven through the real daemon half on the kernel's test host: the real install service, state files
 * and signature checks, with the MCP plugin's file and runtime ports as in-memory stand-ins. One test per row.
 *
 * WHAT THE STAND-IN DOES NOT PROVE: it ignores the `governance` and `fresh` arguments the runtime installer is
 * handed, so these tests do not show that Catalogs passes governance on to it; and it replaces MCP's own
 * `.mcp.json` confinement (what MCP lets an install write is MCP's to prove). MCP and Skills also take no
 * `catalog.items` hook yet, so none of this runs end to end on a real daemon (ports-pending.json, the cross lines).
 */
import { describe, expect, test } from 'bun:test';
import { catalogsFixture, type CatalogsFixture, makeCatalog, mcpServer } from '../../support/daemon-host.ts';

const ferret = { kind: 'ferret', id: 'F1936' } as const;
const SOURCE = { kind: 'mcp', mcp: 'pdf-tools' } as const;
const ROOT = '/work/app';

/** The MCP plugin's project file and runtime config, in memory. */
function stores() {
  const file = { text: null as string | null, version: 0 };
  const components = new Map<string, Record<string, unknown>>();
  const provider = {
    projectRoots: async () => [ROOT],
    project: {
      read: async () => ({ text: file.text, etag: file.text === null ? null : `e${file.version}` }),
      replace: async (_path: string, text: string, expected: string | null) => {
        if (expected !== (file.text === null ? null : `e${file.version}`)) throw new Error('the file changed');
        file.text = text;
        file.version += 1;
        return `e${file.version}`;
      },
    },
    runtime: {
      runtimes: async () => ({ runtimes: [{ id: 'rt-1', name: 'claude-work', profile: 'work', harness: 'claude' }] }),
      profiles: async () => ({ profiles: [{ name: 'work' }] }),
      storedComponent: async (name: string) => components.get(name),
      propose: async (change: { name: string }) => ({ id: change.name }),
      apply: async (id: string) => {
        components.delete(id);
        return { outcome: 'executed' };
      },
      installCatalogItem: async (change: { name: string; component: object; installedFrom: object }) => {
        const stored = { ...change.component, installedFrom: change.installedFrom };
        components.set(change.name, stored);
        return { component: stored };
      },
    },
  };
  return { file, components, provider: provider as never };
}

/** A host with one MCP item in a catalog and the signed file that carries it. */
async function installing() {
  const held = stores();
  const fx: CatalogsFixture = await catalogsFixture({ mcp: [mcpServer('pdf-tools')], mcpProvider: held.provider });
  const catalog = await makeCatalog(fx);
  const preview = await fx.host.request('POST', `/v1/catalogs/${catalog}/items/preview`, { body: { source: SOURCE } });
  await fx.host.request('POST', `/v1/catalogs/${catalog}/items`, {
    body: { source: SOURCE, digest: preview.json<{ digest: string }>().digest },
  });
  const exported = (await fx.host.request('POST', `/v1/catalogs/${catalog}/export`, { body: {} })).json<{
    signedManifest: unknown;
    items: unknown[];
  }>();
  const base = { signedManifest: exported.signedManifest, item: exported.items[0] };
  return { fx, held, base };
}

const projectTarget = { scope: 'project', projectRoot: ROOT, harness: 'claude' } as const;
const runtimeTarget = { scope: 'runtime', runtime: 'rt-1', profile: 'work' } as const;

/** Reviews then applies one install; answers its id. */
async function install(rig: Awaited<ReturnType<typeof installing>>, scope: 'project' | 'runtime') {
  const body = { ...rig.base, target: scope === 'project' ? projectTarget : runtimeTarget };
  const preview = await rig.fx.host.request('POST', `/v1/catalog-installs/${scope}/preview`, { body });
  expect(preview.status).toBe(200);
  const applied = await rig.fx.host.request('POST', `/v1/catalog-installs/${scope}`, {
    body: { previewId: preview.json<{ previewId: string }>().previewId, secretBindings: {} },
  });
  expect(applied.status).toBe(200);
  return applied.json<{ install: { installId: string } }>().install.installId;
}

describe('the catalog install routes', () => {
  test('R-0258 R-0257 a project install is reviewed with nothing written, then applied to the project’s .mcp.json', async () => {
    const rig = await installing();
    const body = { ...rig.base, target: projectTarget };
    const preview = await rig.fx.host.request('POST', '/v1/catalog-installs/project/preview', { body });
    expect(preview.status).toBe(200);
    expect(rig.held.file.text).toBeNull();
    expect(
      (await rig.fx.host.request('POST', '/v1/catalog-installs/project/preview', { body, as: ferret })).status,
    ).toBe(200);
    const unknown = await rig.fx.host.request('POST', '/v1/catalog-installs/project/preview', {
      body: { ...body, target: { ...projectTarget, projectRoot: '/elsewhere' } },
    });
    expect(unknown.status).toBe(404);
    expect(unknown.json()).toMatchObject({ code: 'catalog_target_unknown' });
    const previewId = preview.json<{ previewId: string }>().previewId;
    expect(
      (
        await rig.fx.host.request('POST', '/v1/catalog-installs/project', {
          body: { previewId, secretBindings: {} },
          as: ferret,
        })
      ).status,
    ).toBe(403);
    const applied = await rig.fx.host.request('POST', '/v1/catalog-installs/project', {
      body: { previewId, secretBindings: {} },
    });
    expect(applied.status).toBe(200);
    expect(rig.held.file.text).toContain('pdf-tools');
    expect(applied.json()).toMatchObject({ install: { target: projectTarget } });
  });

  test('R-0260 R-0259 a runtime install is reviewed with nothing written, then applied to the runtime’s profile', async () => {
    const rig = await installing();
    const body = { ...rig.base, target: runtimeTarget };
    const preview = await rig.fx.host.request('POST', '/v1/catalog-installs/runtime/preview', { body });
    expect(preview.status).toBe(200);
    expect(rig.held.components.size).toBe(0);
    const bad = await rig.fx.host.request('POST', '/v1/catalog-installs/runtime', {
      body: { previewId: `cip_${'x'.repeat(22)}`, secretBindings: {} },
    });
    expect(bad.status).toBe(404);
    expect(bad.json()).toMatchObject({ code: 'catalog_preview_unknown' });
    const applied = await rig.fx.host.request('POST', '/v1/catalog-installs/runtime', {
      body: { previewId: preview.json<{ previewId: string }>().previewId, secretBindings: {} },
    });
    expect(applied.status).toBe(200);
    expect([...rig.held.components.keys()]).toEqual(['pdf-tools']);
  });

  test('R-0060 R-0214 R-0215 GET /v1/catalog-installs lists what is installed; PATCH keeps a version or skips one', async () => {
    const rig = await installing();
    const project = await install(rig, 'project');
    const listed = await rig.fx.host.request('GET', '/v1/catalog-installs', { as: ferret });
    expect(listed.status).toBe(200);
    expect(listed.json()).toMatchObject({ installs: [{ installId: project }] });
    const held = await rig.fx.host.request('PATCH', `/v1/catalog-installs/project/${project}`, {
      body: { hold: true },
    });
    expect(held.status).toBe(200);
    expect(held.json()).toMatchObject({ installId: project, hold: true });
    expect((await rig.fx.host.request('PATCH', `/v1/catalog-installs/project/${project}`, { body: {} })).status).toBe(
      400,
    );
    expect(
      (
        await rig.fx.host.request('PATCH', `/v1/catalog-installs/project/${project}`, {
          body: { hold: false },
          as: ferret,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await rig.fx.host.request('PATCH', `/v1/catalog-installs/project/cin_${'z'.repeat(22)}`, {
          body: { hold: true },
        })
      ).status,
    ).toBe(404);
  });

  test('R-0214 R-0215 a runtime install is kept and skipped through its own route', async () => {
    const rig = await installing();
    const runtime = await install(rig, 'runtime');
    const skipped = await rig.fx.host.request('PATCH', `/v1/catalog-installs/runtime/${runtime}`, {
      body: { skippedVersion: 2 },
    });
    expect(skipped.status).toBe(200);
    expect(skipped.json()).toMatchObject({ installId: runtime, skippedVersion: 2 });
    const cleared = await rig.fx.host.request('PATCH', `/v1/catalog-installs/runtime/${runtime}`, {
      body: { skippedVersion: null },
    });
    expect(cleared.status).toBe(200);
  });

  test('R-0005 DELETE /v1/catalog-installs/project/:installId removes what was written and the record', async () => {
    const rig = await installing();
    const project = await install(rig, 'project');
    expect(
      (await rig.fx.host.request('DELETE', `/v1/catalog-installs/project/${project}`, { as: ferret })).status,
    ).toBe(403);
    const removed = await rig.fx.host.request('DELETE', `/v1/catalog-installs/project/${project}`);
    expect(removed.status).toBe(200);
    expect(removed.json()).toMatchObject({ installId: project });
    expect(rig.held.file.text).not.toContain('pdf-tools');
    expect((await rig.fx.host.request('GET', '/v1/catalog-installs')).json()).toMatchObject({ installs: [] });
    expect((await rig.fx.host.request('DELETE', `/v1/catalog-installs/project/${project}`)).status).toBe(404);
  });

  test('R-0006 DELETE /v1/catalog-installs/runtime/:installId removes the runtime component and the record', async () => {
    const rig = await installing();
    const runtime = await install(rig, 'runtime');
    const removed = await rig.fx.host.request('DELETE', `/v1/catalog-installs/runtime/${runtime}`);
    expect(removed.status).toBe(200);
    expect(rig.held.components.size).toBe(0);
    expect((await rig.fx.host.request('GET', '/v1/catalog-installs')).json()).toMatchObject({ installs: [] });
  });
});
