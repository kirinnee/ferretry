import { describe, expect, test } from 'bun:test';
import { PROTOCOL, type PluginInventory, type FerretId } from '@ferretry/kernel/contract';
import {
  AUDIT_KINDS,
  AuditRecordSchema,
  CAPABILITIES,
  callerIsAgent,
  coreCapabilityName,
  DEFAULT_GATE_CONFIG,
  deviceAdmits,
  ferretOf,
  GateConfigSchema,
  gateConfigLoosens,
  grantRefusalCode,
  isFerretToken,
  LIMITED_DEVICE_GRANTS,
  PLUGIN_INVENTORY_DESCRIPTOR,
  projectInventory,
  ReadCapabilityGrantsSchema,
  STEP_UP_ACTS,
  StepUpActSchema,
  STEP_UP_SUBJECTS,
  stepUpKeepsProof,
  stepUpSkippableAtMachine,
} from '../../contract/index.ts';
import {
  credentialProviderConformance,
  FakeDeviceProvider,
  FakeStepUpWitness,
  fakeSignature,
  ferretStanding,
  holder,
  ownerStanding,
  stepUpWitnessConformance,
  wardenStanding,
} from '../../contract/testing/index.ts';

let next = 0;
credentialProviderConformance('FakeDeviceProvider', () => {
  const provider = new FakeDeviceProvider();
  return {
    provider,
    enrol: () => {
      const id = holder(`dev-${(next += 1)}`);
      provider.enrol(id);
      return id;
    },
    revoke: id => provider.revoke(id),
    narrow: id => provider.narrow(id, LIMITED_DEVICE_GRANTS),
  };
});

stepUpWitnessConformance('FakeStepUpWitness', () => {
  const witness = new FakeStepUpWitness();
  return {
    witness,
    enrol: async () => {
      const id = holder(`dev-${(next += 1)}`);
      witness.register(id, 'credA');
      return {
        holder: id,
        good: { credentialId: 'credA', clientDataJSON: 'Y2Q', authenticatorData: 'YWQ', signature: fakeSignature(id) },
      };
    },
  };
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
  test('a stored grant set reads a capability it does not name as not granted', () => {
    const read = ReadCapabilityGrantsSchema.parse({ fleet: { use: true, configure: false } });
    expect(read.secrets).toEqual({ use: false, configure: false });
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
  test('G7 a ferret token is an agent caller, never a person', () => {
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
  test('widening a grant, turning the unlock off and honouring a remote warden loosen; narrowing does not', () => {
    const before = DEFAULT_GATE_CONFIG;
    const narrowed = { ...before, grants: { ...before.grants, terminal: { use: false, configure: false } } };
    expect(gateConfigLoosens(before, narrowed)).toEqual([]);
    expect(gateConfigLoosens(narrowed, before)).toEqual(['grants terminal.use turned on', 'grants terminal.configure turned on']);
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
    plugins: ['gate', 'vault', 'ferrets', 'asks', 'kernel', 'access', 'terminals', 'board', 'warden', 'updates'].map(id => ({
      id,
      on: true,
      contract: `h-${id}`,
    })),
  };
  const surfaces = new Map([
    ['terminals', [{ minimum: 'operator', caller: 'person', capability: { capability: CAPABILITIES.terminal, axis: 'use' }, audit: { skip: 'x' }, guard: 'secrets' }]],
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
    expect(ids(projectInventory(inventory, { kind: 'warden' }, surfaces))).toEqual(['gate', 'vault', 'ferrets', 'asks', 'kernel', 'warden']);
    expect(ids(projectInventory(inventory, { kind: 'member' }, surfaces))).toBe(403);
    expect(ids(projectInventory(inventory, { kind: 'none' }, surfaces))).toBe(401);
  });
  test('an unknown capability is never admitted', () => {
    expect(
      deviceAdmits(
        { minimum: 'authenticated', caller: 'any', capability: { capability: 'mystery' as never, axis: 'use' }, audit: { skip: 'x' }, guard: { none: 'x' } },
        LIMITED_DEVICE_GRANTS,
      ),
    ).toBe(false);
  });
});
