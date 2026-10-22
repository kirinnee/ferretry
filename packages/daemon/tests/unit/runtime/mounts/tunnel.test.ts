import { describe, it } from 'bun:test';
import { STEP_UP_REQUIRED_CODE, TUNNEL_OFF_SENTENCE, TunnelStatusViewSchema } from '@ferretry/protocol';
import should from 'should';
import type { StepUpWitness } from '../../../../src/lib/api/capability.ts';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import type { SessionDevice } from '../../../../src/lib/api/http.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { DEFAULT_CAPABILITY_GRANTS } from '../../../../src/lib/grants/index.ts';
import { tunnelRoutes } from '../../../../src/lib/runtime/mounts/tunnel.ts';
import type { TunnelSwitchPort } from '../../../../src/lib/tunnel/index.ts';
import { jsonBody, request } from '../../api/support.ts';
import { CREDENTIALS, grantSubsystem, human } from './support.ts';

/**
 * The tunnel switch's routes, driven through the REAL dispatcher and the REAL grant guard, so the
 * `pairing.configure` demand, the step-up behind it and where the caller arrived are enforced by the
 * code production runs.
 */
const PHONE: SessionDevice = { deviceId: 'device-phone', appSession: 'app-one' };

const witnessFor = (...held: readonly SessionDevice[]): StepUpWitness => ({
  held: subject => held.some(entry => entry.deviceId === subject.deviceId && entry.appSession === subject.appSession),
});

/** A switch that answers from one flag and records every change it is asked for. */
class RecordingSwitch implements TunnelSwitchPort {
  enabled = false;
  readonly changes: boolean[] = [];

  view() {
    return this.enabled
      ? {
          enabled: true,
          explicit: true,
          state: 'provisioning' as const,
          tunnelUrl: null,
          sentence: 'Tunnel: on — asking the hosted service for a tunnel',
        }
      : { enabled: false, explicit: false, state: 'off' as const, tunnelUrl: null, sentence: TUNNEL_OFF_SENTENCE };
  }

  async change(enabled: boolean) {
    this.changes.push(enabled);
    this.enabled = enabled;
    return this.view();
  }
}

interface World {
  readonly stepUps?: StepUpWitness;
  readonly grants?: Parameters<typeof grantSubsystem>[0];
}

async function mount(world: World = {}) {
  const tunnel = new RecordingSwitch();
  const grants = grantSubsystem(world.grants);
  await grants.refresh();
  const dispatcher = new ApiDispatcher(
    new ApiRouter(tunnelRoutes(tunnel)),
    CREDENTIALS,
    grants,
    undefined,
    world.stepUps,
  );
  return { tunnel, dispatcher };
}

const ON = JSON.stringify({ enabled: true });

/** A paired device off this host — across the relay, the tunnel or WebRTC, which all arrive remote. */
const fromDevice = (method: string, body?: string) =>
  request({ method, path: '/v1/tunnel', device: PHONE, loopback: false, ...(body === undefined ? {} : { body }) });

/** The host command line: the admin token over loopback, which is what `fy daemon tunnel` is. */
const fromHost = (method: string, body?: string) =>
  request({ method, path: '/v1/tunnel', headers: human, loopback: true, ...(body === undefined ? {} : { body }) });

describe('the routes this mount serves', () => {
  it('should serve the read and the change, the change on pairing.configure', () => {
    // Act
    const routes = tunnelRoutes(new RecordingSwitch());

    // Assert
    should(routes.map(route => `${route.method} ${route.path}`)).deepEqual(['GET /v1/tunnel', 'PUT /v1/tunnel']);
    should(routes[0]?.minimum).equal('authenticated');
    should(routes[0]?.capability).be.undefined();
    should(routes[1]?.minimum).equal('operator');
    should(routes[1]?.capability).deepEqual({ capability: 'pairing', axis: 'configure' });
  });
});

