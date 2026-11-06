import { describe, it } from 'bun:test';
import { type AccountIndexDocument, MAX_ACCOUNTS } from '@ferretry/protocol';
import should from 'should';
import {
  combinedValues,
  LoginDirectory,
  LoginEntryError,
  type LoginIndexStore,
  LoginVault,
  SecretRedactor,
  SecretStoreError,
  SecretVault,
  totpCode,
} from '../../../src/lib/secrets/index.ts';
import { FakeSecretCipher, MemoryLoginIndex, MemorySecretDocuments, plantSeed } from '../runtime/mounts/support.ts';
import { putSavedLogin } from './saved-login-fixture.ts';

const CLOCK = { now: () => '2026-10-31T09:00:00.000Z' };
const PASSWORD = 'hunter2-UNIQUE-pw';
const SEED = 'JBSWY3DPEHPK3PXP';

function world(index = new MemoryLoginIndex(), sealed = new MemorySecretDocuments()) {
  const cipher = new FakeSecretCipher();
  let key = 0;
  const newKey = () => `L${(key++).toString(16).toUpperCase().padStart(24, '0')}`;
  return {
    index,
    sealed,
    directory: new LoginDirectory(index, sealed, cipher, CLOCK, { newKey }),
    vault: new LoginVault(index, sealed, cipher),
  };
}

describe('the account store as the input bridge holds it', () => {
  it('should list nothing for a store that was never written', async () => {
    should(await world().directory.accounts.list()).deepEqual({ accounts: [], signIns: [] });
  });

  it('should create an account with a label, a plain username and a sealed password', async () => {
    const w = world();
    const summary = await w.directory.accounts.putAccount('GITHUB_KIRINNEE', {
      label: 'GitHub (kirinnee)',
      username: 'kirinnee',
      password: PASSWORD,
    });

    should(summary).containDeep({
      id: 'GITHUB_KIRINNEE',
      label: 'GitHub (kirinnee)',
      username: 'kirinnee',
      fields: { password: true, totp: false },
      createdAt: CLOCK.now(),
      updatedAt: CLOCK.now(),
    });
    should(JSON.stringify(w.index.document)).not.containEql(PASSWORD);
    should(JSON.stringify(await w.sealed.read())).not.containEql(PASSWORD);
  });

  it('should refuse a new account with no label', async () => {
    const error = await world()
      .directory.accounts.putAccount('X_Y', { password: PASSWORD })
      .catch((caught: unknown) => caught);
    should(error).be.instanceOf(LoginEntryError);
    should((error as LoginEntryError).refusal).equal('label_required');
  });

  it('should keep the parts not named and remove the ones set to null', async () => {
    const w = world();
    await w.directory.accounts.putAccount('SUDO_BOX', { label: 'sudo on box', username: 'kirin', password: PASSWORD });
    const relabelled = await w.directory.accounts.putAccount('SUDO_BOX', { label: 'sudo (box)' });
    should(relabelled.username).equal('kirin');
    should(relabelled.fields.password).be.true();
    const cleared = await w.directory.accounts.putAccount('SUDO_BOX', { username: null, password: null });
    should(cleared.username).be.undefined();
    should(cleared.fields.password).be.false();
    should(Object.keys((await w.sealed.read())?.entries ?? {})).deepEqual([]);
  });

  it('should add and remove a 2FA seed with its parameters, never listing the seed', async () => {
    const w = world();
    await w.directory.accounts.putAccount('GITHUB', { label: 'GitHub' });
    await plantSeed(w.directory.accounts, 'GITHUB', SEED, undefined, { digits: 8 });
    const added = (await w.directory.accounts.list()).accounts.find(entry => entry.id === 'GITHUB');
    should(added?.fields.totp).be.true();
    should(added?.totp).deepEqual({ algorithm: 'SHA1', digits: 8, period: 30 });
    should(JSON.stringify(await w.directory.accounts.list())).not.containEql(SEED);
    const factor = added?.factors.find(each => each.kind === 'totp');
    should(await w.directory.accounts.removeFactor('GITHUB', factor?.id as never)).be.true();
    const removed = (await w.directory.accounts.list()).accounts.find(entry => entry.id === 'GITHUB');
    should(removed?.fields.totp).be.false();
    should(removed?.totp).be.undefined();
  });

  it('should rename an account without touching what is sealed, and refuse a name in use', async () => {
    const w = world();
    await putSavedLogin(w.directory, 'SUDO_LAPTOP', { label: 'sudo', password: PASSWORD });
    await putSavedLogin(w.directory, 'OTHER', { label: 'other' });
    const sealedBefore = JSON.stringify(await w.sealed.read());
    const renamed = await w.directory.accounts.renameAccount('SUDO_LAPTOP', 'SUDO_KIRIN_BOX');

    should(renamed.id).equal('SUDO_KIRIN_BOX');
    should(JSON.stringify(await w.sealed.read())).equal(sealedBefore);
    should(await w.vault.fill('SUDO_KIRIN_BOX', 'password', 0)).equal(PASSWORD);
    const taken = await w.directory.accounts.renameAccount('OTHER', 'SUDO_KIRIN_BOX').catch((error: unknown) => error);
    should((taken as LoginEntryError).refusal).equal('login_exists');
    const missing = await w.directory.accounts.renameAccount('NOPE', 'NEW').catch((error: unknown) => error);
    should((missing as LoginEntryError).refusal).equal('unknown_login');
    should((await w.directory.accounts.renameAccount('OTHER', 'OTHER')).id).equal('OTHER');
  });

  it('should remove an account and its sealed values, and say whether there was one', async () => {
    const w = world();
    await putSavedLogin(w.directory, 'SUDO', { label: 'sudo', password: PASSWORD });
    should(await w.directory.accounts.removeAccount('SUDO')).be.true();
    should(await w.directory.accounts.removeAccount('SUDO')).be.false();
    should((await w.directory.accounts.list()).accounts).deepEqual([]);
    should(Object.keys((await w.sealed.read())?.entries ?? {})).deepEqual([]);
  });

  it('should refuse a new account past the cap, and still change an existing one', async () => {
    const w = world();
    const accounts: AccountIndexDocument['accounts'] = {};
    for (let index = 0; index < MAX_ACCOUNTS; index += 1)
      accounts[`E${String(index)}`] = {
        key: `L${index.toString(16).toUpperCase().padStart(24, '0')}`,
        label: `e${String(index)}`,
        seals: {},
        createdAt: CLOCK.now(),
        updatedAt: CLOCK.now(),
      };
    w.index.document = { v: 2, accounts, signIns: {} };
    const refused = await w.directory.accounts.putAccount('ONE_MORE', { label: 'x' }).catch((error: unknown) => error);
    should((refused as SecretStoreError).failure).equal('full');
    should((await w.directory.accounts.putAccount('E0', { label: 'renamed' })).label).equal('renamed');
  });

  it('should raise for a damaged index or a foreign cipher, never answer empty', async () => {
    const damaged = world(new MemoryLoginIndex(new SecretStoreError('unreadable', 'bad')));
    should(await damaged.directory.accounts.list().catch((error: unknown) => error)).be.instanceOf(SecretStoreError);
    const foreign = new MemorySecretDocuments();
    await foreign.write({ v: 1, cipher: 'OTHER', entries: {} });
    should(
      await world(new MemoryLoginIndex(), foreign)
        .directory.accounts.list()
        .catch((error: unknown) => error),
    ).be.instanceOf(SecretStoreError);
  });
});

