/**
 * What the built-in tunnel serves besides its session socket: the connector's public door paths, END TO END.
 *
 * Everything on the path is production code: Connections' real composition (`composeOtherConnections`) decides what
 * the tunnel listener's surface is, the kernel's real carrier listener serves it on loopback, and the kernel's real
 * `Dispatcher` answers. The only stand-ins are the Cloudflare side (the test fetches as `cloudflared` would, with
 * `CF-Connecting-IP`), the admission (it records what it was asked) and the door route itself: the connector plugin is
 * not merged yet, so a test-only `connector` fixture declares two public routes.
 */
import { afterEach, expect, test } from 'bun:test';
import { type CallStanding, type CarrierListenerPort, jsonResponse } from '@ferretry/kernel/contract';
import { route } from '@ferretry/kernel/manifest';
import { implementDaemon } from '@ferretry/kernel/manifest';
import { carrierListenerPort } from '../../../../../core/kernel/host/carrier-listener.ts';
import { Dispatcher, type MountedRoute } from '../../../../../core/kernel/host/dispatch.ts';
import { testHost } from '../../../../../core/kernel/testing/host.ts';
import { buildConnections, kernelConnectionBindings } from '../../../daemon/index.ts';
import manifest from '../../../manifest.ts';
import { FakeSessions } from '../../support/sessions.ts';
import type { Carrier } from '@ferretry/kernel/contract';

const fixture = {
  door: 'public',
  minimum: 'none',
  caller: 'any',
  audit: { skip: 'fixture' },
  guard: { none: 'fixture' },
} as const;
const authorize = route('GET /oauth/authorize', fixture);
const mcp = route('POST /mcp', fixture);

const closers: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

/** Connections' composed tunnel opens ITS listener on the kernel's real carrier listener, bound to the fixture. */
async function tunnel(serving: () => boolean) {
  // Admission admits every arrival (the door is credential-less) and records each question it was asked.
  const asked: string[] = [];
  const admission = {
    admit: (input: { readonly descriptor: { readonly method: string; readonly path: string } }) => {
      asked.push(`${input.descriptor.method} ${input.descriptor.path}`);
      return { outcome: 'admitted', standing: {} as unknown as CallStanding, actor: 'owner-tools' } as const;
    },
    admitMember: () => {
      throw new Error('no member call');
    },
    readmit: () => true,
    inventory: (_request: unknown, entries: readonly unknown[]) => entries,
  };
  const seen: string[] = [];
  const owner: MountedRoute['owner'] = {
    plugin: 'connector' as never,
    title: 'Connector',
    serving: () => ({ kind: serving() ? 'serving' : 'skeleton' }),
  };
  const dispatcher = new Dispatcher(
    { admission: () => admission as never, outputGuard: () => undefined, version: '5.0.0' },
    {
      routes: [authorize, mcp].map(declared => ({
        ...declared,
        owner,
        handle: async call => {
          seen.push(`${declared.method} ${declared.path} from ${String(call.request.clientAddress)}`);
          return jsonResponse({ ok: true });
        },
      })),
      sockets: [],
      memberRoutes: [],
    },
  );
  const listeners: Awaited<ReturnType<CarrierListenerPort['open']>>[] = [];
  const carrierListener: CarrierListenerPort = {
    open: async input => {
      // The kernel binds :0; every fixture bind stays inside the test range 7480-7499.
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
      try {
        const handle = await carrierListenerPort({
          manifest: manifest as never,
          dispatcher: () => dispatcher,
          daemonId: 'fy_daemon_door_fixture',
          onStop: () => {},
          stopping: () => false,
        }).open(input);
        listeners.push(handle);
        return handle;
      } finally {
        (Bun as { serve: unknown }).serve = serve;
      }
    },
  };
  let half: ReturnType<typeof buildConnections> | undefined;
  const plugin = implementDaemon(manifest, {
    build: ctx =>
      (half = buildConnections(ctx, kernelConnectionBindings(ctx.kernel), undefined, {
        cloudflared: { locate: () => ({ kind: 'found', path: '/bin/cloudflared', via: 'path' }) },
      })),
  });
  const host = await testHost({
    plugins: [plugin],
    spawn: () => {
      throw new Error('no real child in a door test');
    },
    fetch: url =>
      url.pathname === '/v1/tunnel-service'
        ? Response.json({ version: 1, available: true })
        : new Response('{}', { status: 503 }), // provisioning is retried later: the listener stays open
    carrierListener,
    config: { 'connections.yaml': { tunnel: { enabled: true } } },
  });
  const controller = new AbortController();
  await (half!.hooks['carriers:tunnel'] as Carrier).start(new FakeSessions(), controller.signal);
  await host.clock.advance(1);
  await Bun.sleep(20);
  closers.push(async () => {
    controller.abort();
    await host.stop();
    for (const listener of listeners) await listener.close();
  });
  const listener = listeners[0];
  if (listener === undefined) throw new Error('the composed tunnel opened no listener');
  return { origin: `http://127.0.0.1:${String(listener.port)}`, seen, asked };
}

