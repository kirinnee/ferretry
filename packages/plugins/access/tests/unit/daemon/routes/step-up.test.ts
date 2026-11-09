import { describe, it } from 'bun:test';
import { DEFAULT_SECURITY_SETTINGS } from '@ferretry/core-gate/contract';
import should from 'should';
import { toBase64Url } from '../../../../daemon/lib/proof/binary.ts';
import {
  type StagedPasteRuleBinding,
  type StagedSeedBinding,
  type StagedSignInRuleBinding,
  type StagedTaskPlanBinding,
  stepUpRoutes,
} from '../../../../daemon/lib/routes/step-up.ts';
import {
  ChallengeLedger,
  type PasskeyStore,
  type PasskeyVerifierPort,
  StepUpRegistry,
  StepUpService,
  type StoredPasskey,
} from '../../../../daemon/lib/step-up/index.ts';
import { STEP_UP_ACTS, stepUpRefusalCode } from '../../../../daemon/lib/wire.ts';
import { type CallOverrides, jsonBody, respond } from '../../../support/daemon/call.ts';

/**
 * Access's passkey step-up routes, over the REAL step-up service: who the caller is comes from the kernel-stamped
 * principal and the arrival, never a body, and a ceremony the caller may not have issues nothing.
 */

const T0 = Date.parse('2026-10-14T09:00:00.000Z');
const ORIGIN = 'https://app.example.test';
const phoneId = `fy_device_id_${'d'.repeat(22)}`;
const laptopId = `fy_device_id_${'e'.repeat(22)}`;
const phone = { deviceId: phoneId, appSession: 'app-one' } as const;
const laptop = { deviceId: laptopId, appSession: 'laptop-one' } as const;
const STAGE = `srs_${'a'.repeat(24)}` as const;
const DERIVED = new Uint8Array(32).fill(5);

const stored = (deviceId: string, credentialId: string): StoredPasskey => ({
  credentialId,
  deviceId,
  algorithm: -7,
  publicKeySpki: Buffer.from([9, 9, 9, 9]).toString('base64url'),
  signCount: 1,
  origin: ORIGIN,
  createdAt: '2026-10-14T08:00:00.000Z',
});

class MemoryStore implements PasskeyStore {
  held: StoredPasskey[] = [stored(phoneId, 'AQIDBA'), stored(laptopId, 'BQYHCA')];
  async list(id: string) {
    return this.held.filter(passkey => passkey.deviceId === id);
  }
  async holder(credentialId: string) {
    return this.held.find(passkey => passkey.credentialId === credentialId)?.deviceId;
  }
  async add(passkey: StoredPasskey) {
    this.held.push(passkey);
  }
  async updateSignCount(id: string, credentialId: string, signCount: number) {
    const passkey = this.held.find(entry => entry.deviceId === id && entry.credentialId === credentialId);
    if (passkey === undefined || signCount <= passkey.signCount) return false;
    this.held = this.held.map(entry => (entry === passkey ? { ...entry, signCount } : entry));
    return true;
  }
  async forgetDevice(id: string) {
    this.held = this.held.filter(passkey => passkey.deviceId !== id);
  }
}

let assertions = 0;
const verifier: PasskeyVerifierPort = {
  verifyRegistration: async () => ({ ok: false, reason: 'unused' }),
  verifyAssertion: async () => {
    assertions += 1;
    return { ok: true, signCount: 100 + assertions, origin: ORIGIN };
  },
};

interface StagedBindings {
  readonly seeds?: StagedSeedBinding;
  readonly plans?: StagedTaskPlanBinding;
  readonly pasteRules?: StagedPasteRuleBinding;
}