describe('the saved-login vault', () => {
  it('should fill the username, the password and the current 2FA code, and refuse a field that is not there', async () => {
    const w = world();
    await putSavedLogin(w.directory, 'GITHUB', { label: 'GitHub', username: 'kirinnee', password: PASSWORD });
    await plantSeed(w.directory.accounts, 'GITHUB', SEED);
    await putSavedLogin(w.directory, 'BARE', { label: 'bare' });
    const at = 1_761_900_000_000;

    should(await w.vault.fill('GITHUB', 'username', at)).equal('kirinnee');
    should(await w.vault.fill('GITHUB', 'password', at)).equal(PASSWORD);
    should(await w.vault.fill('GITHUB', 'totp', at)).equal(
      totpCode(SEED, { algorithm: 'SHA1', digits: 6, period: 30 }, at) as string,
    );
    for (const role of ['username', 'password', 'totp'] as const)
      should((await w.vault.fill('BARE', role, at).catch(error => error)).refusal).equal('no_such_field');
    should((await w.vault.fill('MISSING', 'password', at).catch(error => error)).refusal).equal('unknown_login');
  });

  it('should offer every secret field for masking under a name no vault secret can take, the username never', async () => {
    const w = world();
    await putSavedLogin(w.directory, 'GITHUB', { label: 'GitHub', username: 'kirinnee', password: PASSWORD });
    await plantSeed(w.directory.accounts, 'GITHUB', SEED);
    const values = await w.vault.values();
    should([...values.keys()].sort()).deepEqual(['login:GITHUB:password', 'login:GITHUB:totp']);
    should([...values.values()]).not.containEql('kirinnee');
  });

  it('should still mask a sealed value no entry names any more', async () => {
    const w = world();
    await putSavedLogin(w.directory, 'SUDO', { label: 'sudo', password: PASSWORD });
    w.index.document = { v: 1, entries: {} };
    should([...(await w.vault.values()).values()]).deepEqual([PASSWORD]);
  });

  it('should mask saved values together with vault secrets through one redactor', async () => {
    const w = world();
    await putSavedLogin(w.directory, 'SUDO', { label: 'sudo', password: PASSWORD });
    const vaultDocuments = new MemorySecretDocuments();
    const cipher = new FakeSecretCipher();
    await vaultDocuments.write({
      v: 1,
      cipher: cipher.algorithm,
      entries: { API_KEY: { ...(await cipher.seal('API_KEY', 'sk-live-0123456789')), createdAt: 'a', updatedAt: 'a' } },
    });
    const redactor = new SecretRedactor(combinedValues(new SecretVault(vaultDocuments, cipher), w.vault));
    const masked = await redactor.redact(`typed ${PASSWORD} and sk-live-0123456789`);
    should(masked).equal('typed [redacted:login:SUDO:password] and [redacted:API_KEY]');
  });

  it('should still mask every sealed value when the index is damaged, by its sealed name', async () => {
    const sealed = new MemorySecretDocuments();
    await putSavedLogin(world(new MemoryLoginIndex(), sealed).directory, 'SUDO', { label: 'sudo', password: PASSWORD });
    const damaged = world(new MemoryLoginIndex(new SecretStoreError('unreadable', 'bad')), sealed);
    const masked = await new SecretRedactor(combinedValues(damaged.vault)).redact(`typed ${PASSWORD}`);
    should(masked).not.containEql(PASSWORD);
    should(masked).containEql('[redacted:login:unnamed:');
  });

  it('should fail the redactor closed when the sealed logins cannot be opened', async () => {
    const foreign = new MemorySecretDocuments(new SecretStoreError('key_missing', 'gone'));
    const redactor = new SecretRedactor(combinedValues(world(new MemoryLoginIndex(), foreign).vault));
    should(await redactor.redact('anything').catch(error => error)).be.instanceOf(SecretStoreError);
  });
});

