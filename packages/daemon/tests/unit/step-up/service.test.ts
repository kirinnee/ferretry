import { describe, it } from 'bun:test';
import {
  MAX_PASSKEYS_PER_DEVICE,
  PASSKEY_CHALLENGE_TTL_SECONDS,
  PASSKEY_REGISTRATION_WINDOW_SECONDS,
  STEP_UP_TTL_SECONDS,
} from '@ferretry/protocol';
import { toBase64Url } from '@ferretry/relay';
import should from 'should';
import {
  ChallengeLedger,
  type PasskeyStore,
  passkeyVerifier,
  relyingPartyIdFor,
  type StepUpCaller,
  StepUpRegistry,
  StepUpService,
  type StepUpSubject,
  type StoredPasskey,
} from '../../../src/lib/step-up/index.ts';
import {
  type Authenticator,
  assertion,
  attestedCredential,
  CHALLENGE,
  CREDENTIAL_ID,
  cbor,
  clientData,
  es256Authenticator,
  ORIGIN,
  registration,
  webCrypto,
} from '../../support/passkey-authenticator.ts';
import { deviceId } from '../push/support.ts';

/**
 * The step-up service over the REAL WebAuthn verifier and a software authenticator, so every verdict
 * here is a verdict on bytes laid out as an authenticator lays them out — origin binding and the
 * counter rule included — rather than on a fake's say-so.
 */

const PAIRED_AT_MS = Date.parse('2026-10-13T10:00:00.000Z');
const OTHER_ORIGIN = 'https://ferretry.example.com';

class MemoryPasskeys implements PasskeyStore {
  rows: StoredPasskey[] = [];
  async list(id: string) {
    return this.rows.filter(row => row.deviceId === id);
  }
  async add(passkey: StoredPasskey) {
    this.rows.push(passkey);
  }
  async updateSignCount(id: string, credentialId: string, signCount: number) {
    this.rows = this.rows.map(row =>
      row.deviceId === id && row.credentialId === credentialId ? { ...row, signCount } : row,
    );
  }
  async forgetDevice(id: string) {
    this.rows = this.rows.filter(row => row.deviceId !== id);
  }
}

const phone: StepUpSubject = { deviceId: deviceId('a'), appSession: 'tab-one' };
const remote = (subject: StepUpSubject = phone): StepUpCaller => ({ device: subject, hostLocal: false });

function fixture(options: { nowMs?: number; origins?: readonly string[]; paired?: boolean } = {}) {
  const clock = { now: options.nowMs ?? PAIRED_AT_MS + 60_000 };
  const store = new MemoryPasskeys();
  // ONE construction point for the registry, so a change to its constructor is a one-line edit.
  const registry = new StepUpRegistry();
  const service = new StepUpService({
    store,
    verifier: passkeyVerifier(webCrypto),
    registry,
    challenges: new ChallengeLedger(),
    // The software authenticator signs over a fixed challenge, so the daemon "randomly" issues it.
    random: { bytes: length => CHALLENGE.slice(0, length) },
    clock: { nowMs: () => clock.now },
    devices: {
      device: async id =>
        options.paired === false || id !== phone.deviceId
          ? undefined
          : { name: 'Phone', createdAt: new Date(PAIRED_AT_MS).toISOString() },
    },
    allowedOrigins: () => options.origins ?? [ORIGIN, OTHER_ORIGIN],
    relyingPartyName: 'Ferretry',
  });
  return { clock, store, registry, service };
}

const registrationBody = async (authenticator: Authenticator, credentialId = CREDENTIAL_ID) => {
  const made = await registration(authenticator, {
    auth: { flags: 0x45, attested: attestedCredential(cbor(authenticator.coseKey), credentialId) },
  });
  return {
    credentialId: toBase64Url(credentialId),
    clientDataJSON: toBase64Url(made.clientDataJSON),
    attestationObject: toBase64Url(made.attestationObject),
  };
};

const assertionBody = async (
  authenticator: Authenticator,
  overrides: Parameters<typeof assertion>[1] = {},
  credentialId = toBase64Url(CREDENTIAL_ID),
) => {
  const made = await assertion(authenticator, overrides);
  return {
    credentialId,
    clientDataJSON: toBase64Url(made.clientDataJSON),
    authenticatorData: toBase64Url(made.authenticatorData),
    signature: toBase64Url(made.signature),
  };
};

