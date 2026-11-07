import { describe, it } from 'bun:test';
import {
  type CapabilityGrants,
  CAPABILITY_NAMES as DAEMON_CAPABILITIES,
  LIMITED_DEVICE_GRANTS,
  grantRefusalCode,
} from '@ferretry/core-gate/contract';
import { type ApiResponse, errorResponse } from '@ferretry/kernel/contract';
import should from 'should';
import manifest from '../../../../manifest.ts';
import {
  CapabilityGrantService,
  DEFAULT_CAPABILITY_GRANTS,
  DeviceGrantService,
  type GrantAuditEntry,
  GrantError,
} from '../../../../daemon/lib/grants/index.ts';
import {
  type DeviceGrantSubsystem,
  type PairingSubsystem,
  pairingRoutes,
} from '../../../../daemon/lib/routes/pairing.ts';
import {
  type CapabilityPresentation,
  type DaemonId,
  type PairedDevice,
  type PairedDevicesView,
  STEP_UP_REQUIRED_CODE,
} from '../../../../daemon/lib/wire.ts';
import { call, jsonBody, respond } from '../../../support/daemon/call.ts';

/**
 * Changing ONE device's grants over `PATCH /v1/pair/devices/:deviceId/grants` (B5).
 *
 * Over the REAL grant subsystem and the REAL device-grant service, so the device grants the boundary narrows by and
 * the ones the route changes are the same map. In 5.0 Gate admits the call; {@link dispatch} stands in for the
 * boundary's one question this route asks (its declared `pairing.use` narrowing, decided by Access's own grant
 * policy) and stamps the presentation Gate would, so the route's own behaviour is what each case proves.
 */

const callerId = `fy_device_id_${'a'.repeat(22)}`;
const targetId = `fy_device_id_${'b'.repeat(22)}`;
const caller = { deviceId: callerId, appSession: 'app-one' };

const ALL_OFF = Object.fromEntries(
  Object.keys(DEFAULT_CAPABILITY_GRANTS).map(capability => [capability, { use: false, configure: false }]),
) as CapabilityGrants;

const record = (id: string, grants: CapabilityGrants): PairedDevice =>
  ({
    id,
    name: id === callerId ? 'Pixel 8' : 'iPad',
    platform: 'browser',
    createdAt: '2026-08-01T09:00:00.000Z',
    lastSeenAt: '2026-08-03T11:58:00.000Z',
    idleExpiresAt: '2026-09-02T11:58:00.000Z',
    grants,
  }) as PairedDevice;

/** Today's `grantSubsystem` (tests/unit/runtime/mounts/support.ts): the daemon-wide service over an in-memory document. */
function grantSubsystem(world: { grants?: CapabilityGrants; broken?: boolean } = {}): CapabilityGrantService {
  let recorded = world.grants ?? DEFAULT_CAPABILITY_GRANTS;
  const recordedChanges: GrantAuditEntry[] = [];
  return new CapabilityGrantService({
    document: {
      read: async () => {
        if (world.broken === true) throw new Error('the grant document could not be read');
        return recorded;
      },
      written: async () => (world.grants === undefined ? [] : DAEMON_CAPABILITIES),
      write: async next => {
        recorded = next;
      },
    },
    clock: { nowMs: () => 1_700_000_000_000 },
    audit: {
      record: async entry => {
        recordedChanges.push(entry);
      },
      recent: async limit => ({
        entries: [...recordedChanges].reverse().slice(0, limit),
        unreadable: 0,
        truncated: false,
      }),
    },
    clientName: 'fy',
  });
}

/** Today's `deviceGrantsOver`: the device-grant service over a map of device grants. */
function deviceGrantsOver(
  grants: CapabilityGrantService,
  devices: Map<string, CapabilityGrants> = new Map(),
  audit: GrantAuditEntry[] = [],
  changed: () => void = () => undefined,
): DeviceGrantService {
  return new DeviceGrantService({
    devices: {
      deviceGrants: id => devices.get(id),
      setDeviceGrants: async (id, next) => {
        if (!devices.has(id)) return false;
        devices.set(id, next);
        return true;
      },
    },
    daemonWide: () => grants.enforced(),
    audit: {
      record: async entry => {
        audit.push(entry);
      },
      recent: async () => ({ entries: [], unreadable: 0, truncated: false }),
    },
    clock: { nowMs: () => 1_700_000_000_000 },
    clientName: 'fy',
    changed,
  });
}

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

