import { describe, it } from 'bun:test';
import { CgroupConfigViewSchema, type CgroupConfigPatch, type CgroupConfigView } from '@ferretry/protocol';
import should from 'should';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { CgroupError } from '../../../../src/lib/cgroups/index.ts';
import { type CgroupSubsystem, cgroupRoutes } from '../../../../src/lib/runtime/mounts/cgroups.ts';
import { request } from '../../api/support.ts';
import { CREDENTIALS, GRANTED, human } from './support.ts';

/**
 * Fleet resource limits, over the real dispatcher and the real credentials.
 *
 * The two halves that cannot be checked by calling a route function directly are the ones under
 * test here: who may reach each route, and what an operator's malformed or empty request is
 * answered with. A warden must reach neither — a supervision session that could raise the cap on
 * the fleet it supervises could escalate its own authority, and it is deliberately outside the
 * capped slice in the first place.
 */

const warden = { authorization: `Bearer ${CREDENTIALS.warden}`, 'x-ferretry-client': 'cli' } as const;

const VIEW: CgroupConfigView = {
  config: {
    enabled: true,
    fleet: { cpuPercent: 90, memoryPercent: 90 },
    perAgent: { cpuPercent: 25, memoryPercent: 25 },
  },
  supported: true,
  fleetSlice: 'ferretry-fleet.slice',
  effective: {
    cpus: 8,
    memoryBytes: 1_000_000,
    fleet: { cpuQuota: '720%', memoryMax: '900000' },
    perAgent: { cpuQuota: '200%', memoryMax: '250000' },
  },
  restartRequiredSessions: [],
  warnings: [],
};

class FakeCgroups implements CgroupSubsystem {
  readonly patches: CgroupConfigPatch[] = [];
  constructor(private readonly failure?: CgroupError) {}
  async config(): Promise<CgroupConfigView> {
    if (this.failure !== undefined) throw this.failure;
    return VIEW;
  }
  async updateConfig(patch: CgroupConfigPatch): Promise<CgroupConfigView> {
    this.patches.push(patch);
    if (this.failure !== undefined) throw this.failure;
    return { ...VIEW, restartRequiredSessions: ['s1'] };
  }
}

const dispatcher = (subsystem: CgroupSubsystem = new FakeCgroups()): ApiDispatcher =>
  new ApiDispatcher(new ApiRouter(cgroupRoutes(subsystem)), CREDENTIALS, GRANTED);

const get = (headers: Readonly<Record<string, string>> = human) =>
  request({ method: 'GET', path: '/v1/cgroups/config', headers });

const patch = (body: string, headers: Readonly<Record<string, string>> = human) =>
  request({ method: 'PATCH', path: '/v1/cgroups/config', headers, body });

describe('reading the resource limits', () => {
  it('should answer with a body the client can parse', async () => {
    // Arrange / Act
    const response = await dispatcher().dispatch(get());

    // Assert
    should(response.status).equal(200);
    should(() => CgroupConfigViewSchema.parse(JSON.parse(response.body))).not.throw();
  });

  it('should refuse a warden, which has no business reading the cap on the fleet it supervises', async () => {
    // Arrange / Act / Assert
    should((await dispatcher().dispatch(get(warden))).status).equal(403);
  });

  it('should never be cached: a stale read shows limits the last save replaced', async () => {
    // Arrange / Act
    const routes = cgroupRoutes(new FakeCgroups());

    // Assert
    should(routes.every(route => route.noStore === true)).be.true();
  });

  it('should govern the read with the fleet capability it belongs to, on the use axis', async () => {
    // Arrange / Act
    const route = cgroupRoutes(new FakeCgroups()).find(candidate => candidate.method === 'GET');

    // Assert
    should(route?.capability).deepEqual({ capability: 'fleet', axis: 'use' });
  });

  it('should restate a host failure as a server fault the client can branch on', async () => {
    // Arrange
    const subject = dispatcher(new FakeCgroups(new CgroupError('failed', 'the bus is gone')));

    // Act
    const response = await subject.dispatch(get());

    // Assert
    should(response.status).equal(500);
    should(JSON.parse(response.body).code).equal('cgroup_apply_failed');
  });
});

