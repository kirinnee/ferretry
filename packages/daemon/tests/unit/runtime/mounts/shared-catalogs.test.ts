import { describe, it } from 'bun:test';
import should from 'should';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import {
  type SharedCatalogSubsystem,
  sharedCatalogRoutes,
} from '../../../../src/lib/runtime/mounts/shared-catalogs.ts';
import { CatalogRefusal, type CatalogRefusalCode } from '../../../../src/lib/shared-catalogs/refusal.ts';
import { jsonBody, request } from '../../api/support.ts';
import { handleDirectly } from './second-line.ts';
import { agentIn, CREDENTIALS, fromFerret, GRANTED, human } from './support.ts';

const CAT = `cat_${'A'.repeat(22)}`;
const ITEM = `itm_${'B'.repeat(22)}`;
const DIGEST = `sha256:${'c'.repeat(64)}`;
const UNDO = `cqu_${'u'.repeat(22)}`;

type Calls = string[];

function stubbed(failWith?: CatalogRefusalCode) {
  const calls: Calls = [];
  const act =
    (name: string) =>
    async (...args: unknown[]) => {
      calls.push(`${name} ${JSON.stringify(args)}`);
      if (failWith !== undefined) throw new CatalogRefusal(failWith, `refused ${failWith}`);
      return { ok: name };
    };
  const catalogs = {
    list: act('list'),
    listItems: act('listItems'),
    create: act('create'),
    update: act('update'),
    remove: act('remove'),
    previewItem: act('previewItem'),
    addItem: act('addItem'),
    publishVersion: act('publishVersion'),
    getItem: act('getItem'),
    currentOf: async (item: string) => {
      calls.push(`currentOf ["${item}"]`);
      return 2;
    },
    itemVersion: act('itemVersion'),
    itemChanges: act('itemChanges'),
    previewItemVersion: act('previewItemVersion'),
    publishItemVersion: act('publishItemVersion'),
    makeCurrent: act('makeCurrent'),
    setRetired: act('setRetired'),
    withdraw: act('withdraw'),
    exportCatalog: act('exportCatalog'),
    quickAdd: act('quickAdd'),
    undoQuickAdd: act('undoQuickAdd'),
  } as unknown as SharedCatalogSubsystem['catalogs'];
  const dispatch = new ApiDispatcher(new ApiRouter(sharedCatalogRoutes({ catalogs })), CREDENTIALS, GRANTED);
  return { calls, dispatch };
}

const call = (
  method: string,
  path: string,
  body?: unknown,
  headers: Readonly<Record<string, string>> = human,
  query: readonly (readonly [string, string])[] = [],
) =>
  request({
    method,
    path,
    query,
    headers: { ...headers, 'content-type': 'application/json' },
    body: body === undefined ? '' : JSON.stringify(body),
    loopback: true,
  });

const WRITES: readonly (readonly [string, string, unknown])[] = [
  ['POST', '/v1/catalogs', { name: 'Team' }],
  ['PATCH', `/v1/catalogs/${CAT}`, { name: 'New' }],
  ['PATCH', `/v1/catalogs/${CAT}`, { role: 'default' }],
  ['POST', `/v1/catalogs/${CAT}/items`, { itemId: ITEM, version: 1 }],
  ['DELETE', `/v1/catalogs/${CAT}`, undefined],
  ['POST', `/v1/catalogs/${CAT}/items`, { source: { kind: 'skill', skill: 'demo' }, digest: DIGEST }],
  ['POST', `/v1/catalogs/${CAT}/items/${ITEM}/versions`, { digest: DIGEST }],
  ['POST', `/v1/catalog-items/${ITEM}/versions`, { digest: DIGEST }],
  ['PUT', `/v1/catalog-items/${ITEM}/current`, { version: 1, from: 2 }],
  ['PATCH', `/v1/catalog-items/${ITEM}/versions/1`, { retired: true }],
  ['DELETE', `/v1/catalogs/${CAT}/items/${ITEM}`, undefined],
  ['POST', `/v1/catalogs/${CAT}/export`, {}],
  ['POST', '/v1/catalog-items/quick-add', { source: { kind: 'skill', skill: 'demo' } }],
  ['POST', '/v1/catalog-items/quick-add', { itemId: ITEM }],
  ['POST', '/v1/catalog-items/quick-add/undo', { token: UNDO }],
];

