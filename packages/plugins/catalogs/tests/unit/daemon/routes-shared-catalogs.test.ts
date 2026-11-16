/**
 * The publisher's catalog route table, called directly: a ferret only reads the current version of an item, the
 * owner does the rest, and a bad id, a bad version or a refusal is answered with its own status.
 */
import { describe, expect, it } from 'bun:test';
import { sharedCatalogRoutes, type SharedCatalogSubsystem } from '../../../daemon/lib/routes/shared-catalogs.ts';
import { CatalogRefusal } from '../../../daemon/lib/shared-catalogs/refusal.ts';
import { type Answered, bodyOf, callRoute, recordingService } from '../../support/route-driver.ts';

const CATALOG = `cat_${'c'.repeat(22)}`;
const ITEM = `itm_${'i'.repeat(22)}`;
const UNDO = `cqu_${'u'.repeat(22)}`;
const OTHER = `itm_${'o'.repeat(22)}`;
const DIGEST = `sha256:${'a'.repeat(64)}`;

function table(overrides: Partial<Record<keyof SharedCatalogSubsystem['catalogs'], unknown>> = {}, failWith?: Error) {
  const { service, calls } = recordingService<SharedCatalogSubsystem['catalogs']>(failWith);
  const catalogs = new Proxy(service, {
    get: (target, name) => (name in overrides ? overrides[name as keyof typeof overrides] : Reflect.get(target, name)),
  });
  return { routes: sharedCatalogRoutes({ catalogs }), calls };
}

const status = (answered: Answered) =>
  answered.error === undefined ? answered.response.status : answered.error.status;

describe('shared catalog routes: reads', () => {
  it('lists catalogs and items, with or without the source state', async () => {
    const { routes, calls } = table();
    await callRoute(routes, 'GET', '/v1/catalogs', { ferret: true });
    await callRoute(routes, 'GET', '/v1/catalogs', { query: [['sourceState', '1']] });
    await callRoute(routes, 'GET', '/v1/catalog-items');
    await callRoute(routes, 'GET', '/v1/catalog-items', { query: [['sourceState', '1']] });
    expect(calls.map(call => call.args)).toEqual([
      [{ sourceState: false }],
      [{ sourceState: true }],
      [{ sourceState: false }],
      [{ sourceState: true }],
    ]);
  });

  it('reads one item, and answers 404 for an id that could never be one', async () => {
    const { routes, calls } = table();
    await callRoute(routes, 'GET', '/v1/catalog-items/:itemId', { params: { itemId: ITEM } });
    expect(calls[0]?.args).toEqual([ITEM, { sourceState: false }]);
    expect((await callRoute(routes, 'GET', '/v1/catalog-items/:itemId', { params: { itemId: 'x' } })).error?.code).toBe(
      'item_unknown',
    );
  });

  it('lets a ferret read only the current version of an item', async () => {
    const { routes, calls } = table({ currentOf: async () => 2 });
    const path = '/v1/catalog-items/:itemId/versions/:version';
    expect(status(await callRoute(routes, 'GET', path, { params: { itemId: ITEM, version: '2' }, ferret: true }))).toBe(
      200,
    );
    const older = await callRoute(routes, 'GET', path, { params: { itemId: ITEM, version: '1' }, ferret: true });
    expect(older.error?.status).toBe(403);
    expect(status(await callRoute(routes, 'GET', path, { params: { itemId: ITEM, version: '1' } }))).toBe(200);
    expect(calls.map(call => call.name)).toEqual(['itemVersion', 'itemVersion']);
  });

  it('reads the changes between two versions, and refuses a version that is not a number from 1', async () => {
    const { routes, calls } = table({ currentOf: async () => 2 });
    const path = '/v1/catalog-items/:itemId/changes';
    const params = { itemId: ITEM };
    expect(
      status(
        await callRoute(routes, 'GET', path, {
          params,
          query: [
            ['from', '1'],
            ['to', '2'],
          ],
        }),
      ),
    ).toBe(200);
    expect(calls[0]?.args).toEqual([ITEM, 1, 2]);
    expect(
      (
        await callRoute(routes, 'GET', path, {
          params,
          query: [
            ['from', '1'],
            ['to', '2'],
          ],
          ferret: true,
        })
      ).error?.status,
    ).toBe(403);
    for (const bad of ['0', '01', 'x', '', '9999999999'])
      expect(
        (
          await callRoute(routes, 'GET', path, {
            params,
            query: [
              ['from', bad],
              ['to', '2'],
            ],
          })
        ).error?.code,
      ).toBe('version_unknown');
  });
});

