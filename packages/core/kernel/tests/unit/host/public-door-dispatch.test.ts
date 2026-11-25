import { describe, expect, test } from 'bun:test';
import { jsonResponse } from '../../../contract/http.ts';
import type { PluginId } from '../../../contract/ids.ts';
import type { Arrival } from '../../../contract/session.ts';
import { Dispatcher, type MountedRoute } from '../../../host/dispatch.ts';
import { recordingAdmission, request } from './fixtures.ts';

const door = (plugin = 'connector'): Arrival => ({ kind: 'door', door: 'own', plugin: plugin as PluginId });
const mounted = (path: string, plugin: string, isDoor = false): MountedRoute => ({
  method: 'GET',
  path,
  minimum: 'none',
  caller: 'any',
  ...(isDoor ? { door: 'public' as const } : {}),
  audit: { skip: 'fixture' },
  guard: { none: 'fixture' },
  owner: { plugin: plugin as PluginId, title: plugin, serving: () => ({ kind: 'serving' }) },
  handle: async () => jsonResponse({ ok: true }),
});
const publicRoute = mounted('/oauth/authorize', 'connector', true);
const table = (...routes: MountedRoute[]) =>
  new Dispatcher(
    { admission: () => recordingAdmission(), outputGuard: () => undefined, version: '5.0.0' },
    { routes, sockets: [], memberRoutes: [] },
  );

describe('public door routing is isolated from every API arrival', () => {
  test('door route is 404 on local API and carried direct, relay, tunnel and webrtc sessions', async () => {
    const dispatcher = table(publicRoute);
    for (const arrival of [
      request('GET', '/').arrival,
      ...['direct', 'relay', 'tunnel', 'webrtc'].map(carrier => ({ kind: 'carried', carrier }) as Arrival),
    ]) {
      for (const method of ['GET', 'POST'])
        expect((await dispatcher.dispatch({ ...request(method, publicRoute.path), arrival })).status).toBe(404);
    }
  });
  test('door cannot reach a normal route, public health, another plugin, or a method map', async () => {
    const dispatcher = table(
      publicRoute,
      mounted('/v1/ferrets', 'ferrets'),
      mounted('/healthz', 'kernel'),
      mounted('/foreign', 'other', true),
    );
    for (const path of ['/v1/ferrets', '/healthz', '/metrics', '/unknown', '/foreign'])
      for (const method of ['GET', 'POST'])
        expect((await dispatcher.dispatch({ ...request(method, path), arrival: door() })).status).toBe(404);
    expect((await dispatcher.dispatch({ ...request('POST', publicRoute.path), arrival: door() })).status).toBe(404);
    expect((await dispatcher.dispatch({ ...request('GET', publicRoute.path), arrival: door('other') })).status).toBe(
      404,
    );
  });
  test('own and tunnel doors serve only allow-listed public routes; unavailable routes disappear', async () => {
    const dispatcher = table(publicRoute, mounted('/foreign', 'other', true));
    for (const arrival of [door(), { kind: 'door', door: 'tunnel' } as Arrival]) {
      expect((await dispatcher.dispatch({ ...request('GET', publicRoute.path), arrival })).status).toBe(200);
      expect((await dispatcher.dispatch({ ...request('GET', '/foreign'), arrival })).status).toBe(404);
    }
    expect(
      (
        await table({ ...publicRoute, available: () => false }).dispatch({
          ...request('GET', publicRoute.path),
          arrival: door(),
        })
      ).status,
    ).toBe(404);
    const hidden = new Dispatcher(
      { admission: () => recordingAdmission(() => false), outputGuard: () => undefined, version: '5.0.0' },
      { routes: [{ ...publicRoute, available: () => false }], sockets: [], memberRoutes: [] },
    );
    expect((await hidden.dispatch(request('GET', publicRoute.path))).status).toBe(401);
    expect(
      (
        await hidden.dispatch({
          ...request('GET', publicRoute.path, { local: false }),
          principal: { kind: 'member' } as never,
        })
      ).status,
    ).toBe(403);
  });
  test('a private route cannot shadow a door route with the same path', async () => {
    const dispatcher = table(mounted(publicRoute.path, 'kernel'), publicRoute);
    expect((await dispatcher.dispatch({ ...request('GET', publicRoute.path), arrival: door() })).status).toBe(200);
  });
  test('door matching is literal and method-exact', async () => {
    for (const arrival of [door(), { kind: 'door', door: 'tunnel' } as Arrival]) {
      for (const path of ['/oauth/authorize/', '/oauth//authorize', '/oauth/../oauth/authorize', '/oauth/%61uthorize'])
        expect((await table(publicRoute).dispatch({ ...request('GET', path), arrival })).status, path).toBe(404);
      expect((await table(publicRoute).dispatch({ ...request('get', publicRoute.path), arrival })).status).toBe(404);
    }
  });
  test('stopped, failed, damaged or unbuilt plugins disappear on both doors', async () => {
    for (const arrival of [door(), { kind: 'door', door: 'tunnel' } as Arrival]) {
      for (const kind of ['skeleton', 'failed', 'damaged'] as const) {
        const stopped = { ...publicRoute, owner: { ...publicRoute.owner, serving: () => ({ kind, files: [] }) } };
        expect((await table(stopped).dispatch({ ...request('GET', publicRoute.path), arrival })).status, kind).toBe(
          404,
        );
      }
      expect(
        (await table({ ...publicRoute, handle: undefined }).dispatch({ ...request('GET', publicRoute.path), arrival }))
          .status,
      ).toBe(404);
    }
  });
  test('unauthenticated API misses do not disclose public path claims', async () => {
    const hidden = new Dispatcher(
      { admission: () => recordingAdmission(() => false), outputGuard: () => undefined, version: '5.0.0' },
      { routes: [publicRoute], sockets: [], memberRoutes: [] },
    );
    for (const method of ['GET', 'POST']) {
      const known = await hidden.dispatch(request(method, publicRoute.path));
      const unknown = await hidden.dispatch(request(method, '/unknown'));
      expect(known.status).toBe(unknown.status);
      expect(known.status).toBe(401);
    }
  });
});