/** Registers the phone's first passkey through both calls, as the app does. */
async function enrol(service: StepUpService, authenticator: Authenticator, caller = remote()) {
  const options = await service.registrationOptions(caller, ORIGIN);
  should(options.ok).be.true();
  return await service.register(caller, await registrationBody(authenticator));
}

describe('StepUpService', () => {
  describe('a caller that is not a device', () => {
    it('should refuse every ceremony with not-a-device', async () => {
      // Arrange
      const { service } = fixture();
      const nobody: StepUpCaller = { hostLocal: true };
      const authenticator = await es256Authenticator();

      // Act
      const outcomes = [
        await service.view(nobody),
        await service.registrationOptions(nobody, ORIGIN),
        await service.register(nobody, await registrationBody(authenticator)),
        await service.stepUpOptions(nobody, ORIGIN),
        await service.stepUp(nobody, await assertionBody(authenticator)),
      ];

      // Assert
      should(outcomes).eql(outcomes.map(() => ({ ok: false, refusal: 'not-a-device' })));
    });

    it('should refuse registration options for a device the directory no longer knows', async () => {
      // Arrange
      const { service } = fixture({ paired: false });

      // Act
      const hosted = await service.registrationOptions({ device: phone, hostLocal: true }, ORIGIN);

      // Assert
      should(hosted).eql({ ok: false, refusal: 'not-a-device' });
    });
  });

  describe('who may register a passkey (B2)', () => {
    it('should open the first-passkey window for ten minutes after pairing', async () => {
      // Arrange
      const { service } = fixture();

      // Act
      const view = await service.view(remote());

      // Assert
      should(view).eql({
        ok: true,
        value: {
          passkeys: [],
          registration: 'first-window',
          registrationClosesAt: new Date(PAIRED_AT_MS + PASSKEY_REGISTRATION_WINDOW_SECONDS * 1_000).toISOString(),
        },
      });
    });

    it('should close the window once it lapses', async () => {
      // Arrange
      const { service } = fixture({ nowMs: PAIRED_AT_MS + PASSKEY_REGISTRATION_WINDOW_SECONDS * 1_000 });

      // Act
      const view = await service.view(remote());
      const options = await service.registrationOptions(remote(), ORIGIN);

      // Assert
      should(view).eql({ ok: true, value: { passkeys: [], registration: 'closed' } });
      should(options).eql({ ok: false, refusal: 'registration-closed' });
    });

    it('should close the window for a device the directory no longer knows', async () => {
      // Arrange
      const { service } = fixture({ paired: false });

      // Act / Assert
      should(await service.view(remote())).eql({ ok: true, value: { passkeys: [], registration: 'closed' } });
    });

    it('should close the window once the device holds a passkey and its step-up has lapsed', async () => {
      // Arrange
      const { clock, service } = fixture();
      await enrol(service, await es256Authenticator());
      clock.now += STEP_UP_TTL_SECONDS * 1_000;

      // Act
      const options = await service.registrationOptions(remote(), ORIGIN);

      // Assert
      should(options).eql({ ok: false, refusal: 'registration-closed' });
    });

    it('should let a device with a current step-up add a second passkey after the window', async () => {
      // Arrange — enrolled inside the window; now both the window and that step-up have lapsed.
      const { clock, service, store } = fixture();
      const first = await es256Authenticator();
      await enrol(service, first);
      clock.now += STEP_UP_TTL_SECONDS * 1_000;
      const closed = await service.view(remote());
      await service.stepUpOptions(remote(), ORIGIN);
      should((await service.stepUp(remote(), await assertionBody(first))).ok).be.true();
      const second = await es256Authenticator();

      // Act
      const view = await service.view(remote());
      await service.registrationOptions(remote(), ORIGIN);
      const added = await service.register(
        remote(),
        await registrationBody(second, Uint8Array.from({ length: 16 }, () => 0x11)),
      );

      // Assert
      should(closed).match({ ok: true, value: { registration: 'closed' } });
      should(view).match({ ok: true, value: { registration: 'stepped-up' } });
      should(added).match({ ok: true, value: { origin: ORIGIN } });
      should(store.rows).have.length(2);
    });

    it('should let the host register at any time', async () => {
      // Arrange
      const { service } = fixture({ nowMs: PAIRED_AT_MS + 86_400_000 });
      const host: StepUpCaller = { device: phone, hostLocal: true };

      // Act
      const view = await service.view(host);
      const added = await enrol(service, await es256Authenticator(), host);

      // Assert
      should(view).eql({ ok: true, value: { passkeys: [], registration: 'host' } });
      should(added.ok).be.true();
    });

    it('should re-check the window at registration, not trust the options call', async () => {
      // Arrange
      const { clock, service } = fixture({ nowMs: PAIRED_AT_MS + PASSKEY_REGISTRATION_WINDOW_SECONDS * 1_000 - 1 });
      await service.registrationOptions(remote(), ORIGIN);
      clock.now += 1;

      // Act
      const added = await service.register(remote(), await registrationBody(await es256Authenticator()));

      // Assert
      should(added).eql({ ok: false, refusal: 'registration-closed' });
    });

    it('should refuse past the per-device limit at options and at registration', async () => {
      // Arrange
      const { service, store } = fixture();
      const authenticator = await es256Authenticator();
      await enrol(service, authenticator);
      const template = store.rows[0] as StoredPasskey;
      for (let index = 1; index < MAX_PASSKEYS_PER_DEVICE; index += 1)
        store.rows.push({ ...template, credentialId: `c${index}` });

      // Act
      const options = await service.registrationOptions(remote(), ORIGIN);
      const added = await service.register(remote(), await registrationBody(authenticator));

      // Assert
      should(options).eql({ ok: false, refusal: 'too-many-passkeys' });
      should(added).eql({ ok: false, refusal: 'too-many-passkeys' });
    });

    it('should issue options naming this origin as the relying party and excluding held credentials', async () => {
      // Arrange
      const { service } = fixture();

      // Act
      const options = await service.registrationOptions(remote(), ORIGIN);

      // Assert
      should(options).eql({
        ok: true,
        value: {
          challenge: toBase64Url(CHALLENGE),
          rp: { id: relyingPartyIdFor(ORIGIN), name: 'Ferretry' },
          user: {
            id: toBase64Url(new TextEncoder().encode(phone.deviceId)),
            name: 'Phone',
            displayName: 'Phone',
          },
          pubKeyCredParams: [
            { type: 'public-key', alg: -7 },
            { type: 'public-key', alg: -8 },
            { type: 'public-key', alg: -257 },
          ],
          timeout: PASSKEY_CHALLENGE_TTL_SECONDS * 1_000,
          excludeCredentials: [],
        },
      });
    });

    it('should refuse options for an origin this daemon does not serve', async () => {
      // Arrange
      const { service } = fixture({ origins: [ORIGIN] });

      // Act / Assert
      should(await service.registrationOptions(remote(), OTHER_ORIGIN)).eql({
        ok: false,
        refusal: 'origin-not-allowed',
      });
      should(await service.stepUpOptions(remote(), OTHER_ORIGIN)).eql({ ok: false, refusal: 'origin-not-allowed' });
    });
  });

  describe('registering', () => {
    it('should store the verified credential and count the registration as a step-up', async () => {
      // Arrange
      const { service, store } = fixture();
      const authenticator = await es256Authenticator();

      // Act
      const added = await enrol(service, authenticator);

      // Assert
      should(added).eql({
        ok: true,
        value: { id: toBase64Url(CREDENTIAL_ID), origin: ORIGIN, createdAt: new Date(PAIRED_AT_MS + 60_000).toISOString() },
      });
      should(store.rows).eql([
        {
          credentialId: toBase64Url(CREDENTIAL_ID),
          deviceId: phone.deviceId,
          algorithm: authenticator.algorithm,
          publicKeySpki: toBase64Url(authenticator.spki),
          signCount: 0,
          origin: ORIGIN,
          createdAt: new Date(PAIRED_AT_MS + 60_000).toISOString(),
        },
      ]);
      should(service.held(phone)).be.true();
      should(service.held({ ...phone, appSession: 'tab-two' })).be.false();
    });

    it('should refuse an answer to no challenge, and spend a challenge on a refused answer', async () => {
      // Arrange
      const { service } = fixture();
      const body = await registrationBody(await es256Authenticator());

      // Act
      const unasked = await service.register(remote(), body);
      await service.registrationOptions(remote(), ORIGIN);
      const garbled = await service.register(remote(), { ...body, attestationObject: 'A' });
      const retried = await service.register(remote(), body);

      // Assert
      should(unasked).eql({ ok: false, refusal: 'not-verified' });
      should(garbled).eql({ ok: false, refusal: 'not-verified' });
      should(retried).eql({ ok: false, refusal: 'not-verified' });
    });

    it('should refuse a credential id that is not the one the authenticator attested', async () => {
      // Arrange
      const { service } = fixture();
      await service.registrationOptions(remote(), ORIGIN);
      const body = await registrationBody(await es256Authenticator());

      // Act
      const added = await service.register(remote(), { ...body, credentialId: toBase64Url(new Uint8Array(16)) });

      // Assert
      should(added).eql({ ok: false, refusal: 'not-verified' });
    });

    it('should refuse a credential this device already holds', async () => {
      // Arrange
      const { service, store } = fixture();
      const authenticator = await es256Authenticator();
      await enrol(service, authenticator);

      // Act
      await service.registrationOptions(remote(), ORIGIN);
      const again = await service.register(remote(), await registrationBody(authenticator));

      // Assert
      should(again).eql({ ok: false, refusal: 'not-verified' });
      should(store.rows).have.length(1);
    });

    it('should refuse an attestation the verifier rejects, saying only not-verified', async () => {
      // Arrange
      const { service } = fixture({ origins: [OTHER_ORIGIN] });
      await service.registrationOptions(remote(), OTHER_ORIGIN);

      // Act — the attestation was made at ORIGIN, which this daemon does not serve.
      const added = await service.register(remote(), await registrationBody(await es256Authenticator()));

      // Assert
      should(added).eql({ ok: false, refusal: 'not-verified' });
    });
  });

  describe('stepping up', () => {
    it('should grant a step-up for this app session for the window, and record the counter', async () => {
      // Arrange
      const { clock, service, store, registry } = fixture();
      const authenticator = await es256Authenticator();
      await enrol(service, authenticator);
      registry.forgetDevice(phone.deviceId);

      // Act
      const options = await service.stepUpOptions(remote(), ORIGIN);
      const stepped = await service.stepUp(remote(), await assertionBody(authenticator, { auth: { signCount: 5 } }));

      // Assert
      should(options).eql({
        ok: true,
        value: {
          challenge: toBase64Url(CHALLENGE),
          rpId: relyingPartyIdFor(ORIGIN),
          allowCredentials: [{ type: 'public-key', id: toBase64Url(CREDENTIAL_ID) }],
          timeout: PASSKEY_CHALLENGE_TTL_SECONDS * 1_000,
        },
      });
      should(stepped).eql({
        ok: true,
        value: { expiresAt: new Date(clock.now + STEP_UP_TTL_SECONDS * 1_000).toISOString() },
      });
      should(store.rows[0]?.signCount).equal(5);
      should(service.held(phone)).be.true();
      should((await service.view(remote())).ok && (await service.view(remote()))).match({
        value: { stepUpUntil: new Date(clock.now + STEP_UP_TTL_SECONDS * 1_000).toISOString() },
      });
      clock.now += STEP_UP_TTL_SECONDS * 1_000;
      should(service.held(phone)).be.false();
    });

    it('should not let a step-up held by one app session count for another of the same device', async () => {
      // Arrange
      const { service } = fixture();
      const authenticator = await es256Authenticator();
      await enrol(service, authenticator);
      const otherTab = { ...phone, appSession: 'tab-two' };

      // Act — the second tab answers the FIRST tab's challenge.
      await service.stepUpOptions(remote(), ORIGIN);
      const crossed = await service.stepUp(remote(otherTab), await assertionBody(authenticator));

      // Assert
      should(crossed).eql({ ok: false, refusal: 'not-verified' });
      should(service.held(otherTab)).be.false();
    });

    it('should answer a challenge once', async () => {
      // Arrange
      const { service } = fixture();
      const authenticator = await es256Authenticator();
      await enrol(service, authenticator);
      await service.stepUpOptions(remote(), ORIGIN);
      const body = await assertionBody(authenticator, { auth: { signCount: 1 } });

      // Act
      const first = await service.stepUp(remote(), body);
      const replay = await service.stepUp(remote(), body);

      // Assert
      should(first.ok).be.true();
      should(replay).eql({ ok: false, refusal: 'not-verified' });
    });

    it('should refuse an answer after the challenge lapsed', async () => {
      // Arrange
      const { clock, service } = fixture();
      const authenticator = await es256Authenticator();
      await enrol(service, authenticator);
      await service.stepUpOptions(remote(), ORIGIN);
      clock.now += PASSKEY_CHALLENGE_TTL_SECONDS * 1_000;

      // Act / Assert
      should(await service.stepUp(remote(), await assertionBody(authenticator))).eql({
        ok: false,
        refusal: 'not-verified',
      });
    });

    it('should refuse a rewound or stuck counter and keep the stored one', async () => {
      // Arrange
      const { service, store } = fixture();
      const authenticator = await es256Authenticator();
      await enrol(service, authenticator);
      await service.stepUpOptions(remote(), ORIGIN);
      await service.stepUp(remote(), await assertionBody(authenticator, { auth: { signCount: 7 } }));

      // Act
      await service.stepUpOptions(remote(), ORIGIN);
      const stuck = await service.stepUp(
        remote(),
        await assertionBody(authenticator, { auth: { signCount: 7 }, storedCount: 7 }),
      );
      await service.stepUpOptions(remote(), ORIGIN);
      const rewound = await service.stepUp(
        remote(),
        await assertionBody(authenticator, { auth: { signCount: 3 }, storedCount: 7 }),
      );

      // Assert
      should(stuck).eql({ ok: false, refusal: 'not-verified' });
      should(rewound).eql({ ok: false, refusal: 'not-verified' });
      should(store.rows[0]?.signCount).equal(7);
    });

    it('should never let a passkey registered at one origin assert for another', async () => {
      // Arrange — the phone's passkey was made at ORIGIN; both origins are served.
      const { service, store } = fixture();
      const authenticator = await es256Authenticator();
      await enrol(service, authenticator);

      // Act
      const options = await service.stepUpOptions(remote(), OTHER_ORIGIN);
      await service.stepUpOptions(remote(), ORIGIN);
      // An assertion whose clientData and rpIdHash name the other origin, signed by the right key.
      const relayed = await service.stepUp(
        remote(),
        await assertionBody(authenticator, {
          client: clientData('webauthn.get', { origin: OTHER_ORIGIN }),
          auth: { rpId: relyingPartyIdFor(OTHER_ORIGIN), signCount: 1 },
        }),
      );

      // Assert
      should(options).eql({ ok: false, refusal: 'no-passkey' });
      should(relayed).eql({ ok: false, refusal: 'not-verified' });
      should(store.rows[0]?.origin).equal(ORIGIN);
    });

    it('should refuse an unknown credential and undecodable fields', async () => {
      // Arrange
      const { service } = fixture();
      const authenticator = await es256Authenticator();
      await enrol(service, authenticator);
      const body = await assertionBody(authenticator);

      // Act
      await service.stepUpOptions(remote(), ORIGIN);
      const unknown = await service.stepUp(remote(), { ...body, credentialId: toBase64Url(new Uint8Array(16)) });
      await service.stepUpOptions(remote(), ORIGIN);
      const garbled = await service.stepUp(remote(), { ...body, signature: 'A' });

      // Assert
      should(unknown).eql({ ok: false, refusal: 'not-verified' });
      should(garbled).eql({ ok: false, refusal: 'not-verified' });
    });

    it('should refuse step-up options to a device with no passkey', async () => {
      // Arrange
      const { service } = fixture();

      // Act / Assert
      should(await service.stepUpOptions(remote(), ORIGIN)).eql({ ok: false, refusal: 'no-passkey' });
    });
  });

  it('should forget a revoked device’s passkeys, step-ups and challenges', async () => {
    // Arrange
    const { service, store } = fixture({ nowMs: PAIRED_AT_MS + 1 });
    const authenticator = await es256Authenticator();
    await enrol(service, authenticator);
    await service.stepUpOptions(remote(), ORIGIN);

    // Act
    await service.forgetDevice(phone.deviceId);

    // Assert
    should(store.rows).eql([]);
    should(service.held(phone)).be.false();
    should(await service.stepUp(remote(), await assertionBody(authenticator))).eql({
      ok: false,
      refusal: 'not-verified',
    });
  });
});