describe('shared catalog routes: the owner publishes', () => {
  const owner = { ferret: true } as const;

  it('previews an item version for anyone and publishes one for the owner', async () => {
    const { routes, calls } = table();
    const params = { itemId: ITEM };
    expect(
      status(await callRoute(routes, 'POST', '/v1/catalog-items/:itemId/versions/preview', { params, ...owner })),
    ).toBe(200);
    expect(
      status(
        await callRoute(routes, 'POST', '/v1/catalog-items/:itemId/versions', { params, body: { digest: DIGEST } }),
      ),
    ).toBe(201);
    expect(calls.map(call => call.name)).toEqual(['previewItemVersion', 'publishItemVersion']);
  });

  it('chooses the current version and retires a version', async () => {
    const { routes, calls } = table();
    const params = { itemId: ITEM };
    expect(
      status(
        await callRoute(routes, 'PUT', '/v1/catalog-items/:itemId/current', { params, body: { version: 2, from: 1 } }),
      ),
    ).toBe(200);
    expect(
      status(
        await callRoute(routes, 'PATCH', '/v1/catalog-items/:itemId/versions/:version', {
          params: { ...params, version: '2' },
          body: { retired: true },
        }),
      ),
    ).toBe(200);
    expect(
      (
        await callRoute(routes, 'PATCH', '/v1/catalog-items/:itemId/versions/:version', {
          params: { ...params, version: 'x' },
          body: { retired: true },
        })
      ).error?.code,
    ).toBe('version_unknown');
    expect(calls.map(call => call.name)).toEqual(['makeCurrent', 'setRetired']);
  });

  it('makes, changes and deletes a catalog', async () => {
    const { routes, calls } = table();
    const params = { id: CATALOG };
    expect(status(await callRoute(routes, 'POST', '/v1/catalogs', { body: { name: 'Team' } }))).toBe(201);
    expect(status(await callRoute(routes, 'PATCH', '/v1/catalogs/:id', { params, body: { name: 'Crew' } }))).toBe(200);
    expect(status(await callRoute(routes, 'DELETE', '/v1/catalogs/:id', { params }))).toBe(200);
    expect((await callRoute(routes, 'DELETE', '/v1/catalogs/:id', { params: { id: 'x' } })).error?.code).toBe(
      'catalog_unknown',
    );
    expect(calls.map(call => call.name)).toEqual(['create', 'update', 'remove']);
  });

  it('previews, adds, versions and withdraws a catalog item', async () => {
    const { routes, calls } = table();
    const params = { id: CATALOG, itemId: ITEM };
    const source = { kind: 'mcp', mcp: 'pdf-tools' };
    expect(
      status(await callRoute(routes, 'POST', '/v1/catalogs/:id/items/preview', { params, body: { source }, ...owner })),
    ).toBe(200);
    expect(
      status(await callRoute(routes, 'POST', '/v1/catalogs/:id/items', { params, body: { source, digest: DIGEST } })),
    ).toBe(201);
    expect(
      status(
        await callRoute(routes, 'POST', '/v1/catalogs/:id/items/:itemId/versions', {
          params,
          body: { digest: DIGEST },
        }),
      ),
    ).toBe(201);
    expect(status(await callRoute(routes, 'DELETE', '/v1/catalogs/:id/items/:itemId', { params }))).toBe(200);
    expect(calls.map(call => call.name)).toEqual(['previewItem', 'addItem', 'publishVersion', 'withdraw']);
  });

  it('quick-adds (201 when added, 200 otherwise) and undoes, naming who asked from the credential', async () => {
    const { routes, calls } = table({
      quickAdd: async (_caller: string, request: { itemId: string }) => ({
        outcome: request.itemId === ITEM ? 'added' : 'already',
      }),
    });
    expect(status(await callRoute(routes, 'POST', '/v1/catalog-items/quick-add', { body: { itemId: ITEM } }))).toBe(
      201,
    );
    expect(status(await callRoute(routes, 'POST', '/v1/catalog-items/quick-add', { body: { itemId: OTHER } }))).toBe(
      200,
    );
    expect(status(await callRoute(routes, 'POST', '/v1/catalog-items/quick-add/undo', { body: { token: UNDO } }))).toBe(
      200,
    );
    expect(calls.map(call => [call.name, call.args[0]])).toEqual([['undoQuickAdd', 'host']]);
  });

  it('exports a catalog', async () => {
    const { routes, calls } = table();
    expect(
      status(await callRoute(routes, 'POST', '/v1/catalogs/:id/export', { params: { id: CATALOG }, body: {} })),
    ).toBe(200);
    expect(calls.map(call => call.name)).toEqual(['exportCatalog']);
  });

  it('refuses a ferret every publishing route', async () => {
    const { routes } = table();
    const params = { id: CATALOG, itemId: ITEM, version: '1' };
    for (const [method, path] of [
      ['POST', '/v1/catalog-items/:itemId/versions'],
      ['PUT', '/v1/catalog-items/:itemId/current'],
      ['PATCH', '/v1/catalog-items/:itemId/versions/:version'],
      ['POST', '/v1/catalogs'],
      ['PATCH', '/v1/catalogs/:id'],
      ['DELETE', '/v1/catalogs/:id'],
      ['POST', '/v1/catalogs/:id/items'],
      ['POST', '/v1/catalogs/:id/items/:itemId/versions'],
      ['DELETE', '/v1/catalogs/:id/items/:itemId'],
      ['POST', '/v1/catalog-items/quick-add'],
      ['POST', '/v1/catalog-items/quick-add/undo'],
      ['POST', '/v1/catalogs/:id/export'],
    ] as const)
      expect((await callRoute(routes, method, path, { params, ferret: true })).error?.status).toBe(403);
  });
});

