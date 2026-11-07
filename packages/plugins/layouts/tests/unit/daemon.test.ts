import { describe, expect, test } from 'bun:test';
import type { ApiRequest, CallContext } from '@ferretry/kernel/contract';
import { device, ferret, testHost } from '@ferretry/kernel/testing';
import {
  COMPACT_LAYOUT,
  DEFAULT_LAYOUT,
  LAYOUT_CODES,
  LayoutListSchema,
  CurrentLayoutSchema,
} from '../../contract/index.ts';
import daemon from '../../daemon/index.ts';
import { layoutsRoutes } from '../../daemon/lib/routes.ts';
import { createLayoutsService } from '../../daemon/lib/service.ts';
import { configTree } from './support.ts';

/** A call as a handler sees it: a body and raw path parameters. */
const call = (body?: unknown, params: Record<string, string> = {}): CallContext =>
  ({
    request: { text: async () => JSON.stringify(body ?? {}) } as unknown as ApiRequest,
    params: new Map(Object.entries(params)),
  }) as CallContext;

const routes = (refuse?: string) => {
  const tree = configTree({}, refuse);
  return { tree, routes: layoutsRoutes(createLayoutsService(tree.port, tree.door)) };
};

const json = (response: { body: string }): any => JSON.parse(response.body);

describe('layouts routes', () => {
  test('GET /v1/layouts and /current answer the wire shapes', async () => {
    const { routes: r } = routes();
    expect(LayoutListSchema.safeParse(json(await r['GET /v1/layouts']())).success).toBe(true);
    expect(CurrentLayoutSchema.safeParse(json(await r['GET /v1/layouts/current']())).success).toBe(true);
  });

  test('GET /v1/layouts/:layoutId serves an installed layout and answers 404 for another, or a bad id', async () => {
    const { routes: r } = routes();
    const route = r['GET /v1/layouts/:layoutId'];
    expect(json(await route(call(undefined, { layoutId: 'compact' })))).toEqual(COMPACT_LAYOUT);
    const gone = await route(call(undefined, { layoutId: 'nope' }));
    expect([gone.status, json(gone).code]).toEqual([404, LAYOUT_CODES.unknown]);
    expect((await route(call(undefined, { layoutId: '..%2Fetc' }))).status).toBe(404);
  });

  test('PATCH /v1/layouts/current applies the change and answers the layout now in force', async () => {
    const { routes: r, tree } = routes();
    const response = await r['PATCH /v1/layouts/current'](call({ changes: [{ path: 'nav.side', value: 'right' }] }));
    expect(response.status).toBe(200);
    expect(json(response).current.nav.side).toBe('right');
    expect(tree.documents.get('layout.yaml')).toEqual({ overrides: { nav: { side: 'right' } } });
  });

  test('a change that cannot be a layout is 422 layout_invalid with the issues, and writes nothing', async () => {
    const { routes: r, tree } = routes();
    const response = await r['PATCH /v1/layouts/current'](call({ changes: [{ path: 'nav.side', value: 'diagonal' }] }));
    expect([response.status, json(response).code]).toEqual([422, LAYOUT_CODES.invalid]);
    expect(json(response).issues.length).toBeGreaterThan(0);
    expect(tree.calls).toEqual([]);
  });

  test('a body that is not JSON is 400 and one that is not a request is 422', async () => {
    const { routes: r } = routes();
    const notJson = { request: { text: async () => '{oops' }, params: new Map() } as unknown as CallContext;
    await expect(r['PATCH /v1/layouts/current'](notJson)).rejects.toMatchObject({ status: 400 });
    await expect(r['PATCH /v1/layouts/current'](call({ changes: [] }))).rejects.toMatchObject({ status: 422 });
    await expect(r['PUT /v1/layouts/current'](call({ layout: 'x', extra: true }))).rejects.toMatchObject({
      status: 422,
    });
  });

  test('PUT /v1/layouts/current switches; an unknown layout is 404', async () => {
    const { routes: r } = routes();
    const ok = await r['PUT /v1/layouts/current'](call({ layout: 'compact' }));
    expect(json(ok).current.id).toBe('compact');
    const gone = await r['PUT /v1/layouts/current'](call({ layout: 'nope' }));
    expect([gone.status, json(gone).code]).toEqual([404, LAYOUT_CODES.unknown]);
  });

  test('PUT /v1/layouts/theme switches; an unknown theme is 404 theme_unknown', async () => {
    const { routes: r } = routes();
    expect(json(await r['PUT /v1/layouts/theme'](call({ theme: 'default' }))).current.id).toBe('default');
    const gone = await r['PUT /v1/layouts/theme'](call({ theme: 'nope' }));
    expect([gone.status, json(gone).code]).toEqual([404, LAYOUT_CODES.themeUnknown]);
  });

  test('POST /v1/layouts/reset answers the default layout', async () => {
    const { routes: r } = routes();
    expect(json(await r['POST /v1/layouts/reset']()).current).toEqual(DEFAULT_LAYOUT);
  });

  test('POST /v1/layouts saves (201) and refuses a taken name (409 layout_exists)', async () => {
    const { routes: r } = routes();
    const saved = await r['POST /v1/layouts'](call({ id: 'mine' }));
    expect([saved.status, json(saved)]).toEqual([201, { id: 'mine', origin: 'saved' }]);
    const taken = await r['POST /v1/layouts'](call({ id: 'default' }));
    expect([taken.status, json(taken).code]).toEqual([409, LAYOUT_CODES.exists]);
  });

  test('DELETE /v1/layouts/:layoutId refuses a built-in (409), removes a saved one, 404 for an unknown or bad id', async () => {
    const { routes: r } = routes();
    await r['POST /v1/layouts'](call({ id: 'mine' }));
    const del = r['DELETE /v1/layouts/:layoutId'];
    expect(json(await del(call(undefined, { layoutId: 'mine' })))).toEqual({ id: 'mine', removed: true });
    const builtIn = await del(call(undefined, { layoutId: 'default' }));
    expect([builtIn.status, json(builtIn).code]).toEqual([409, LAYOUT_CODES.builtIn]);
    expect((await del(call(undefined, { layoutId: 'mine' }))).status).toBe(404);
    expect((await del(call(undefined, { layoutId: 'A..' }))).status).toBe(404);
  });

  test('a refusing config door is a 422, not a crash', async () => {
    const { routes: r } = routes('the file did not check');
    const response = await r['PUT /v1/layouts/current'](call({ layout: 'compact' }));
    expect([response.status, json(response).code]).toEqual([422, LAYOUT_CODES.invalid]);
  });
});

