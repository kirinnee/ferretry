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
  passkeyAddedNotice,
  passkeyVerifier,
  relyingPartyIdFor,
  type StepUpCaller,
  StepUpRegistry,
  StepUpService,
  type StepUpSubject,
  type StoredPasskey,
  type UnlockLedgerPort,
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
  /** The adapter's compare-and-set, so a counter that did not move refuses here as it does there. */
  async updateSignCount(id: string, credentialId: string, signCount: number) {
    const row = this.rows.find(candidate => candidate.deviceId === id && candidate.credentialId === credentialId);
    if (row === undefined || (row.signCount >= signCount && (row.signCount !== 0 || signCount !== 0))) return false;
    this.rows = this.rows.map(candidate => (candidate === row ? { ...row, signCount } : candidate));
    return true;
  }
  async forgetDevice(id: string) {
    this.rows = this.rows.filter(row => row.deviceId !== id);
  }
}

const phone: StepUpSubject = { deviceId: deviceId('a'), appSession: 'tab-one' };
/** A second paired device, for the cases where one device's passkey must never work for another. */
const laptop: StepUpSubject = { deviceId: deviceId('b'), appSession: 'laptop-tab' };
const remote = (subject: StepUpSubject = phone): StepUpCaller => ({ device: subject, hostLocal: false });

/** The `register-confirm` challenge, distinct from {@link CHALLENGE} so the two can never be mixed up here. */
const CONFIRM = Uint8Array.from({ length: 32 }, (_, index) => (index * 11 + 5) & 0xff);

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
    /** The challenges the daemon "randomly" issues, in order; the last repeats. */
    challenges?: readonly Uint8Array[];
    announce?: (notice: unknown) => Promise<unknown>;
    /** The phone's paired name; `Phone` otherwise. */
    deviceName?: string;
    /** This machine's name as pairing knows it; `studio` otherwise. */
    machineName?: string;
    /** Where unlocks are kept across a restart; absent keeps them in memory only. */
    unlocks?: UnlockLedgerPort;
  } = {},
) {
  const clock = { now: options.nowMs ?? PAIRED_AT_MS + 60_000 };
  const directory = { paired: options.paired !== false };
  const issued = [...(options.challenges ?? [CHALLENGE])];
  const announced: unknown[] = [];
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
    // The software authenticator signs over a known challenge, so the daemon "randomly" issues it.
    random: { bytes: length => ((issued.length > 1 ? issued.shift() : issued[0]) ?? CHALLENGE).slice(0, length) },
    clock: { nowMs: () => clock.now },
    devices: {
      device: async id =>
        !directory.paired || (id !== phone.deviceId && id !== laptop.deviceId)
          ? undefined
          : {
              name: id === phone.deviceId ? (options.deviceName ?? 'Phone') : 'Laptop',
              createdAt: new Date(PAIRED_AT_MS).toISOString(),
            },
    },
    allowedOrigins: () => options.origins ?? [ORIGIN, OTHER_ORIGIN],
    relyingPartyName: 'Ferretry',
    machineName: options.machineName ?? 'studio',
    ...(options.withSettings === true || options.settings !== undefined
      ? { settings: () => ({ ...DEFAULT_SECURITY_SETTINGS, ...options.settings }) }
      : {}),
    ...(options.rotation === undefined ? {} : { rotation: options.rotation }),
    ...(options.unlocks === undefined ? {} : { unlocks: options.unlocks }),
    audit: {
      record: async entry => {
        audited.push(entry);
      },
    },
    announce:
      options.announce ??
      (async notice => {
        announced.push(notice);
      }),
  });
  return { clock, store, registry, service, audited, announced, directory };
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