function machine(bindings: StagedBindings = {}) {
  const clock = { now: T0 };
  const registry = new StepUpRegistry({ nowMs: () => clock.now });
  registry.open(phone);
  registry.open({ ...phone, appSession: 'app-two' });
  registry.open(laptop);
  const audited: { readonly actor: string; readonly changes: readonly string[] }[] = [];
  const draws: number[] = [];
  const service = new StepUpService({
    store: new MemoryStore(),
    verifier,
    registry,
    challenges: new ChallengeLedger(),
    random: {
      bytes: length => {
        draws.push(length);
        return new Uint8Array(length).fill(7);
      },
    },
    clock: { nowMs: () => clock.now },
    devices: {
      device: async id =>
        id === phoneId
          ? { name: 'Phone', createdAt: '2026-10-14T08:00:00.000Z' }
          : id === laptopId
            ? { name: 'Laptop', createdAt: '2026-10-14T08:00:00.000Z' }
            : undefined,
    },
    allowedOrigins: () => [ORIGIN],
    relyingPartyName: 'Ferretry',
    machineName: 'studio',
    settings: () => DEFAULT_SECURITY_SETTINGS,
    audit: {
      record: async entry => {
        audited.push(entry);
      },
    },
  });
  /** One staged standing rule, waiting on the PHONE only. */
  const asked: string[] = [];
  const rules: StagedSignInRuleBinding = {
    challengeOf: (stage, deviceId) => {
      asked.push(`${stage} ${deviceId}`);
      return stage === STAGE && deviceId === phoneId ? DERIVED : undefined;
    },
  };
  const routes = stepUpRoutes(service, bindings.seeds, bindings.plans, rules, bindings.pasteRules);
  const ask = (key: string, body: unknown, overrides: CallOverrides) =>
    respond(routes, key, { body: JSON.stringify(body), ...overrides });
  return { clock, registry, service, routes, ask, audited, draws, asked };
}

const refusedAs = (response: { status: number; body: string }, status: number, code: string) =>
  should([response.status, (JSON.parse(response.body) as { code?: string }).code]).deepEqual([status, code]);

describe('the standing-rule step-up options', () => {
  it('G86 should answer only the device the stage waits on; anyone else, or a stage not waiting, gets 404 and no challenge', async () => {
    // Arrange
    const world = machine();
    const body = (subject: string) => ({ origin: ORIGIN, act: STEP_UP_ACTS.approveSignInRule, subject });

    // Act
    const otherDevice = await world.ask('POST /v1/step-up/options', body(STAGE), { device: laptop });
    const notWaiting = await world.ask('POST /v1/step-up/options', body(`srs_${'b'.repeat(24)}`), { device: phone });
    const atMachine = await world.ask('POST /v1/step-up/options', body(STAGE), { host: true });
    const waitedOn = await world.ask('POST /v1/step-up/options', body(STAGE), { device: phone });

    // Assert — the refusals carry no challenge, and the one answer carries exactly the derived one, never a draw
    for (const refused of [otherDevice, notWaiting, atMachine]) {
      refusedAs(refused, 404, 'stage_not_found');
      should(jsonBody(refused)).not.have.property('challenge');
    }
    should(waitedOn.status).equal(200);
    should(jsonBody(waitedOn).challenge).equal(toBase64Url(DERIVED));
    should(world.draws).deepEqual([]);
    // The machine's caller named no device, so the stage was never even asked about for it.
    should(world.asked).deepEqual([`${STAGE} ${laptopId}`, `srs_${'b'.repeat(24)} ${phoneId}`, `${STAGE} ${phoneId}`]);
  });
});

