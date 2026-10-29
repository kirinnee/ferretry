import { describe, it } from 'bun:test';
import {
  type CapabilityGrants,
  LIMITED_DEVICE_GRANTS,
  type PairedDevice,
  type PairedDevicesView,
  STEP_UP_REQUIRED_CODE,
} from '@ferretry/protocol';
import should from 'should';
import {
  ApiDispatcher,
  ApiRouter,
  type CapabilityPresentation,
  type SessionDevice,
} from '../../../../src/lib/api/index.ts';
import {
  DEFAULT_CAPABILITY_GRANTS,
  DeviceGrantService,
  type GrantAuditEntry,
  GrantError,
} from '../../../../src/lib/grants/index.ts';
import {
  type DeviceGrantSubsystem,
  type PairingSubsystem,
  pairingRoutes,
} from '../../../../src/lib/runtime/mounts/pairing.ts';
import { jsonBody, request } from '../../api/support.ts';
import { deviceGrantsOver, grantSubsystem } from './support.ts';

/**
 * Changing ONE device's grants over `PATCH /v1/pair/devices/:deviceId/grants` (B5).
 *
 * Over the REAL grant subsystem, the REAL device-grant service and the REAL dispatcher, so the device
 * grants the boundary narrows by and the ones the route changes are the same map.
 */

const callerId = `fy_device_id_${'a'.repeat(22)}`;
const targetId = `fy_device_id_${'b'.repeat(22)}`;
const caller: SessionDevice = { deviceId: callerId, appSession: 'app-one' };

const ALL_OFF = Object.fromEntries(
  Object.keys(DEFAULT_CAPABILITY_GRANTS).map(capability => [capability, { use: false, configure: false }]),
) as CapabilityGrants;

const record = (id: string, grants: CapabilityGrants): PairedDevice => ({
  id,
  name: id === callerId ? 'Pixel 8' : 'iPad',
  platform: 'browser',
  createdAt: '2026-08-01T09:00:00.000Z',
  lastSeenAt: '2026-08-03T11:58:00.000Z',
  idleExpiresAt: '2026-09-02T11:58:00.000Z',
  grants,
});

interface World {
  readonly caller?: CapabilityGrants;
  readonly target?: CapabilityGrants;
  readonly daemonWide?: CapabilityGrants;
  readonly steppedUp?: boolean;
  /**
   * Whether the caller proved a passkey for THIS act — what a widen needs. Follows `steppedUp` unless
   * set: `false` with `steppedUp` on is an unlocked device that has not confirmed the widen.
   */
  readonly freshProof?: boolean;
  /** Replaces the real device-grant service, for a case driving a failure it would never raise. */
  readonly service?: DeviceGrantSubsystem;
}

async function mount(world: World = {}) {
  const devices = new Map<string, CapabilityGrants>([
    [callerId, world.caller ?? LIMITED_DEVICE_GRANTS],
    [targetId, world.target ?? LIMITED_DEVICE_GRANTS],
  ]);
  const grants = grantSubsystem(world.daemonWide === undefined ? {} : { grants: world.daemonWide });
  await grants.refresh();
  const audit: GrantAuditEntry[] = [];
  let rechecks = 0;
  let spentFresh = 0;
  const service = deviceGrantsOver(grants, devices, audit, () => {
    rechecks += 1;
  });
  const pairing: PairingSubsystem = {
    mint: () => {
      throw new Error('not under test');
    },
    status: () => undefined,
    revoke: () => undefined,
    devices: async () => [...devices].map(([id, own]) => record(id, own)),
    revokeDevice: async () => false,
  };
  const credentials = {
    admin: 'admin-secret',
    devices: { has: (id: string) => devices.has(id), grants: (id: string) => devices.get(id) },
  };
  const dispatcher = new ApiDispatcher(
    new ApiRouter(pairingRoutes(pairing, world.service ?? service)),
    credentials,
    grants,
    undefined,
    {
      held: () => world.steppedUp ?? true,
      freshlyHeld: () => world.freshProof ?? world.steppedUp ?? true,
      spendFresh: () => {
        spentFresh += 1;
      },
    },
  );
  return { dispatcher, devices, audit, service, rechecks: () => rechecks, spentFresh: () => spentFresh };
}

const patch = (body: unknown, target = targetId) =>
  request({
    method: 'PATCH',
    path: `/v1/pair/devices/${target}/grants`,
    device: caller,
    loopback: false,
    body: JSON.stringify(body),
  });

const fromHost = (body: unknown) =>
  request({
    method: 'PATCH',
    path: `/v1/pair/devices/${targetId}/grants`,
    headers: { authorization: 'Bearer admin-secret' },
    loopback: true,
    body: JSON.stringify(body),
  });

