import { describe, expect, test } from 'bun:test';
import { PROTOCOL, type PluginInventory, type FerretId } from '@ferretry/kernel/contract';
import {
  AUDIT_KINDS,
  AuditRecordSchema,
  CAPABILITIES,
  callerIsAgent,
  coreCapabilityName,
  DEFAULT_GATE_CONFIG,
  DEFAULT_GATE_SECURITY,
  DEFAULT_SECURITY_SETTINGS,
  deviceAdmits,
  ferretOf,
  GateConfigSchema,
  gateConfigLoosens,
  GRANT_AUDIT_MAX_ENTRIES,
  GrantAuditEntryViewSchema,
  GrantAuditViewSchema,
  GrantsPatchSchema,
  MEMBER_UNLOCK_DAYS_DEFAULT,
  ReadCapabilityGrantsSchema,
  SecuritySettingsSchema,
  securitySettingsOf,
  grantRefusalCode,
  isFerretToken,
  LIMITED_DEVICE_GRANTS,
  PLUGIN_INVENTORY_DESCRIPTOR,
  projectInventory,
  STEP_UP_ACTS,
  StepUpActSchema,
  STEP_UP_SUBJECTS,
  stepUpKeepsProof,
  stepUpSkippableAtMachine,
} from '../../contract/index.ts';
import {
  credentialProviderConformance,
  deviceStanding,
  StandInAdmission,
  FakeDeviceProvider,
  FakeStepUpWitness,
  ferretStanding,
  holder,
  ownerStanding,
  stepUpWitnessConformance,
  T0,
  wardenStanding,
} from '../../contract/testing/index.ts';

let next = 0;
credentialProviderConformance('FakeDeviceProvider', () => {
  const provider = new FakeDeviceProvider();
  return {
    provider,
    enrol: () => {
      next += 1;
      const id = holder(`dev-${next}`);
      provider.enrol(id);
      return id;
    },
    revoke: id => provider.revoke(id),
    narrow: id => provider.narrow(id, LIMITED_DEVICE_GRANTS),
  };
});

stepUpWitnessConformance('FakeStepUpWitness', () => {
  const witness = new FakeStepUpWitness({ nowMs: () => 0, settings: () => DEFAULT_GATE_CONFIG.security });
  return {
    witness,
    proved: act => {
      next += 1;
      const copy = { deviceId: `dev-${next}`, appSession: `app-${next}` };
      witness.grant(copy, true, act);
      return copy;
    },
  };
});

describe('the testing provider', () => {
  test('G149 FakeDeviceProvider pushes (watch), so the credentials suite runs its watch checks against it', () => {
    expect(typeof new FakeDeviceProvider().watch).toBe('function');
  });
});

describe('policy vocabulary', () => {
  test('capability refs keep their names and an unknown one is not a core capability', () => {
    expect(String(CAPABILITIES.terminal)).toBe('terminal');
    expect(coreCapabilityName(CAPABILITIES.secrets)).toBe('secrets');
    expect(coreCapabilityName('not-a-capability' as never)).toBeUndefined();
  });
  test('refusal codes are spelled as today', () => {
    expect(grantRefusalCode('device-not-granted')).toBe('grant_device_not_granted');
  });
  test('the closed step-up lists are today’s', () => {
    expect(stepUpSkippableAtMachine(STEP_UP_ACTS.addDevice)).toBe(true);
    expect(stepUpSkippableAtMachine(STEP_UP_ACTS.addTwoFactorKey)).toBe(false);
    expect(stepUpKeepsProof(STEP_UP_ACTS.approveSignInRule)).toBe(true);
    expect(stepUpKeepsProof(STEP_UP_ACTS.approveTaskPlan)).toBe(false);
    expect(StepUpActSchema.parse('share-link')).toBe(STEP_UP_ACTS.shareLink);
    expect(STEP_UP_SUBJECTS['add-2fa-key'].safeParse('st_0123456789abcdef01234567').success).toBe(true);
    expect(STEP_UP_SUBJECTS['add-2fa-key'].safeParse('tps_0123456789abcdef01234567').success).toBe(false);
  });
  test('audit kinds are refs with their names', () => {
    expect(String(AUDIT_KINDS['device.paired'])).toBe('device.paired');
    const record = AuditRecordSchema.parse({
      format: 1,
      at: '2026-11-07T12:00:00.000Z',
      event: 'device.paired',
      actor: { kind: 'host' },
      outcome: 'succeeded',
    });
    expect(String(record.event)).toBe('device.paired');
  });
});