interface Call {
  readonly key: string;
  readonly host: boolean;
  readonly deviceId?: string;
  readonly body?: unknown;
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
  let mints = 0;
  const service = deviceGrantsOver(grants, devices, audit, () => {
    rechecks += 1;
  });
  const pairing: PairingSubsystem = {
    daemonId: `fy_daemon_${'a'.repeat(43)}` as DaemonId,
    mint: () => {
      mints += 1;
      throw new Error('not under test');
    },
    status: () => undefined,
    revoke: () => undefined,
    devices: async () => [...devices].map(([id, own]) => record(id, own)),
    revokeDevice: async () => false,
  };
  const routes = pairingRoutes(pairing, world.service ?? service);
  /** One call, admitted as Gate would admit it, then answered by the route. */
  const dispatch = async (request: Call): Promise<ApiResponse> => {
    const [method, path] = request.key.split(' ') as [string, string];
    const route = routes.find(candidate => candidate.method === method && candidate.path === path);
    if (route === undefined) throw new Error(`no route ${request.key}`);
    const presentation: Partial<CapabilityPresentation> = request.host
      ? {}
      : {
          stepUp: world.steppedUp ?? true,
          freshStepUp: world.freshProof ?? world.steppedUp ?? true,
          deviceGrants: devices.get(callerId) ?? null,
        };
    const overrides = {
      host: request.host,
      ...(request.host ? {} : { device: caller }),
      presentation,
      ...(request.deviceId === undefined ? {} : { params: { deviceId: request.deviceId } }),
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      standing: {
        // A widen TAKES its proof in one step as it is written (L4): a claim spends it.
        claimFreshStepUp: (() => {
          if (!(world.freshProof ?? world.steppedUp ?? true)) return false;
          spentFresh += 1;
          return true;
        }) as never,
      },
    };
    const demand = route.capability;
    if (demand !== undefined) {
      const standing = call(overrides).presentation as CapabilityPresentation;
      const decision = grants.decide(demand, standing);
      if (!decision.allowed)
        return errorResponse(
          403,
          grants.explain(demand, decision.refusal) ?? 'refused',
          grantRefusalCode(decision.refusal),
        );
    }
    try {
      return await respond(routes, request.key, overrides);
    } catch {
      return errorResponse(500, 'this daemon hit a defect', 'internal_error');
    }
  };
  return {
    dispatch,
    devices,
    audit,
    service,
    rechecks: () => rechecks,
    spentFresh: () => spentFresh,
    mints: () => mints,
  };
}

const KEY = 'PATCH /v1/pair/devices/:deviceId/grants';
const patch = (body: unknown, target = targetId): Call => ({ key: KEY, host: false, deviceId: target, body });
const fromHost = (body: unknown): Call => ({ key: KEY, host: true, deviceId: targetId, body });

/** A device allowed to manage devices and holding the terminal. */
const MANAGER: CapabilityGrants = {
  ...LIMITED_DEVICE_GRANTS,
  pairing: { use: true, configure: true },
  terminal: { use: true, configure: false },
};