describe('layouts on the test host', () => {
  test('reads are served to any issued credential, from config', async () => {
    const host = await testHost({
      plugins: [daemon],
      config: { 'layout.yaml': { layout: 'compact' } },
    });
    const response = await host.request('GET', '/v1/layouts/current', { as: device('phone') });
    expect(response.status).toBe(200);
    expect(response.json<{ layout: { id: string } }>().layout.id).toBe('compact');
    await host.stop();
  });

  test('a write is a person act: a ferret is refused, and without a config door the owner is told why', async () => {
    const host = await testHost({ plugins: [daemon] });
    const refused = await host.request('PUT', '/v1/layouts/current', { body: { layout: 'compact' }, as: ferret('F1') });
    expect(refused.status).toBe(403);
    const unavailable = await host.request('PUT', '/v1/layouts/current', { body: { layout: 'compact' } });
    expect([unavailable.status, unavailable.json<{ code: string }>().code]).toEqual([503, LAYOUT_CODES.noConfigDoor]);
    await host.stop();
  });

  test('any change to the layout files, ours or a hand edit, tells every open app once per change', async () => {
    const host = await testHost({ plugins: [daemon] });
    host.setConfig('layout.yaml', { layout: 'compact' });
    host.setConfig('themes', { dusk: { id: 'dusk', label: 'Dusk', base: 'neo' } });
    await host.settle();
    expect(host.published.map(event => [event.event, event.payload])).toEqual([
      ['layouts.changed', { layout: 'compact' }],
      ['layouts.changed', { layout: 'compact' }],
    ]);
    await host.stop();
  });

  test('the read model other plugins call returns the same current layout', async () => {
    const host = await testHost({ plugins: [daemon] });
    const { LayoutsPort } = await import('../../contract/index.ts');
    expect((await host.provided(LayoutsPort).current()).layout).toEqual(DEFAULT_LAYOUT);
    await host.stop();
  });
});