/** A device allowed to manage devices and holding the terminal. */
const MANAGER: CapabilityGrants = {
  ...LIMITED_DEVICE_GRANTS,
  pairing: { use: true, configure: true },
  terminal: { use: true, configure: false },
};

describe('changing one device’s grants', () => {
  it('should let the host widen any axis, with no step-up, and answer the whole list', async () => {
    // Arrange
    const { dispatcher, devices, audit, rechecks } = await mount({ steppedUp: false });

    // Act
    const response = await dispatcher.dispatch(fromHost({ secrets: { configure: true }, terminal: { use: true } }));

    // Assert
    should(response.status).equal(200);
    should(devices.get(targetId)?.secrets).deepEqual({ use: true, configure: true });
    should(devices.get(targetId)?.terminal).deepEqual({ use: true, configure: false });
    const view = jsonBody(response) as PairedDevicesView;
    should(view.devices.find(entry => entry.id === targetId)?.grants.secrets).deepEqual({ use: true, configure: true });
    should(view.mayWiden).deepEqual(DEFAULT_CAPABILITY_GRANTS);
    // Audited through the grant journal, attributed, one line per axis that moved.
    should(audit).have.length(1);
    should(audit[0]?.changes).deepEqual([
      `${targetId}/terminal.use=on`,
      `${targetId}/secrets.use=on`,
      `${targetId}/secrets.configure=on`,
    ]);
    // And the open streams are asked again.
    should(rechecks()).equal(1);
  });

  it('should let a remote manager widen what it holds, once stepped up', async () => {
    // Arrange
    const { dispatcher, devices } = await mount({ caller: MANAGER });

    // Act
    const response = await dispatcher.dispatch(patch({ terminal: { use: true } }));

    // Assert
    should(response.status).equal(200);
    should(devices.get(targetId)?.terminal).deepEqual({ use: true, configure: false });
  });

  it('should refuse a remote widen on the unlock alone, naming the act, and spend a fresh proof on one', async () => {
    // Arrange — OWNER DECISION: widening another device always wants a passkey proved for it, even on an
    // unlocked device with `stepUpOnActions` off. The unlock is the held step-up; no fresh proof is.
    const unlocked = await mount({ caller: MANAGER, freshProof: false });
    const confirmed = await mount({ caller: MANAGER });

    // Act
    const refused = await unlocked.dispatcher.dispatch(patch({ terminal: { use: true } }));
    const allowed = await confirmed.dispatcher.dispatch(patch({ terminal: { use: true } }));

    // Assert
    should(refused.status).equal(403);
    should(jsonBody(refused).code).equal(STEP_UP_REQUIRED_CODE);
    should(jsonBody(refused).demand).deepEqual({ capability: 'pairing', axis: 'use', act: 'widen-device' });
    should(unlocked.devices.get(targetId)).deepEqual(LIMITED_DEVICE_GRANTS);
    should(allowed.status).equal(200);
    // One confirmation, one widen: the proof is spent.
    should(confirmed.spentFresh()).equal(1);
  });

  it('should let an unlocked device NARROW without a fresh proof, and spend none', async () => {
    // Arrange
    const { dispatcher, devices, spentFresh } = await mount({
      caller: MANAGER,
      target: MANAGER,
      freshProof: false,
    });

    // Act
    const response = await dispatcher.dispatch(patch({ terminal: { use: false } }));

    // Assert
    should(response.status).equal(200);
    should(devices.get(targetId)?.terminal).deepEqual({ use: false, configure: false });
    should(spentFresh()).equal(0);
  });

  it('should ask a remote manager for a step-up first', async () => {
    // Arrange
    const { dispatcher, devices } = await mount({ caller: MANAGER, steppedUp: false });

    // Act
    const response = await dispatcher.dispatch(patch({ fleet: { use: false } }));

    // Assert — refused at the boundary (pairing.use needs a step-up) before the subsystem is asked.
    should(response.status).equal(403);
    should(jsonBody(response).code).equal(STEP_UP_REQUIRED_CODE);
    should(devices.get(targetId)).deepEqual(LIMITED_DEVICE_GRANTS);
  });

  it('should refuse a remote widen of an axis the caller does not hold, naming the host command', async () => {
    // Arrange
    const { dispatcher, devices, audit } = await mount({ caller: MANAGER });

    // Act
    const response = await dispatcher.dispatch(patch({ secrets: { use: true } }));

    // Assert
    should(response.status).equal(403);
    should(jsonBody(response).code).equal('grant_forbidden');
    should(String(jsonBody(response).error)).match(new RegExp(`fy device grant ${targetId} secrets --use`, 'u'));
    should(devices.get(targetId)).deepEqual(LIMITED_DEVICE_GRANTS);
    should(audit).be.empty();
  });

  it('should refuse a remote widen by a device without pairing.configure', async () => {
    // Arrange — it holds the terminal and may USE pairing, but may not manage devices.
    const { dispatcher } = await mount({ caller: { ...MANAGER, pairing: { use: true, configure: false } } });

    // Act
    const response = await dispatcher.dispatch(patch({ terminal: { use: true } }));

    // Assert
    should(response.status).equal(403);
    should(jsonBody(response).code).equal('grant_forbidden');
  });

  it('should refuse a widen the daemon-wide document forbids, even to a device that holds it', async () => {
    // effective = daemonWide ∧ device: switching `terminal` off for everyone also stops it being passed on.
    // Arrange
    const { dispatcher } = await mount({
      caller: MANAGER,
      daemonWide: { ...DEFAULT_CAPABILITY_GRANTS, terminal: { use: false, configure: false } },
    });

    // Act
    const response = await dispatcher.dispatch(patch({ terminal: { use: true } }));

    // Assert
    should(response.status).equal(403);
    should(jsonBody(response).code).equal('grant_forbidden');
  });

  it('should refuse a mixed patch WHOLE when any field widens illegally', async () => {
    // Arrange — the target holds terminal; narrowing it is fine, widening secrets is not.
    const target = { ...LIMITED_DEVICE_GRANTS, terminal: { use: true, configure: false } };
    const { dispatcher, devices } = await mount({ caller: MANAGER, target });

    // Act
    const response = await dispatcher.dispatch(patch({ terminal: { use: false }, secrets: { use: true } }));

    // Assert
    should(response.status).equal(403);
    should(devices.get(targetId)).deepEqual(target);
  });

  it('should let a device with pairing.use narrow ANOTHER device, and itself, with a step-up and nothing else', async () => {
    // Narrowing is never harder than widening: no pairing.configure, no holding of the axis, needed.
    // Arrange
    const holder = { ...LIMITED_DEVICE_GRANTS, pairing: { use: true, configure: false } };
    const target = { ...LIMITED_DEVICE_GRANTS, browser: { use: true, configure: true } };
    const { dispatcher, devices } = await mount({ caller: holder, target });

    // Act
    const other = await dispatcher.dispatch(patch({ browser: { use: false } }));
    const self = await dispatcher.dispatch(patch({ pairing: { use: false } }, callerId));

    // Assert
    should([other.status, self.status]).deepEqual([200, 200]);
    should(devices.get(targetId)?.browser).deepEqual({ use: false, configure: false });
    should(devices.get(callerId)?.pairing).deepEqual({ use: false, configure: false });
  });

  it('should refuse a DEFAULT device the route at all, since it lacks pairing.use, and say how to get it', async () => {
    // Arrange
    const { dispatcher } = await mount();

    // Act
    const response = await dispatcher.dispatch(patch({ fleet: { use: false } }, callerId));

    // Assert
    should(response.status).equal(403);
    should(jsonBody(response).code).equal('grant_device_not_granted');
    should(String(jsonBody(response).error)).match(/device grant <device> pairing --use/u);
  });

  it('should answer 404 for a device that is not paired, and for a malformed id', async () => {
    // Arrange
    const { dispatcher } = await mount({ caller: MANAGER });

    // Act
    const unknown = await dispatcher.dispatch(patch({ fleet: { use: false } }, `fy_device_id_${'z'.repeat(22)}`));
    const malformed = await dispatcher.dispatch(patch({ fleet: { use: false } }, 'nonsense'));

    // Assert
    should([unknown.status, malformed.status]).deepEqual([404, 404]);
    should(jsonBody(unknown).code).equal('pairing_device_not_found');
  });

  it('should refuse an empty or unknown-capability patch as a bad request', async () => {
    // Arrange
    const { dispatcher } = await mount({ caller: MANAGER });

    // Act
    const empty = await dispatcher.dispatch(patch({}));
    const unknown = await dispatcher.dispatch(patch({ audio: { use: true } }));

    // Assert
    should([empty.status, unknown.status]).deepEqual([400, 400]);
  });

  it('should record nothing and re-check nothing for a patch that changes nothing', async () => {
    // Arrange
    const { dispatcher, audit, rechecks } = await mount();

    // Act
    const response = await dispatcher.dispatch(fromHost({ fleet: { use: true } }));

    // Assert
    should(response.status).equal(200);
    should(audit).be.empty();
    should(rechecks()).equal(0);
  });
});