describe('the read', () => {
  it('should answer any paired device with no capability and no step-up, uncached', async () => {
    // Arrange — even with pairing switched off entirely, the read is not governed.
    const { dispatcher } = await mount({
      grants: { grants: { ...DEFAULT_CAPABILITY_GRANTS, pairing: { use: false, configure: false } } },
    });

    // Act
    const answered = await dispatcher.dispatch(fromDevice('GET'));

    // Assert
    should(answered.status).equal(200);
    should(answered.headers.get('cache-control')).match(/no-store/u);
    should(TunnelStatusViewSchema.parse(jsonBody(answered))).deepEqual({
      enabled: false,
      explicit: false,
      state: 'off',
      tunnelUrl: null,
      sentence: TUNNEL_OFF_SENTENCE,
    });
  });

  it('should refuse an unauthenticated reader', async () => {
    // Arrange
    const { dispatcher } = await mount();

    // Act
    const answered = await dispatcher.dispatch(request({ path: '/v1/tunnel', loopback: false }));

    // Assert
    should(answered.status).equal(401);
  });
});

describe('the change', () => {
  it('should let the host switch it with no step-up, whatever the grants say', async () => {
    // Arrange — a caller at the machine is ungoverned.
    const { dispatcher, tunnel } = await mount({
      grants: { grants: { ...DEFAULT_CAPABILITY_GRANTS, pairing: { use: false, configure: false } } },
    });

    // Act
    const answered = await dispatcher.dispatch(fromHost('PUT', ON));

    // Assert
    should(answered.status).equal(200);
    should(answered.headers.get('cache-control')).match(/no-store/u);
    should(TunnelStatusViewSchema.parse(jsonBody(answered)).enabled).be.true();
    should(tunnel.changes).deepEqual([true]);
  });

  it('should ask a remote device for a step-up before it switches anything', async () => {
    // Arrange
    const { dispatcher, tunnel } = await mount();

    // Act
    const answered = await dispatcher.dispatch(fromDevice('PUT', ON));

    // Assert
    should(answered.status).equal(403);
    should(jsonBody(answered)).have.property('code', STEP_UP_REQUIRED_CODE);
    should(tunnel.changes).deepEqual([]);
  });

  it('should switch for a stepped-up remote device that holds pairing.configure', async () => {
    // Arrange
    const { dispatcher, tunnel } = await mount({ stepUps: witnessFor(PHONE) });

    // Act
    const on = await dispatcher.dispatch(fromDevice('PUT', ON));
    const off = await dispatcher.dispatch(fromDevice('PUT', JSON.stringify({ enabled: false })));

    // Assert
    should(on.status).equal(200);
    should(off.status).equal(200);
    should(TunnelStatusViewSchema.parse(jsonBody(off)).sentence).equal(TUNNEL_OFF_SENTENCE);
    should(tunnel.changes).deepEqual([true, false]);
  });

  it('should treat a device on a loopback peer as remote — a tunnel or a local proxy forwards from one', async () => {
    // Arrange
    const { dispatcher, tunnel } = await mount();

    // Act
    const answered = await dispatcher.dispatch(
      request({ method: 'PUT', path: '/v1/tunnel', device: PHONE, loopback: true, body: ON }),
    );

    // Assert
    should(answered.status).equal(403);
    should(jsonBody(answered)).have.property('code', STEP_UP_REQUIRED_CODE);
    should(tunnel.changes).deepEqual([]);
  });

  it('should refuse a stepped-up device when the operator switched pairing configuration off', async () => {
    // Arrange
    const { dispatcher, tunnel } = await mount({
      stepUps: witnessFor(PHONE),
      grants: { grants: { ...DEFAULT_CAPABILITY_GRANTS, pairing: { use: true, configure: false } } },
    });

    // Act
    const answered = await dispatcher.dispatch(fromDevice('PUT', ON));

    // Assert
    should(answered.status).equal(403);
    should(jsonBody(answered)).have.property('code', 'grant_not_granted');
    should(tunnel.changes).deepEqual([]);
  });

  it('should refuse a warden, and a body that is not a switch', async () => {
    // Arrange
    const { dispatcher, tunnel } = await mount({ stepUps: witnessFor(PHONE) });

    // Act
    const warden = await dispatcher.dispatch(
      request({
        method: 'PUT',
        path: '/v1/tunnel',
        headers: { authorization: 'Bearer warden-secret' },
        loopback: false,
        body: ON,
      }),
    );
    const word = await dispatcher.dispatch(fromHost('PUT', JSON.stringify({ enabled: 'on' })));

    // Assert
    should(warden.status).equal(403);
    should(word.status).equal(400);
    should(tunnel.changes).deepEqual([]);
  });
});
