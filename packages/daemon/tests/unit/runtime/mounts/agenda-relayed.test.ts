import { describe, it } from 'bun:test';
import { LIMITED_DEVICE_GRANTS, type CapabilityGrants } from '@ferretry/protocol';
import should from 'should';
import { ApiDispatcher, ApiRouter, type ApiRoute, type SessionDevice } from '../../../../src/lib/api/index.ts';
import { DEFAULT_CAPABILITY_GRANTS } from '../../../../src/lib/grants/index.ts';
import { agendaRoutes } from '../../../../src/lib/runtime/mounts/agenda.ts';
import { wardenRoutes } from '../../../../src/lib/runtime/mounts/warden.ts';
import { request } from '../../api/support.ts';
import { agendaService, CREDENTIALS, FakeWarden, grantSubsystem, NO_HELD_REPLIES } from './support.ts';

/**
 * THE AGENDA ROUTES MET BY A CALLER ON THE RELAY: the dispatcher over the real grant guard, for the caller
 * this surface exists to protect — one that arrives over the relay (decided from the carrier, never a peer
 * address), where a mismatch would let a remote phone through a door that should stay shut.
 */

const noNotifications = { enrolledDevices: async () => 0 };

const routes: readonly ApiRoute[] = [
  ...agendaRoutes(agendaService(), noNotifications, NO_HELD_REPLIES),
  ...wardenRoutes(new FakeWarden()),
];

const find = (method: string, path: string): ApiRoute => {
  const found = routes.find(route => route.method === method && route.path === path);
  if (found === undefined) throw new Error(`no route ${method} ${path} is mounted`);
  return found;
};

const AGENDA_ROUTES = [
  ['GET', '/v1/sessions/:sessionId/agenda'],
  ['POST', '/v1/sessions/:sessionId/agenda'],
  ['POST', '/v1/sessions/:sessionId/agenda/replies'],
  ['GET', '/v1/warden/agenda'],
] as const;

const PHONE: SessionDevice = { deviceId: 'device-phone', appSession: 'app-one' };

/** The real dispatcher over the real grant guard, for a device holding exactly `deviceGrants`. */
async function relayedDispatcher(deviceGrants: CapabilityGrants): Promise<ApiDispatcher> {
  const guard = grantSubsystem();
  await guard.refresh();
  return new ApiDispatcher(
    new ApiRouter(routes),
    { ...CREDENTIALS, devices: { has: () => true, grants: () => deviceGrants } },
    guard,
  );
}

const WITHOUT_WARDEN: CapabilityGrants = {
  ...DEFAULT_CAPABILITY_GRANTS,
  warden: { use: false, configure: false },
};

const concrete = (path: string): string => path.replace(':sessionId', 's1');

describe('a relayed caller meeting the agenda routes', () => {
  it('should refuse a relayed device without the warden grant on the warden agenda', async () => {
    // Arrange
    const dispatcher = await relayedDispatcher(WITHOUT_WARDEN);

    // Act
    const refused = await dispatcher.dispatch(
      request({ method: 'GET', path: '/v1/warden/agenda', loopback: false, device: PHONE }),
    );

    // Assert
    should(refused.status).equal(403);
  });

  it('should serve a relayed device holding the warden grant the warden agenda', async () => {
    // Arrange
    const dispatcher = await relayedDispatcher(DEFAULT_CAPABILITY_GRANTS);

    // Act
    const served = await dispatcher.dispatch(
      request({ method: 'GET', path: '/v1/warden/agenda', loopback: false, device: PHONE }),
    );

    // Assert
    should(served.status).equal(200);
  });

  it('should refuse an unauthenticated relayed caller on every route', async () => {
    // Arrange
    const dispatcher = await relayedDispatcher(DEFAULT_CAPABILITY_GRANTS);

    // Act / Assert
    for (const [method, path] of AGENDA_ROUTES) {
      const response = await dispatcher.dispatch(request({ method, path: concrete(path), loopback: false }));
      should(response.status).equal(401);
    }
  });
});

it('keeps conversation reads operator-only on relayed loopback and admits a governed person without host privilege', async () => {
  // Arrange
  const dispatcher = await relayedDispatcher(LIMITED_DEVICE_GRANTS);
  const path = '/v1/sessions/s1/agenda/A1/conversation';
  const route = find('GET', '/v1/sessions/:sessionId/agenda/:id/conversation');

  // Act
  const anonymous = await dispatcher.dispatch(request({ path, loopback: true, carrier: 'tunnel' }));
  const phone = await dispatcher.dispatch(request({ path, loopback: true, carrier: 'tunnel', device: PHONE }));

  // Assert
  should(route.minimum).equal('operator');
  should(route.caller).equal('any');
  should(route.privilegedOnly).be.undefined();
  should(anonymous.status).equal(401);
  should(phone.status).equal(404); // admitted; this session has no such item
});