describe('what the device list says a caller may widen', () => {
  it('should list exactly what a remote manager holds, and nothing for a device that may not manage', async () => {
    // Arrange
    const manager = await mount({ caller: MANAGER });
    const plain = await mount({ caller: { ...LIMITED_DEVICE_GRANTS, pairing: { use: true, configure: false } } });
    const list = request({ path: '/v1/pair/devices', device: caller, loopback: false });

    // Act
    const managed = jsonBody(await manager.dispatcher.dispatch(list)) as PairedDevicesView;
    const unmanaged = jsonBody(await plain.dispatcher.dispatch(list)) as PairedDevicesView;

    // Assert
    should(managed.mayWiden).deepEqual({ ...ALL_OFF, ...MANAGER });
    should(managed.thisDeviceId).equal(callerId);
    should(unmanaged.mayWiden).deepEqual(ALL_OFF);
  });
});

describe('the device-grant service on its own', () => {
  const presentation = (overrides: Partial<CapabilityPresentation> = {}): CapabilityPresentation => ({
    loopback: false,
    adminToken: false,
    actor: `device:${callerId}`,
    stepUp: true,
    deviceGrants: MANAGER,
    ...overrides,
  });

  it('should refuse to judge a remote change while the daemon-wide document is undetermined', async () => {
    // Arrange
    const grants = grantSubsystem({ broken: true });
    await grants.refresh().catch(() => undefined);
    const service = deviceGrantsOver(grants, new Map([[targetId, LIMITED_DEVICE_GRANTS]]));

    // Act + Assert
    await should(service.change(targetId, { terminal: { use: true } }, presentation())).be.rejectedWith({
      failure: 'unavailable',
    });
  });

  it('should give nothing to widen to a governed caller that is not a device, and refuse its change', async () => {
    // A remote warden, or a remote admin token: governed, with no device record to hold anything.
    // Arrange
    const grants = grantSubsystem();
    await grants.refresh();
    const service = deviceGrantsOver(grants, new Map([[targetId, LIMITED_DEVICE_GRANTS]]));
    const { deviceGrants: _none, ...noDevice } = presentation();

    // Act + Assert
    should(service.mayWiden(noDevice)).deepEqual(ALL_OFF);
    should(service.mayWiden(presentation({ deviceGrants: null }))).deepEqual(ALL_OFF);
    await should(service.change(targetId, { terminal: { use: true } }, noDevice)).be.rejectedWith({
      failure: 'forbidden',
    });
  });

  it('should refuse a remote narrowing without a live step-up, and write nothing', async () => {
    // Arrange
    const grants = grantSubsystem();
    await grants.refresh();
    const service = deviceGrantsOver(grants, new Map([[targetId, LIMITED_DEVICE_GRANTS]]));

    // Act + Assert
    await should(service.change(targetId, { fleet: { use: false } }, presentation({ stepUp: false }))).be.rejectedWith({
      failure: 'step-up-required',
      message: /passkey confirmation from this device/u,
    });
  });

  it('should report a device removed between the read and the write as not found', async () => {
    // Arrange
    const grants = grantSubsystem();
    await grants.refresh();
    const racing = new DeviceGrantService({
      devices: { deviceGrants: () => LIMITED_DEVICE_GRANTS, setDeviceGrants: async () => false },
      daemonWide: () => grants.enforced(),
      audit: { record: async () => undefined, recent: async () => ({ entries: [], unreadable: 0, truncated: false }) },
      clock: { nowMs: () => 0 },
      clientName: 'fy',
    });

    // Act
    const outcome = await racing.change(targetId, { fleet: { use: false } }, presentation({ loopback: true }));

    // Assert
    should(outcome).equal('not-found');
  });

  it('should answer an undetermined daemon-wide document 503, and a defect as a defect', async () => {
    // Arrange — a remote manager reaches the subsystem; the subsystem then fails.
    const failing = (error: Error): DeviceGrantSubsystem => ({
      mayWiden: () => DEFAULT_CAPABILITY_GRANTS,
      change: async () => {
        throw error;
      },
    });
    const undetermined = (
      await mount({ caller: MANAGER, service: failing(new GrantError('unavailable', 'unreadable')) })
    ).dispatcher;
    const broken = (await mount({ caller: MANAGER, service: failing(new Error('disk on fire')) })).dispatcher;

    // Act
    const unavailable = await undetermined.dispatch(patch({ fleet: { use: false } }));
    const defect = await broken.dispatch(patch({ fleet: { use: false } }));

    // Assert
    should(unavailable.status).equal(503);
    should(jsonBody(unavailable).code).equal('grants_undetermined');
    should(defect.status).equal(500);
  });
});
