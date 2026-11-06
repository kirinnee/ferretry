import { describe, expect, it } from 'bun:test';
import type { ScopedRoute } from '../../../src/lib/api/route.ts';
import {
  createMountedSocketDispatcher,
  mountedDaemonRoutes,
  mountedSocketRoutes,
} from '../../../src/lib/runtime/mounts/index.ts';
import { request } from '../api/support.ts';
import { surfaceCarrier } from './mounts/surface-carrier.ts';
import { base, subsystems } from './mounts/surface-world.ts';
import snapshot from './mounted-surface.snapshot.json';

const canonical = (routes: readonly ScopedRoute[]) =>
  routes.map(route => `${route.method} ${route.path} ${route.minimum} ${route.caller}`).sort();

describe('canonical mounted route snapshot', () => {
  it('preserves the pre-module HTTP and socket contracts, including all carrier outcomes', () => {
    const mounted = subsystems();
    const sockets = canonical(mountedSocketRoutes(mounted));
    expect({
      http: canonical(mountedDaemonRoutes(base, mounted)),
      sockets,
      carrierPresent: canonical([...mountedSocketRoutes(mounted), surfaceCarrier()]),
      // A failed identity load returns a refusal with no route, exactly like an absent carrier.
      carrierRefused: sockets,
      carrierAbsent: sockets,
    }).toEqual(snapshot);
  });
  it('serves a present carrier, preserves its admission refusal, and leaves an absent one unclaimed', async () => {
    const mounted = subsystems();
    const carrier = surfaceCarrier();
    const dispatcher = createMountedSocketDispatcher(base, mounted, [carrier]);
    expect((await dispatcher.upgrade(request({ path: '/v1/rendezvous/snapshot-daemon/client' }))).outcome).toBe(
      'accepted',
    );
    const refused = await dispatcher.upgrade(request({ path: '/v1/rendezvous/wrong-daemon/client' }));
    expect(refused.outcome).toBe('refused');
    if (refused.outcome === 'refused') expect(refused.response.status).toBe(404);
    const absent = createMountedSocketDispatcher(base, mounted);
    expect(
      await absent.upgrade(
        request({
          path: '/v1/rendezvous/snapshot-daemon/client',
          headers: { authorization: `Bearer ${base.credentials.admin}` },
        }),
      ),
    ).toEqual({ outcome: 'unclaimed' });
  });
});