describe('standing', () => {
  test('a ferret token is an agent caller, never a person (G7)', () => {
    const ferret = 'f1' as FerretId;
    const call = ferretStanding(ferret);
    expect(callerIsAgent(call.credential, call.actor)).toBe(true);
    expect(ferretOf(call)).toBe(ferret);
    expect(isFerretToken(`fys_${'a'.repeat(43)}`)).toBe(true);
    expect(isFerretToken('a'.repeat(47))).toBe(false);
  });
  test('the admin token is a person only with no ferret named behind it', () => {
    const owner = ownerStanding();
    expect(callerIsAgent(owner.credential, owner.actor)).toBe(false);
    expect(callerIsAgent(owner.credential, 'ferret:f1')).toBe(true);
    const warden = wardenStanding('w1' as FerretId);
    expect(callerIsAgent(warden.credential, warden.actor)).toBe(true);
  });
});

describe('gate.yaml', () => {
  test('an empty file reads as today’s defaults', () => {
    expect(GateConfigSchema.parse({})).toEqual(DEFAULT_GATE_CONFIG);
  });
  test('a misspelled capability in grants is refused, never discarded', () => {
    const grants = { ...DEFAULT_GATE_CONFIG.grants, termnial: { use: false, configure: false } };
    expect(GateConfigSchema.safeParse({ grants }).success).toBe(false);
    expect(
      GateConfigSchema.safeParse({ grants: { terminal: { use: true, configure: true, usee: false } } }).success,
    ).toBe(false);
    expect(GateConfigSchema.safeParse({ grants: { terminal: { use: 'no', configure: false } } }).success).toBe(false);
  });
  test('an omitted capability or axis in grants reads as the product default; a written one wins', () => {
    const read = GateConfigSchema.parse({ grants: { terminal: { use: false } } });
    expect(read.grants.terminal).toEqual({ use: false, configure: DEFAULT_GATE_CONFIG.grants.terminal.configure });
    expect(read.grants.secrets).toEqual(DEFAULT_GATE_CONFIG.grants.secrets);
  });
  test('widening a grant, turning the unlock off and honouring a remote warden loosen; narrowing does not', () => {
    const before = DEFAULT_GATE_CONFIG;
    const narrowed = { ...before, grants: { ...before.grants, terminal: { use: false, configure: false } } };
    expect(gateConfigLoosens(before, narrowed)).toEqual([]);
    expect(gateConfigLoosens(narrowed, before)).toEqual([
      'grants terminal.use turned on',
      'grants terminal.configure turned on',
    ]);
    const loose = { ...before, security: { ...before.security, unlockOnOpen: false }, warden: { remote: true } };
    expect(gateConfigLoosens(before, loose)).toEqual([
      'security unlockOnOpen loosened from true to false',
      'a remote warden is now honoured',
    ]);
  });
});

