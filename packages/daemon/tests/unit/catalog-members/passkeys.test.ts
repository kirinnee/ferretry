import { describe, it } from 'bun:test';
import { MAX_PASSKEYS_PER_DEVICE, memberPasskeyName, PASSKEY_CHALLENGE_TTL_SECONDS } from '@ferretry/protocol';
import { toBase64Url } from '@ferretry/relay';
import should from 'should';
import type { AuditEntry } from '../../../src/lib/audit/types.ts';
import { MEMBER_PASSKEY_REFUSALS, MemberPasskeyService } from '../../../src/lib/catalog-members/passkeys.ts';
import type { MemberAccess } from '../../../src/lib/catalog-members/service.ts';
import {
  ChallengeLedger,
  passkeyVerifier,
  type PasskeyStore,
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
import { catalogId, DAY, iso, keyId, memberId, MINUTE, T0 } from './support.ts';

/**
 * A member's passkeys and unlock, over the REAL WebAuthn verifier and a software authenticator: every verdict is
 * a verdict on bytes laid out as an authenticator lays them out.
 */

const OTHER_ORIGIN = 'https://ferretry.example.com';
const SECOND_ID = Uint8Array.from({ length: 16 }, () => 0x11);
const WINDOW_ENDS = iso(T0 + 10 * MINUTE);

class MemoryPasskeys implements PasskeyStore {
  rows: StoredPasskey[] = [];
  forgotten: string[] = [];
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
    const row = this.rows.find(candidate => candidate.deviceId === id && candidate.credentialId === credentialId);
    if (row === undefined || (row.signCount >= signCount && (row.signCount !== 0 || signCount !== 0))) return false;
    this.rows = this.rows.map(candidate => (candidate === row ? { ...row, signCount } : candidate));
    return true;
  }
  async forgetDevice(id: string) {
    this.forgotten.push(id);
    this.rows = this.rows.filter(row => row.deviceId !== id);
  }
}

class MemoryUnlocks implements UnlockLedgerPort {
  stored = new Map<string, number>();
  writes: Map<string, number>[] = [];
  failRead: unknown;
  failWrite: Error | undefined;
  hold: Promise<void> | undefined;
  active = 0;
  overlapped = false;
  async read() {
    if (this.failRead !== undefined) throw this.failRead;
    return this.stored;
  }
  async write(unlocks: ReadonlyMap<string, number>) {
    this.active += 1;
    if (this.active > 1) this.overlapped = true;
    const gate = this.hold;
    this.hold = undefined;
    await gate;
    this.writes.push(new Map(unlocks));
    this.active -= 1;
    if (this.failWrite !== undefined) throw this.failWrite;
  }
}

const accessOf = (n = 1, overrides: Partial<MemberAccess> = {}): MemberAccess => ({
  memberId: memberId(n),
  keyId: keyId(n),
  label: 'Alice',
  memberKey: 'ignored',
  clientName: 'Firefox on a Mac',
  catalogIds: [catalogId(1)],
  passkeyCount: 0,
  passkeyWindowEndsAt: WINDOW_ENDS,
  ...overrides,
});

const callerOf = (access: MemberAccess = accessOf(), appSession = 'tab-one') => ({ access, appSession });

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

