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
import { agentIn, CREDENTIALS, GRANTED, human } from './support.ts';

const CAT = `cat_${'A'.repeat(22)}`;
const ITEM = `itm_${'B'.repeat(22)}`;
const DIGEST = `sha256:${'c'.repeat(64)}`;

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
    create: act('create'),
    update: act('update'),
    remove: act('remove'),
    previewItem: act('previewItem'),
    addItem: act('addItem'),
    publishVersion: act('publishVersion'),
    withdraw: act('withdraw'),
    exportCatalog: act('exportCatalog'),
  } as unknown as SharedCatalogSubsystem['catalogs'];
  const dispatch = new ApiDispatcher(new ApiRouter(sharedCatalogRoutes({ catalogs })), CREDENTIALS, GRANTED);
  return { calls, dispatch };
}

const call = (method: string, path: string, body?: unknown, headers: Readonly<Record<string, string>> = human) =>
  request({
    method,
    path,
    headers: { ...headers, 'content-type': 'application/json' },
    body: body === undefined ? '' : JSON.stringify(body),
    loopback: true,
  });

const WRITES: readonly (readonly [string, string, unknown])[] = [
  ['POST', '/v1/catalogs', { name: 'Team' }],
  ['PATCH', `/v1/catalogs/${CAT}`, { name: 'New' }],
  ['DELETE', `/v1/catalogs/${CAT}`, undefined],
  ['POST', `/v1/catalogs/${CAT}/items`, { source: { kind: 'skill', skill: 'demo' }, digest: DIGEST }],
  ['POST', `/v1/catalogs/${CAT}/items/${ITEM}/versions`, { digest: DIGEST }],
  ['DELETE', `/v1/catalogs/${CAT}/items/${ITEM}`, undefined],
  ['POST', `/v1/catalogs/${CAT}/export`, {}],
];

describe('the shared catalogs routes', () => {
  it('should serve nine routes, all behind sharing/use', () => {
    const routes = sharedCatalogRoutes(stubbed().dispatch as never as SharedCatalogSubsystem);
    should(routes.map(route => `${route.method} ${route.path}`)).deepEqual([
      'GET /v1/catalogs',
      'POST /v1/catalogs',
      'PATCH /v1/catalogs/:id',
      'DELETE /v1/catalogs/:id',
      'POST /v1/catalogs/:id/items/preview',
      'POST /v1/catalogs/:id/items',
      'POST /v1/catalogs/:id/items/:itemId/versions',
      'DELETE /v1/catalogs/:id/items/:itemId',
      'POST /v1/catalogs/:id/export',
    ]);
    for (const route of routes) should(route.capability).deepEqual({ capability: 'sharing', axis: 'use' });
  });

  it('should let the owner do every one, with 201 for what makes something', async () => {
    const { dispatch, calls } = stubbed();
    const statuses: number[] = [];
    for (const [method, path, body] of WRITES)
      statuses.push((await dispatch.dispatch(call(method, path, body))).status);
    should(statuses).deepEqual([201, 200, 200, 201, 201, 200, 200]);
    const listed = await dispatch.dispatch(call('GET', '/v1/catalogs'));
    should(listed.status).equal(200);
    const previewed = await dispatch.dispatch(
      call('POST', `/v1/catalogs/${CAT}/items/preview`, { source: { kind: 'mcp', mcp: 'files' } }),
    );
    should(previewed.status).equal(200);
    should(calls).have.length(9);
  });

  it('should let a ferret list and preview, and refuse every other call with 403 forbidden', async () => {
    const { dispatch, calls } = stubbed();
    const ferret = agentIn('session-1');
    for (const [method, path, body] of WRITES) {
      const refused = await dispatch.dispatch(call(method, path, body, ferret));
      should(refused.status).equal(403);
      should(jsonBody(refused)).containEql({ code: 'forbidden' });
    }
    should(calls).deepEqual([]);
    should((await dispatch.dispatch(call('GET', '/v1/catalogs', undefined, ferret))).status).equal(200);
    const preview = await dispatch.dispatch(
      call('POST', `/v1/catalogs/${CAT}/items/preview`, { itemId: ITEM }, ferret),
    );
    should(preview.status).equal(200);
    should(calls).have.length(2);
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
      public_unavailable: 400,
      source_unknown: 404,
      source_ambiguous: 409,
      source_refused: 422,
      changed_since_preview: 409,
      nothing_to_publish: 409,
      signing_unavailable: 503,
      store_damaged: 500,
      export_failed: 500,
    };
    for (const [code, status] of Object.entries(expected)) {
      const { dispatch } = stubbed(code as CatalogRefusalCode);
      const response = await dispatch.dispatch(call('POST', '/v1/catalogs', { name: 'Team' }));
      should(response.status).equal(status);
      should(jsonBody(response)).containEql({ code });
    }
  });
});