describe('the shared catalogs routes', () => {
  it('should serve nineteen routes, all behind sharing/use', () => {
    const routes = sharedCatalogRoutes(stubbed().dispatch as never as SharedCatalogSubsystem);
    should(routes.map(route => `${route.method} ${route.path}`)).deepEqual([
      'GET /v1/catalogs',
      'GET /v1/catalog-items',
      'GET /v1/catalog-items/:itemId',
      'GET /v1/catalog-items/:itemId/versions/:version',
      'GET /v1/catalog-items/:itemId/changes',
      'POST /v1/catalog-items/:itemId/versions/preview',
      'POST /v1/catalog-items/:itemId/versions',
      'PUT /v1/catalog-items/:itemId/current',
      'PATCH /v1/catalog-items/:itemId/versions/:version',
      'POST /v1/catalogs',
      'PATCH /v1/catalogs/:id',
      'DELETE /v1/catalogs/:id',
      'POST /v1/catalogs/:id/items/preview',
      'POST /v1/catalogs/:id/items',
      'POST /v1/catalogs/:id/items/:itemId/versions',
      'DELETE /v1/catalogs/:id/items/:itemId',
      'POST /v1/catalog-items/quick-add',
      'POST /v1/catalog-items/quick-add/undo',
      'POST /v1/catalogs/:id/export',
    ]);
    for (const route of routes) should(route.capability).deepEqual({ capability: 'sharing', axis: 'use' });
  });

  it('should never let a cache keep what an item publish or a version read answered', () => {
    const routes = sharedCatalogRoutes(stubbed().dispatch as never as SharedCatalogSubsystem);
    const itemRoutes = routes.filter(route => route.path.startsWith('/v1/catalog-items/:itemId'));
    should(itemRoutes).have.length(7);
    for (const route of itemRoutes) should(route.noStore).equal(true);
    should(
      routes.find(route => route.method === 'POST' && route.path === '/v1/catalog-items/:itemId/versions')?.noStore,
    ).equal(true);
  });

  it('should let the owner do every one, with 201 for what makes something', async () => {
    const { dispatch, calls } = stubbed();
    const statuses: number[] = [];
    for (const [method, path, body] of WRITES)
      statuses.push((await dispatch.dispatch(call(method, path, body))).status);
    should(statuses).deepEqual([201, 200, 200, 201, 200, 201, 201, 201, 200, 200, 200, 200, 200, 200, 200]);
    const listed = await dispatch.dispatch(call('GET', '/v1/catalogs'));
    should(listed.status).equal(200);
    const previewed = await dispatch.dispatch(
      call('POST', `/v1/catalogs/${CAT}/items/preview`, { source: { kind: 'mcp', mcp: 'files' } }),
    );
    should(previewed.status).equal(200);
    should(
      (await dispatch.dispatch(call('GET', '/v1/catalog-items', undefined, human, [['sourceState', '1']]))).status,
    ).equal(200);
    should(calls).have.length(18);
  });

  it('should answer 201 for a quick add that added, 200 for one that did not, and tie Undo to the caller', async () => {
    const answers: unknown[] = [{ outcome: 'added' }, { outcome: 'already' }, { outcome: 'review' }];
    const seen: string[] = [];
    const catalogs = {
      quickAdd: async (caller: string) => {
        seen.push(caller);
        return answers.shift();
      },
      undoQuickAdd: async (caller: string, token: string) => {
        seen.push(`${caller} ${token}`);
        return { ok: true };
      },
    } as unknown as SharedCatalogSubsystem['catalogs'];
    const dispatch = new ApiDispatcher(new ApiRouter(sharedCatalogRoutes({ catalogs })), CREDENTIALS, GRANTED);
    const body = { source: { kind: 'skill', skill: 'demo' } };

    const statuses = [
      (await dispatch.dispatch(call('POST', '/v1/catalog-items/quick-add', body))).status,
      (await dispatch.dispatch(call('POST', '/v1/catalog-items/quick-add', body))).status,
      (await dispatch.dispatch(call('POST', '/v1/catalog-items/quick-add', body))).status,
    ];
    await dispatch.dispatch(call('POST', '/v1/catalog-items/quick-add/undo', { token: UNDO }));

    should(statuses).deepEqual([201, 200, 200]);
    should(seen).deepEqual(['host', 'host', 'host', `host ${UNDO}`]);
  });

  it('should hand the service the paired device that tapped, so two devices cannot spend each other’s Undo', async () => {
    const seen: string[] = [];
    const catalogs = {
      quickAdd: async (caller: string) => {
        seen.push(caller);
        return { outcome: 'already' };
      },
      undoQuickAdd: async (caller: string, token: string) => {
        seen.push(`${caller} ${token}`);
        return { ok: true };
      },
    } as unknown as SharedCatalogSubsystem['catalogs'];
    const routes = sharedCatalogRoutes({ catalogs });
    const deviceOne = {
      credential: { kind: 'authenticated', tokenClass: 'device', deviceId: 'd1' } as const,
      actor: 'device:d1',
    };
    const deviceTwo = {
      credential: { kind: 'authenticated', tokenClass: 'device', deviceId: 'd2' } as const,
      actor: 'device:d2',
    };
    const body = { source: { kind: 'skill', skill: 'demo' } };

    await handleDirectly(routes, 'POST', '/v1/catalog-items/quick-add', deviceOne, body);
    await handleDirectly(routes, 'POST', '/v1/catalog-items/quick-add', deviceTwo, body);
    await handleDirectly(routes, 'POST', '/v1/catalog-items/quick-add/undo', deviceTwo, { token: UNDO });

    should(seen).deepEqual(['device:d1', 'device:d2', `device:d2 ${UNDO}`]);
  });

  it('should refuse a bad Undo token and a quick add that claims to be clean, with nothing called', async () => {
    const { dispatch, calls } = stubbed();
    const bad = await dispatch.dispatch(call('POST', '/v1/catalog-items/quick-add/undo', { token: 'nope' }));
    const claimed = await dispatch.dispatch(
      call('POST', '/v1/catalog-items/quick-add', { source: { kind: 'skill', skill: 'demo' }, clean: true }),
    );
    should(bad.status).be.within(400, 422);
    should(claimed.status).be.within(400, 422);
    should(calls).deepEqual([]);
  });

  it('should check the sources only when the list is asked with sourceState=1', async () => {
    const { dispatch, calls } = stubbed();
    await dispatch.dispatch(call('GET', '/v1/catalogs'));
    await dispatch.dispatch(call('GET', '/v1/catalogs', undefined, human, [['sourceState', '1']]));
    await dispatch.dispatch(call('GET', '/v1/catalogs', undefined, human, [['sourceState', '0']]));
    should(calls).deepEqual([
      'list [{"sourceState":false}]',
      'list [{"sourceState":true}]',
      'list [{"sourceState":false}]',
    ]);
  });

  it('should let a ferret list and preview, and refuse every other call with 403 owner_only', async () => {
    const { dispatch, calls } = stubbed();
    const ferret = agentIn('session-1');
    for (const [method, path, body] of WRITES) {
      // On the admin token naming its session (an older fy), and on its own session credential.
      for (const asked of [call(method, path, body, ferret), fromFerret(call(method, path, body))]) {
        const refused = await dispatch.dispatch(asked);
        should(refused.status).equal(403);
        should(jsonBody(refused)).containEql({ code: 'owner_only' });
      }
    }
    should(calls).deepEqual([]);
    should((await dispatch.dispatch(call('GET', '/v1/catalogs', undefined, ferret))).status).equal(200);
    should((await dispatch.dispatch(fromFerret(call('GET', '/v1/catalogs')))).status).equal(200);
    const preview = await dispatch.dispatch(
      call('POST', `/v1/catalogs/${CAT}/items/preview`, { itemId: ITEM }, ferret),
    );
    should(preview.status).equal(200);
    should(calls).have.length(3);
  });

  it('should refuse a role other than default at the route, with nothing called', async () => {
    const { dispatch, calls } = stubbed();
    const response = await dispatch.dispatch(call('PATCH', `/v1/catalogs/${CAT}`, { role: 'collection' }));
    should(response.status).equal(400);
    should(calls).deepEqual([]);
  });

  it('should let a ferret read the shared items', async () => {
    const { dispatch } = stubbed();
    const ferret = agentIn('session-1');
    should((await dispatch.dispatch(call('GET', '/v1/catalog-items', undefined, ferret))).status).equal(200);
    should((await dispatch.dispatch(fromFerret(call('GET', '/v1/catalog-items')))).status).equal(200);
  });

  describe('what changed, and publishing at the item', () => {
    const ferret = agentIn('session-1');
    const VERSIONS = `/v1/catalog-items/${ITEM}/versions`;

    it('should let anyone read an item, a version and the changes, a ferret included', async () => {
      const { dispatch, calls } = stubbed();
      for (const headers of [human, ferret]) {
        for (const path of [`/v1/catalog-items/${ITEM}`, `${VERSIONS}/2`])
          should((await dispatch.dispatch(call('GET', path, undefined, headers))).status).equal(200);
        should(
          (
            await dispatch.dispatch(
              call('GET', `/v1/catalog-items/${ITEM}/changes`, undefined, headers, [
                ['from', '2'],
                ['to', '2'],
              ]),
            )
          ).status,
        ).equal(200);
        should((await dispatch.dispatch(call('POST', `${VERSIONS}/preview`, {}, headers))).status).equal(200);
      }
      should((await dispatch.dispatch(fromFerret(call('GET', `/v1/catalog-items/${ITEM}`)))).status).equal(200);
      should(calls.slice(0, 4)).deepEqual([
        `getItem ["${ITEM}",{"sourceState":false}]`,
        `itemVersion ["${ITEM}",2]`,
        `itemChanges ["${ITEM}",2,2]`,
        `previewItemVersion ["${ITEM}"]`,
      ]);
    });

    it('should let a ferret read only the current version, and the owner read any', async () => {
      const { dispatch, calls } = stubbed();
      const changes = (headers: Readonly<Record<string, string>>, from: string, to: string) =>
        call('GET', `/v1/catalog-items/${ITEM}/changes`, undefined, headers, [
          ['from', from],
          ['to', to],
        ]);
      should((await dispatch.dispatch(call('GET', `${VERSIONS}/2`, undefined, ferret))).status).equal(200);
      should((await dispatch.dispatch(changes(ferret, '2', '2'))).status).equal(200);
      calls.length = 0;
      for (const asked of [
        call('GET', `${VERSIONS}/1`, undefined, ferret),
        call('GET', `${VERSIONS}/3`, undefined, ferret),
        changes(ferret, '1', '2'),
        changes(ferret, '2', '3'),
        fromFerret(call('GET', `${VERSIONS}/1`)),
      ]) {
        const refused = await dispatch.dispatch(asked);
        should(refused.status).equal(403);
        should(jsonBody(refused)).containEql({ code: 'forbidden' });
      }
      should(calls.every(entry => entry.startsWith('currentOf'))).be.true();
      calls.length = 0;
      should((await dispatch.dispatch(call('GET', `${VERSIONS}/1`))).status).equal(200);
      should((await dispatch.dispatch(changes(human, '1', '3'))).status).equal(200);
      should(calls).deepEqual([`itemVersion ["${ITEM}",1]`, `itemChanges ["${ITEM}",1,3]`]);
    });

    it('should check the source of one item only with sourceState=1', async () => {
      const { dispatch, calls } = stubbed();
      await dispatch.dispatch(call('GET', `/v1/catalog-items/${ITEM}`, undefined, human, [['sourceState', '1']]));
      should(calls).deepEqual([`getItem ["${ITEM}",{"sourceState":true}]`]);
    });

    it('should answer 201 for a publish, and refuse a ferret, with nothing called', async () => {
      const { dispatch, calls } = stubbed();
      const published = await dispatch.dispatch(call('POST', VERSIONS, { digest: DIGEST }));
      should(published.status).equal(201);
      should(calls).deepEqual([`publishItemVersion ["${ITEM}",{"digest":"${DIGEST}"}]`]);
      const refused = await dispatch.dispatch(call('POST', VERSIONS, { digest: DIGEST }, ferret));
      should(refused.status).equal(403);
      should(jsonBody(refused)).containEql({ code: 'owner_only' });
      should(calls).have.length(1);
    });

    it('should hand a make-current and a retire to the service, and refuse a ferret, with nothing called', async () => {
      const { dispatch, calls } = stubbed();
      const current = await dispatch.dispatch(
        call('PUT', `/v1/catalog-items/${ITEM}/current`, { version: 1, from: 2 }),
      );
      should(current.status).equal(200);
      const retired = await dispatch.dispatch(call('PATCH', `${VERSIONS}/1`, { retired: true }));
      should(retired.status).equal(200);
      const back = await dispatch.dispatch(call('PATCH', `${VERSIONS}/3`, { retired: false }));
      should(back.status).equal(200);
      should(calls).deepEqual([
        `makeCurrent ["${ITEM}",{"version":1,"from":2}]`,
        `setRetired ["${ITEM}",1,true]`,
        `setRetired ["${ITEM}",3,false]`,
      ]);
      for (const [method, path, body] of [
        ['PUT', `/v1/catalog-items/${ITEM}/current`, { version: 1, from: 2 }],
        ['PATCH', `${VERSIONS}/1`, { retired: true }],
      ] as const) {
        const refused = await dispatch.dispatch(call(method, path, body, ferret));
        should(refused.status).equal(403);
        should(jsonBody(refused)).containEql({ code: 'owner_only' });
      }
      should(calls).have.length(3);
    });

    it('should refuse a bad make-current or retire request with nothing called', async () => {
      const { dispatch, calls } = stubbed();
      const current = (body: unknown) => call('PUT', `/v1/catalog-items/${ITEM}/current`, body);
      for (const body of [{}, { version: 1 }, { version: 0, from: 2 }, { version: 1, from: 2, extra: 1 }])
        should((await dispatch.dispatch(current(body))).status).be.within(400, 422);
      for (const body of [{}, { retired: 'yes' }, { retired: true, extra: 1 }])
        should((await dispatch.dispatch(call('PATCH', `${VERSIONS}/1`, body))).status).be.within(400, 422);
      const bad = await dispatch.dispatch(call('PATCH', `${VERSIONS}/x`, { retired: true }));
      should(bad.status).equal(404);
      should(jsonBody(bad)).containEql({ code: 'version_unknown' });
      should(
        (await dispatch.dispatch(call('PUT', '/v1/catalog-items/nope/current', { version: 1, from: 2 }))).status,
      ).equal(404);
      should(calls).deepEqual([]);
    });

    it('should refuse a bad body, a bad item id and a bad version with nothing called', async () => {
      const { dispatch, calls } = stubbed();
      should((await dispatch.dispatch(call('POST', VERSIONS, {}))).status).be.within(400, 422);
      should((await dispatch.dispatch(call('POST', VERSIONS, { digest: DIGEST, extra: 1 }))).status).be.within(
        400,
        422,
      );
      should((await dispatch.dispatch(call('POST', `${VERSIONS}/preview`, { source: 'x' }))).status).be.within(
        400,
        422,
      );
      const badItem = await dispatch.dispatch(call('GET', '/v1/catalog-items/nope'));
      should(badItem.status).equal(404);
      should(jsonBody(badItem)).containEql({ code: 'item_unknown' });
      for (const version of ['0', '-1', '1.5', 'x', '01', '99999999999']) {
        const bad = await dispatch.dispatch(call('GET', `${VERSIONS}/${version}`));
        should(bad.status).equal(404);
        should(jsonBody(bad)).containEql({ code: 'version_unknown' });
      }
      const query = (pairs: readonly (readonly [string, string])[]) =>
        call('GET', `/v1/catalog-items/${ITEM}/changes`, undefined, human, pairs);
      for (const pairs of [
        [],
        [['from', '1']],
        [['to', '1']],
        [
          ['from', 'a'],
          ['to', '2'],
        ],
      ] as const) {
        const bad = await dispatch.dispatch(query(pairs));
        should(bad.status).equal(404);
        should(jsonBody(bad)).containEql({ code: 'version_unknown' });
      }
      should(calls).deepEqual([]);
    });
  });

  it('should let a failure that is not a refusal through', async () => {
    const catalogs = {
      list: async () => {
        throw new Error('the store caught fire');
      },
    } as unknown as SharedCatalogSubsystem['catalogs'];
    const dispatch = new ApiDispatcher(new ApiRouter(sharedCatalogRoutes({ catalogs })), CREDENTIALS, GRANTED);
    const response = await dispatch.dispatch(call('GET', '/v1/catalogs'));
    should(response.status).equal(500);
  });

  it('should answer 404 for an id that is not one, before touching the store', async () => {
    const { dispatch, calls } = stubbed();
    const bad = await dispatch.dispatch(call('PATCH', '/v1/catalogs/nope', { name: 'x' }));
    should(bad.status).equal(404);
    should(jsonBody(bad)).containEql({ code: 'catalog_unknown' });
    const badItem = await dispatch.dispatch(call('DELETE', `/v1/catalogs/${CAT}/items/nope`));
    should(badItem.status).equal(404);
    should(jsonBody(badItem)).containEql({ code: 'item_unknown' });
    should(calls).deepEqual([]);
  });

  it('should refuse a body the contract does not accept', async () => {
    const { dispatch } = stubbed();
    const response = await dispatch.dispatch(call('POST', '/v1/catalogs', { name: '' }));
    should(response.status).be.within(400, 422);
  });

  it('should map every refusal to its status and keep its code', async () => {
    const expected: Record<CatalogRefusalCode, number> = {
      catalog_unknown: 404,
      item_unknown: 404,
      item_withdrawn: 409,
      name_taken: 409,
      catalog_full: 409,
      catalogs_full: 409,
      items_full: 409,
      item_listed: 409,
      current_changed: 409,
      public_unavailable: 400,
      source_unknown: 404,
      source_ambiguous: 409,
      source_refused: 422,
      changed_since_preview: 409,
      nothing_to_publish: 409,
      same_as_version: 409,
      version_unknown: 404,
      version_current: 409,
      version_retired: 409,
      version_before_join: 409,
      signing_unavailable: 503,
      store_damaged: 500,
      export_failed: 500,
      export_too_big: 413,
      undo_expired: 410,
    };
    for (const [code, status] of Object.entries(expected)) {
      const { dispatch } = stubbed(code as CatalogRefusalCode);
      const response = await dispatch.dispatch(call('POST', '/v1/catalogs', { name: 'Team' }));
      should(response.status).equal(status);
      should(jsonBody(response)).containEql({ code });
    }
  });
});

describe('the handlers’ own second line', () => {
  it('should still refuse a ferret’s own credential every write if the boundary ever let one through', async () => {
    // Arrange
    const catalogs = {} as SharedCatalogSubsystem['catalogs'];

    // Act
    const answer = await handleDirectly(sharedCatalogRoutes({ catalogs }), 'POST', '/v1/catalogs', undefined, {
      name: 'x',
    });

    // Assert
    should([answer.status, answer.code]).deepEqual([403, 'forbidden']);
    should(answer.message).match(/a ferret cannot make a catalog/u);
  });
});