const EDGE = { 'cf-connecting-ip': '203.0.113.9' };

test('the composed tunnel serves the connector door paths, keyed by the address the edge saw', async () => {
  const world = await tunnel(() => true);
  const got = await fetch(`${world.origin}/oauth/authorize`, { headers: EDGE });
  expect(got.status).toBe(200);
  const posted = await fetch(`${world.origin}/mcp`, { method: 'POST', headers: EDGE, body: '{}' });
  expect(posted.status).toBe(200);
  expect(world.seen).toEqual(['GET /oauth/authorize from 203.0.113.9', 'POST /mcp from 203.0.113.9']);
});

test('an arrival with no edge address shares one bucket rather than escaping one', async () => {
  const world = await tunnel(() => true);
  await fetch(`${world.origin}/oauth/authorize`);
  await fetch(`${world.origin}/oauth/authorize`, { headers: { 'cf-connecting-ip': 'not an address' } });
  expect(world.seen).toEqual(['GET /oauth/authorize from tunnel', 'GET /oauth/authorize from tunnel']);
});

test('the door paths are 404 while the connector is off', async () => {
  let on = true;
  const world = await tunnel(() => on);
  expect((await fetch(`${world.origin}/oauth/authorize`, { headers: EDGE })).status).toBe(200);
  on = false;
  expect((await fetch(`${world.origin}/oauth/authorize`, { headers: EDGE })).status).toBe(404);
  expect((await fetch(`${world.origin}/mcp`, { method: 'POST', headers: EDGE, body: '{}' })).status).toBe(404);
});

test('nothing else of the daemon is reachable through the tunnel, whatever credential it carries', async () => {
  const world = await tunnel(() => true);
  for (const authorization of [undefined, 'Bearer fake-admin-token', 'Bearer fyc_at_fake', 'Bearer fys_fake'])
    for (const path of ['/v1/ferrets', '/v1/connector', '/healthz', '/metrics', '/nothing/here', '/oauth/other']) {
      const answer = await fetch(`${world.origin}${path}`, {
        headers: { ...EDGE, ...(authorization === undefined ? {} : { authorization }) },
      });
      expect(answer.status, `${authorization ?? 'no credential'} ${path}`).toBe(404);
    }
  // A wrong method on a door path is a 404 too, never a 405 that maps the door.
  expect((await fetch(`${world.origin}/mcp`, { method: 'DELETE', headers: EDGE })).status).toBe(404);
  expect(world.seen).toEqual([]);
});

test('a door arrival is anonymous to admission, however it is dressed', async () => {
  const world = await tunnel(() => true);
  await fetch(`${world.origin}/oauth/authorize`, { headers: { ...EDGE, authorization: 'Bearer fake-admin-token' } });
  expect(world.seen).toHaveLength(1);
});
