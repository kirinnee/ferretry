import { describe, it } from 'bun:test';
import {
  type AccountIndexDocument,
  AccountIndexDocumentSchema,
  sealedNamesOf,
  TotpParametersSchema,
} from '@ferretry/protocol';
import should from 'should';
import {
  combinedValues,
  LoginIndexDocumentSchema,
  referencedSeals,
  SecretRedactor,
  SecretStoreError,
  totpCode,
} from '../../../src/lib/secrets/index.ts';
import { MemoryLoginIndex } from '../runtime/mounts/support.ts';
import {
  CountingSealed,
  daemonOver,
  FailingIndex,
  GITHUB_PASSWORD,
  GOOGLE_PASSWORD,
  KEY,
  plant,
  SEAL,
  SEED,
  SUDO_PASSWORD,
  version1,
} from './accounts-fixtures.ts';

/**
 * THE BOOT MIGRATION, saved logins → accounts (docs/secrets.md, "Accounts and sign-ins"). r1-plan §2.3 and §5:
 * the sealed document is never written (3), a sweep after it keeps every seal — the password AND every 2FA seed (the
 * single most dangerous line), damaged is not empty (6), an older daemon fails closed (7), masking is the same before
 * and after (8), and the version 1 bytes are kept once for the way back.
 */

const NOW_MS = Date.parse('2026-10-31T09:00:00.000Z');

describe('the migration never touches what is sealed', () => {
  it('should not write the sealed document at all, and keep every sealed name the version 1 index points at', async () => {
    const { index, sealed } = await plant(undefined, undefined, { orphan: false });
    const before = JSON.stringify(await sealed.read());

    const booted = await daemonOver(index, sealed).directory.prepare();

    should(booted.damaged).be.undefined();
    should(sealed.writes).equal(0);
    should(JSON.stringify(await sealed.read())).equal(before);
    const committed = index.accounts;
    const names = Object.values(committed.accounts).flatMap(account => sealedNamesOf(account));
    for (const name of [SEAL.githubPassword, SEAL.githubSeed, SEAL.googlePassword, SEAL.sudoPassword])
      should(names).containEql(name);
  });
});

describe('the sweep after the migration (the most dangerous line)', () => {
  it('should keep the password AND the 2FA seed of every account, and sweep only what nothing points at', async () => {
    const { index, sealed } = await plant();
    const daemon = daemonOver(index, sealed);

    const booted = await daemon.directory.prepare();

    // The orphan is the proof that a sweep ran: it must go, and every value an account points at must stay.
    should(booted.swept).equal(1);
    const left = Object.keys((await sealed.read())?.entries ?? {}).sort();
    should(left).deepEqual([SEAL.githubPassword, SEAL.githubSeed, SEAL.googlePassword, SEAL.sudoPassword].sort());
    should(await daemon.vault.fill('GITHUB', 'password', NOW_MS)).equal(GITHUB_PASSWORD);
    should(await daemon.vault.fill('GITHUB', 'totp', NOW_MS)).equal(
      totpCode(SEED, TotpParametersSchema.parse({}), NOW_MS) as string,
    );
    // And again at the next boot, now over version 2.
    should((await daemonOver(index, sealed).directory.prepare()).swept).equal(0);
    should(await daemon.vault.fill('GITHUB', 'totp', NOW_MS)).equal(
      totpCode(SEED, TotpParametersSchema.parse({}), NOW_MS) as string,
    );
  });

  it('should keep every seal of an account: its password, each seeded 2FA key, and nothing else', () => {
    const accounts: AccountIndexDocument['accounts'] = {
      GITHUB: {
        key: KEY.GITHUB,
        label: 'GitHub',
        seals: { password: SEAL.githubPassword },
        factors: [
          {
            id: 'tf_000000000001',
            kind: 'totp',
            label: 'Phone',
            seal: SEAL.githubSeed,
            params: TotpParametersSchema.parse({}),
            addedAt: 'a',
            addedBy: 'owner',
          },
          {
            id: 'tf_000000000002',
            kind: 'totp',
            label: 'Backup',
            seal: `${KEY.GITHUB}_TOTP_0000000F`,
            params: TotpParametersSchema.parse({}),
            addedAt: 'a',
            addedBy: 'owner',
          },
          { id: 'tf_000000000003', kind: 'totp', label: 'Mine only', addedAt: 'a', addedBy: 'owner' },
          { id: 'tf_000000000004', kind: 'sms', label: 'Phone ••42', endsWith: '42', addedAt: 'a', addedBy: 'owner' },
        ],
        createdAt: 'a',
        updatedAt: 'a',
      },
    };
    should([...referencedSeals({ accounts })].sort()).deepEqual(
      [SEAL.githubPassword, SEAL.githubSeed, `${KEY.GITHUB}_TOTP_0000000F`].sort(),
    );
  });
});

