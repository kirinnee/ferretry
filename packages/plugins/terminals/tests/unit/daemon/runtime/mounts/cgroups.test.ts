import { describe, it } from 'bun:test';
import { type LimitsView, LimitsViewSchema } from '../../../../../daemon/lib/protocol/limits.ts';
import should from 'should';
import { cgroupConfigView } from '../../../../../protocol/tests/fixtures.ts';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { cgroupRoutes, type LimitsSubsystem } from '../../../../../daemon/lib/runtime/mounts/cgroups.ts';
import { request } from '../../api/support.ts';
import { CREDENTIALS, GRANTED, human } from './support.ts';

/**
 * Ferret limits, over the real dispatcher and the real credentials.
 *
 * What cannot be checked by calling a route function directly is who may reach the route, and what a
 * request to a route that no longer exists is answered with. A warden must not read it: a supervision
 * session has no business with the cap on the fleet it supervises.
 */

const warden = { authorization: `Bearer ${CREDENTIALS.warden}`, 'x-ferretry-client': 'cli' } as const;

const VIEW: LimitsView = cgroupConfigView;

class FakeLimits implements LimitsSubsystem {
  async view(): Promise<LimitsView> {
    return VIEW;
  }
}

const dispatcher = (subsystem: LimitsSubsystem = new FakeLimits()): ApiDispatcher =>
  new ApiDispatcher(new ApiRouter(cgroupRoutes(subsystem)), CREDENTIALS, GRANTED);

const get = (headers: Readonly<Record<string, string>> = human) =>
  request({ method: 'GET', path: '/v1/cgroups/config', headers });

describe('reading the ferret limits', () => {
  it('should answer with a body the client can parse', async () => {
    // Arrange / Act
    const response = await dispatcher().dispatch(get());

    // Assert
    should(response.status).equal(200);
    should(() => LimitsViewSchema.parse(JSON.parse(response.body))).not.throw();
  });

  it('should refuse a warden', async () => {
    // Arrange / Act / Assert
    should((await dispatcher().dispatch(get(warden))).status).equal(403);
  });

  it('should never be cached: the live part is a measurement of this moment', () => {
    // Arrange / Act
    const routes = cgroupRoutes(new FakeLimits());

    // Assert
    should(routes.every(route => route.noStore === true)).be.true();
  });

  it('should govern the read with the fleet capability, on the use axis', () => {
    // Arrange / Act
    const route = cgroupRoutes(new FakeLimits()).find(candidate => candidate.method === 'GET');

    // Assert
    should(route?.capability).deepEqual({ capability: 'fleet', axis: 'use' });
  });

  it('should have no save: limits.yaml is the one writer, and its writer holds a loosening for the owner', () => {
    // Arrange / Act
    const routes = cgroupRoutes(new FakeLimits());

    // Assert
    should(routes.map(route => route.method)).deepEqual(['GET']);
  });
});