function fixture(
  options: {
    origins?: readonly string[];
    days?: number;
    withLedger?: boolean;
    auditFails?: boolean;
    names?: ReadonlyMap<string, string>;
    daemonName?: string;
  } = {},
) {
  const clock = { now: T0 };
  const store = new MemoryPasskeys();
  const ledger = new MemoryUnlocks();
  const challenges = new ChallengeLedger();
  const audited: AuditEntry[] = [];
  const added: string[] = [];
  const config = { days: options.days ?? 30 };
  const service = new MemberPasskeyService({
    store,
    verifier: passkeyVerifier(webCrypto),
    challenges,
    random: { bytes: length => CHALLENGE.slice(0, length) },
    clock: { nowMs: () => clock.now },
    ...(options.withLedger === false ? {} : { unlocks: ledger }),
    members: {
      passkeyAdded: async id => {
        added.push(id);
        return added.length;
      },
    },
    catalogNames: async () => options.names ?? new Map([[catalogId(1), 'Spring Pack']]),
    allowedOrigins: () => options.origins ?? [ORIGIN, OTHER_ORIGIN],
    relyingPartyName: 'Ferretry',
    daemonName: () => options.daemonName ?? 'studio',
    unlockDays: () => config.days,
    audit: {
      record: async entry => {
        audited.push(entry);
        if (options.auditFails === true) throw new Error('audit is down');
      },
    },
  });
  return { clock, store, ledger, challenges, service, audited, added, config };
}

type Fixture = ReturnType<typeof fixture>;

/** Registers one passkey through both calls, as the app does. */
async function enrol(
  { service }: Fixture,
  authenticator: Authenticator,
  caller = callerOf(),
  credentialId = CREDENTIAL_ID,
) {
  const options = await service.registrationOptions(caller, ORIGIN);
  should(options.ok).be.true();
  return await service.register(caller, await registrationBody(authenticator, credentialId));
}

/** Asks to unlock and answers with the authenticator, as the app does. */
async function unlockWith(
  { service }: Fixture,
  authenticator: Authenticator,
  caller = callerOf(),
  credentialId = toBase64Url(CREDENTIAL_ID),
  signCount = 1,
) {
  const options = await service.unlockOptions(caller, ORIGIN);
  should(options.ok).be.true();
  return await service.unlock(caller, await assertionBody(authenticator, { auth: { signCount } }, credentialId));
}