describe('what the migration commits', () => {
  it('should write version 2 once, keep the version 1 bytes beside it, and report in counts', async () => {
    const { index, sealed } = await plant();
    const bytes = `${JSON.stringify(version1(), undefined, 2)}\n`;

    const booted = await daemonOver(index, sealed).directory.prepare();

    should(index.document?.v).equal(2);
    should(AccountIndexDocumentSchema.safeParse(index.document).success).be.true();
    should(index.version1).equal(bytes);
    should(booted.migrated).match({
      entries: 4,
      accounts: 4,
      signIns: 4,
      droppedFacts: 1,
      droppedVia: 1,
      twoFactorKeys: 1,
    });
    // secrev-1201 L5: the provider whose link was dropped is NAMED, so the owner can give it its site.
    should(booted.migrated?.providersWithoutLink).deepEqual(['GOOGLE']);
    // The migration is done: a second boot migrates nothing.
    should((await daemonOver(index, sealed).directory.prepare()).migrated).be.undefined();
  });

  it('should never overwrite a version 1 copy that is already there', async () => {
    const { index, sealed } = await plant();
    index.version1 = 'the first copy';
    await daemonOver(index, sealed).directory.prepare();
    should(index.version1).equal('the first copy');
  });

  it('should read the same accounts before and after the commit (the same pure migration, the same ids)', async () => {
    const { index, sealed } = await plant();
    const daemon = daemonOver(index, sealed);
    const before = await daemon.directory.list();
    // A read migrates in memory and writes nothing.
    should(index.document?.v).equal(1);
    should(index.version1).be.undefined();

    await daemon.directory.prepare();

    should(await daemon.directory.list()).deepEqual(before);
  });

  it('should keep the version 1 copy first when a change is the first version 2 write', async () => {
    const { index, sealed } = await plant();
    const daemon = daemonOver(index, sealed);
    await daemon.directory.putAccount('SUDO', { label: 'sudo on kirin-box' });
    should(index.document?.v).equal(2);
    should(index.version1).equal(`${JSON.stringify(version1(), undefined, 2)}\n`);
  });
});

describe('masking across the migration', () => {
  it('should mask the same values under the same names before and after', async () => {
    const { index, sealed } = await plant(undefined, undefined, { orphan: false });
    const daemon = daemonOver(index, sealed);
    const before = await daemon.vault.values();

    await daemon.directory.prepare();
    const after = await daemonOver(index, sealed).vault.values();

    should([...after.entries()].sort()).deepEqual([...before.entries()].sort());
    should(Object.fromEntries(after)).deepEqual({
      'login:GITHUB:password': GITHUB_PASSWORD,
      'login:GITHUB:totp': SEED,
      'login:GOOGLE:password': GOOGLE_PASSWORD,
      'login:SUDO:password': SUDO_PASSWORD,
    });
    const redactor = new SecretRedactor(combinedValues(daemon.vault));
    should(await redactor.redact(`${GITHUB_PASSWORD} ${SEED}`)).not.containEql(GITHUB_PASSWORD);
  });
});

describe('damaged is not empty', () => {
  it('should migrate nothing and sweep nothing when the index cannot be read', async () => {
    const sealed = new CountingSealed();
    await plant(new MemoryLoginIndex(), sealed);
    const broken = new MemoryLoginIndex(new SecretStoreError('unreadable', 'login-entries.json is not JSON'));

    const booted = await daemonOver(broken, sealed).directory.prepare();

    should(booted).deepEqual({ swept: 0, damaged: 'login-entries.json is not JSON' });
    should(sealed.writes).equal(0);
    should(Object.keys((await sealed.read())?.entries ?? {})).containEql(SEAL.orphan);
  });

  it('should migrate nothing, keep no copy and sweep nothing when a saved login names a sealed value that is gone', async () => {
    const { index, sealed } = await plant();
    const document = await sealed.read();
    const { [SEAL.githubSeed]: _lost, ...rest } = document?.entries ?? {};
    await sealed.write({ v: 1, cipher: document?.cipher ?? '', entries: rest });
    sealed.writes = 0;

    const booted = await daemonOver(index, sealed).directory.prepare();

    should(booted.damaged).containEql('1 sealed value');
    should(booted.migrated).be.undefined();
    should(index.document?.v).equal(1);
    should(index.version1).be.undefined();
    should(sealed.writes).equal(0);
    // A change refuses too: it would be the first version 2 write over a store that cannot be trusted.
    const refused = await daemonOver(index, sealed)
      .directory.putAccount('SUDO', { label: 'sudo again' })
      .catch((error: unknown) => error);
    should(refused).be.instanceOf(SecretStoreError);
    should(index.document?.v).equal(1);
  });

  it('should migrate nothing when a saved login cannot become an account', async () => {
    const { index, sealed } = await plant();
    const broken = version1();
    const { seals: _seals, ...github } = broken.entries.GITHUB as NonNullable<(typeof broken.entries)['GITHUB']>;
    // 2FA parameters with no seed: a hand-edit. Inventing a key for it would be guessing.
    index.document = { ...broken, entries: { ...broken.entries, GITHUB: { ...github, seals: {} } } };

    const booted = await daemonOver(index, sealed).directory.prepare();

    should(booted.damaged).containEql('cannot become accounts');
    should(index.document?.v).equal(1);
    should(sealed.writes).equal(0);
    should(
      await daemonOver(index, sealed)
        .directory.list()
        .catch((error: unknown) => error),
    ).be.instanceOf(SecretStoreError);
  });
});

describe('an older daemon reads version 2 as damaged', () => {
  it('should not parse a committed version 2 index as a version 1 one', async () => {
    const { index, sealed } = await plant();
    await daemonOver(index, sealed).directory.prepare();
    // The schema this daemon reads version 1 with is the one an older daemon reads the file with.
    should(LoginIndexDocumentSchema.safeParse(index.document).success).be.false();
    should(LoginIndexDocumentSchema.safeParse(JSON.parse(index.version1 as string)).success).be.true();
  });
});

describe('a store never written', () => {
  it('should do nothing at boot', async () => {
    const index = new FailingIndex();
    should(await daemonOver(index, new CountingSealed()).directory.prepare()).deepEqual({ swept: 0 });
    should(index.document).be.undefined();
  });
});
