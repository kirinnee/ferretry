import { describe, it } from 'bun:test';
import { type AccountIndexDocument, sealedNamesOf, TotpParametersSchema } from '@ferretry/protocol';
import should from 'should';
import {
  combinedValues,
  referencedSeals,
  SecretRedactor,
  SecretStoreError,
  totpCode,
} from '../../../src/lib/secrets/index.ts';
import { MemoryLoginIndex } from '../runtime/mounts/support.ts';
import {
  CountingSealed,
  daemonOver,
  GITHUB_PASSWORD,
  GOOGLE_PASSWORD,
  KEY,
  plant,
  SEAL,
  SEED,
  SUDO_PASSWORD,
} from './accounts-fixtures.ts';

/**
 * THE BOOT SWEEP (docs/secrets.md, "Accounts and sign-ins"): a sweep keeps every seal an account points at — the
 * password AND every 2FA seed (the single most dangerous line) — and removes only what nothing points at; damaged is
 * not empty; masking covers every sealed value.
 */

const NOW_MS = Date.parse('2026-10-31T09:00:00.000Z');

describe('a boot over a store with nothing to sweep', () => {
  it('should not write the sealed document at all, and keep every sealed name the index points at', async () => {
    const { index, sealed } = await plant(undefined, undefined, { orphan: false });
    const before = JSON.stringify(await sealed.read());

    const booted = await daemonOver(index, sealed).directory.prepare();

    should(booted).deepEqual({ swept: 0 });
    should(sealed.writes).equal(0);
    should(JSON.stringify(await sealed.read())).equal(before);
    const names = Object.values(index.accounts.accounts).flatMap(account => sealedNamesOf(account));
    for (const name of [SEAL.githubPassword, SEAL.githubSeed, SEAL.googlePassword, SEAL.sudoPassword])
      should(names).containEql(name);
  });
});

describe('the sweep (the most dangerous line)', () => {
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
    // And again at the next boot: nothing left to sweep.
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

  it('should keep the index as it was when the sweep after it fails, the orphan still masked until the next boot', async () => {
    const { index, sealed } = await plant();
    const written = index.document;
    sealed.failing = true;

    const booted = await daemonOver(index, sealed).directory.prepare();

    should(booted.swept).equal(0);
    should(index.document).equal(written);
    const masked = [...(await daemonOver(index, sealed).vault.values()).keys()];
    should(masked).containEql(`login:unnamed:${SEAL.orphan}`);
    sealed.failing = false;
    should((await daemonOver(index, sealed).directory.prepare()).swept).equal(1);
    const daemon = daemonOver(index, sealed);
    should(await daemon.vault.fill('GITHUB', 'password', 0)).equal(GITHUB_PASSWORD);
    should((await daemon.vault.values()).get('login:GITHUB:totp')).equal(SEED);
  });
});

describe('masking', () => {
  it('should mask every sealed value under the name of the account that holds it', async () => {
    const { index, sealed } = await plant(undefined, undefined, { orphan: false });
    const daemon = daemonOver(index, sealed);

    const values = await daemon.vault.values();

    should(Object.fromEntries(values)).deepEqual({
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
  it('should sweep nothing when the index cannot be read', async () => {
    const sealed = new CountingSealed();
    await plant(new MemoryLoginIndex(), sealed);
    const broken = new MemoryLoginIndex(new SecretStoreError('unreadable', 'login-entries.json is not JSON'));

    const booted = await daemonOver(broken, sealed).directory.prepare();

    should(booted).deepEqual({ swept: 0, damaged: 'login-entries.json is not JSON' });
    should(sealed.writes).equal(0);
    should(Object.keys((await sealed.read())?.entries ?? {})).containEql(SEAL.orphan);
  });

  it('should sweep nothing, and report the loss, when an account names a sealed value that is gone', async () => {
    const { index, sealed } = await plant();
    const document = await sealed.read();
    const { [SEAL.githubSeed]: _lost, ...rest } = document?.entries ?? {};
    await sealed.write({ v: 1, cipher: document?.cipher ?? '', entries: rest });
    sealed.writes = 0;

    const booted = await daemonOver(index, sealed).directory.prepare();

    should(booted.damaged).containEql('1 sealed value');
    should(sealed.writes).equal(0);
    should(Object.keys((await sealed.read())?.entries ?? {})).containEql(SEAL.orphan);
  });
});

describe('a store never written', () => {
  it('should do nothing at boot', async () => {
    const index = new MemoryLoginIndex();
    should(await daemonOver(index, new CountingSealed()).directory.prepare()).deepEqual({ swept: 0 });
    should(index.document).be.undefined();
  });
});
