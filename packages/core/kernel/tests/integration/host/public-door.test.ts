import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { KernelPorts, PublicDoorHandle } from '../../../contract/ports.ts';
import { arrivedLocal, arrivedPrivileged, jsonResponse } from '../../../contract/http.ts';
import { bootHost } from '../../../host/host.ts';
import { realAdapters } from '../../../host/wiring.ts';
import { definePlugin, implementDaemon, route } from '../../../manifest/index.ts';
import { request } from '../../unit/host/fixtures.ts';

/** Real boot, real dispatcher/final check and real loopback HTTP. All values and homes are synthetic. */
test('a real kernel public listener is remote, isolated, live and closed with its plugin', async () => {
  const home = await mkdtemp(`${tmpdir()}/fy-u1-public-door-`);
  let kernel: KernelPorts | undefined;
  let available = true;
  const publicRoute = route('GET /oauth/authorize', {
    minimum: 'none',
    caller: 'any',
    door: 'public',
    available: () => available,
    audit: { skip: 'fixture' },
    guard: { none: 'fixture values only' },
  });
  const privateRoute = route('GET /v1/private', {
    minimum: 'none',
    caller: 'any',
    audit: { skip: 'fixture' },
    guard: { none: 'fixture' },
  });
  const plugin = implementDaemon(
    definePlugin({
      id: 'connector',
      title: 'Connector fixture',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      permissions: { publicDoor: true },
      actions: { routes: [publicRoute, privateRoute] },
    }),
    {
      build: context => {
        kernel = context.kernel;
        return {
          routes: {
            'GET /oauth/authorize': async call =>
              jsonResponse({
                arrival: call.request.arrival,
                local: arrivedLocal(call.request),
                privileged: arrivedPrivileged(call.request, true),
                address: call.request.clientAddress,
                hasPrincipal: call.request.principal !== undefined,
              }),
            'GET /v1/private': async () => jsonResponse({ private: true }),
          },
        };
      },
    },
  );
  const outcome = await bootHost({
    home,
    version: '5.0.0',
    implementations: [plugin],
    adapters: realAdapters(home, () => {}, { binary: 'fy' }),
  });
  if (outcome.kind !== 'running') throw new Error(outcome.sentence);
  let handle: PublicDoorHandle | undefined;
  try {
    if (kernel === undefined) throw new Error('connector was not built');
    // Every bound test port is in the assigned range. An occupied fixture port is never disturbed.
    for (let port = 7480; port <= 7499; port++) {
      try {
        handle = await kernel.publicDoor.open({ port, peer: headers => headers.get('cf-connecting-ip') ?? 'shared' });
        break;
      } catch (error) {
        if ((error as { code?: string }).code !== 'EADDRINUSE') throw error;
      }
    }
    if (handle === undefined) throw new Error('no test port free in 7480-7499');
    const base = `http://127.0.0.1:${String(handle.port)}`;
    const headers = {
      authorization: 'Bearer fixture-admin',
      host: 'localhost',
      'cf-connecting-ip': '203.0.113.8',
      'x-forwarded-for': '127.0.0.1',
    };
    const response = await fetch(`${base}/oauth/authorize`, { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      arrival: { kind: 'door', door: 'own', plugin: 'connector' },
      local: false,
      privileged: false,
      address: '203.0.113.8',
      hasPrincipal: false,
    });
    expect(response.headers.get('x-ferretry-version')).toBe('5.0.0');
    for (const path of ['/v1/private', '/v1/ferrets', '/healthz', '/metrics', '/missing'])
      expect((await fetch(`${base}${path}`, { headers })).status).toBe(404);
    expect((await fetch(`${base}/oauth/authorize`, { method: 'POST', headers })).status).toBe(404);
    expect((await fetch(`${base}/oauth/authorize`, { headers: { upgrade: 'websocket' } })).status).toBe(404);
    // With no Gate bound, ordinary API misses fail admission alike; a public claim reveals nothing there.
    expect((await outcome.host.dispatch(request('GET', '/oauth/authorize'))).status).toBe(
      (await outcome.host.dispatch(request('GET', '/unknown'))).status,
    );
    expect((await outcome.host.dispatch(request('GET', '/v1/private'))).status).toBe(200);
    available = false;
    expect((await fetch(`${base}/oauth/authorize`)).status).toBe(404);
    available = true;
    expect((await fetch(`${base}/oauth/authorize`)).status).toBe(200);
    const samePort = handle.port;
    await handle.close();
    handle = await kernel.publicDoor.open({ port: samePort });
    expect((await fetch(`${base}/oauth/authorize`)).status).toBe(200);
    await outcome.host.stop();
    await handle.close();
    await handle.close();
    await expect(fetch(`${base}/oauth/authorize`)).rejects.toThrow();
    await expect(kernel.publicDoor.open({ port: handle.port })).rejects.toThrow(/has stopped/);
  } finally {
    await handle?.close();
    await outcome.host.stop();
    await rm(home, { recursive: true, force: true });
  }
});
