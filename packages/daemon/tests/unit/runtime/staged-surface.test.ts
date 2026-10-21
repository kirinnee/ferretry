import { describe, it } from 'bun:test';
import { DAEMON_STARTING_CODE } from '@ferretry/protocol';
import should from 'should';
import type { ApiRequest, ApiResponse } from '../../../src/lib/api/http.ts';
import { jsonResponse } from '../../../src/lib/api/responses.ts';
import type { DaemonLivenessSource } from '../../../src/lib/api/routes/health.ts';
import type { ApiHttpDispatch, ApiSocketGate } from '../../../src/lib/api/server.ts';
import type { BootSnapshot } from '../../../src/lib/runtime/liveness.ts';
import { StagedApiSurface } from '../../../src/lib/runtime/staged-surface.ts';
import { daemonVersion } from '../../../src/lib/version.ts';
import { fixedClock, jsonBody, request } from '../api/support.ts';

const NOW = 1_800_000_000_000;

const STALL = {
  atMs: NOW - 1_000,
  durationMs: 812,
  during: ['fleet refresh', 'fleet refresh › usage feed'],
  innermost: ['fleet refresh › usage feed'],
  stacks: [{ stack: 'readFileSync ← scan (fleet/src/adapters/homes.ts:88)', share: 0.75 }],
};

const STALL_VIEW = {
  at: new Date(NOW - 1_000).toISOString(),
  durationMs: 812,
  during: ['fleet refresh', 'fleet refresh › usage feed'],
  innermost: ['fleet refresh › usage feed'],
  stacks: [{ stack: 'readFileSync ← scan (fleet/src/adapters/homes.ts:88)', share: 0.75 }],
};

const booting = (boot: BootSnapshot): DaemonLivenessSource => ({
  pid: 4242,
  boot: () => boot,
  loop: () => ({
    lagMs: 3,
    maxLagMs: 812,
    stalls: 1,
    lastStall: STALL,
    worstStall: STALL,
  }),
});

const SELF_CHECK: BootSnapshot = {
  phase: 'starting',
  step: 'first self-check (reconciling the session index)',
  stepElapsedMs: 8_400,
  bootElapsedMs: 12_100,
};

/** A mounted dispatcher pair that records what reached it. */
const mounted = () => {
  const reached: string[] = [];
  const http: ApiHttpDispatch = {
    dispatch: async (incoming: ApiRequest): Promise<ApiResponse> => {
      reached.push(`http ${incoming.path}`);
      return jsonResponse({ served: incoming.path });
    },
  };
  const sockets: ApiSocketGate = {
    claims: (incoming: ApiRequest) => incoming.path === '/v1/events',
    upgrade: async (incoming: ApiRequest) => {
      reached.push(`socket ${incoming.path}`);
      return { outcome: 'unclaimed' };
    },
  };
  return { http, sockets, reached };
};

describe('StagedApiSurface before the boot mounts its routes', () => {
  it('should answer liveness with the step in progress, as a 503 a readiness wait keeps waiting on', async () => {
    // Arrange
    const surface = new StagedApiSurface(fixedClock(NOW), NOW - 12_100, booting(SELF_CHECK));

    // Act
    const response = await surface.http.dispatch(request({ path: '/healthz' }));

    // Assert
    should(response.status).equal(503);
    should(response.headers.get('retry-after')).equal('2');
    should(response.headers.get('cache-control')).equal('no-store');
    should(jsonBody(response)).deepEqual({
      status: 'starting',
      version: daemonVersion,
      sessionProtocol: 'ferretry-relay/2',
      uptimeSeconds: 12,
      pid: 4242,
      boot: {
        phase: 'starting',
        step: 'first self-check (reconciling the session index)',
        stepElapsedSeconds: 8,
        elapsedSeconds: 12,
      },
      eventLoop: {
        lagMs: 3,
        maxLagMs: 812,
        stalls: 1,
        lastStall: STALL_VIEW,
        worstStall: STALL_VIEW,
      },
    });
    should(surface.mounted).be.false();
  });

  it('should refuse every other route, the full health report included, naming the step', async () => {
    // Arrange
    const surface = new StagedApiSurface(fixedClock(NOW), NOW, booting(SELF_CHECK));

    // Act
    const health = await surface.http.dispatch(request({ path: '/v1/health' }));
    const write = await surface.http.dispatch(request({ path: '/healthz', method: 'POST' }));

    // Assert
    for (const response of [health, write]) {
      should(response.status).equal(503);
      should(response.headers.get('retry-after')).equal('2');
      should(jsonBody(response).code).equal(DAEMON_STARTING_CODE);
      should(jsonBody(response).error).equal(
        'the daemon is starting (first self-check (reconciling the session index)); ask again shortly',
      );
    }
  });

  it('should claim no socket, and refuse an upgrade that slips past the claim', async () => {
    // Arrange
    const surface = new StagedApiSurface(fixedClock(NOW), NOW, booting(SELF_CHECK));

    // Act
    const claimed = surface.sockets.claims(request({ path: '/v1/events' }));
    const decision = await surface.sockets.upgrade(request({ path: '/v1/events' }));

    // Assert
    should(claimed).be.false();
    should(decision.outcome).equal('refused');
    if (decision.outcome === 'refused') should(decision.response.status).equal(503);
  });
});

describe('StagedApiSurface once the boot mounts its routes', () => {
  it('should hand every request to the mounted dispatchers, liveness included', async () => {
    // Arrange
    const surface = new StagedApiSurface(fixedClock(NOW), NOW, booting({ ...SELF_CHECK, phase: 'finishing' }));
    const real = mounted();

    // Act
    surface.mount(real.http, real.sockets);
    await surface.http.dispatch(request({ path: '/healthz' }));
    await surface.http.dispatch(request({ path: '/v1/sessions' }));
    const claimed = surface.sockets.claims(request({ path: '/v1/events' }));
    await surface.sockets.upgrade(request({ path: '/v1/events' }));

    // Assert
    should(surface.mounted).be.true();
    should(claimed).be.true();
    should(real.reached).deepEqual(['http /healthz', 'http /v1/sessions', 'socket /v1/events']);
  });
});
