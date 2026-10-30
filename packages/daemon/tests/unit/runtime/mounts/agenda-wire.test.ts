import { describe, it } from 'bun:test';
import { DAEMON_FEATURES, LIMITED_DEVICE_GRANTS, type CapabilityGrants } from '@ferretry/protocol';
import should from 'should';
import { ApiDispatcher, ApiRouter, type ApiRoute, type SessionDevice } from '../../../../src/lib/api/index.ts';
import { DEFAULT_CAPABILITY_GRANTS } from '../../../../src/lib/grants/index.ts';
import { agendaRoutes } from '../../../../src/lib/runtime/mounts/agenda.ts';
import { wardenRoutes } from '../../../../src/lib/runtime/mounts/warden.ts';
import { request } from '../../api/support.ts';
import { agendaService, CREDENTIALS, FakeWarden, grantSubsystem, human, NO_HELD_REPLIES } from './support.ts';

/**
 * THE AGENDA WIRE (`agenda.wire.1`), server side: every new route is the old one under a new name.
 *
 * Two halves, because they prove different things. The route table proves the grants were COPIED —
 * `minimum`, `capability`, `noStore`, `wardenRemedy` and the very same handler. The dispatcher half
 * proves they are ENFORCED the same way for the caller this surface exists to protect: one that
 * arrives over the relay (decided from the carrier, never a peer address), where a mismatch would
 * let a remote phone through a door its old spelling kept shut.
 */

const noNotifications = { enrolledDevices: async () => 0, agendaDelivered: async () => 0 };

const routes: readonly ApiRoute[] = [
  ...agendaRoutes(agendaService(), noNotifications, NO_HELD_REPLIES),
  ...wardenRoutes(new FakeWarden()),
];

const find = (method: string, path: string): ApiRoute => {
  const found = routes.find(route => route.method === method && route.path === path);
  if (found === undefined) throw new Error(`no route ${method} ${path} is mounted`);
  return found;
};

const PAIRS = [
  ['GET', '/v1/sessions/:sessionId/agenda', '/v1/sessions/:sessionId/attention'],
  ['POST', '/v1/sessions/:sessionId/agenda', '/v1/sessions/:sessionId/attention'],
  ['POST', '/v1/sessions/:sessionId/agenda/replies', '/v1/sessions/:sessionId/attention/replies'],
  ['GET', '/v1/warden/agenda', '/v1/warden/attention'],
] as const;

describe('the agenda routes beside their attention twins', () => {
  for (const [method, next, old] of PAIRS) {
    it(`should declare ${method} ${next} with exactly the grants of ${old}`, () => {
      // Arrange
      const added = find(method, next);
      const kept = find(method, old);

      // Act / Assert
      should(added.minimum).equal(kept.minimum);
      should(added.capability).deepEqual(kept.capability);
      should(added.noStore).equal(kept.noStore);
      should(added.wardenRemedy).deepEqual(kept.wardenRemedy);
      should(added.privilegedOnly).equal(kept.privilegedOnly);
      should(added.handle).equal(kept.handle);
    });

    it(`should mark ${method} ${old} legacy and leave ${next} unmarked`, () => {
      should(find(method, old).legacy).equal(true);
      should(find(method, next).legacy).be.undefined();
    });
  }

  it('should mark the notify route legacy too, since it is the oldest spelling of the same door', () => {
    should(find('POST', '/v1/sessions/:sessionId/notify').legacy).equal(true);
  });

  it('should leave no other route marked legacy', () => {
    // Arrange / Act
    const marked = routes.filter(route => route.legacy === true).map(route => `${route.method} ${route.path}`);

    // Assert
    should(marked.sort()).deepEqual(
      [
        'GET /v1/sessions/:sessionId/attention',
        'POST /v1/sessions/:sessionId/attention',
        'POST /v1/sessions/:sessionId/attention/replies',
        'POST /v1/sessions/:sessionId/notify',
        'GET /v1/warden/attention',
      ].sort(),
    );
  });
});

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