/** An assertion over `challenge` by `authenticator`, as the existing passkey's answer to `confirm`. */
const confirmationBy = async (
  authenticator: Authenticator,
  challenge: Uint8Array = CONFIRM,
  signCount = 1,
  credentialId = toBase64Url(CREDENTIAL_ID),
) =>
  await assertionBody(
    authenticator,
    { client: clientData('webauthn.get', { challenge: toBase64Url(challenge) }), auth: { signCount } },
    credentialId,
  );

const SECOND_ID = Uint8Array.from({ length: 16 }, () => 0x11);

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
      // Arrange — a window the owner re-opened, still in memory, for a device whose grant is already gone
      const { service, directory } = fixture({ nowMs: PAIRED_AT_MS + 86_400_000 });
      await service.reopenRegistration({ hostLocal: true }, phone.deviceId);
      directory.paired = false;

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

    it('should ask a device that holds a passkey to confirm with it, and let a step-up stand in for nothing', async () => {
      // Arrange — enrolled inside the window, then stepped up: it holds a live step-up now.
      const { service } = fixture({ challenges: [CHALLENGE, CHALLENGE, CHALLENGE, CONFIRM] });
      const first = await es256Authenticator();
      await enrol(service, first);
      await service.stepUpOptions(remote(), ORIGIN);
      should((await service.stepUp(remote(), await assertionBody(first))).ok).be.true();

      // Act
      const view = await service.view(remote());
      const options = await service.registrationOptions(remote(), ORIGIN);

      // Assert
      should(service.held(phone)).be.true();
      should(view).match({ ok: true, value: { registration: 'confirm-existing' } });
      should(options).match({
        ok: true,
        value: {
          challenge: toBase64Url(CHALLENGE),
          confirm: {
            challenge: toBase64Url(CONFIRM),
            rpId: relyingPartyIdFor(ORIGIN),
            allowCredentials: [{ type: 'public-key', id: toBase64Url(CREDENTIAL_ID) }],
            timeout: PASSKEY_CHALLENGE_TTL_SECONDS * 1_000,
          },
        },
      });
    });

    it('should add a second passkey only with a fresh assertion by the first, made for this registration', async () => {
      // Arrange — long after the window, holding no step-up.
      const { clock, service, store, audited } = fixture({ challenges: [CHALLENGE, CHALLENGE, CONFIRM] });
      const first = await es256Authenticator();
      await enrol(service, first);
      clock.now += STEP_UP_TTL_SECONDS * 1_000;
      const second = await es256Authenticator();

      // Act
      await service.registrationOptions(remote(), ORIGIN);
      const added = await service.register(remote(), {
        ...(await registrationBody(second, SECOND_ID)),
        confirmation: await confirmationBy(first),
      });

      // Assert — added, the first passkey's counter moved, and no step-up was granted by any of it.
      should(added).match({ ok: true, value: { id: toBase64Url(SECOND_ID), origin: ORIGIN } });
      should(store.rows.map(row => [row.credentialId, row.signCount])).eql([
        [toBase64Url(CREDENTIAL_ID), 1],
        [toBase64Url(SECOND_ID), 0],
      ]);
      should(service.held(phone)).be.false();
      should(audited.map(entry => entry.changes)).eql([
        [`passkey.added=${phone.deviceId}`],
        [`passkey.added=${phone.deviceId}`],
      ]);
    });

    it('should refuse a second passkey with a missing, stale, wrong-purpose or other-device confirmation', async () => {
      // Arrange — each attempt asks for fresh options; the daemon issues R, C each time (and S for a step-up).
      const STALE = Uint8Array.from({ length: 32 }, () => 0x42);
      const STEP = Uint8Array.from({ length: 32 }, () => 0x24);
      const { service, store, registry } = fixture({
        challenges: [CHALLENGE, CHALLENGE, STALE, CHALLENGE, CONFIRM, STEP, CHALLENGE, CONFIRM, CHALLENGE, CONFIRM],
      });
      const first = await es256Authenticator();
      await enrol(service, first);
      registry.open(laptop);
      const laptopKey = await es256Authenticator();
      const laptopId = toBase64Url(new Uint8Array([9, 9, 9, 9]));
      store.rows.push({ ...(store.rows[0] as StoredPasskey), credentialId: laptopId, deviceId: laptop.deviceId });
      const second = await registrationBody(await es256Authenticator(), SECOND_ID);

      // Act
      // 1. No confirmation at all — holding a session (or a step-up) is not one.
      await service.registrationOptions(remote(), ORIGIN); // R, STALE
      const missing = await service.register(remote(), second);
      // 2. Stale: answers the confirm challenge from an EARLIER options call.
      await service.registrationOptions(remote(), ORIGIN); // R, C
      const stale = await service.register(remote(), { ...second, confirmation: await confirmationBy(first, STALE) });
      // 3. Wrong purpose: a step-up's assertion offered as the confirmation.
      await service.stepUpOptions(remote(), ORIGIN); // STEP
      await service.registrationOptions(remote(), ORIGIN); // R, C
      const wrongPurpose = await service.register(remote(), {
        ...second,
        confirmation: await confirmationBy(first, STEP),
      });
      // 4. Another device's passkey, signing a perfectly fresh confirm challenge.
      await service.registrationOptions(remote(), ORIGIN); // R, C
      const otherDevice = await service.register(remote(), {
        ...second,
        confirmation: await confirmationBy(laptopKey, CONFIRM, 1, laptopId),
      });

      // Assert
      for (const outcome of [missing, stale, wrongPurpose, otherDevice])
        should(outcome).eql({ ok: false, refusal: 'not-verified' });
      should(store.rows.filter(row => row.deviceId === phone.deviceId)).have.length(1);
    });

    it('should not let page code add a software passkey to a device that holds one, step-up or not', async () => {
      // Page code (XSS, a malicious deploy) can mint a key pair with WebCrypto and build a registration
      // and an "assertion" with it, flags and all. It cannot sign with the passkey the daemon holds.
      // Arrange
      const { service, store, registry } = fixture({ challenges: [CHALLENGE, CHALLENGE, CONFIRM] });
      await enrol(service, await es256Authenticator());
      registry.grant(phone, PAIRED_AT_MS + 60_000);
      const forged = await es256Authenticator();

      // Act
      await service.registrationOptions(remote(), ORIGIN);
      const selfSigned = await service.register(remote(), {
        ...(await registrationBody(forged, SECOND_ID)),
        confirmation: await confirmationBy(forged, CONFIRM, 1, toBase64Url(SECOND_ID)),
      });
      await service.registrationOptions(remote(), ORIGIN);
      // The forged key claiming the REAL credential's id: the signature does not verify under its key.
      const impersonated = await service.register(remote(), {
        ...(await registrationBody(forged, SECOND_ID)),
        confirmation: await confirmationBy(forged),
      });

      // Assert
      should(selfSigned).eql({ ok: false, refusal: 'not-verified' });
      should(impersonated).eql({ ok: false, refusal: 'not-verified' });
      should(store.rows).have.length(1);
    });

    it('should refuse options for a confirmation no passkey at this origin could give', async () => {
      // Arrange — the phone's only passkey was made at ORIGIN.
      const { service } = fixture();
      await enrol(service, await es256Authenticator());

      // Act / Assert
      should(await service.registrationOptions(remote(), OTHER_ORIGIN)).eql({ ok: false, refusal: 'no-passkey' });
    });

    it('should tell the other devices a passkey was added, and keep it when the notice cannot be sent', async () => {
      // Arrange
      const announced = fixture();
      const failing = fixture({ announce: async () => Promise.reject(new Error('push service down')) });

      // Act
      const told = await enrol(announced.service, await es256Authenticator());
      const kept = await enrol(failing.service, await es256Authenticator());

      // Assert
      should(told.ok && kept.ok).be.true();
      should(announced.announced).eql([passkeyAddedNotice('Phone')]);
      should(failing.store.rows).have.length(1);
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
      // Spent by that one passkey: from now on a further one needs a confirmation by it.
      const afterwards = await service.view(remote({ ...phone, appSession: 'tab-two' }));

      // Assert
      const closesAt = new Date(opensAt + PASSKEY_REGISTRATION_WINDOW_SECONDS * 1_000).toISOString();
      should(byBrowser).eql({ ok: false, refusal: 'not-at-machine' });
      should(byOwner).eql({ ok: true, value: { deviceId: phone.deviceId, deviceName: 'Phone', closesAt } });
      should(unknown).eql({ ok: false, refusal: 'unknown-device' });
      should(view).eql({ ok: true, value: { passkeys: [], registration: 'reopened', registrationClosesAt: closesAt } });
      should(added.ok).be.true();
      should(afterwards.ok && afterwards.value.registration).equal('confirm-existing');
      should(audited).eql([
        {
          actor: 'admin-cli',
          changes: [`passkey.registration-window=${phone.deviceId}`],
          at: new Date(opensAt).toISOString(),
        },
        {
          actor: `device:${phone.deviceId}`,
          changes: [`passkey.added=${phone.deviceId}`],
          at: new Date(opensAt).toISOString(),
        },
      ]);
    });

    it('should let a re-opened window add a passkey with no confirmation, for a device whose authenticator is lost', async () => {
      // Arrange — the phone holds a passkey it can no longer use; the owner re-opens its window.
      const { service, store } = fixture({ nowMs: PAIRED_AT_MS + 86_400_000 });
      store.rows.push({
        credentialId: toBase64Url(CREDENTIAL_ID),
        deviceId: phone.deviceId,
        algorithm: -7,
        publicKeySpki: 'AAAA',
        signCount: 3,
        origin: ORIGIN,
        createdAt: new Date(PAIRED_AT_MS).toISOString(),
      });
      await service.reopenRegistration({ hostLocal: true }, phone.deviceId);

      // Act
      const view = await service.view(remote());
      const options = await service.registrationOptions(remote(), ORIGIN);
      const added = await service.register(remote(), await registrationBody(await es256Authenticator(), SECOND_ID));

      // Assert
      should(view.ok && view.value.registration).equal('reopened');
      should(options.ok && 'confirm' in options.value).be.false();
      should(added.ok).be.true();
      should(service.held(phone)).be.false();
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
            name: 'Phone → studio',
            displayName: 'Ferretry: Phone → studio',
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

    it('should name the passkey by device and machine, shortening the device first to fit 64 bytes', async () => {
      // Arrange
      const bytes = (text: string) => new TextEncoder().encode(text).length;
      const { service } = fixture({
        deviceName: 'Kirin’s very long iPhone 17 Pro Max with a story',
        machineName: 'AMER-D22HXVF42W',
      });

      // Act
      const options = await service.registrationOptions(remote(), ORIGIN);

      // Assert
      if (!options.ok) throw new Error(options.refusal);
      should(options.value.user.name).equal('Kirin’s very long iPhone 17 Pro Max wit… → AMER-D22HXVF42W');
      should(options.value.user.displayName).equal('Ferretry: Kirin’s very long iPhone 17 P… → AMER-D22HXVF42W');
      should(bytes(options.value.user.name)).belowOrEqual(64);
      should(bytes(options.value.user.displayName)).belowOrEqual(64);
    });

    it('should keep part of the device name when the machine name alone would fill the budget', async () => {
      // Arrange
      const { service } = fixture({ deviceName: 'iPhone 17 Pro', machineName: 'm'.repeat(100) });

      // Act
      const options = await service.registrationOptions(remote(), ORIGIN);

      // Assert
      if (!options.ok) throw new Error(options.refusal);
      should(options.value.user.name).equal(`iPhone 17… → ${'m'.repeat(44)}…`);
      should(options.value.user.displayName).equal(`Ferretry: iPhone 17… → ${'m'.repeat(34)}…`);
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
    it('should store the verified credential and grant NO step-up for it', async () => {
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
      // A registration proves nothing about the person: the next act asks for a step-up like any other.
      should(service.held(phone)).be.false();
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

      // Act — confirmed by that very passkey, so the duplicate is what refuses
      await service.registrationOptions(remote(), ORIGIN);
      const again = await service.register(remote(), {
        ...(await registrationBody(authenticator)),
        confirmation: await confirmationBy(authenticator, CHALLENGE),
      });

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

    it('should refuse a rewound or stuck counter, keep the stored one and write the refusal down', async () => {
      // Arrange
      const { service, store, audited } = fixture();
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
      should(audited.map(entry => entry.changes).slice(1)).eql([
        [`passkey.counter-refused=${phone.deviceId}`],
        [`passkey.counter-refused=${phone.deviceId}`],
      ]);
    });

    it('should refuse a counter a concurrent assertion already moved past, and write it down', async () => {
      // Two copies of the app verify against the same stored count; the store's compare-and-set lets one win.
      // Arrange
      const { service, store, audited } = fixture();
      const authenticator = await es256Authenticator();
      await enrol(service, authenticator);
      await service.stepUpOptions(remote(), ORIGIN);
      const body = await assertionBody(authenticator, { auth: { signCount: 6 } });
      // The other tab's assertion landed first, at 9, after this one was verified against 0.
      const raced = store.updateSignCount.bind(store);
      store.updateSignCount = async (id, credentialId, count) => {
        await raced(id, credentialId, 9);
        return await raced(id, credentialId, count);
      };

      // Act
      const stepped = await service.stepUp(remote(), body);

      // Assert
      should(stepped).eql({ ok: false, refusal: 'not-verified' });
      should(store.rows[0]?.signCount).equal(9);
      should(service.held(phone)).be.false();
      should(audited.at(-1)?.changes).eql([`passkey.counter-refused=${phone.deviceId}`]);
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
    const authenticator = await es256Authenticator();
    await enrol(service, authenticator);
    await service.stepUpOptions(remote(), ORIGIN);
    should((await service.stepUp(remote(), await assertionBody(authenticator))).ok).be.true();
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
    const authenticator = await es256Authenticator();
    await enrol(service, authenticator);
    await service.stepUpOptions(remote(), ORIGIN);
    should((await service.stepUp(remote(), await assertionBody(authenticator))).ok).be.true();

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

  it('should never count the unlock as a FRESH proof: adding a device wants a passkey for it', async () => {
    // Arrange — unlocked, `stepUpOnActions` off: every ordinary act is allowed with no prompt.
    const { service, authenticator, registry } = await enrolled({
      settings: { unlockOnOpen: true, stepUpOnActions: false },
    });
    await service.unlockOptions(remote(), ORIGIN);
    await service.unlock(remote(), await nextAssertion(authenticator, 1));
    registry.forgetDevice(phone.deviceId);

    // Act / Assert — held for ordinary acts, never fresh for one that adds access.
    should(service.held(phone)).be.true();
    should(service.freshlyHeld(phone)).be.false();

    // A passkey proved now is fresh, and one act that adds access spends it.
    await service.stepUpOptions(remote(), ORIGIN);
    should((await service.stepUp(remote(), await nextAssertion(authenticator, 2))).ok).be.true();
    should(service.freshlyHeld(phone)).be.true();
    service.spendFresh(phone);
    should(service.freshlyHeld(phone)).be.false();
    should(service.held(phone)).be.true();
  });

  it('should let an unlock-only device claim no proof, and a stepped-up one claim it exactly once', async () => {
    // Arrange
    const { service, authenticator } = await enrolled({ settings: { unlockOnOpen: true, stepUpOnActions: false } });
    await service.unlockOptions(remote(), ORIGIN);
    await service.unlock(remote(), await nextAssertion(authenticator, 1));
    should(service.held(phone)).be.true();

    // Act / Assert — the unlock opened the machine; it is no proof for an act.
    should(service.claimFresh(phone)).be.false();
    await service.stepUpOptions(remote(), ORIGIN);
    should((await service.stepUp(remote(), await nextAssertion(authenticator, 2))).ok).be.true();
    should([service.claimFresh(phone), service.claimFresh(phone)]).deepEqual([true, false]);
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

  it('should NOT count registering a passkey as an unlock: the new device unlocks with it next', async () => {
    // Review M3: code in the page can forge an attestation, so a registration proves nothing about the person.
    // Arrange
    const { service } = fixture({ settings: { unlockOnOpen: true } });
    should(service.unlockRequired(phone)).be.true();

    // Act
    await enrol(service, await es256Authenticator());

    // Assert
    should(service.unlockRequired(phone)).be.true();
    should(service.held(phone)).be.false();
  });

  it('should forget a revoked device’s confirmation', async () => {
    // Arrange
    const { service, authenticator } = await enrolled({ settings: { unlockOnOpen: true } });
    await service.unlockOptions(remote(), ORIGIN);
    should((await service.unlock(remote(), await nextAssertion(authenticator, 1))).ok).be.true();
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

/** The unlock ledger in memory, standing in for `state/unlocks.json` across a "restart". */
class MemoryUnlockLedger implements UnlockLedgerPort {
  stored = new Map<string, number>();
  writes = 0;
  failRead: Error | undefined;
  failWrite: Error | undefined;
  async read(): Promise<ReadonlyMap<string, number>> {
    if (this.failRead !== undefined) throw this.failRead;
    return new Map(this.stored);
  }
  async write(unlocks: ReadonlyMap<string, number>): Promise<void> {
    this.writes += 1;
    if (this.failWrite !== undefined) throw this.failWrite;
    this.stored = new Map(unlocks);
  }
}

describe('StepUpService unlock across a restart (owner: "we don\'t need to authenticate every time the daemon updates")', () => {
  const nextAssertion = (authenticator: Authenticator, signCount: number) =>
    assertionBody(authenticator, { auth: { signCount }, storedCount: signCount - 1 });

  /** A machine whose phone has unlocked, then a fresh copy of the service over the same ledger: a restart. */
  async function unlockedThenRestarted(settings: Partial<SecuritySettings> = { unlockOnOpen: true }) {
    const unlocks = new MemoryUnlockLedger();
    const before = fixture({ settings, unlocks });
    const authenticator = await es256Authenticator();
    await enrol(before.service, authenticator);
    before.clock.now += HOUR_MS;
    await before.service.unlockOptions(remote(), ORIGIN);
    should((await before.service.unlock(remote(), await nextAssertion(authenticator, 1))).ok).be.true();
    const unlockedAt = before.clock.now;
    const after = fixture({ settings, unlocks, nowMs: unlockedAt + HOUR_MS });
    return { unlocks, before, after, unlockedAt };
  }

  it('should keep a device unlocked through a restart inside its period, and ask again once it lapses', async () => {
    // Arrange
    const { after, unlockedAt, unlocks } = await unlockedThenRestarted({ unlockOnOpen: true, unlockValidityHours: 8 });
    should(unlocks.stored.get(phone.deviceId)).equal(unlockedAt);

    // Act
    const notice = await after.service.restore();

    // Assert
    should(notice).be.undefined();
    should(after.service.unlockRequired(phone)).be.false();
    should(after.service.held(phone)).be.true();
    after.clock.now = unlockedAt + 8 * HOUR_MS;
    should(after.service.unlockRequired(phone)).be.true();
  });

  it('should honour a shorter period set while it was down, and the longest one a week allows', async () => {
    // Arrange
    const shorter = await unlockedThenRestarted({ unlockOnOpen: true, unlockValidityHours: 1 });
    const week = await unlockedThenRestarted({ unlockOnOpen: true, unlockValidityHours: 168 });

    // Act
    await shorter.after.service.restore();
    week.after.clock.now = week.unlockedAt + 167 * HOUR_MS;
    await week.after.service.restore();

    // Assert
    should(shorter.after.service.unlockRequired(phone)).be.true();
    should(week.after.service.unlockRequired(phone)).be.false();
  });

  it('should restore nothing for a device unpaired meanwhile, an instant in the future, or one older than any period', async () => {
    // Arrange
    const unpaired = await unlockedThenRestarted();
    unpaired.after.directory.paired = false;
    const future = await unlockedThenRestarted();
    future.unlocks.stored.set(phone.deviceId, future.after.clock.now + 1);
    const ancient = await unlockedThenRestarted({ unlockOnOpen: true, unlockValidityHours: 168 });
    ancient.after.clock.now = ancient.unlockedAt + 168 * HOUR_MS;

    // Act
    await unpaired.after.service.restore();
    await future.after.service.restore();
    await ancient.after.service.restore();

    // Assert
    unpaired.after.directory.paired = true;
    should(unpaired.after.service.unlockRequired(phone)).be.true();
    should(future.after.service.unlockRequired(phone)).be.true();
    should(ancient.after.service.unlockRequired(phone)).be.true();
  });

  it('should forget a revoked device in the ledger too, so no restart brings its unlock back', async () => {
    // Arrange
    const { before, unlocks } = await unlockedThenRestarted();

    // Act
    await before.service.forgetDevice(phone.deviceId);

    // Assert
    should(unlocks.stored.has(phone.deviceId)).be.false();
  });

  it('should drop an unlock no setting could honour when it next writes', async () => {
    // Arrange
    const { before, unlocks } = await unlockedThenRestarted();
    unlocks.stored.set(laptop.deviceId, 0);
    before.clock.now += 200 * HOUR_MS;

    // Act
    await before.service.forgetDevice(laptop.deviceId);

    // Assert
    should([...unlocks.stored.keys()]).eql([]);
  });

  it('should ask every device again, and say why, when the ledger cannot be read', async () => {
    // Arrange
    const { after, unlocks } = await unlockedThenRestarted();
    unlocks.failRead = new Error('not valid JSON');

    // Act
    const notice = await after.service.restore();

    // Assert
    should(notice).equal(
      'the unlock ledger could not be read (not valid JSON), so every device is asked to unlock again',
    );
    should(after.service.unlockRequired(phone)).be.true();
    unlocks.failRead = undefined;
    // A thrown non-Error is said as itself.
    const odd = fixture({
      settings: { unlockOnOpen: true },
      unlocks: { read: async () => Promise.reject('gone'), write: async () => {} },
    });
    should(await odd.service.restore()).equal(
      'the unlock ledger could not be read (gone), so every device is asked to unlock again',
    );
  });

  it('should still unlock when the ledger cannot be written, costing only the next restart', async () => {
    // Arrange
    const unlocks = new MemoryUnlockLedger();
    unlocks.failWrite = new Error('disk full');
    const { service, clock } = fixture({ settings: { unlockOnOpen: true }, unlocks });
    const authenticator = await es256Authenticator();
    await enrol(service, authenticator);
    clock.now += HOUR_MS;
    await service.unlockOptions(remote(), ORIGIN);

    // Act
    const granted = await service.unlock(remote(), await nextAssertion(authenticator, 1));

    // Assert
    should(granted.ok).be.true();
    should(service.unlockRequired(phone)).be.false();
    should(unlocks.writes).equal(1);
    should(unlocks.stored.size).equal(0);
  });

  it('should restore nothing, and say nothing, without a ledger', async () => {
    // Arrange
    const { service } = fixture({ settings: { unlockOnOpen: true } });

    // Act / Assert
    should(await service.restore()).be.undefined();
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