describe('saving a change', () => {
  it('should hand the domain exactly what the operator stated', async () => {
    // Arrange
    const subsystem = new FakeCgroups();

    // Act
    const response = await dispatcher(subsystem).dispatch(patch(JSON.stringify({ perAgent: { cpuPercent: 10 } })));

    // Assert
    should(response.status).equal(200);
    should(subsystem.patches).deepEqual([{ perAgent: { cpuPercent: 10 } }]);
  });

  it('should answer with the restart requirements the save produced', async () => {
    // Arrange / Act
    const response = await dispatcher().dispatch(patch(JSON.stringify({ enabled: true })));

    // Assert
    should(JSON.parse(response.body).restartRequiredSessions).deepEqual(['s1']);
  });

  it('should govern the write on the CONFIGURE axis, not the read one', async () => {
    // Arrange / Act
    const route = cgroupRoutes(new FakeCgroups()).find(candidate => candidate.method === 'PATCH');

    // Assert
    should(route?.capability).deepEqual({ capability: 'fleet', axis: 'configure' });
  });

  it('should refuse a warden outright', async () => {
    // Arrange / Act / Assert
    should((await dispatcher().dispatch(patch(JSON.stringify({ enabled: false }), warden))).status).equal(403);
  });

  it('should refuse a field the wire does not declare, by name', async () => {
    // Arrange / Act
    const response = await dispatcher().dispatch(patch(JSON.stringify({ enabld: true })));

    // Assert
    should(response.status).equal(400);
  });

  it('should refuse an empty patch rather than reporting a save that did not happen', async () => {
    // Arrange
    const subsystem = new FakeCgroups();

    // Act
    const response = await dispatcher(subsystem).dispatch(patch('{}'));

    // Assert
    should(response.status).equal(400);
    should(JSON.parse(response.body).code).equal('empty_patch');
    should(subsystem.patches).be.empty();
  });

  it('should refuse a patch whose only section is empty', async () => {
    // Arrange / Act
    const response = await dispatcher().dispatch(patch(JSON.stringify({ fleet: {} })));

    // Assert
    should(response.status).equal(400);
    should(JSON.parse(response.body).code).equal('empty_patch');
  });

  it('should restate an impossible combination as a client error', async () => {
    // Arrange
    const subject = dispatcher(new FakeCgroups(new CgroupError('invalid', 'perAgent may not exceed fleet')));

    // Act
    const response = await subject.dispatch(patch(JSON.stringify({ fleet: { cpuPercent: 1 } })));

    // Assert
    should(response.status).equal(400);
    should(JSON.parse(response.body).code).equal('invalid_request');
  });

  it('should tell a client that the HOST, not the request, is what cannot provide enforcement', async () => {
    // Arrange
    const subject = dispatcher(new FakeCgroups(new CgroupError('unsupported', 'this host reports darwin')));

    // Act
    const response = await subject.dispatch(patch(JSON.stringify({ enabled: true })));

    // Assert — 409, so an unsupported platform is distinguishable from a malformed request.
    should(response.status).equal(409);
    should(JSON.parse(response.body).code).equal('cgroups_unsupported');
  });

  it('should let a genuine defect stay a defect rather than dressing it as a refusal', async () => {
    // Arrange
    const subsystem: CgroupSubsystem = {
      config: async () => VIEW,
      updateConfig: async () => {
        throw new TypeError('a real bug');
      },
    };

    // Act
    const response = await dispatcher(subsystem).dispatch(patch(JSON.stringify({ enabled: true })));

    // Assert
    should(response.status).equal(500);
    should(JSON.parse(response.body).code).not.equal('cgroup_apply_failed');
  });
});
