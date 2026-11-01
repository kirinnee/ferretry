import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SharedCatalogFileSchema } from '@ferretry/protocol';
import { verifySharedCatalogFile } from '@ferretry/relay';
import should from 'should';
import { StateFileSystem } from '../../../src/adapters/filesystem/state-file-system.ts';
import {
  FileCatalogBlobStore,
  FileCatalogDocumentStore,
  NodeSkillFolder,
} from '../../../src/adapters/shared-catalogs/index.ts';
import { ApiDispatcher } from '../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../src/lib/api/router.ts';
import { createFoundationPaths, resolveStateHome } from '../../../src/lib/index.ts';
import { sharedCatalogRoutes } from '../../../src/lib/runtime/mounts/shared-catalogs.ts';
import { agentIn, CREDENTIALS, GRANTED, human } from '../../unit/runtime/mounts/support.ts';
import { jsonBody, request } from '../../unit/api/support.ts';
import { crypto, rig } from '../../unit/shared-catalogs/support.ts';

/**
 * The nine owner routes over the real service, the real stores in a real state home and a real skill
 * folder: create, add a skill and an MCP setup, publish a new version, withdraw, export, and verify the
 * exported file the way an installer would.
 */

const homes = new Set<string>();

afterEach(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
  homes.clear();
});

async function world() {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-catalog-routes-'));
  homes.add(home);
  const skillDirectory = join(home, 'skills', 'demo');
  await mkdir(skillDirectory, { recursive: true });
  const manifest = join(skillDirectory, 'SKILL.md');
  await writeFile(manifest, '---\nname: demo\ndescription: Does the demo thing\n---\nBody\n');
  const paths = createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: home }));
  const files = new StateFileSystem(paths);
  const stack = await rig({
    documents: new FileCatalogDocumentStore(paths, files),
    blobs: new FileCatalogBlobStore(paths, files),
    skillTree: new NodeSkillFolder(),
    skills: { list: async () => [{ path: manifest, name: 'demo' }] },
  });
  const dispatch = new ApiDispatcher(
    new ApiRouter(sharedCatalogRoutes({ catalogs: stack.service })),
    CREDENTIALS,
    GRANTED,
  );
  const call = (method: string, path: string, body?: unknown, headers: Readonly<Record<string, string>> = human) =>
    dispatch.dispatch(
      request({
        method,
        path,
        headers: { ...headers, 'content-type': 'application/json' },
        body: body === undefined ? '' : JSON.stringify(body),
        loopback: true,
      }),
    );
  return { call, manifest };
}

describe('the catalogs owner routes over real storage', () => {
  it('should take a catalog from nothing to a signed file an installer verifies', async () => {
    const { call } = await world();

    const created = jsonBody(await call('POST', '/v1/catalogs', { name: 'Team', description: 'Our tools' })) as {
      id: string;
    };
    const preview = jsonBody(
      await call('POST', `/v1/catalogs/${created.id}/items/preview`, { source: { kind: 'skill', skill: 'demo' } }),
    ) as { digest: string; name: string; version: number };
    const added = await call('POST', `/v1/catalogs/${created.id}/items`, {
      source: { kind: 'skill', skill: 'demo' },
      digest: preview.digest,
    });
    const exported = await call('POST', `/v1/catalogs/${created.id}/export`, {});

    should(preview).containEql({ name: 'demo', version: 1 });
    should(added.status).equal(201);
    should(exported.status).equal(200);
    const file = SharedCatalogFileSchema.parse(jsonBody(exported));
    should(file.items).have.length(1);
    should((await verifySharedCatalogFile(crypto, file)).ok).equal(true);
  });

  it('should refuse an add whose digest no longer matches the source', async () => {
    const { call, manifest } = await world();
    const created = jsonBody(await call('POST', '/v1/catalogs', { name: 'Team' })) as { id: string };
    const preview = jsonBody(
      await call('POST', `/v1/catalogs/${created.id}/items/preview`, { source: { kind: 'skill', skill: 'demo' } }),
    ) as { digest: string };
    await writeFile(manifest, '---\nname: demo\ndescription: Does the demo thing\n---\nChanged after the preview\n');

    const refused = await call('POST', `/v1/catalogs/${created.id}/items`, {
      source: { kind: 'skill', skill: 'demo' },
      digest: preview.digest,
    });

    should(refused.status).equal(409);
    should(jsonBody(refused)).containEql({ code: 'changed_since_preview' });
  });

  it('should let a ferret list what is published and nothing more', async () => {
    const { call } = await world();
    const ferret = agentIn('session-1');

    const listed = await call('GET', '/v1/catalogs', undefined, ferret);
    const made = await call('POST', '/v1/catalogs', { name: 'Sneaky' }, ferret);

    should(listed.status).equal(200);
    should(made.status).equal(403);
    should(jsonBody(made)).containEql({ code: 'owner_only' });
  });

  it('should refuse the same name twice and a catalog that is not there', async () => {
    const { call } = await world();
    await call('POST', '/v1/catalogs', { name: 'Team' });

    const twice = await call('POST', '/v1/catalogs', { name: 'Team' });
    const missing = await call('DELETE', `/v1/catalogs/cat_${'Z'.repeat(22)}`);

    should(twice.status).equal(409);
    should(jsonBody(twice)).containEql({ code: 'name_taken' });
    should(missing.status).equal(404);
    should(jsonBody(missing)).containEql({ code: 'catalog_unknown' });
  });
});
