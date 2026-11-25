import { expect, test } from 'bun:test';
import { connect } from 'node:net';
import { Carriers } from '../../../contract/kernel.ts';
import { jsonResponse } from '../../../contract/http.ts';
import type { CarrierListenerHandle, PublicDoorHandle } from '../../../contract/ports.ts';
import { definePlugin, route, socket } from '../../../manifest/index.ts';
import { Dispatcher, type MountedRoute } from '../../../host/dispatch.ts';
import { carrierListenerPort } from '../../../host/carrier-listener.ts';
import { publicDoorPort } from '../../../host/public-door.ts';
import { recordingAdmission } from '../../unit/host/fixtures.ts';

/** Write the actual HTTP target: fetch/URL would resolve dot segments before the listener ever sees them. */
function rawStatus(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    let text = '';
    const client = connect({ host: '127.0.0.1', port }, () => {
      client.write(`GET ${path} HTTP/1.1\r\nHost: fixture.example\r\nConnection: close\r\n\r\n`);
    });
    client.setTimeout(2000, () => client.destroy(new Error('HTTP fixture timed out')));
    client.on('error', reject);
    client.on('data', data => {
      text += data.toString();
    });
    client.on('end', () => resolve(Number(text.split(' ')[1])));
  });
}

const publicRoute = route('GET /oauth/authorize', {
  door: 'public',
  minimum: 'none',
  caller: 'any',
  audit: { skip: 'fixture' },
  guard: { none: 'fixture' },
});
const mcp = route('POST /mcp', {
  door: 'public',
  minimum: 'none',
  caller: 'any',
  audit: { skip: 'fixture' },
  guard: { none: 'fixture' },
});
const connector = definePlugin({
  id: 'connector',
  title: 'Connector fixture',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: [],
  permissions: { publicDoor: true },
  actions: { routes: [publicRoute, mcp] },
});
const session = socket('GET /v1/rendezvous/:daemonId/client', {
  minimum: 'none',
  caller: 'any',
  audit: { skip: 'fixture' },
  guard: { none: 'fixture' },
});
const carrier = definePlugin({
  id: 'carrierfix',
  title: 'Tunnel fixture',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['carrier'],
  hooks: { takes: [{ hook: Carriers, key: 'tunnel' }] },
  actions: { sockets: [session] },
});

async function listen(kind: 'own' | 'tunnel') {
  let serving = true;
  const owner: MountedRoute['owner'] = {
    plugin: 'connector' as never,
    title: 'Connector',
    serving: () => ({ kind: serving ? 'serving' : 'skeleton' }),
  };
  const dispatcher = new Dispatcher(
    { admission: () => recordingAdmission(), outputGuard: () => undefined, version: '5.0.0' },
    {
      routes: [
        { ...publicRoute, owner, handle: async () => jsonResponse({ ok: true }) },
        { ...mcp, owner, handle: async call => jsonResponse({ bytes: (await call.request.text()).length }) },
      ],
      sockets: [],
      memberRoutes: [],
    },
  );
  const deps = { dispatcher: () => dispatcher, onStop: () => {}, stopping: () => false };
  // The carrier port normally asks for :0. Keep every fixture bind within its assigned test range.
  const serve = Bun.serve;
  (Bun as { serve: unknown }).serve = (options: Record<string, unknown>) => {
    for (let port = 7480; port <= 7499; port++) {
      try {
        return serve({ ...options, port } as never);
      } catch (error) {
        if ((error as { code?: string }).code !== 'EADDRINUSE') throw error;
      }
    }
    throw new Error('no fixture port available');
  };
  let handle: PublicDoorHandle | CarrierListenerHandle;
  try {
    handle =
      kind === 'own'
        ? await publicDoorPort({ ...deps, manifest: connector }).open({ port: 7480 })
        : await carrierListenerPort({ ...deps, manifest: carrier, daemonId: 'fixture' }).open({
            carrier: 'tunnel' as never,
            surface: { socket: session.key, doors: true },
          });
  } finally {
    (Bun as { serve: unknown }).serve = serve;
  }
  return {
    handle,
    off: () => {
      serving = false;
    },
  };
}

for (const kind of ['own', 'tunnel'] as const) {
  test(`${kind} door matches the literal HTTP target without normalizing traversal or trailing slashes`, async () => {
    const { handle } = await listen(kind);
    try {
      expect(await rawStatus(handle.port, '/oauth/authorize?fixture=1')).toBe(200);
      for (const path of [
        '/oauth/authorize/',
        '/oauth//authorize',
        '/OAUTH/authorize',
        '/oauth/%61uthorize',
        '/ignored/../oauth/authorize',
        '/ignored/%2e%2e/oauth/authorize',
        '/ignored/.%2e/oauth/authorize',
        '/oauth/./authorize',
        '/oauth/%2E/authorize',
      ])
        expect(await rawStatus(handle.port, path), path).toBe(404);
    } finally {
      await handle.close();
    }
  });
  test(`${kind} door caps request bodies at 1 MiB and hides a stopped connector`, async () => {
    const { handle, off } = await listen(kind);
    const base = `http://127.0.0.1:${handle.port}`;
    try {
      const valid = await fetch(`${base}/mcp`, { method: 'POST', body: 'x'.repeat(1024 * 1024) });
      expect(valid.status).toBe(200);
      expect(await valid.json()).toEqual({ bytes: 1024 * 1024 });
      expect((await fetch(`${base}/mcp`, { method: 'POST', body: 'x'.repeat(1024 * 1024 + 1) })).status).toBe(413);
      off();
      expect((await fetch(`${base}/oauth/authorize`)).status).toBe(404);
    } finally {
      await handle.close();
    }
  });
}