describe('changing one device’s grants', () => {
  it('G146 the grants route demands pairing.use as a narrowing, in the route table and the manifest alike', () => {
    // Arrange
    const route = pairingRoutes(
      {} as PairingSubsystem,
      { mayWiden: () => ALL_OFF, change: async () => 'changed' } as DeviceGrantSubsystem,
    ).find(candidate => `${candidate.method} ${candidate.path}` === KEY);
    const declared = manifest.actions?.routes?.find(candidate => `${candidate.method} ${candidate.path}` === KEY);

    // Assert
    should(route?.capability).deepEqual({ capability: 'pairing', axis: 'use', narrowing: true });
    should(declared?.capability).deepEqual({ capability: 'pairing', axis: 'use', narrowing: true });
  });

  it('G150 should let the host widen any axis, with no step-up, answer the whole list, and audit one line per axis', async () => {
    // Arrange
    const { dispatch, devices, audit, rechecks } = await mount({ steppedUp: false });

    // Act
    const response = await dispatch(fromHost({ secrets: { configure: true }, terminal: { use: true } }));

    // Assert
    should(response.status).equal(200);
    should(devices.get(targetId)?.secrets).deepEqual({ use: true, configure: true });
    should(devices.get(targetId)?.terminal).deepEqual({ use: true, configure: false });
    const view = jsonBody(response) as PairedDevicesView;
    should(view.devices.find(entry => entry.id === targetId)?.grants.secrets).deepEqual({ use: true, configure: true });
    should(view.mayWiden).deepEqual(DEFAULT_CAPABILITY_GRANTS);
    // Audited through the grant journal, attributed, one line per axis that moved.
    should(audit).have.length(1);
    should(audit[0]?.actor).equal('admin-cli');
    should(audit[0]?.changes).deepEqual([
      `${targetId}/terminal.use=on`,
      `${targetId}/secrets.use=on`,
      `${targetId}/secrets.configure=on`,
    ]);
    // And the open streams are asked again.
    should(rechecks()).equal(1);
  });

  it('G143 should let a remote manager widen what it holds, once stepped up', async () => {
    // Arrange
    const { dispatch, devices } = await mount({ caller: MANAGER });

    // Act
    const response = await dispatch(patch({ terminal: { use: true } }));

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
    const refused = await unlocked.dispatch(patch({ terminal: { use: true } }));
    const allowed = await confirmed.dispatch(patch({ terminal: { use: true } }));

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
    const { dispatch, devices, spentFresh } = await mount({
      caller: MANAGER,
      target: MANAGER,
      freshProof: false,
    });

    // Act
    const response = await dispatch(patch({ terminal: { use: false } }));

    // Assert
    should(response.status).equal(200);
    should(devices.get(targetId)?.terminal).deepEqual({ use: false, configure: false });
    should(spentFresh()).equal(0);
  });

  it('G144 should let a remote manager NARROW with no per-act step-up, but ask a passkey proved for a widen (C31)', async () => {
    // Arrange — "ask again for each act" on: the manager holds no step-up and no fresh proof.
    const { dispatch, devices } = await mount({ caller: MANAGER, steppedUp: false });

    // Act
    const narrowed = await dispatch(patch({ fleet: { use: false } }));
    const widened = await dispatch(patch({ terminal: { use: true } }));

    // Assert — taking away is never harder than having it; giving more still asks for this act.
    should(narrowed.status).equal(200);
    should(devices.get(targetId)?.fleet).deepEqual({ use: false, configure: false });
    should(widened.status).equal(403);
    should(jsonBody(widened).code).equal(STEP_UP_REQUIRED_CODE);
    should(devices.get(targetId)?.terminal).deepEqual(LIMITED_DEVICE_GRANTS.terminal);
  });

  it('G145 should refuse a remote widen of an axis the caller does not hold, naming the host command', async () => {
    // Arrange
    const { dispatch, devices, audit } = await mount({ caller: MANAGER });

    // Act
    const response = await dispatch(patch({ secrets: { use: true } }));

    // Assert
    should(response.status).equal(403);
    should(jsonBody(response).code).equal('grant_forbidden');
    should(String(jsonBody(response).error)).match(new RegExp(`fy device grant ${targetId} secrets --use`, 'u'));
    should(devices.get(targetId)).deepEqual(LIMITED_DEVICE_GRANTS);
    should(audit).be.empty();
  });

  it('should refuse a remote widen by a device without pairing.configure', async () => {
    // Arrange — it holds the terminal and may USE pairing, but may not manage devices.
    const { dispatch } = await mount({ caller: { ...MANAGER, pairing: { use: true, configure: false } } });

    // Act
    const response = await dispatch(patch({ terminal: { use: true } }));

    // Assert
    should(response.status).equal(403);
    should(jsonBody(response).code).equal('grant_forbidden');
  });

  it('G133 should refuse a widen the daemon-wide document forbids, even to a device that holds it', async () => {
    // effective = daemonWide ∧ device: switching `terminal` off for everyone also stops it being passed on.
    // Arrange
    const { dispatch } = await mount({
      caller: MANAGER,
      daemonWide: { ...DEFAULT_CAPABILITY_GRANTS, terminal: { use: false, configure: false } },
    });

    // Act
    const response = await dispatch(patch({ terminal: { use: true } }));

    // Assert
    should(response.status).equal(403);
    should(jsonBody(response).code).equal('grant_forbidden');
  });

  it('G148 should refuse a mixed patch WHOLE when any field widens illegally', async () => {
    // Arrange — the target holds terminal; narrowing it is fine, widening secrets is not.
    const target = { ...LIMITED_DEVICE_GRANTS, terminal: { use: true, configure: false } };
    const { dispatch, devices } = await mount({ caller: MANAGER, target });

    // Act
    const response = await dispatch(patch({ terminal: { use: false }, secrets: { use: true } }));

    // Assert
    should(response.status).equal(403);
    should(devices.get(targetId)).deepEqual(target);
  });

  it('G144 should let a device with pairing.use narrow ANOTHER device, and itself, with a step-up and nothing else', async () => {
    // Narrowing is never harder than widening: no pairing.configure, no holding of the axis, needed.
    // Arrange
    const holder = { ...LIMITED_DEVICE_GRANTS, pairing: { use: true, configure: false } };
    const target = { ...LIMITED_DEVICE_GRANTS, browser: { use: true, configure: true } };
    const { dispatch, devices } = await mount({ caller: holder, target });

    // Act
    const other = await dispatch(patch({ browser: { use: false } }));
    const self = await dispatch(patch({ pairing: { use: false } }, callerId));

    // Assert
    should([other.status, self.status]).deepEqual([200, 200]);
    should(devices.get(targetId)?.browser).deepEqual({ use: false, configure: false });
    should(devices.get(callerId)?.pairing).deepEqual({ use: false, configure: false });
  });

  it('G146 should refuse a DEFAULT device the route at all, since it lacks pairing.use, and say how to get it', async () => {
    // Arrange
    const { dispatch } = await mount();

    // Act
    const response = await dispatch(patch({ fleet: { use: false } }, callerId));

    // Assert
    should(response.status).equal(403);
    should(jsonBody(response).code).equal('grant_device_not_granted');
    should(String(jsonBody(response).error)).match(/device grant <device> pairing --use/u);
  });

  it('should answer 404 for a device that is not paired, and for a malformed id', async () => {
    // Arrange
    const { dispatch } = await mount({ caller: MANAGER });

    // Act
    const unknown = await dispatch(patch({ fleet: { use: false } }, `fy_device_id_${'z'.repeat(22)}`));
    const malformed = await dispatch(patch({ fleet: { use: false } }, 'nonsense'));

    // Assert
    should([unknown.status, malformed.status]).deepEqual([404, 404]);
    should(jsonBody(unknown).code).equal('pairing_device_not_found');
  });

  it('should refuse an empty or unknown-capability patch as a bad request', async () => {
    // Arrange
    const { dispatch } = await mount({ caller: MANAGER });

    // Act
    const empty = await dispatch(patch({}));
    const unknown = await dispatch(patch({ audio: { use: true } }));

    // Assert
    should([empty.status, unknown.status]).deepEqual([400, 400]);
  });

  it('should record nothing and re-check nothing for a patch that changes nothing', async () => {
    // Arrange
    const { dispatch, audit, rechecks } = await mount();

    // Act
    const response = await dispatch(fromHost({ fleet: { use: true } }));

    // Assert
    should(response.status).equal(200);
    should(audit).be.empty();
    should(rechecks()).equal(0);
  });
});