describe('inventory projection (§9.6)', () => {
  const inventory: PluginInventory = {
    protocol: PROTOCOL,
    plugins: ['gate', 'vault', 'ferrets', 'asks', 'kernel', 'access', 'terminals', 'board', 'warden', 'updates'].map(
      id => ({
        id,
        on: true,
        contract: `h-${id}`,
      }),
    ),
  };
  const surfaces = new Map([
    [
      'terminals',
      [
        {
          minimum: 'operator',
          caller: 'person',
          capability: { capability: CAPABILITIES.terminal, axis: 'use' },
          audit: { skip: 'x' },
          guard: 'secrets',
        },
      ],
    ],
    ['board', [{ minimum: 'authenticated', caller: 'any', audit: { skip: 'x' }, guard: { none: 'x' } }]],
    ['updates', [{ minimum: 'admin-token', caller: 'person', audit: { skip: 'x' }, guard: { none: 'x' } }]],
  ] as const);
  const ids = (projection: ReturnType<typeof projectInventory>) =>
    projection.outcome === 'shown' ? projection.inventory.plugins.map(p => p.id) : projection.status;

  test('the descriptor is today’s §9.6 one', () => {
    expect(PLUGIN_INVENTORY_DESCRIPTOR).toMatchObject({ minimum: 'authenticated', unlockExempt: true, noStore: true });
    expect(PLUGIN_INVENTORY_DESCRIPTOR.capability).toBeUndefined();
  });
  test('the owner and a ferret see every package', () => {
    expect(ids(projectInventory(inventory, { kind: 'owner' }, surfaces))).toHaveLength(10);
    expect(ids(projectInventory(inventory, { kind: 'ferret' }, surfaces))).toHaveLength(10);
  });
  test('a limited device sees the core pieces, Access and what its grants admit, nothing else', () => {
    expect(ids(projectInventory(inventory, { kind: 'device', grants: LIMITED_DEVICE_GRANTS }, surfaces))).toEqual([
      'gate',
      'vault',
      'ferrets',
      'asks',
      'kernel',
      'access',
      'board',
    ]);
  });
  test('the remote warden sees the core pieces and Warden; a member and no principal are refused', () => {
    expect(ids(projectInventory(inventory, { kind: 'warden' }, surfaces))).toEqual([
      'gate',
      'vault',
      'ferrets',
      'asks',
      'kernel',
      'warden',
    ]);
    expect(ids(projectInventory(inventory, { kind: 'member' }, surfaces))).toBe(403);
    expect(ids(projectInventory(inventory, { kind: 'none' }, surfaces))).toBe(401);
  });
  test('an unknown capability is never admitted', () => {
    expect(
      deviceAdmits(
        {
          minimum: 'authenticated',
          caller: 'any',
          capability: { capability: 'mystery' as never, axis: 'use' },
          audit: { skip: 'x' },
          guard: { none: 'x' },
        },
        LIMITED_DEVICE_GRANTS,
      ),
    ).toBe(false);
  });
});

describe('StandInAdmission', () => {
  const request = (path: string) =>
    ({
      method: 'GET',
      path,
      query: new Map(),
      headers: new Map(),
      arrival: { kind: 'carried', carrier: 'relay' },
      text: async () => '',
    }) as never;
  const route = (extra: object) => ({
    table: 'route' as const,
    request: request('/v1/x'),
    params: new Map(),
    descriptor: {
      method: 'GET',
      path: '/v1/x',
      minimum: 'operator' as const,
      caller: 'any' as const,
      audit: { skip: 'x' },
      guard: { none: 'x' } as const,
      ...extra,
    },
  });
  test('a person route refuses a ferret with owner_only (G7)', () => {
    const admission = new StandInAdmission(() => ferretStanding('f1' as FerretId));
    const decision = admission.admit(route({ caller: 'person' }));
    expect(decision.outcome === 'refused' && JSON.parse(decision.response.body).code).toBe('owner_only');
  });
  test('a limited device is refused a terminal it was not granted, by its own half', () => {
    const admission = new StandInAdmission(() => deviceStanding('d1', LIMITED_DEVICE_GRANTS, true));
    const decision = admission.admit(route({ capability: { capability: CAPABILITIES.terminal, axis: 'use' } }));
    expect(decision.outcome === 'refused' && JSON.parse(decision.response.body).code).toBe('grant_device_not_granted');
  });
  test('an undetermined policy fails closed', () => {
    const admission = new StandInAdmission(
      () => deviceStanding('d1'),
      () => undefined,
    );
    const decision = admission.admit(route({ capability: { capability: CAPABILITIES.fleet, axis: 'use' } }));
    expect(decision.outcome === 'refused' && JSON.parse(decision.response.body).code).toBe('grant_undetermined');
  });
  test('the warden never reaches an operator route; the owner reaches everything', () => {
    expect(new StandInAdmission(() => wardenStanding('w1' as FerretId)).admit(route({})).outcome).toBe('refused');
    expect(new StandInAdmission(() => ownerStanding()).admit(route({ minimum: 'admin-token' })).outcome).toBe(
      'admitted',
    );
    expect(
      new StandInAdmission(() => ownerStanding()).admit(
        route({ capability: { capability: CAPABILITIES.secrets, axis: 'configure' } }),
      ).outcome,
    ).toBe('admitted');
  });
});

