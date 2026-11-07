import { describe, it } from 'bun:test';
import { DEFAULT_SECURITY_SETTINGS } from '@ferretry/core-gate/contract';
import should from 'should';
import manifest from '../../../../manifest.ts';
import { stepUpRoutes } from '../../../../daemon/lib/routes/step-up.ts';
import {
  ChallengeLedger,
  type PasskeyStore,
  type PasskeyVerifierPort,
  StepUpRegistry,
  StepUpService,
  type StoredPasskey,
} from '../../../../daemon/lib/step-up/index.ts';
import { type SecuritySettings, stepUpRefusalCode } from '../../../../daemon/lib/wire.ts';
import { type CallOverrides, jsonBody, respond } from '../../../support/daemon/call.ts';

/**
 * THE UNLOCK, AS ACCESS ANSWERS IT (`docs/design/zero-trust.md` B6, owner decision 2026-10-14).
 *
 * The gate that answers `401 unlock_required` to a locked device is Gate's in 5.0 (it reads `unlockedUntil` from
 * Access's `credentials:device` provider and the route's `unlockExempt` flag), so the end-to-end cases that drove the
 * whole dispatcher over the terminal, session, Console, permission, dialog, MCP sign-in and security routes moved with
 * those packages. What stays here is Access's half: its unlock ceremony routes, which routes it declares a locked
 * device may reach, and the unlock fact it keeps — how long it holds, for which device, and what ends it.
 *
 * Everything runs through the REAL step-up service and Access's REAL route table; only the WebAuthn verdict is fixed.
 */

const T0 = Date.parse('2026-10-14T09:00:00.000Z');
const HOUR_MS = 3_600_000;
const ORIGIN = 'https://app.example.test';
const deviceId = `fy_device_id_${'d'.repeat(22)}`;
const phone = { deviceId, appSession: 'app-one' } as const;
const CREDENTIAL_ID = Buffer.from([1, 2, 3, 4]).toString('base64url');