describe('the staged-subject step-up options', () => {
  const SEED_STAGE = `st_${'a'.repeat(24)}` as const;
  const PLAN_STAGE = `tps_${'a'.repeat(24)}` as const;
  const PASTE_STAGE = `prs_${'a'.repeat(24)}` as const;
  const options = (act: string, subject: string) => ({ origin: ORIGIN, act, subject });

  it('G86 should bind a 2FA key save to the one stage that is waiting, and issue no challenge for any other or when none are staged', async () => {
    // Arrange
    const asked: string[] = [];
    const staged = machine({
      seeds: {
        boundSubjectOf: stage => {
          asked.push(stage);
          return stage === SEED_STAGE ? 'account-1/st-a' : undefined;
        },
      },
    });
    const none = machine();
    const body = (stage: string) => options(STEP_UP_ACTS.addTwoFactorKey, stage);

    // Act
    const waiting = await staged.ask('POST /v1/step-up/options', body(SEED_STAGE), { device: phone });
    const elsewhere = await staged.ask('POST /v1/step-up/options', body(`st_${'b'.repeat(24)}`), { device: phone });
    const unstaged = await none.ask('POST /v1/step-up/options', body(SEED_STAGE), { device: phone });

    // Assert
    should(waiting.status).equal(200);
    should(jsonBody(waiting)).have.property('challenge');
    for (const refused of [elsewhere, unstaged]) {
      refusedAs(refused, 404, 'stage_not_found');
      should(jsonBody(refused)).not.have.property('challenge');
    }
    should(asked).deepEqual([SEED_STAGE, `st_${'b'.repeat(24)}`]);
    should(none.draws).deepEqual([]);
  });

  it('G86 should bind a task plan approval to the one staged selection that is waiting, and issue no challenge otherwise', async () => {
    // Arrange
    const staged = machine({
      plans: { boundSubjectOf: stage => (stage === PLAN_STAGE ? 'plan-1/lines' : undefined) },
    });
    const none = machine();
    const body = (stage: string) => options(STEP_UP_ACTS.approveTaskPlan, stage);

    // Act
    const waiting = await staged.ask('POST /v1/step-up/options', body(PLAN_STAGE), { device: phone });
    const elsewhere = await staged.ask('POST /v1/step-up/options', body(`tps_${'b'.repeat(24)}`), { device: phone });
    const unstaged = await none.ask('POST /v1/step-up/options', body(PLAN_STAGE), { device: phone });

    // Assert
    should(waiting.status).equal(200);
    for (const refused of [elsewhere, unstaged]) {
      refusedAs(refused, 404, 'stage_not_found');
      should(jsonBody(refused)).not.have.property('challenge');
    }
  });

  it('G86 should ask the paste rule binding for this device and this kind of change, and refuse a stage not waiting for it', async () => {
    // Arrange
    const asked: string[] = [];
    const staged = machine({
      pasteRules: {
        boundSubjectOf: (stage, kind, deviceId) => {
          asked.push(`${stage} ${kind} ${deviceId}`);
          return stage === PASTE_STAGE && deviceId === phoneId ? `bound-${kind}` : undefined;
        },
      },
    });
    const none = machine();

    // Act
    const rule = await staged.ask('POST /v1/step-up/options', options(STEP_UP_ACTS.approvePasteRule, PASTE_STAGE), {
      device: phone,
    });
    const targets = await staged.ask(
      'POST /v1/step-up/options',
      options(STEP_UP_ACTS.allowProfileTargets, PASTE_STAGE),
      { device: phone },
    );
    const otherDevice = await staged.ask(
      'POST /v1/step-up/options',
      options(STEP_UP_ACTS.approvePasteRule, PASTE_STAGE),
      { device: laptop },
    );
    const atMachine = await staged.ask(
      'POST /v1/step-up/options',
      options(STEP_UP_ACTS.approvePasteRule, PASTE_STAGE),
      { host: true },
    );
    const unstaged = await none.ask('POST /v1/step-up/options', options(STEP_UP_ACTS.approvePasteRule, PASTE_STAGE), {
      device: phone,
    });

    // Assert: the stage is only ever asked about for a device, and with the kind the act names
    should([rule.status, targets.status]).deepEqual([200, 200]);
    for (const refused of [otherDevice, atMachine, unstaged]) {
      refusedAs(refused, 404, 'paste_rule_stage_not_found');
      should(jsonBody(refused)).not.have.property('challenge');
    }
    should(asked).deepEqual([
      `${PASTE_STAGE} rule ${phoneId}`,
      `${PASTE_STAGE} profile-targets ${phoneId}`,
      `${PASTE_STAGE} rule ${laptopId}`,
    ]);
  });
});