describe('gate.yaml security.memberUnlockDays', () => {
  test('a whole number of days, 1 to 90, 30 unless the owner changed it', () => {
    expect(GateConfigSchema.parse({}).security.memberUnlockDays).toBe(MEMBER_UNLOCK_DAYS_DEFAULT);
    expect(
      GateConfigSchema.parse({ security: { ...DEFAULT_GATE_SECURITY, memberUnlockDays: 90 } }).security
        .memberUnlockDays,
    ).toBe(90);
    for (const bad of [0, 91, 1.5, '30'])
      expect(
        GateConfigSchema.safeParse({ security: { ...DEFAULT_GATE_SECURITY, memberUnlockDays: bad } }).success,
      ).toBe(false);
  });

  test('raising it is a loosening, held like any other; lowering it is not', () => {
    const at = (days: number) => ({
      ...DEFAULT_GATE_CONFIG,
      security: { ...DEFAULT_GATE_SECURITY, memberUnlockDays: days },
    });
    expect(gateConfigLoosens(at(30), at(31))).toEqual(['security memberUnlockDays loosened from 30 to 31']);
    expect(gateConfigLoosens(at(30), at(7))).toEqual([]);
  });

  test('the security settings /v1/security serves do not carry it', () => {
    expect(securitySettingsOf(DEFAULT_GATE_SECURITY)).toEqual(DEFAULT_SECURITY_SETTINGS);
    expect(SecuritySettingsSchema.safeParse(DEFAULT_GATE_SECURITY).success).toBe(false);
  });
});

describe('the grants wire', () => {
  test('a client reads a capability an older daemon omitted as off, and drops one it does not know', () => {
    const { sharing: _omitted, ...older } = DEFAULT_GATE_CONFIG.grants;
    const read = ReadCapabilityGrantsSchema.parse({ ...older, someday: { use: true, configure: true } });
    expect(read.sharing).toEqual({ use: false, configure: false });
    expect(read).not.toHaveProperty('someday');
  });

  test('a grant patch must change something, and names only known capabilities and axes', () => {
    expect(GrantsPatchSchema.safeParse({}).success).toBe(false);
    expect(GrantsPatchSchema.safeParse({ fleet: { use: false } }).success).toBe(true);
    expect(GrantsPatchSchema.safeParse({ fleet: { delete: true } }).success).toBe(false);
  });

  test('a grant history entry is names only, bounded', () => {
    expect(GRANT_AUDIT_MAX_ENTRIES).toBe(50);
    expect(
      GrantAuditViewSchema.safeParse({
        entries: [{ at: T0, actor: 'admin-cli', changes: ['fleet.use=off'] }],
        unreadable: 0,
        truncated: false,
      }).success,
    ).toBe(true);
    expect(GrantAuditEntryViewSchema.safeParse({ at: T0, actor: 123, changes: [] }).success).toBe(false);
  });
});