describe('the saved-login vault when what it reads is wrong', () => {
  it('should reject masking when reading the index fails for a reason that is not a damaged store', async () => {
    const broken: LoginIndexStore = {
      read: async () => {
        throw new Error('the disk went away');
      },
      write: async () => undefined,
      keepVersion1: async () => undefined,
    };
    const vault = new LoginVault(broken, new MemorySecretDocuments(), new FakeSecretCipher());
    should(await vault.values().catch(error => error)).be.instanceOf(Error);
  });

  it('should refuse to make a code from a sealed seed that is not base32', async () => {
    const w = world();
    await putSavedLogin(w.directory, 'BAD', { label: 'bad' });
    await plantSeed(w.directory.accounts, 'BAD', '0189-not-base32');
    should((await w.vault.fill('BAD', 'totp', 0).catch(error => error)).refusal).equal('no_such_field');
  });
});

describe('how an account signs in, at rest', () => {
  it('should keep a method, its provider and the login domains, and change only what is named', async () => {
    const w = world();
    await putSavedLogin(w.directory, 'GOOGLE', { label: 'Google', match: ['accounts.google.com'], password: PASSWORD });
    await putSavedLogin(w.directory, 'VERCEL', {
      label: 'Vercel',
      match: ['vercel.com'],
      method: { kind: 'google', via: 'GOOGLE' },
      domains: ['vercel.com'],
    });
    await w.directory.accounts.putAccount('VERCEL', { label: 'Vercel (team)' });
    const vercel = async () => (await w.directory.accounts.list()).signIns.find(signIn => signIn.account === 'VERCEL');
    should((await vercel())?.method).deepEqual({ kind: 'google', via: 'GOOGLE' });
    should((await vercel())?.place).containDeep({ kind: 'site', domains: ['vercel.com'] });
    const back = await w.directory.accounts.putSignIn((await vercel())?.id as never, { method: { kind: 'password' } });
    should(back.method).deepEqual({ kind: 'password' });
    should(JSON.stringify(w.index.document)).not.containEql(PASSWORD);
  });

  it('should add the page a card saved from to the login domains an account keeps', async () => {
    const w = world();
    await putSavedLogin(w.directory, 'GOOGLE', { label: 'Google', domains: ['accounts.google.com'], match: [] });
    await w.directory.saveFields('GOOGLE', 'Google', 'myaccount.google.com', { password: PASSWORD });
    const domains = async () => {
      const place = (await w.directory.accounts.list()).signIns.find(signIn => signIn.account === 'GOOGLE')?.place;
      return place?.kind === 'site' ? place.domains : undefined;
    };
    should(await domains()).deepEqual(['accounts.google.com', 'myaccount.google.com']);
    await w.directory.saveFields('GOOGLE', 'Google', 'sudo@box', { password: `${PASSWORD}2` });
    should(await domains()).deepEqual(['accounts.google.com', 'myaccount.google.com']);
  });
});