describe('what the device list says a caller may widen', () => {
  it('G151 should list exactly what a remote manager holds, and nothing for a device that may not manage', async () => {
    // Arrange
    const manager = await mount({ caller: MANAGER });
    const plain = await mount({ caller: { ...LIMITED_DEVICE_GRANTS, pairing: { use: true, configure: false } } });
    const list: Call = { key: 'GET /v1/pair/devices', host: false };

    // Act
    const managed = jsonBody(await manager.dispatch(list)) as PairedDevicesView;
    const unmanaged = jsonBody(await plain.dispatch(list)) as PairedDevicesView;

    // Assert
    should(managed.mayWiden).deepEqual({ ...ALL_OFF, ...MANAGER });
    should(managed.thisDeviceId).equal(callerId);
    should(unmanaged.mayWiden).deepEqual(ALL_OFF);
  });
});

describe('what a device may pass on when it mints', () => {
  it('G137 should refuse a full code to a device that does not hold everything, and let it mint a limited one', async () => {
    // The choice travels in the mint request and is held by the daemon; a device passes on only what it holds.
    // Arrange
    const { dispatch, mints } = await mount({ caller: MANAGER });

    // Act
    const full = await dispatch({ key: 'POST /v1/pair/code', host: false, body: {} });
    const refusedMints = mints();
    await dispatch({ key: 'POST /v1/pair/code', host: false, body: { grants: 'limited' } });

    // Assert
    should(full.status).equal(403);
    should(jsonBody(full).code).equal('grant_forbidden');
    should(refusedMints).equal(0);
    should(mints()).equal(1);
  });
});