describe('the ceremonies that need no staged subject', () => {
  it('P2 should issue a step-up challenge for a plain act, then grant the step-up on an assertion the device proves', async () => {
    // Arrange
    const world = machine();
    const assertion = {
      credentialId: 'AQIDBA',
      clientDataJSON: 'Y2xpZW50',
      authenticatorData: 'YXV0aA',
      signature: 'c2ln',
    };

    // Act
    const issued = await world.ask('POST /v1/step-up/options', { origin: ORIGIN }, { device: phone });
    const granted = await world.ask('POST /v1/step-up', assertion, { device: phone });

    // Assert
    should(issued.status).equal(200);
    should(jsonBody(issued)).have.property('challenge');
    should(granted.status).equal(200);
    should(jsonBody(granted)).have.property('expiresAt');
  });

  it('P2 should refuse a passkey registration from a caller that is not a device, and one with no challenge issued', async () => {
    // Arrange
    const world = machine();
    const registration = { credentialId: 'AQIDBA', clientDataJSON: 'Y2xpZW50', attestationObject: 'YXR0ZXN0' };

    // Act
    const atMachine = await world.ask('POST /v1/passkeys', registration, { host: true });
    const unchallenged = await world.ask('POST /v1/passkeys', registration, { device: phone });

    // Assert
    refusedAs(atMachine, 400, stepUpRefusalCode('not-a-device'));
    refusedAs(unchallenged, 401, stepUpRefusalCode('not-verified'));
  });
});

describe('re-opening a passkey window', () => {
  it('P133 should never be done by a browser, its own window or another device’s, nor by the admin token off the machine', async () => {
    // Arrange
    const world = machine();

    // Act
    const own = await world.ask('POST /v1/passkeys/registration-window', { deviceId: phoneId }, { device: phone });
    const other = await world.ask('POST /v1/passkeys/registration-window', { deviceId: laptopId }, { device: phone });
    const offMachine = await world.ask('POST /v1/passkeys/registration-window', { deviceId: phoneId }, {});

    // Assert — and nothing was audited, because nothing was opened
    for (const refused of [own, other, offMachine]) refusedAs(refused, 403, stepUpRefusalCode('not-at-machine'));
    should(world.audited).deepEqual([]);
  });

  it('P132 should re-pair nothing: the device keeps its unlock, its step-ups and its other pages', async () => {
    // Arrange — the phone unlocked on one page and stepped up on another
    const world = machine();
    await world.ask('POST /v1/unlock/options', { origin: ORIGIN }, { device: phone });
    const unlocked = await world.ask(
      'POST /v1/unlock',
      { credentialId: 'AQIDBA', clientDataJSON: 'Y2xpZW50', authenticatorData: 'YXV0aA', signature: 'c2ln' },
      { device: phone },
    );
    should(unlocked.status).equal(200);
    world.registry.grant({ ...phone, appSession: 'app-two' }, world.clock.now);

    // Act
    const opened = await world.ask('POST /v1/passkeys/registration-window', { deviceId: phoneId }, { host: true });

    // Assert
    should(opened.status).equal(200);
    should(jsonBody(opened)).deepEqual({
      deviceId: phoneId,
      deviceName: 'Phone',
      closesAt: new Date(T0 + 10 * 60_000).toISOString(),
    });
    should(world.service.unlockRequired(phone)).be.false();
    should(world.service.unlockedUntil(phoneId)).not.be.undefined();
    should(world.registry.held({ ...phone, appSession: 'app-two' }, world.clock.now)).be.true();
    should(world.audited).deepEqual([
      { actor: 'admin-cli', changes: [`passkey.registration-window=${phoneId}`], at: new Date(T0).toISOString() },
    ]);
  });
});
