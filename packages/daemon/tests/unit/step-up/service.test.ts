import { describe, it } from 'bun:test';
import {
  DEFAULT_SECURITY_SETTINGS,
  MAX_PASSKEYS_PER_DEVICE,
  PASSKEY_CHALLENGE_TTL_SECONDS,
  PASSKEY_REGISTRATION_WINDOW_SECONDS,
  type SecuritySettings,
  STEP_UP_TTL_SECONDS,
} from '@ferretry/protocol';
import { toBase64Url } from '@ferretry/relay';
import should from 'should';
import {
  ChallengeLedger,
  type DeviceKeyRotationPort,
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
  async holder(credentialId: string) {
    return this.rows.find(row => row.credentialId === credentialId)?.deviceId;
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
/** A second paired device, for the cases where one device's passkey must never work for another. */
const laptop: StepUpSubject = { deviceId: deviceId('b'), appSession: 'laptop-tab' };
const remote = (subject: StepUpSubject = phone): StepUpCaller => ({ device: subject, hostLocal: false });

function fixture(
  options: {
    nowMs?: number;
    origins?: readonly string[];
    paired?: boolean;
    settings?: Partial<SecuritySettings>;
    /** Whether the machine's settings are wired at all; absent means the service is built without them. */
    withSettings?: boolean;
    rotation?: DeviceKeyRotationPort;
    /** The step-up window in force, in minutes, which a case may change after the fact; the default otherwise. */
    window?: { minutes: number };
  } = {},
) {
  const clock = { now: options.nowMs ?? PAIRED_AT_MS + 60_000 };
  const store = new MemoryPasskeys();
  // Both of the phone's tabs hold a live session throughout, so a step-up is judged on its window and
  // binding alone; what ends a span is the span tests' subject.
  const window = options.window;
  const registry = new StepUpRegistry(
    { nowMs: () => clock.now },
    window === undefined ? undefined : () => window.minutes,
  );
  registry.open(phone);
  registry.open({ ...phone, appSession: 'tab-two' });
  const audited: { readonly actor: string; readonly changes: readonly string[] }[] = [];
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
        options.paired === false || (id !== phone.deviceId && id !== laptop.deviceId)
          ? undefined
          : { name: id === phone.deviceId ? 'Phone' : 'Laptop', createdAt: new Date(PAIRED_AT_MS).toISOString() },
    },
    allowedOrigins: () => options.origins ?? [ORIGIN, OTHER_ORIGIN],
    relyingPartyName: 'Ferretry',
    ...(options.withSettings === true || options.settings !== undefined
      ? { settings: () => ({ ...DEFAULT_SECURITY_SETTINGS, ...options.settings }) }
      : {}),
    ...(options.rotation === undefined ? {} : { rotation: options.rotation }),
    audit: {
      record: async entry => {
        audited.push(entry);
      },
    },
  });
  return { clock, store, registry, service, audited };
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
      // Arrange — a step-up still held in memory for a device whose grant is already gone
      const { clock, registry, service } = fixture({ paired: false });
      registry.grant(phone, clock.now);

      // Act
      const options = await service.registrationOptions(remote(), ORIGIN);

      // Assert
      should(options).eql({ ok: false, refusal: 'not-a-device' });
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
        await registrationBody(
          second,
          Uint8Array.from({ length: 16 }, () => 0x11),
        ),
      );

      // Assert
      should(closed).match({ ok: true, value: { registration: 'closed' } });
      should(view).match({ ok: true, value: { registration: 'stepped-up' } });
      should(added).match({ ok: true, value: { origin: ORIGIN } });
      should(store.rows).have.length(2);
    });

    it('should let the owner at the machine re-open a window for one passkey, ten minutes, audited', async () => {
      // Arrange — paired a day ago, so the first window is long closed; a browser is never the owner (B4)
      const { clock, service, audited } = fixture({ nowMs: PAIRED_AT_MS + 86_400_000 });
      const owner: StepUpCaller = { hostLocal: true, actor: 'admin-cli' };
      const opensAt = clock.now;

      // Act
      const byBrowser = await service.reopenRegistration(remote(), phone.deviceId);
      const byOwner = await service.reopenRegistration(owner, phone.deviceId);
      const unknown = await service.reopenRegistration(owner, deviceId('z'));
      const view = await service.view(remote());
      const added = await enrol(service, await es256Authenticator());
      // Spent by that one passkey: another copy of the app on the phone, holding no step-up, is closed.
      const afterwards = await service.view(remote({ ...phone, appSession: 'tab-two' }));

      // Assert
      const closesAt = new Date(opensAt + PASSKEY_REGISTRATION_WINDOW_SECONDS * 1_000).toISOString();
      should(byBrowser).eql({ ok: false, refusal: 'not-at-machine' });
      should(byOwner).eql({ ok: true, value: { deviceId: phone.deviceId, deviceName: 'Phone', closesAt } });
      should(unknown).eql({ ok: false, refusal: 'unknown-device' });
      should(view).eql({ ok: true, value: { passkeys: [], registration: 'reopened', registrationClosesAt: closesAt } });
      should(added.ok).be.true();
      should(afterwards.ok && afterwards.value.registration).equal('closed');
      should(audited).eql([
        {
          actor: 'admin-cli',
          changes: [`passkey.registration-window=${phone.deviceId}`],
          at: new Date(opensAt).toISOString(),
        },
      ]);
    });

    it('should close a re-opened window when its ten minutes end, or when the device is revoked', async () => {
      // Arrange
      const { clock, service } = fixture({ nowMs: PAIRED_AT_MS + 86_400_000 });
      const owner: StepUpCaller = { hostLocal: true };
      await service.reopenRegistration(owner, phone.deviceId);

      // Act
      clock.now += PASSKEY_REGISTRATION_WINDOW_SECONDS * 1_000;
      const lapsed = await service.view(remote());
      await service.reopenRegistration(owner, phone.deviceId);
      await service.forgetDevice(phone.deviceId);
      const revoked = await service.view(remote());

      // Assert
      should(lapsed.ok && lapsed.value.registration).equal('closed');
      should(revoked.ok && revoked.value.registration).equal('closed');
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
        value: {
          id: toBase64Url(CREDENTIAL_ID),
          origin: ORIGIN,
          createdAt: new Date(PAIRED_AT_MS + 60_000).toISOString(),
        },
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

    it('should refuse a credential another device already holds, and leave that device its passkey', async () => {
      // A synced passkey, or an id a device learned: registering it here would move the phone's passkey.
      // Arrange
      const { service, store, registry } = fixture();
      const authenticator = await es256Authenticator();
      await enrol(service, authenticator);
      registry.open(laptop);

      // Act — the laptop is inside its own first window and presents the phone's credential
      await service.registrationOptions(remote(laptop), ORIGIN);
      const taken = await service.register(remote(laptop), await registrationBody(authenticator));

      // Assert
      should(taken).eql({ ok: false, refusal: 'not-verified' });
      should(store.rows.map(row => row.deviceId)).eql([phone.deviceId]);
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

    it('should accept only a credential registered to THIS device: a synced passkey steps up nobody else', async () => {
      // iCloud Keychain or Google Password Manager puts the phone's credential on the laptop too. It is the
      // phone's: a valid signature by it, presented by another paired device, is refused.
      // Arrange
      const { service, store, registry } = fixture();
      const authenticator = await es256Authenticator();
      await enrol(service, authenticator);
      registry.open(laptop);
      // The laptop holds a passkey of its own, so it is offered a challenge at all.
      const own = toBase64Url(new Uint8Array([7, 7, 7, 7]));
      const phonesPasskey = store.rows[0];
      if (phonesPasskey === undefined) throw new Error('the phone enrolled no passkey');
      store.rows.push({ ...phonesPasskey, credentialId: own, deviceId: laptop.deviceId });

      // Act
      const options = await service.stepUpOptions(remote(laptop), ORIGIN);
      const synced = await service.stepUp(remote(laptop), await assertionBody(authenticator));

      // Assert — offered only its own credential, and the phone's is not accepted from it
      should(options.ok && options.value.allowCredentials).eql([{ type: 'public-key', id: own }]);
      should(synced).eql({ ok: false, refusal: 'not-verified' });
      should(service.held(laptop)).be.false();
      should(store.rows[0]?.signCount).equal(phonesPasskey.signCount);
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

/** The settings-driven behaviour of `docs/design/zero-trust.md` B6, over the same real verifier. */

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const TRANSCRIPT = Uint8Array.from({ length: 32 }, (_, index) => index);
const NEW_KEY = 'bmV3LWtleQ';
const PROOF = 'cHJvb2Y';

/** A rotation port the case controls: what it is asked, and what it answers. */
class FakeRotation implements DeviceKeyRotationPort {
  verdict = true;
  swapped = true;
  readonly verified: Parameters<DeviceKeyRotationPort['verify']>[0][] = [];
  readonly rotated: Parameters<DeviceKeyRotationPort['rotate']>[0][] = [];

  constructor(public issuedAt: number | undefined) {}

  keyIssuedAt(): number | undefined {
    return this.issuedAt;
  }

  async verify(input: Parameters<DeviceKeyRotationPort['verify']>[0]): Promise<boolean> {
    this.verified.push(input);
    return this.verdict;
  }

  async rotate(input: Parameters<DeviceKeyRotationPort['rotate']>[0]): Promise<boolean> {
    this.rotated.push(input);
    return this.swapped;
  }
}

const inSession = (): StepUpCaller => ({ device: phone, hostLocal: false, transcriptHash: TRANSCRIPT });

describe('StepUpService step-up window (B6)', () => {
  it('should grant a step-up for the default fifteen minutes when the machine names no window', async () => {
    // Arrange
    const { clock, service } = fixture();
    const authenticator = await es256Authenticator();
    await enrol(service, authenticator);
    await service.stepUpOptions(remote(), ORIGIN);

    // Act
    const stepped = await service.stepUp(remote(), await assertionBody(authenticator));

    // Assert
    should(stepped).eql({
      ok: true,
      value: { expiresAt: new Date(clock.now + 15 * 60_000).toISOString() },
    });
  });

  it('should grant a step-up for the window in force', async () => {
    // Arrange
    const { clock, service } = fixture({ window: { minutes: 45 } });
    const authenticator = await es256Authenticator();
    await enrol(service, authenticator);
    await service.stepUpOptions(remote(), ORIGIN);

    // Act
    const stepped = await service.stepUp(remote(), await assertionBody(authenticator));

    // Assert
    should(stepped).eql({ ok: true, value: { expiresAt: new Date(clock.now + 45 * 60_000).toISOString() } });
  });

  it('should end a step-up already held when the window is shortened', async () => {
    // Arrange
    const window = { minutes: 15 };
    const { clock, service } = fixture({ window });
    await enrol(service, await es256Authenticator());
    clock.now += 6 * 60_000;
    should(service.held(phone)).be.true();

    // Act
    window.minutes = 5;

    // Assert
    should(service.held(phone)).be.false();
  });

  it('should hold a step-up for a challenge’s life only, and let one act spend it, when the window is 0', async () => {
    // Arrange
    const { clock, service } = fixture({ window: { minutes: 0 } });
    const authenticator = await es256Authenticator();
    await enrol(service, authenticator);
    await service.stepUpOptions(remote(), ORIGIN);

    // Act
    const stepped = await service.stepUp(remote(), await assertionBody(authenticator));
    const heldBefore = service.held(phone);
    service.spend(phone);

    // Assert
    should(stepped).eql({
      ok: true,
      value: { expiresAt: new Date(clock.now + PASSKEY_CHALLENGE_TTL_SECONDS * 1_000).toISOString() },
    });
    should(heldBefore).be.true();
    should(service.held(phone)).be.false();
  });

  it('should leave a step-up held when an act is spent under a window above 0', async () => {
    // Arrange
    const { service } = fixture({ window: { minutes: 15 } });
    await enrol(service, await es256Authenticator());

    // Act
    service.spend(phone);

    // Assert
    should(service.held(phone)).be.true();
  });
});

describe('StepUpService unlock on opening (B6)', () => {
  /** Enrols the phone's passkey, then lets the confirmation that registering counts as lapse. */
  async function enrolled(options: Parameters<typeof fixture>[0]) {
    const world = fixture(options);
    const authenticator = await es256Authenticator();
    await enrol(world.service, authenticator);
    world.clock.now += 25 * HOUR_MS;
    return { ...world, authenticator };
  }

  const nextAssertion = (authenticator: Authenticator, signCount: number) =>
    assertionBody(authenticator, { auth: { signCount }, storedCount: signCount - 1 });

  it('should ask nobody for an unlock when the service is built without settings', async () => {
    // Arrange
    const { service } = fixture();

    // Act / Assert
    should(service.unlockRequired(phone)).be.false();
  });

  it('should ask nobody for an unlock when the machine does not ask for it on opening', async () => {
    // Arrange
    const { service } = fixture({ settings: { unlockOnOpen: false } });

    // Act / Assert
    should(service.unlockRequired(phone)).be.false();
  });

  it('should ask a device that has never confirmed, until it does', async () => {
    // Arrange
    const { service, authenticator } = await enrolled({ settings: { unlockOnOpen: true } });
    should(service.unlockRequired(phone)).be.true();
    await service.unlockOptions(remote(), ORIGIN);

    // Act
    const granted = await service.unlock(remote(), await nextAssertion(authenticator, 1));

    // Assert
    should(granted.ok).be.true();
    should(service.unlockRequired(phone)).be.false();
  });

  it('should be present until the validity period lapses, and ask again at the instant it does', async () => {
    // Arrange
    const { clock, service, authenticator } = await enrolled({
      settings: { unlockOnOpen: true, unlockValidityHours: 2 },
    });
    await service.unlockOptions(remote(), ORIGIN);
    const confirmedAt = clock.now;
    await service.unlock(remote(), await nextAssertion(authenticator, 1));

    // Act / Assert
    clock.now = confirmedAt + 2 * HOUR_MS - 1;
    should(service.unlockRequired(phone)).be.false();
    clock.now = confirmedAt + 2 * HOUR_MS;
    should(service.unlockRequired(phone)).be.true();
  });

  it('should answer a confirmation with when it lapses for the device', async () => {
    // Arrange
    const { clock, service, authenticator } = await enrolled({
      settings: { unlockOnOpen: true, unlockValidityHours: 3 },
    });
    await service.unlockOptions(remote(), ORIGIN);

    // Act
    const granted = await service.unlock(remote(), await nextAssertion(authenticator, 1));

    // Assert
    should(granted).eql({ ok: true, value: { unlockedUntil: new Date(clock.now + 3 * HOUR_MS).toISOString() } });
  });

  it('should answer a confirmation with the present instant when the service has no settings', async () => {
    // Arrange
    const { clock, service } = fixture();
    const authenticator = await es256Authenticator();
    await enrol(service, authenticator);
    await service.unlockOptions(remote(), ORIGIN);

    // Act
    const granted = await service.unlock(remote(), await nextAssertion(authenticator, 1));

    // Assert
    should(granted).eql({ ok: true, value: { unlockedUntil: new Date(clock.now).toISOString() } });
  });

  it('should hold a confirmation for the whole device, across its app sessions', async () => {
    // Arrange
    const { service, authenticator } = await enrolled({ settings: { unlockOnOpen: true } });
    const otherTab = { ...phone, appSession: 'tab-two' };
    should(service.unlockRequired(otherTab)).be.true();
    await service.unlockOptions(remote(), ORIGIN);

    // Act
    await service.unlock(remote(), await nextAssertion(authenticator, 1));

    // Assert
    should(service.unlockRequired(phone)).be.false();
    should(service.unlockRequired(otherTab)).be.false();
    should(service.unlockRequired({ deviceId: deviceId('b'), appSession: 'tab-one' })).be.true();
  });

  it('should make the unlock the step-up while it holds, with no per-act step-up in the registry', async () => {
    // Arrange — the unlock IS the step-up (owner decision 2026-10-14), and nothing else is held.
    const { service, authenticator, registry, clock } = await enrolled({ settings: { unlockOnOpen: true } });
    registry.forgetDevice(phone.deviceId);
    should(service.held(phone)).be.false();
    await service.unlockOptions(remote(), ORIGIN);

    // Act
    await service.unlock(remote(), await nextAssertion(authenticator, 1));
    registry.forgetDevice(phone.deviceId);

    // Assert
    should(registry.held(phone, clock.now)).be.false();
    should(service.held(phone)).be.true();
  });

  it('should stop holding the step-up at the instant the unlock lapses', async () => {
    // Arrange
    const { clock, service, authenticator, registry } = await enrolled({
      settings: { unlockOnOpen: true, unlockValidityHours: 2 },
    });
    await service.unlockOptions(remote(), ORIGIN);
    const unlockedAt = clock.now;
    await service.unlock(remote(), await nextAssertion(authenticator, 1));
    registry.forgetDevice(phone.deviceId);

    // Act / Assert
    clock.now = unlockedAt + 2 * HOUR_MS - 1;
    should(service.held(phone)).be.true();
    clock.now = unlockedAt + 2 * HOUR_MS;
    should(service.held(phone)).be.false();
  });

  it('should never spend an unlock: an act leaves the device unlocked and the step-up held', async () => {
    // Arrange
    const { service, authenticator, registry } = await enrolled({ settings: { unlockOnOpen: true } });
    await service.unlockOptions(remote(), ORIGIN);
    await service.unlock(remote(), await nextAssertion(authenticator, 1));
    registry.forgetDevice(phone.deviceId);

    // Act
    service.spend(phone);
    service.spend(phone);

    // Assert
    should(service.unlockRequired(phone)).be.false();
    should(service.held(phone)).be.true();
  });

  it('should ask a per-act step-up inside an unlock when the owner turned stepUpOnActions on', async () => {
    // Arrange
    const { service, authenticator, registry } = await enrolled({
      settings: { unlockOnOpen: true, stepUpOnActions: true },
    });
    await service.unlockOptions(remote(), ORIGIN);
    await service.unlock(remote(), await nextAssertion(authenticator, 1));
    registry.forgetDevice(phone.deviceId);

    // Act / Assert — unlocked, and still not stepped up for an act.
    should(service.unlockRequired(phone)).be.false();
    should(service.held(phone)).be.false();
  });

  it('should ask a per-act step-up when the unlock is off, even with stepUpOnActions off', async () => {
    // Arrange — with no unlock there is nothing to cover the act.
    const { service, registry, clock } = fixture({ settings: { unlockOnOpen: false, stepUpOnActions: false } });
    registry.grant(phone, clock.now);
    registry.forgetDevice(phone.deviceId);

    // Act / Assert
    should(service.held(phone)).be.false();
  });

  it('should hold the unlock’s own per-act step-up after an unlock on a machine that asks per act, and spend it once at window 0', async () => {
    // Arrange — an unlock grants a per-act step-up for this app session, so the first act right after
    // unlocking is not asked again; a single-use window spends it.
    const { service, authenticator } = await enrolled({
      settings: { unlockOnOpen: true, stepUpOnActions: true, stepUpWindowMinutes: 0 },
      window: { minutes: 0 },
    });
    await service.unlockOptions(remote(), ORIGIN);
    await service.unlock(remote(), await nextAssertion(authenticator, 1));

    // Act
    const before = service.held(phone);
    service.spend(phone);

    // Assert
    should(before).be.true();
    should(service.held(phone)).be.false();
    should(service.unlockRequired(phone)).be.false();
  });

  it('should spend a single-use per-act step-up on a machine with no unlock', async () => {
    // Arrange
    const { service, registry, clock } = fixture({
      settings: { unlockOnOpen: false },
      window: { minutes: 0 },
    });
    registry.grant(phone, clock.now);

    // Act
    const before = service.held(phone);
    service.spend(phone);

    // Assert
    should(before).be.true();
    should(service.held(phone)).be.false();
  });

  it('should hold the step-up as the per-act registry decides when the service has no settings', async () => {
    // Arrange
    const { service, registry, clock } = fixture();

    // Act / Assert
    should(service.held(phone)).be.false();
    registry.grant(phone, clock.now);
    should(service.held(phone)).be.true();
  });

  it('should count registering a passkey as a confirmation on opening', async () => {
    // Arrange
    const { service } = fixture({ settings: { unlockOnOpen: true } });
    should(service.unlockRequired(phone)).be.true();

    // Act
    await enrol(service, await es256Authenticator());

    // Assert
    should(service.unlockRequired(phone)).be.false();
  });

  it('should forget a revoked device’s confirmation', async () => {
    // Arrange
    const { service } = fixture({ settings: { unlockOnOpen: true } });
    await enrol(service, await es256Authenticator());
    should(service.unlockRequired(phone)).be.false();

    // Act
    await service.forgetDevice(phone.deviceId);

    // Assert
    should(service.unlockRequired(phone)).be.true();
  });

  it('should refuse a confirmation that carries a rotation, and keep the device unconfirmed', async () => {
    // Arrange
    const { service, authenticator } = await enrolled({ settings: { unlockOnOpen: true } });
    await service.unlockOptions(remote(), ORIGIN);
    const body = await nextAssertion(authenticator, 1);

    // Act
    const refused = await service.unlock(remote(), { ...body, rotation: { deviceKey: NEW_KEY, proof: PROOF } });

    // Assert
    should(refused).eql({ ok: false, refusal: 'not-verified' });
    should(service.unlockRequired(phone)).be.true();
  });

  it('should refuse a confirmation from a caller that is not a device', async () => {
    // Arrange
    const { service, authenticator } = await enrolled({ settings: { unlockOnOpen: true } });

    // Act / Assert
    should(await service.unlockOptions({ hostLocal: true }, ORIGIN)).eql({ ok: false, refusal: 'not-a-device' });
    should(await service.unlock({ hostLocal: true }, await nextAssertion(authenticator, 1))).eql({
      ok: false,
      refusal: 'not-a-device',
    });
  });

  it('should refuse unlock options for an origin the machine does not serve or a device with no passkey', async () => {
    // Arrange
    const { service } = fixture({ origins: [ORIGIN], settings: { unlockOnOpen: true } });

    // Act / Assert
    should(await service.unlockOptions(remote(), OTHER_ORIGIN)).eql({ ok: false, refusal: 'origin-not-allowed' });
    should(await service.unlockOptions(remote(), ORIGIN)).eql({ ok: false, refusal: 'no-passkey' });
  });

  it('should answer an unlock only with a challenge issued for an unlock, spending it either way', async () => {
    // Arrange
    const { service, authenticator } = await enrolled({ settings: { unlockOnOpen: true } });
    const body = await nextAssertion(authenticator, 1);

    // Act — a step-up challenge answers no unlock, and an unlock challenge answers once
    await service.stepUpOptions(remote(), ORIGIN);
    const crossed = await service.unlock(remote(), body);
    await service.unlockOptions(remote(), ORIGIN);
    const first = await service.unlock(remote(), body);
    const replay = await service.unlock(remote(), body);

    // Assert
    should(crossed).eql({ ok: false, refusal: 'not-verified' });
    should(first.ok).be.true();
    should(replay).eql({ ok: false, refusal: 'not-verified' });
  });

  it('should not confirm a device whose passkey answer does not check out', async () => {
    // Arrange
    const { service, authenticator } = await enrolled({ settings: { unlockOnOpen: true } });
    await service.unlockOptions(remote(), ORIGIN);
    const body = await nextAssertion(authenticator, 1);

    // Act
    const refused = await service.unlock(remote(), { ...body, signature: 'A' });

    // Assert
    should(refused).eql({ ok: false, refusal: 'not-verified' });
    should(service.unlockRequired(phone)).be.true();
  });
});

describe('StepUpService key rotation (B6)', () => {
  const ROTATION = { deviceKey: NEW_KEY, proof: PROOF };
  const DUE_AT = PAIRED_AT_MS + 30 * DAY_MS;

  /** An enrolled phone whose key was put in place at pairing, `daysIn` days ago by the case's clock. */
  async function enrolled(daysIn: number, rotation: FakeRotation = new FakeRotation(PAIRED_AT_MS)) {
    const world = fixture({ rotation, settings: { deviceKeyRotationDays: 30 } });
    const authenticator = await es256Authenticator();
    await enrol(world.service, authenticator);
    world.clock.now = PAIRED_AT_MS + daysIn * DAY_MS;
    return { ...world, rotation, authenticator };
  }

  const assertWith = (authenticator: Authenticator, signCount: number) =>
    assertionBody(authenticator, { auth: { signCount }, storedCount: signCount - 1 });

  describe('when a key is due', () => {
    it('should name nothing without settings', () => {
      // Arrange
      const { service } = fixture({ rotation: new FakeRotation(PAIRED_AT_MS) });

      // Act / Assert
      should(service.rotateBy(phone.deviceId)).be.undefined();
    });

    it('should name nothing without a rotation port', () => {
      // Arrange
      const { service } = fixture({ withSettings: true });

      // Act / Assert
      should(service.rotateBy(phone.deviceId)).be.undefined();
    });

    it('should name nothing for a device whose key has no issue time', () => {
      // Arrange
      const { service } = fixture({ withSettings: true, rotation: new FakeRotation(undefined) });

      // Act / Assert
      should(service.rotateBy(phone.deviceId)).be.undefined();
    });

    it('should name the issue time plus the period in days', () => {
      // Arrange
      const { service } = fixture({
        settings: { deviceKeyRotationDays: 7 },
        rotation: new FakeRotation(PAIRED_AT_MS),
      });

      // Act / Assert
      should(service.rotateBy(phone.deviceId)).equal(PAIRED_AT_MS + 7 * DAY_MS);
    });
  });

  it('should step up without a rotation while the key is not yet due', async () => {
    // Arrange
    const { service, authenticator, rotation } = await enrolled(29);
    await service.stepUpOptions(inSession(), ORIGIN);

    // Act
    const stepped = await service.stepUp(inSession(), await assertWith(authenticator, 1));

    // Assert
    should(stepped.ok && stepped.value.keyRotated).be.undefined();
    should(rotation.rotated).eql([]);
    should(rotation.verified).eql([]);
  });

  it('should refuse a step-up with rotation-required once the key is due, and not spend the challenge', async () => {
    // Arrange
    const { clock, service, authenticator, rotation } = await enrolled(30);
    should(clock.now).equal(DUE_AT);
    await service.stepUpOptions(inSession(), ORIGIN);
    const body = await assertWith(authenticator, 1);

    // Act
    const refused = await service.stepUp(inSession(), body);
    const followUp = await service.stepUp(inSession(), { ...body, rotation: ROTATION });

    // Assert
    should(refused).eql({ ok: false, refusal: 'rotation-required' });
    should(followUp.ok).be.true();
    should(rotation.rotated).have.length(1);
  });

  it('should refuse a step-up with rotation-required past the due instant too', async () => {
    // Arrange
    const { service, authenticator } = await enrolled(45);
    await service.stepUpOptions(inSession(), ORIGIN);

    // Act
    const refused = await service.stepUp(inSession(), await assertWith(authenticator, 1));

    // Assert
    should(refused).eql({ ok: false, refusal: 'rotation-required' });
    should(service.held(phone)).be.false();
  });

  it('should rotate the key inside the step-up, reporting keyRotated and swapping with the session’s transcript', async () => {
    // Arrange
    const { clock, service, authenticator, rotation } = await enrolled(31);
    await service.stepUpOptions(inSession(), ORIGIN);

    // Act
    const stepped = await service.stepUp(inSession(), {
      ...(await assertWith(authenticator, 1)),
      rotation: ROTATION,
    });

    // Assert
    should(stepped).eql({
      ok: true,
      value: { expiresAt: new Date(clock.now + STEP_UP_TTL_SECONDS * 1_000).toISOString(), keyRotated: true },
    });
    should(rotation.verified).eql([
      { transcriptHash: TRANSCRIPT, deviceId: phone.deviceId, deviceKey: NEW_KEY, proof: PROOF },
    ]);
    should(rotation.rotated).eql([{ deviceId: phone.deviceId, deviceKey: NEW_KEY, transcriptHash: TRANSCRIPT }]);
    should(service.held(phone)).be.true();
  });

  it('should accept a rotation before the key is due, because a client may rotate early', async () => {
    // Arrange
    const { service, authenticator, rotation } = await enrolled(1);
    await service.stepUpOptions(inSession(), ORIGIN);

    // Act
    const stepped = await service.stepUp(inSession(), {
      ...(await assertWith(authenticator, 1)),
      rotation: ROTATION,
    });

    // Assert
    should(stepped).match({ ok: true, value: { keyRotated: true } });
    should(rotation.rotated).have.length(1);
  });

  it('should refuse a rotation whose proof does not verify, never swap, and keep the challenge', async () => {
    // Arrange
    const { service, authenticator, rotation } = await enrolled(31);
    rotation.verdict = false;
    await service.stepUpOptions(inSession(), ORIGIN);
    const body = await assertWith(authenticator, 1);

    // Act
    const refused = await service.stepUp(inSession(), { ...body, rotation: ROTATION });
    rotation.verdict = true;
    const retried = await service.stepUp(inSession(), { ...body, rotation: ROTATION });

    // Assert
    should(refused).eql({ ok: false, refusal: 'not-verified' });
    should(rotation.rotated).have.length(1);
    should(retried.ok).be.true();
  });

  it('should refuse a rotation sent outside a session, since there is no transcript to prove it against', async () => {
    // Arrange
    const { service, authenticator, rotation } = await enrolled(31);
    await service.stepUpOptions(inSession(), ORIGIN);

    // Act
    const refused = await service.stepUp(remote(), {
      ...(await assertWith(authenticator, 1)),
      rotation: ROTATION,
    });

    // Assert
    should(refused).eql({ ok: false, refusal: 'not-verified' });
    should(rotation.verified).eql([]);
    should(rotation.rotated).eql([]);
  });

  it('should refuse a rotation when the machine has no rotation port', async () => {
    // Arrange
    const { service } = fixture({ withSettings: true });
    const authenticator = await es256Authenticator();
    await enrol(service, authenticator);
    await service.stepUpOptions(inSession(), ORIGIN);

    // Act
    const refused = await service.stepUp(inSession(), {
      ...(await assertWith(authenticator, 1)),
      rotation: ROTATION,
    });

    // Assert
    should(refused).eql({ ok: false, refusal: 'not-verified' });
  });

  it('should not swap the key when the passkey answer itself does not check out', async () => {
    // Arrange
    const { service, authenticator, rotation } = await enrolled(31);
    await service.stepUpOptions(inSession(), ORIGIN);
    const body = await assertWith(authenticator, 1);

    // Act
    const refused = await service.stepUp(inSession(), { ...body, signature: 'A', rotation: ROTATION });

    // Assert
    should(refused).eql({ ok: false, refusal: 'not-verified' });
    should(rotation.rotated).eql([]);
    should(service.held(phone)).be.false();
  });

  it('should refuse with not-a-device and grant nothing when the device was revoked before the swap', async () => {
    // Arrange
    const { service, authenticator, rotation } = await enrolled(31);
    rotation.swapped = false;
    await service.stepUpOptions(inSession(), ORIGIN);

    // Act
    const refused = await service.stepUp(inSession(), {
      ...(await assertWith(authenticator, 1)),
      rotation: ROTATION,
    });

    // Assert
    should(refused).eql({ ok: false, refusal: 'not-a-device' });
    should(service.held(phone)).be.false();
  });

  describe('inside an unlock', () => {
    /** An enrolled phone on a machine that unlocks on opening, its unlock long lapsed by the case's clock. */
    async function unlocking(daysIn: number) {
      const rotation = new FakeRotation(PAIRED_AT_MS);
      const world = fixture({ rotation, settings: { deviceKeyRotationDays: 30, unlockOnOpen: true } });
      const authenticator = await es256Authenticator();
      await enrol(world.service, authenticator);
      world.clock.now = PAIRED_AT_MS + daysIn * DAY_MS;
      return { ...world, rotation, authenticator };
    }

    it('should unlock without a rotation while the key is not yet due', async () => {
      // Arrange
      const { service, authenticator, rotation } = await unlocking(29);
      await service.unlockOptions(inSession(), ORIGIN);

      // Act
      const granted = await service.unlock(inSession(), await assertWith(authenticator, 1));

      // Assert
      should(granted.ok && granted.value.keyRotated).be.undefined();
      should(rotation.rotated).eql([]);
      should(service.unlockRequired(phone)).be.false();
    });

    it('should refuse an unlock with rotation-required once the key is due, keep the challenge, and leave the device locked', async () => {
      // Arrange
      const { service, authenticator, rotation } = await unlocking(30);
      await service.unlockOptions(inSession(), ORIGIN);
      const body = await assertWith(authenticator, 1);

      // Act
      const refused = await service.unlock(inSession(), body);
      const lockedAfterRefusal = service.unlockRequired(phone);
      const followUp = await service.unlock(inSession(), { ...body, rotation: ROTATION });

      // Assert
      should(refused).eql({ ok: false, refusal: 'rotation-required' });
      should(lockedAfterRefusal).be.true();
      should(followUp.ok).be.true();
      should(rotation.rotated).have.length(1);
    });

    it('should rotate the key in the unlock, answering keyRotated, with the session’s transcript', async () => {
      // Arrange
      const { clock, service, authenticator, rotation } = await unlocking(31);
      await service.unlockOptions(inSession(), ORIGIN);

      // Act
      const granted = await service.unlock(inSession(), {
        ...(await assertWith(authenticator, 1)),
        rotation: ROTATION,
      });

      // Assert
      should(granted).eql({
        ok: true,
        value: { unlockedUntil: new Date(clock.now + 8 * HOUR_MS).toISOString(), keyRotated: true },
      });
      should(rotation.verified).eql([
        { transcriptHash: TRANSCRIPT, deviceId: phone.deviceId, deviceKey: NEW_KEY, proof: PROOF },
      ]);
      should(rotation.rotated).eql([{ deviceId: phone.deviceId, deviceKey: NEW_KEY, transcriptHash: TRANSCRIPT }]);
      should(service.unlockRequired(phone)).be.false();
    });

    it('should refuse a rotation whose proof does not verify, never swap, and keep the device locked', async () => {
      // Arrange
      const { service, authenticator, rotation } = await unlocking(31);
      rotation.verdict = false;
      await service.unlockOptions(inSession(), ORIGIN);

      // Act
      const refused = await service.unlock(inSession(), {
        ...(await assertWith(authenticator, 1)),
        rotation: ROTATION,
      });

      // Assert
      should(refused).eql({ ok: false, refusal: 'not-verified' });
      should(rotation.rotated).eql([]);
      should(service.unlockRequired(phone)).be.true();
    });

    it('should refuse with not-a-device and leave the device locked when it was revoked before the swap', async () => {
      // Arrange
      const { service, authenticator, rotation } = await unlocking(31);
      rotation.swapped = false;
      await service.unlockOptions(inSession(), ORIGIN);

      // Act
      const refused = await service.unlock(inSession(), {
        ...(await assertWith(authenticator, 1)),
        rotation: ROTATION,
      });

      // Assert
      should(refused).eql({ ok: false, refusal: 'not-a-device' });
      should(service.unlockRequired(phone)).be.true();
    });

    it('should not swap the key when the passkey answer itself does not check out', async () => {
      // Arrange
      const { service, authenticator, rotation } = await unlocking(31);
      await service.unlockOptions(inSession(), ORIGIN);
      const body = await assertWith(authenticator, 1);

      // Act
      const refused = await service.unlock(inSession(), { ...body, signature: 'A', rotation: ROTATION });

      // Assert
      should(refused).eql({ ok: false, refusal: 'not-verified' });
      should(rotation.rotated).eql([]);
    });
  });
});