class MemoryStore implements PasskeyStore {
  held: StoredPasskey[] = [
    {
      credentialId: CREDENTIAL_ID,
      deviceId,
      algorithm: -7,
      publicKeySpki: Buffer.from([9, 9, 9, 9]).toString('base64url'),
      signCount: 1,
      origin: ORIGIN,
      createdAt: '2026-10-14T08:00:00.000Z',
    },
  ];
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

/** Every assertion carries a higher counter than the last, as a real authenticator's does. */
let assertions = 0;
const verifier: PasskeyVerifierPort = {
  verifyRegistration: async () => ({ ok: false, reason: 'unused' }),
  verifyAssertion: async () => {
    assertions += 1;
    return { ok: true, signCount: 100 + assertions, origin: ORIGIN };
  },
};

const json = (value: unknown): string => JSON.stringify(value);
const originBody = json({ origin: ORIGIN });
const assertionBody = json({
  credentialId: CREDENTIAL_ID,
  clientDataJSON: 'Y2xpZW50',
  authenticatorData: 'YXV0aA',
  signature: 'c2ln',
});

/** The machine: settings in force (changeable after the fact) feeding the step-up service and its routes. */
function machine(initial: Partial<SecuritySettings> = {}) {
  const clock = { now: T0 };
  const settings: { current: SecuritySettings } = { current: { ...DEFAULT_SECURITY_SETTINGS, ...initial } };
  const registry = new StepUpRegistry({ nowMs: () => clock.now }, () => settings.current.stepUpWindowMinutes);
  registry.open(phone);
  registry.open({ ...phone, appSession: 'app-two' });
  const service = new StepUpService({
    store: new MemoryStore(),
    verifier,
    registry,
    challenges: new ChallengeLedger(),
    random: { bytes: length => new Uint8Array(length).fill(7) },
    clock: { nowMs: () => clock.now },
    devices: {
      device: async id => (id === deviceId ? { name: 'Phone', createdAt: '2026-10-14T08:00:00.000Z' } : undefined),
    },
    allowedOrigins: () => [ORIGIN],
    relyingPartyName: 'Ferretry',
    machineName: 'studio',
    settings: () => settings.current,
    audit: { record: async () => {} },
  });
  const routes = stepUpRoutes(service);
  const ask = (key: string, body?: string, overrides: CallOverrides = {}) =>
    respond(routes, key, { device: phone, ...(body === undefined ? {} : { body }), ...overrides });
  const unlock = async () => {
    const options = await ask('POST /v1/unlock/options', originBody);
    should(options.status).equal(200);
    const granted = await ask('POST /v1/unlock', assertionBody);
    should(granted.status).equal(200);
    return jsonBody(granted);
  };
  return { clock, settings, registry, service, routes, ask, unlock };
}

const refusedAs = (response: { status: number; body: string }, status: number, code: string) =>
  should([response.status, (JSON.parse(response.body) as { code?: string }).code]).deepEqual([status, code]);

describe('the routes a locked device may reach', () => {
  it('G74 should declare exactly its passkey panel, passkey registration and unlock ceremony unlock-exempt, as the manifest does', () => {
    // Arrange
    const { routes } = machine();
    const declared = manifest.actions.routes
      .filter(route => route.unlockExempt === true)
      .map(route => route.key)
      .sort();

    // Act
    const exempt = routes
      .filter(route => route.unlockExempt === true)
      .map(route => `${route.method} ${route.path}`)
      .sort();

    // Assert — the step-up ceremony is NOT among them: a locked device unlocks, it does not step up
    should(exempt).deepEqual(declared);
    should(exempt).deepEqual([
      'GET /v1/passkeys',
      'POST /v1/passkeys',
      'POST /v1/passkeys/options',
      'POST /v1/unlock',
      'POST /v1/unlock/options',
    ]);
  });

  it('R253 should serve exactly the routes a device needs to unlock to a device that has not unlocked yet', async () => {
    // Arrange
    const world = machine();
    should(world.service.unlockRequired(phone)).be.true();
    should(world.service.unlockedUntil(deviceId)).be.undefined();

    // Act
    const panel = await world.ask('GET /v1/passkeys');
    const options = await world.ask('POST /v1/unlock/options', originBody);
    const unlocked = await world.ask('POST /v1/unlock', assertionBody);

    // Assert
    should([panel.status, options.status, unlocked.status]).deepEqual([200, 200, 200]);
    should(world.service.unlockRequired(phone)).be.false();
  });

  it('should refuse the unlock ceremony to a caller that is not a paired device', async () => {
    // Arrange — the owner at the machine, and the admin token off it: neither holds a device to unlock
    const world = machine();

    // Act
    const atMachine = await world.ask('POST /v1/unlock/options', originBody, { device: undefined, host: true });
    const offMachine = await world.ask('POST /v1/unlock', assertionBody, { device: undefined });

    // Assert
    refusedAs(atMachine, 400, stepUpRefusalCode('not-a-device'));
    refusedAs(offMachine, 400, stepUpRefusalCode('not-a-device'));
  });
});

describe('the unlock', () => {
  it('R255 should be a daemon response naming when it lapses, and nothing else', async () => {
    // Arrange
    const world = machine();

    // Act
    const granted = await world.unlock();

    // Assert — 8 h is the shipped validity
    should(granted).deepEqual({ unlockedUntil: new Date(T0 + 8 * HOUR_MS).toISOString() });
  });

  it('P38 should hold for every page of the device for its period, and end at once when the device is revoked', async () => {
    // Arrange
    const world = machine();
    await world.unlock();
    world.registry.forgetDevice(deviceId);

    // Act
    world.clock.now = T0 + 8 * HOUR_MS - 1;
    const anotherPage = world.service.unlockRequired({ ...phone, appSession: 'app-two' });
    const until = world.service.unlockedUntil(deviceId);
    await world.service.forgetDevice(deviceId);

    // Assert
    should(anotherPage).be.false();
    should(until).equal(T0 + 8 * HOUR_MS);
    should(world.service.unlockedUntil(deviceId)).be.undefined();
    should(world.service.unlockRequired(phone)).be.true();
  });

  it('should lapse at unlockValidityHours, and ask again from that instant', async () => {
    // Arrange
    const world = machine({ unlockValidityHours: 2 });
    const granted = await world.unlock();
    should(granted.unlockedUntil).equal(new Date(T0 + 2 * HOUR_MS).toISOString());

    // Act
    world.clock.now = T0 + 2 * HOUR_MS - 1;
    const justBefore = [world.service.unlockRequired(phone), world.service.unlockedUntil(deviceId)];
    world.clock.now = T0 + 2 * HOUR_MS;
    const atLapse = [world.service.unlockRequired(phone), world.service.unlockedUntil(deviceId)];

    // Assert
    should(justBefore).deepEqual([false, T0 + 2 * HOUR_MS]);
    should(atLapse).deepEqual([true, undefined]);
  });

  it('G77 should judge an unlock against the settings in force, so a shorter period applies at once', async () => {
    // Arrange
    const world = machine({ unlockValidityHours: 8 });
    await world.unlock();

    // Act
    world.settings.current = { ...world.settings.current, unlockValidityHours: 1 };
    world.clock.now = T0 + HOUR_MS;

    // Assert
    should(world.service.unlockRequired(phone)).be.true();
    should(world.service.unlockedUntil(deviceId)).be.undefined();
  });

  it('should never be spent: acts leave the device unlocked and the step-up held', async () => {
    // Arrange
    const world = machine();
    await world.unlock();

    // Act
    for (let acts = 0; acts < 5; acts += 1) {
      world.service.spend(phone);
      world.service.spendFresh(phone);
    }

    // Assert
    should(world.service.unlockRequired(phone)).be.false();
    should(world.service.held(phone)).be.true();
  });

  it('should stop being the step-up once the owner asks per act, though the device stays unlocked', async () => {
    // Arrange
    const world = machine({ stepUpOnActions: true });
    await world.unlock();

    // Act — the unlock leaves its own per-act step-up for this page; drop it, so only the unlock is left
    world.registry.forgetDevice(deviceId);

    // Assert
    should(world.service.held(phone)).be.false();
    should(world.service.unlockRequired(phone)).be.false();
  });

  it('should ask nobody to unlock on a machine whose unlock is off, and hold no step-up for anybody', () => {
    // Arrange
    const world = machine({ unlockOnOpen: false });

    // Act / Assert — with the unlock off, every act asks for its own step-up instead
    should(world.service.unlockRequired(phone)).be.false();
    should(world.service.held(phone)).be.false();
  });
});