describe('MemberPasskeyService', () => {
  it('should name its closed set of refusals', () => {
    // Arrange / Act / Assert
    should([...MEMBER_PASSKEY_REFUSALS]).eql([
      'origin-not-allowed',
      'registration-closed',
      'too-many-passkeys',
      'no-passkey',
      'not-verified',
    ]);
  });

  describe('registration options', () => {
    it('should bind the user handle to the KEY id and name the account for the person and the catalog', async () => {
      // Arrange
      const f = fixture();
      const access = accessOf(1);

      // Act
      const options = await f.service.registrationOptions(callerOf(access), ORIGIN);

      // Assert
      should(options.ok).be.true();
      if (!options.ok) return;
      const name = memberPasskeyName('Alice', ['Spring Pack'], 'studio');
      should(options.value.user).eql({
        id: toBase64Url(new TextEncoder().encode(keyId(1))),
        name,
        displayName: name,
      });
      should(options.value.challenge).equal(toBase64Url(CHALLENGE));
      should(options.value.rp).eql({ id: 'ferretry.pages.dev', name: 'Ferretry' });
      should(options.value.timeout).equal(PASSKEY_CHALLENGE_TTL_SECONDS * 1_000);
      should(options.value.excludeCredentials).eql([]);
    });

    it('should count catalogs when a member holds several and skip ids it has no name for', async () => {
      // Arrange
      const names = new Map([
        [catalogId(1), 'One'],
        [catalogId(2), 'Two'],
      ]);
      const f = fixture({ names });
      const access = accessOf(1, { catalogIds: [catalogId(1), catalogId(2), catalogId(3)] });

      // Act
      const options = await f.service.registrationOptions(callerOf(access), ORIGIN);

      // Assert
      should(options.ok && options.value.user.name).equal(memberPasskeyName('Alice', ['One', 'Two'], 'studio'));
    });

    it('should refuse an origin the daemon does not serve, before anything is read', async () => {
      // Arrange
      const f = fixture();

      // Act
      const options = await f.service.registrationOptions(callerOf(), 'https://evil.example.test');

      // Assert
      should(options).eql({ ok: false, refusal: 'origin-not-allowed' });
    });

    it('should list held credentials for an unlocked key', async () => {
      // Arrange
      const f = fixture();
      const authenticator = await es256Authenticator();
      await enrol(f, authenticator);
      await unlockWith(f, authenticator);

      // Act
      const options = await f.service.registrationOptions(callerOf(), ORIGIN);

      // Assert
      should(options.ok && options.value.excludeCredentials).eql([
        { type: 'public-key', id: toBase64Url(CREDENTIAL_ID) },
      ]);
    });
  });

  describe('who may add a passkey', () => {
    it('should allow the first passkey inside the key window', async () => {
      // Arrange
      const f = fixture();

      // Act / Assert
      should(await f.service.mayRegister(accessOf())).be.true();
    });

    it('should refuse once the window has closed, and when the key has no window at all', async () => {
      // Arrange
      const f = fixture();
      f.clock.now = T0 + 10 * MINUTE;

      // Act / Assert
      should(await f.service.mayRegister(accessOf())).be.false();
      should(await f.service.mayRegister(accessOf(1, { passkeyWindowEndsAt: undefined }))).be.false();
      should(await f.service.registrationOptions(callerOf(), ORIGIN)).eql({
        ok: false,
        refusal: 'registration-closed',
      });
    });

    it('should refuse a second passkey inside the window while the key is not unlocked', async () => {
      // Arrange
      const f = fixture();
      await enrol(f, await es256Authenticator());

      // Act
      const second = await f.service.registrationOptions(callerOf(), ORIGIN);

      // Assert
      should(await f.service.mayRegister(accessOf())).be.false();
      should(second).eql({ ok: false, refusal: 'registration-closed' });
    });

    it('should allow another passkey after the unlock, even once the window is long closed', async () => {
      // Arrange
      const f = fixture();
      const first = await es256Authenticator();
      await enrol(f, first);
      await unlockWith(f, first);
      f.clock.now = T0 + 2 * DAY;

      // Act
      const added = await enrol(f, await es256Authenticator(), callerOf(), SECOND_ID);

      // Assert
      should(added.ok).be.true();
      should((await f.service.views(keyId(1))).length).equal(2);
    });

    it('should refuse past the cap whatever the unlock says, with the cap reason', async () => {
      // Arrange
      const f = fixture();
      const first = await es256Authenticator();
      await enrol(f, first);
      await unlockWith(f, first);
      for (let n = 0; n < MAX_PASSKEYS_PER_DEVICE; n += 1)
        if ((await f.store.list(keyId(1))).length < MAX_PASSKEYS_PER_DEVICE)
          f.store.rows.push({ ...(f.store.rows[0] as StoredPasskey), credentialId: `filler${n}` });

      // Act
      const options = await f.service.registrationOptions(callerOf(), ORIGIN);
      const register = await f.service.register(
        callerOf(),
        await registrationBody(await es256Authenticator(), SECOND_ID),
      );

      // Assert
      should(await f.service.mayRegister(accessOf())).be.false();
      should(options).eql({ ok: false, refusal: 'too-many-passkeys' });
      should(register).eql({ ok: false, refusal: 'too-many-passkeys' });
    });
  });

  describe('register', () => {
    it('should store the passkey under the key id, count it, and audit it without a secret', async () => {
      // Arrange
      const f = fixture();

      // Act
      const added = await enrol(f, await es256Authenticator());

      // Assert
      should(added).eql({
        ok: true,
        value: { id: toBase64Url(CREDENTIAL_ID), origin: ORIGIN, createdAt: iso(T0) },
      });
      should(f.store.rows.map(row => row.deviceId)).eql([keyId(1)]);
      should(f.added).eql([keyId(1)]);
      should(f.audited).eql([
        {
          actor: { kind: 'anonymous' },
          event: 'catalog.member.passkey-added',
          subject: memberId(1),
          outcome: 'succeeded',
          detail: { memberLabel: 'Alice', keyId: keyId(1), clientName: 'Firefox on a Mac' },
        },
      ]);
      const text = JSON.stringify(f.audited);
      should(text.includes(toBase64Url(CREDENTIAL_ID))).be.false();
      should(text.includes(f.store.rows[0]?.publicKeySpki ?? 'x')).be.false();
    });

    it('should still answer when the audit cannot be written', async () => {
      // Arrange
      const f = fixture({ auditFails: true });

      // Act
      const added = await enrol(f, await es256Authenticator());

      // Assert
      should(added.ok).be.true();
    });

    it('should spend the challenge FIRST, so a refusal for any other reason still consumes it', async () => {
      // Arrange
      const f = fixture();
      const authenticator = await es256Authenticator();
      await f.service.registrationOptions(callerOf(), ORIGIN);
      f.clock.now = T0 + 10 * MINUTE;
      const body = await registrationBody(authenticator);

      // Act
      const late = await f.service.register(callerOf(), body);
      f.clock.now = T0 + MINUTE;
      const again = await f.service.register(callerOf(), body);

      // Assert — the window was closed, and the challenge went with that refusal
      should(late).eql({ ok: false, refusal: 'registration-closed' });
      should(again).eql({ ok: false, refusal: 'not-verified' });
      should(f.store.rows).eql([]);
    });

    it('should consume the challenge on the cap refusal too', async () => {
      // Arrange
      const f = fixture();
      const first = await es256Authenticator();
      await enrol(f, first);
      await unlockWith(f, first);
      for (let n = 0; n < MAX_PASSKEYS_PER_DEVICE; n += 1)
        f.store.rows.push({ ...(f.store.rows[0] as StoredPasskey), credentialId: `filler${n}` });
      const subject = { deviceId: keyId(1), appSession: 'tab-one' };
      f.challenges.issue(subject, 'register', CHALLENGE, T0);

      // Act
      const refused = await f.service.register(
        callerOf(),
        await registrationBody(await es256Authenticator(), SECOND_ID),
      );

      // Assert
      should(refused).eql({ ok: false, refusal: 'too-many-passkeys' });
      should(f.challenges.take(subject, 'register', T0)).be.undefined();
    });

    it('should refuse an answer to a challenge nobody asked', async () => {
      // Arrange
      const f = fixture();

      // Act
      const added = await f.service.register(callerOf(), await registrationBody(await es256Authenticator()));

      // Assert
      should(added).eql({ ok: false, refusal: 'not-verified' });
    });

    it('should refuse a challenge another copy of the app was given', async () => {
      // Arrange
      const f = fixture();
      await f.service.registrationOptions(callerOf(accessOf(), 'tab-one'), ORIGIN);

      // Act
      const added = await f.service.register(
        callerOf(accessOf(), 'tab-two'),
        await registrationBody(await es256Authenticator()),
      );

      // Assert
      should(added).eql({ ok: false, refusal: 'not-verified' });
    });

    it('should refuse bytes that are not base64url', async () => {
      // Arrange
      const f = fixture();
      await f.service.registrationOptions(callerOf(), ORIGIN);
      const body = await registrationBody(await es256Authenticator());

      // Act
      const added = await f.service.register(callerOf(), { ...body, clientDataJSON: '!!!' });

      // Assert
      should(added).eql({ ok: false, refusal: 'not-verified' });
    });

    it('should refuse an attestation the verifier will not take', async () => {
      // Arrange
      const f = fixture();
      await f.service.registrationOptions(callerOf(), ORIGIN);
      const made = await registration(await es256Authenticator(), {
        client: clientData('webauthn.create', { origin: 'https://evil.example.test' }),
      });

      // Act
      const added = await f.service.register(callerOf(), {
        credentialId: toBase64Url(CREDENTIAL_ID),
        clientDataJSON: toBase64Url(made.clientDataJSON),
        attestationObject: toBase64Url(made.attestationObject),
      });

      // Assert
      should(added).eql({ ok: false, refusal: 'not-verified' });
    });

    it('should refuse a credential id the attestation does not carry', async () => {
      // Arrange
      const f = fixture();
      await f.service.registrationOptions(callerOf(), ORIGIN);
      const body = await registrationBody(await es256Authenticator());

      // Act
      const added = await f.service.register(callerOf(), { ...body, credentialId: toBase64Url(SECOND_ID) });

      // Assert
      should(added).eql({ ok: false, refusal: 'not-verified' });
    });

    it('should refuse a credential another key already holds, so a synced passkey cannot cross keys', async () => {
      // Arrange
      const f = fixture();
      const authenticator = await es256Authenticator();
      await enrol(f, authenticator, callerOf(accessOf(1)));

      // Act
      const options = await f.service.registrationOptions(callerOf(accessOf(2)), ORIGIN);
      const added = await f.service.register(callerOf(accessOf(2)), await registrationBody(authenticator));

      // Assert
      should(options.ok).be.true();
      should(added).eql({ ok: false, refusal: 'not-verified' });
      should(f.store.rows.map(row => row.deviceId)).eql([keyId(1)]);
    });
  });

  describe('unlock options', () => {
    it('should refuse an origin the daemon does not serve', async () => {
      // Arrange
      const f = fixture();

      // Act / Assert
      should(await f.service.unlockOptions(callerOf(), 'https://evil.example.test')).eql({
        ok: false,
        refusal: 'origin-not-allowed',
      });
    });

    it('should refuse a key with no passkey made at this origin', async () => {
      // Arrange
      const f = fixture();
      await enrol(f, await es256Authenticator());

      // Act
      const none = await f.service.unlockOptions(callerOf(accessOf(2)), ORIGIN);
      const elsewhere = await f.service.unlockOptions(callerOf(), OTHER_ORIGIN);

      // Assert
      should(none).eql({ ok: false, refusal: 'no-passkey' });
      should(elsewhere).eql({ ok: false, refusal: 'no-passkey' });
    });

    it('should offer only the passkeys made at that origin', async () => {
      // Arrange
      const f = fixture();
      await enrol(f, await es256Authenticator());

      // Act
      const options = await f.service.unlockOptions(callerOf(), ORIGIN);

      // Assert
      should(options).eql({
        ok: true,
        value: {
          challenge: toBase64Url(CHALLENGE),
          rpId: 'ferretry.pages.dev',
          allowCredentials: [{ type: 'public-key', id: toBase64Url(CREDENTIAL_ID) }],
          timeout: PASSKEY_CHALLENGE_TTL_SECONDS * 1_000,
        },
      });
    });
  });

  describe('unlock', () => {
    it('should unlock for the configured number of days and say when it ends', async () => {
      // Arrange
      const f = fixture();
      const authenticator = await es256Authenticator();
      await enrol(f, authenticator);
      should(f.service.unlockExpiresAt(keyId(1))).be.undefined();

      // Act
      const unlocked = await unlockWith(f, authenticator);

      // Assert
      should(unlocked).eql({ ok: true, value: { unlockedUntil: iso(T0 + 30 * DAY) } });
      should(f.service.unlockExpiresAt(keyId(1))).equal(T0 + 30 * DAY);
      should(f.service.unlockExpiresAt(keyId(2))).be.undefined();
    });

    it('should follow the setting as it changes and end when the period passes', async () => {
      // Arrange
      const f = fixture({ days: 2 });
      const authenticator = await es256Authenticator();
      await enrol(f, authenticator);

      // Act
      const unlocked = await unlockWith(f, authenticator);
      f.clock.now = T0 + 2 * DAY - 1;
      const stillOpen = f.service.unlockExpiresAt(keyId(1));
      f.clock.now = T0 + 2 * DAY;
      const ended = f.service.unlockExpiresAt(keyId(1));
      f.config.days = 90;
      const longer = f.service.unlockExpiresAt(keyId(1));

      // Assert
      should(unlocked).eql({ ok: true, value: { unlockedUntil: iso(T0 + 2 * DAY) } });
      should(stillOpen).equal(T0 + 2 * DAY);
      should(ended).be.undefined();
      should(longer).equal(T0 + 90 * DAY);
    });

    it('should audit the unlock without a credential in it', async () => {
      // Arrange
      const f = fixture();
      const authenticator = await es256Authenticator();
      await enrol(f, authenticator);
      f.audited.length = 0;

      // Act
      await unlockWith(f, authenticator);

      // Assert
      should(f.audited).eql([
        {
          actor: { kind: 'anonymous' },
          event: 'catalog.member.unlocked',
          subject: memberId(1),
          outcome: 'succeeded',
          detail: { memberLabel: 'Alice', keyId: keyId(1) },
        },
      ]);
    });

    it('should still unlock when the audit cannot be written', async () => {
      // Arrange
      const f = fixture({ auditFails: true });
      const authenticator = await es256Authenticator();
      await enrol(f, authenticator);

      // Act
      const unlocked = await unlockWith(f, authenticator);

      // Assert
      should(unlocked.ok).be.true();
    });

    it('should answer once: a second answer to the same challenge is refused', async () => {
      // Arrange
      const f = fixture();
      const authenticator = await es256Authenticator();
      await enrol(f, authenticator);
      await f.service.unlockOptions(callerOf(), ORIGIN);
      const body = await assertionBody(authenticator, { auth: { signCount: 1 } });

      // Act
      const first = await f.service.unlock(callerOf(), body);
      const second = await f.service.unlock(callerOf(), body);

      // Assert
      should(first.ok).be.true();
      should(second).eql({ ok: false, refusal: 'not-verified' });
    });

    it('should refuse an answer when nothing was asked', async () => {
      // Arrange
      const f = fixture();
      const authenticator = await es256Authenticator();
      await enrol(f, authenticator);

      // Act
      const unlocked = await f.service.unlock(callerOf(), await assertionBody(authenticator));

      // Assert
      should(unlocked).eql({ ok: false, refusal: 'not-verified' });
      should(f.service.unlockExpiresAt(keyId(1))).be.undefined();
    });

    it('should refuse a credential the key does not hold', async () => {
      // Arrange
      const f = fixture();
      const authenticator = await es256Authenticator();
      await enrol(f, authenticator);
      await f.service.unlockOptions(callerOf(), ORIGIN);

      // Act
      const unlocked = await f.service.unlock(
        callerOf(),
        await assertionBody(authenticator, {}, toBase64Url(SECOND_ID)),
      );

      // Assert
      should(unlocked).eql({ ok: false, refusal: 'not-verified' });
    });

    it('should refuse another key using this key passkey', async () => {
      // Arrange
      const f = fixture();
      const authenticator = await es256Authenticator();
      await enrol(f, authenticator);
      await f.service.unlockOptions(callerOf(accessOf(2)), ORIGIN).catch(() => undefined);
      f.challenges.issue({ deviceId: keyId(2), appSession: 'tab-one' }, 'unlock', CHALLENGE, T0);

      // Act
      const unlocked = await f.service.unlock(callerOf(accessOf(2)), await assertionBody(authenticator));

      // Assert
      should(unlocked).eql({ ok: false, refusal: 'not-verified' });
    });

    it('should refuse bytes that are not base64url', async () => {
      // Arrange
      const f = fixture();
      const authenticator = await es256Authenticator();
      await enrol(f, authenticator);
      await f.service.unlockOptions(callerOf(), ORIGIN);
      const body = await assertionBody(authenticator);

      // Act
      const unlocked = await f.service.unlock(callerOf(), { ...body, signature: '!!!' });

      // Assert
      should(unlocked).eql({ ok: false, refusal: 'not-verified' });
    });

    it('should refuse an assertion the verifier will not take', async () => {
      // Arrange
      const f = fixture();
      const authenticator = await es256Authenticator();
      await enrol(f, authenticator);
      await f.service.unlockOptions(callerOf(), ORIGIN);

      // Act — signed by a different authenticator
      const unlocked = await f.service.unlock(callerOf(), await assertionBody(await es256Authenticator()));

      // Assert
      should(unlocked).eql({ ok: false, refusal: 'not-verified' });
    });

    it('should refuse a replayed counter', async () => {
      // Arrange
      const f = fixture();
      const authenticator = await es256Authenticator();
      await enrol(f, authenticator);
      await unlockWith(f, authenticator, callerOf(), toBase64Url(CREDENTIAL_ID), 5);
      f.store.rows = f.store.rows.map(row => ({ ...row, signCount: 9 }));

      // Act
      const again = await unlockWith(f, authenticator, callerOf(), toBase64Url(CREDENTIAL_ID), 6);

      // Assert
      should(again).eql({ ok: false, refusal: 'not-verified' });
    });
  });

  describe('keeping unlocks across a restart', () => {
    it('should write the unlock to the ledger, keyed by key id', async () => {
      // Arrange
      const f = fixture();
      const authenticator = await es256Authenticator();
      await enrol(f, authenticator);

      // Act
      await unlockWith(f, authenticator);

      // Assert
      should(f.ledger.writes.map(write => [...write])).eql([[[keyId(1), T0]]]);
    });

    it('should drop unlocks older than the longest period when it writes', async () => {
      // Arrange
      const f = fixture();
      f.ledger.stored = new Map([[keyId(9), T0 - 91 * DAY]]);
      await f.service.restore();
      const authenticator = await es256Authenticator();
      await enrol(f, authenticator);

      // Act
      await unlockWith(f, authenticator);

      // Assert
      should(f.ledger.writes.map(write => [...write.keys()])).eql([[keyId(1)]]);
    });

    it('should keep the unlock in memory when the ledger cannot be written, and keep later writes going', async () => {
      // Arrange
      const f = fixture();
      f.ledger.failWrite = new Error('disk full');
      const authenticator = await es256Authenticator();
      await enrol(f, authenticator);

      // Act
      const unlocked = await unlockWith(f, authenticator);
      f.ledger.failWrite = undefined;
      await f.service.forgetKey(keyId(1));

      // Assert
      should(unlocked.ok).be.true();
      should(f.ledger.writes.length).equal(2);
      should(f.ledger.writes[1]?.size).equal(0);
    });

    it('should write one snapshot at a time, in order', async () => {
      // Arrange
      const f = fixture();
      const first = await es256Authenticator();
      const second = await es256Authenticator();
      await enrol(f, first, callerOf(accessOf(1)));
      await enrol(f, second, callerOf(accessOf(2)), SECOND_ID);
      let release: () => void = () => undefined;
      f.ledger.hold = new Promise<void>(resolve => {
        release = resolve;
      });

      // Act
      const a = unlockWith(f, first, callerOf(accessOf(1)));
      const b = unlockWith(f, second, callerOf(accessOf(2)), toBase64Url(SECOND_ID));
      await new Promise<void>(resolve => setImmediate(resolve));
      release();
      await Promise.all([a, b]);

      // Assert
      should(f.ledger.overlapped).be.false();
      should(f.ledger.writes.map(write => write.size)).eql([1, 2]);
    });

    it('should keep unlocks in memory alone when there is no ledger', async () => {
      // Arrange
      const f = fixture({ withLedger: false });
      const authenticator = await es256Authenticator();
      await enrol(f, authenticator);

      // Act
      const unlocked = await unlockWith(f, authenticator);
      await f.service.forgetKey(keyId(1));

      // Assert
      should(unlocked.ok).be.true();
      should(await f.service.restore()).be.undefined();
      should(f.ledger.writes).eql([]);
    });
  });

  describe('restore', () => {
    it('should read back an earlier unlock so a restart does not ask again', async () => {
      // Arrange
      const f = fixture();
      f.ledger.stored = new Map([[keyId(1), T0 - 3 * DAY]]);

      // Act
      const notice = await f.service.restore();

      // Assert
      should(notice).be.undefined();
      should(f.service.unlockExpiresAt(keyId(1))).equal(T0 - 3 * DAY + 30 * DAY);
    });

    it('should not honour an unlock from the future or one already past its period', async () => {
      // Arrange
      const f = fixture();
      f.ledger.stored = new Map([
        [keyId(1), T0 + DAY],
        [keyId(2), T0 - 31 * DAY],
      ]);

      // Act
      await f.service.restore();

      // Assert
      should(f.service.unlockExpiresAt(keyId(1))).be.undefined();
      should(f.service.unlockExpiresAt(keyId(2))).be.undefined();
    });

    it('should not overwrite a fresher unlock already in memory', async () => {
      // Arrange
      const f = fixture();
      const authenticator = await es256Authenticator();
      await enrol(f, authenticator);
      await unlockWith(f, authenticator);
      f.ledger.stored = new Map([[keyId(1), T0 - 20 * DAY]]);

      // Act
      await f.service.restore();

      // Assert
      should(f.service.unlockExpiresAt(keyId(1))).equal(T0 + 30 * DAY);
    });

    it('should report a ledger it cannot read, and ask everyone again', async () => {
      // Arrange
      const f = fixture();
      f.ledger.failRead = new Error('the unlock ledger is not valid JSON');

      // Act
      const notice = await f.service.restore();

      // Assert
      should(notice).equal(
        'the member unlock ledger could not be read (the unlock ledger is not valid JSON), so every member is asked to unlock again',
      );
      should(f.service.unlockExpiresAt(keyId(1))).be.undefined();
    });

    it('should report a ledger that failed with something that is not an Error', async () => {
      // Arrange
      const f = fixture();
      f.ledger.failRead = 'gone';

      // Act / Assert
      should(await f.service.restore()).containEql('(gone)');
    });
  });

  describe('forgetKey', () => {
    it('should take the passkeys, the unlock and an open challenge with it', async () => {
      // Arrange
      const f = fixture();
      const authenticator = await es256Authenticator();
      await enrol(f, authenticator);
      await unlockWith(f, authenticator);
      await f.service.unlockOptions(callerOf(), ORIGIN);

      // Act
      await f.service.forgetKey(keyId(1));

      // Assert
      should(await f.service.views(keyId(1))).eql([]);
      should(f.service.unlockExpiresAt(keyId(1))).be.undefined();
      should(f.challenges.take({ deviceId: keyId(1), appSession: 'tab-one' }, 'unlock', T0)).be.undefined();
      should(f.ledger.writes.at(-1)?.size).equal(0);
    });

    it('should not rewrite the ledger for a key that was never unlocked', async () => {
      // Arrange
      const f = fixture();

      // Act
      await f.service.forgetKey(keyId(3));

      // Assert
      should(f.ledger.writes).eql([]);
      should(f.store.forgotten).eql([keyId(3)]);
    });
  });

  describe('views and counts', () => {
    it('should list what the key holds and count it', async () => {
      // Arrange
      const f = fixture();
      await enrol(f, await es256Authenticator());

      // Act / Assert
      should(await f.service.views(keyId(1))).eql([
        { id: toBase64Url(CREDENTIAL_ID), origin: ORIGIN, createdAt: iso(T0) },
      ]);
      should(await f.service.passkeyCount(keyId(1))).equal(1);
      should(await f.service.passkeyCount(keyId(2))).equal(0);
    });
  });
});