const CALLERS: ReadonlyArray<{
  readonly name: string;
  readonly grants: CapabilityGrants;
  readonly overrides: Partial<Parameters<typeof request>[0]>;
}> = [
  { name: 'an anonymous relayed caller', grants: DEFAULT_CAPABILITY_GRANTS, overrides: {} },
  {
    name: 'a relayed device holding the defaults',
    grants: DEFAULT_CAPABILITY_GRANTS,
    overrides: { device: PHONE },
  },
  {
    name: 'a relayed device paired --limited',
    grants: LIMITED_DEVICE_GRANTS,
    overrides: { device: PHONE },
  },
  {
    name: 'a relayed device whose warden grant was narrowed',
    grants: WITHOUT_WARDEN,
    overrides: { device: PHONE },
  },
  { name: 'a relayed admin token', grants: DEFAULT_CAPABILITY_GRANTS, overrides: { headers: human } },
  {
    name: 'a relayed warden token',
    grants: DEFAULT_CAPABILITY_GRANTS,
    overrides: { headers: { authorization: `Bearer ${CREDENTIALS.warden}`, 'x-ferretry-client': 'cli' } },
  },
];

const concrete = (path: string): string => path.replace(':sessionId', 's1');
const BODY = JSON.stringify({ action: 'add', title: 't' });

describe('a relayed caller meeting the agenda routes', () => {
  for (const caller of CALLERS) {
    for (const [method, next, old] of PAIRS) {
      it(`should give ${caller.name} the same answer on ${method} ${next} as on ${old}`, async () => {
        // Arrange
        const dispatcher = await relayedDispatcher(caller.grants);
        const ask = (path: string) =>
          dispatcher.dispatch(
            request({
              method,
              path: concrete(path),
              loopback: false,
              ...(method === 'POST' ? { body: BODY } : {}),
              ...caller.overrides,
            }),
          );

        // Act
        const added = await ask(next);
        const kept = await ask(old);

        // Assert
        should(added.status).equal(kept.status);
        // A refusal names the path it refused, which is the one difference the new name is allowed.
        should(added.body.replaceAll('/agenda', '/attention')).equal(kept.body);
      });
    }
  }

  it('should refuse a relayed device without the warden grant on both warden spellings alike', async () => {
    // Arrange
    const dispatcher = await relayedDispatcher(WITHOUT_WARDEN);
    const ask = (path: string) => dispatcher.dispatch(request({ method: 'GET', path, loopback: false, device: PHONE }));

    // Act
    const added = await ask('/v1/warden/agenda');
    const kept = await ask('/v1/warden/attention');

    // Assert: refused, not merely "the same" — a pair of 200s would pass the equality test above.
    should(added.status).equal(403);
    should(kept.status).equal(403);
  });

  it('should serve a relayed device holding the warden grant on both warden spellings', async () => {
    // Arrange
    const dispatcher = await relayedDispatcher(DEFAULT_CAPABILITY_GRANTS);
    const ask = (path: string) => dispatcher.dispatch(request({ method: 'GET', path, loopback: false, device: PHONE }));

    // Act / Assert
    should((await ask('/v1/warden/agenda')).status).equal(200);
    should((await ask('/v1/warden/attention')).status).equal(200);
  });

  it('should refuse an unauthenticated relayed caller on every pair', async () => {
    // Arrange
    const dispatcher = await relayedDispatcher(DEFAULT_CAPABILITY_GRANTS);

    // Act / Assert
    for (const [method, next, old] of PAIRS) {
      for (const path of [next, old]) {
        const response = await dispatcher.dispatch(request({ method, path: concrete(path), loopback: false }));
        should(response.status).equal(401);
      }
    }
  });
});

describe('the agenda wire feature', () => {
  it('should be named agenda.wire.1', () => {
    should(DAEMON_FEATURES.agendaWire).equal('agenda.wire.1');
  });
});