describe('shared catalog routes: who tapped', () => {
  it('names a paired device, the agents or the host from the credential, never from the body', async () => {
    const seen: string[] = [];
    const { routes } = table({
      undoQuickAdd: async (caller: string) => {
        seen.push(caller);
        return {};
      },
    });
    const run = (credential: unknown) => {
      const path = '/v1/catalog-items/quick-add/undo';
      const route = routes.find(candidate => candidate.path === path);
      if (route === undefined) throw new Error('no route');
      return route.handle({
        request: { query: new Map(), headers: new Map(), text: async () => JSON.stringify({ token: UNDO }) },
        params: new Map(),
        credential,
      } as never);
    };
    await run({ tokenClass: 'device', principal: { holder: 'fy_device_id_x' } });
    await run(undefined);
    expect(seen).toEqual(['device:fy_device_id_x', 'host']);
  });
});

describe('shared catalog routes: refusals', () => {
  it('answers a refusal with its own status and code', async () => {
    const { routes } = table({}, new CatalogRefusal('name_taken', 'that name is taken'));
    const answered = await callRoute(routes, 'GET', '/v1/catalogs');
    expect(answered.error?.status).toBe(409);
    expect(answered.error?.code).toBe('name_taken');
  });

  it('lets any other failure through', async () => {
    const { routes } = table({}, new Error('disk gone'));
    await expect(callRoute(routes, 'GET', '/v1/catalogs')).rejects.toThrow('disk gone');
  });

  it('answers the body of a read as the service gave it', async () => {
    const { routes } = table();
    expect(bodyOf(await callRoute(routes, 'GET', '/v1/catalogs'))).toEqual({ called: 'list' });
  });
});