describe('the device-grant service on its own', () => {
  const presentation = (overrides: Partial<CapabilityPresentation> = {}): CapabilityPresentation => ({
    local: false,
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

  it('G140 should give nothing to widen to a governed caller that is not a device, and refuse its change', async () => {
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

  it('G144 should let a remote narrowing through without a live step-up (C31: narrowing never asks again)', async () => {
    // Arrange
    const grants = grantSubsystem();
    await grants.refresh();
    const devices = new Map([[targetId, LIMITED_DEVICE_GRANTS]]);
    const service = deviceGrantsOver(grants, devices);

    // Act
    await service.change(targetId, { fleet: { use: false } }, presentation({ stepUp: false }));

    // Assert
    should(devices.get(targetId)?.fleet).deepEqual({ use: false, configure: false });
  });

  it('should let one passkey pay for one widen: of two racing on one proof, exactly one is written (L4)', async () => {
    // Arrange — one fresh proof, claimed in one step as each widen is about to be written
    const grants = grantSubsystem();
    await grants.refresh();
    const otherId = `fy_device_id_${'c'.repeat(22)}`;
    const devices = new Map([
      [targetId, LIMITED_DEVICE_GRANTS],
      [otherId, LIMITED_DEVICE_GRANTS],
    ]);
    const service = deviceGrantsOver(grants, devices);
    let proofs = 1;
    const claim = (): boolean => {
      if (proofs <= 0) return false;
      proofs -= 1;
      return true;
    };
    const fresh = presentation({ freshStepUp: true });

    // Act — two widens, of two devices, race on the one proof
    const outcomes = await Promise.allSettled([
      service.change(targetId, { terminal: { use: true } }, fresh, claim),
      service.change(otherId, { terminal: { use: true } }, fresh, claim),
    ]);

    // Assert
    should(outcomes.map(outcome => outcome.status).toSorted()).eql(['fulfilled', 'rejected']);
    should(outcomes.find(outcome => outcome.status === 'rejected')).match({
      reason: { failure: 'widen-step-up-required' },
    });
    should(proofs).equal(0);
    should([devices.get(targetId)?.terminal.use, devices.get(otherId)?.terminal.use].filter(Boolean)).have.length(1);
  });

  it('should ask a governed widen with no live step-up for one, and claim no proof for it (review A M3)', async () => {
    // Arrange
    const grants = grantSubsystem();
    await grants.refresh();
    const service = deviceGrantsOver(grants, new Map([[targetId, LIMITED_DEVICE_GRANTS]]));
    let claimed = 0;

    // Act + Assert
    await should(
      service.change(targetId, { terminal: { use: true } }, presentation({ stepUp: false }), () => {
        claimed += 1;
        return true;
      }),
    ).be.rejectedWith({ failure: 'step-up-required' });
    should(claimed).equal(0);
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
    const outcome = await racing.change(targetId, { fleet: { use: false } }, presentation({ local: true }));

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
    const undetermined = (await mount({ caller: MANAGER, service: failing(new GrantError('unavailable', 'unreadable')) }))
      .dispatch;
    const broken = (await mount({ caller: MANAGER, service: failing(new Error('disk on fire')) })).dispatch;

    // Act
    const unavailable = await undetermined(patch({ fleet: { use: false } }));
    const defect = await broken(patch({ fleet: { use: false } }));

    // Assert
    should(unavailable.status).equal(503);
    should(jsonBody(unavailable).code).equal('grants_undetermined');
    should(defect.status).equal(500);
  });
});
