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
    expect((await hidden.dispatch(request('GET', publicRoute.path))).status).toBe(404);
    expect(
      (
        await hidden.dispatch({
          ...request('GET', publicRoute.path, { local: false }),
          principal: { kind: 'member' } as never,
        })
      ).status,
    ).toBe(404);
  });
  test('a private route cannot shadow a door route with the same path', async () => {
    const dispatcher = table(mounted(publicRoute.path, 'kernel'), publicRoute);
    expect((await dispatcher.dispatch({ ...request('GET', publicRoute.path), arrival: door() })).status).toBe(200);
  });
});
