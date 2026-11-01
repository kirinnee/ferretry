import { describe, it } from 'bun:test';
import { MAX_LOGIN_ENTRIES, type PutLoginEntry, PutLoginEntryRequestSchema } from '@ferretry/protocol';
import should from 'should';
import {
  combinedValues,
  LoginDirectory,
  LoginEntryError,
  type LoginIndexDocument,
  type LoginIndexStore,
  LoginVault,
  SecretRedactor,
  SecretStoreError,
  SecretVault,
  totpCode,
} from '../../../src/lib/secrets/index.ts';
import { FakeSecretCipher, MemoryLoginIndex, MemorySecretDocuments } from '../runtime/mounts/support.ts';

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

const change = (input: unknown): PutLoginEntry => PutLoginEntryRequestSchema.parse(input);

describe('the saved-login directory', () => {
  it('should list nothing for a store that was never written', async () => {
    should(await world().directory.list()).deepEqual([]);
  });

  it('should create an entry with a label, a match, a plain username and a sealed password', async () => {
    const w = world();
    const summary = await w.directory.put(
      'GITHUB_KIRINNEE',
      change({ label: 'GitHub (kirinnee)', match: ['github.com'], username: 'kirinnee', password: PASSWORD }),
    );

    should(summary).deepEqual({
      id: 'GITHUB_KIRINNEE',
      label: 'GitHub (kirinnee)',
      match: ['github.com'],
      method: { kind: 'password' },
      domains: ['github.com'],
      username: 'kirinnee',
      fields: { password: true, totp: false },
      createdAt: CLOCK.now(),
      updatedAt: CLOCK.now(),
    });
    should(JSON.stringify(w.index.document)).not.containEql(PASSWORD);
    should(JSON.stringify(await w.sealed.read())).not.containEql(PASSWORD);
  });

  it('should refuse a new entry with no label', async () => {
    const error = await world()
      .directory.put('X_Y', change({ password: PASSWORD }))
      .catch(caught => caught);
    should(error).be.instanceOf(LoginEntryError);
    should(error.refusal).equal('label_required');
  });

  it('should keep the parts not named and remove the ones set to null', async () => {
    const w = world();
    await w.directory.put('SUDO_BOX', change({ label: 'sudo on box', username: 'kirin', password: PASSWORD }));
    const relabelled = await w.directory.put('SUDO_BOX', change({ label: 'sudo (box)' }));
    should(relabelled.username).equal('kirin');
    should(relabelled.fields.password).be.true();
    const cleared = await w.directory.put('SUDO_BOX', change({ username: null, password: null }));
    should(cleared.username).be.undefined();
    should(cleared.fields.password).be.false();
    should(Object.keys((await w.sealed.read())?.entries ?? {})).deepEqual([]);
  });

  it('should add and remove a 2FA seed with its parameters, never listing the seed', async () => {
    const w = world();
    const added = await w.directory.put(
      'GITHUB',
      change({ label: 'GitHub', totp: { seed: SEED, parameters: { digits: 8 } }, totpAcknowledged: true }),
    );
    should(added.fields.totp).be.true();
    should(added.totp).deepEqual({ algorithm: 'SHA1', digits: 8, period: 30 });
    should(JSON.stringify(await w.directory.list())).not.containEql(SEED);
    const removed = await w.directory.put('GITHUB', change({ totp: null }));
    should(removed.fields.totp).be.false();
    should(removed.totp).be.undefined();
  });

  it('should rename an entry without touching what is sealed, and refuse a name in use', async () => {
    const w = world();
    await w.directory.put('SUDO_LAPTOP', change({ label: 'sudo', password: PASSWORD }));
    await w.directory.put('OTHER', change({ label: 'other' }));
    const sealedBefore = JSON.stringify(await w.sealed.read());
    const renamed = await w.directory.rename('SUDO_LAPTOP', 'SUDO_KIRIN_BOX');

    should(renamed.id).equal('SUDO_KIRIN_BOX');
    should(JSON.stringify(await w.sealed.read())).equal(sealedBefore);
    should(await w.vault.fill('SUDO_KIRIN_BOX', 'password', 0)).equal(PASSWORD);
    should((await w.directory.rename('OTHER', 'SUDO_KIRIN_BOX').catch(error => error)).refusal).equal('login_exists');
    should((await w.directory.rename('NOPE', 'NEW').catch(error => error)).refusal).equal('unknown_login');
    should((await w.directory.rename('OTHER', 'OTHER')).id).equal('OTHER');
  });

  it('should remove an entry and its sealed values, and say whether there was one', async () => {
    const w = world();
    await w.directory.put('SUDO', change({ label: 'sudo', password: PASSWORD }));
    should(await w.directory.remove('SUDO')).be.true();
    should(await w.directory.remove('SUDO')).be.false();
    should(await w.directory.list()).deepEqual([]);
    should(Object.keys((await w.sealed.read())?.entries ?? {})).deepEqual([]);
  });

  it('should refuse a new entry past the cap, and still change an existing one', async () => {
    const w = world();
    const entries: LoginIndexDocument['entries'] = {};
    for (let index = 0; index < MAX_LOGIN_ENTRIES; index += 1)
      entries[`E${index}`] = {
        key: `L${index.toString(16).toUpperCase().padStart(24, '0')}`,
        label: `e${index}`,
        match: [],
        seals: {},
        createdAt: CLOCK.now(),
        updatedAt: CLOCK.now(),
      };
    w.index.document = { v: 1, entries };
    should((await w.directory.put('ONE_MORE', change({ label: 'x' })).catch(error => error)).failure).equal('full');
    should((await w.directory.put('E0', change({ label: 'renamed' }))).label).equal('renamed');
  });

  it('should raise for a damaged index or a foreign cipher, never answer empty', async () => {
    const damaged = world(new MemoryLoginIndex(new SecretStoreError('unreadable', 'bad')));
    should(await damaged.directory.list().catch(error => error)).be.instanceOf(SecretStoreError);
    const foreign = new MemorySecretDocuments();
    await foreign.write({ v: 1, cipher: 'OTHER', entries: {} });
    should(
      await world(new MemoryLoginIndex(), foreign)
        .directory.list()
        .catch(error => error),
    ).be.instanceOf(SecretStoreError);
  });
});

describe('the saved-login vault', () => {
  it('should fill the username, the password and the current 2FA code, and refuse a field that is not there', async () => {
    const w = world();
    await w.directory.put(
      'GITHUB',
      change({
        label: 'GitHub',
        username: 'kirinnee',
        password: PASSWORD,
        totp: { seed: SEED },
        totpAcknowledged: true,
      }),
    );
    await w.directory.put('BARE', change({ label: 'bare' }));
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
    await w.directory.put(
      'GITHUB',
      change({
        label: 'GitHub',
        username: 'kirinnee',
        password: PASSWORD,
        totp: { seed: SEED },
        totpAcknowledged: true,
      }),
    );
    const values = await w.vault.values();
    should([...values.keys()].sort()).deepEqual(['login:GITHUB:password', 'login:GITHUB:totp']);
    should([...values.values()]).not.containEql('kirinnee');
  });

  it('should still mask a sealed value no entry names any more', async () => {
    const w = world();
    await w.directory.put('SUDO', change({ label: 'sudo', password: PASSWORD }));
    w.index.document = { v: 1, entries: {} };
    should([...(await w.vault.values()).values()]).deepEqual([PASSWORD]);
  });

  it('should mask saved values together with vault secrets through one redactor', async () => {
    const w = world();
    await w.directory.put('SUDO', change({ label: 'sudo', password: PASSWORD }));
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
    await world(new MemoryLoginIndex(), sealed).directory.put('SUDO', change({ label: 'sudo', password: PASSWORD }));
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
    await w.directory.put('BAD', { label: 'bad', totp: { seed: '0189-not-base32' } } as PutLoginEntry);
    should((await w.vault.fill('BAD', 'totp', 0).catch(error => error)).refusal).equal('no_such_field');
  });
});

describe('how a saved login signs in, at rest', () => {
  it('should read an entry saved before methods as a password one on its web hosts, without rewriting it', async () => {
    const index = new MemoryLoginIndex();
    const old: LoginIndexDocument = {
      v: 1,
      entries: {
        GITHUB: {
          key: 'L000000000000000000000000',
          label: 'GitHub',
          match: ['github.com', 'git@github.com'],
          seals: {},
          createdAt: CLOCK.now(),
          updatedAt: CLOCK.now(),
        },
      },
    };
    index.document = old;
    const [summary] = await world(index).directory.list();
    should(summary?.method).deepEqual({ kind: 'password' });
    should(summary?.domains).deepEqual(['github.com']);
    should(index.document).deepEqual(old);
  });

  it('should keep a method, its provider and the login domains, and change only what is named', async () => {
    const w = world();
    await w.directory.put('GOOGLE', change({ label: 'Google', match: ['accounts.google.com'], password: PASSWORD }));
    await w.directory.put(
      'VERCEL',
      change({
        label: 'Vercel',
        match: ['vercel.com'],
        method: { kind: 'google', via: 'GOOGLE' },
        domains: ['vercel.com'],
      }),
    );
    const relabelled = await w.directory.put('VERCEL', change({ label: 'Vercel (team)' }));
    should(relabelled.method).deepEqual({ kind: 'google', via: 'GOOGLE' });
    should(relabelled.domains).deepEqual(['vercel.com']);
    const back = await w.directory.put('VERCEL', change({ method: { kind: 'password' }, domains: [] }));
    should(back.method).deepEqual({ kind: 'password' });
    should(back.domains).deepEqual([]);
    should(JSON.stringify(w.index.document)).not.containEql(PASSWORD);
  });

  it('should add the page a card saved from to the login domains an entry keeps', async () => {
    const w = world();
    await w.directory.put('GOOGLE', change({ label: 'Google', domains: ['accounts.google.com'] }));
    const saved = await w.directory.saveFields('GOOGLE', 'Google', 'myaccount.google.com', { password: PASSWORD });
    should(saved.domains).deepEqual(['accounts.google.com', 'myaccount.google.com']);
    const terminal = await w.directory.saveFields('GOOGLE', 'Google', 'sudo@box', { password: `${PASSWORD}2` });
    should(terminal.domains).deepEqual(['accounts.google.com', 'myaccount.google.com']);
  });

  it('should refuse a circle of provider links', async () => {
    const w = world();
    await w.directory.put('GOOGLE', change({ label: 'Google', match: ['google.com'] }));
    await w.directory.put(
      'SITE',
      change({ label: 'Site', match: ['site.example'], method: { kind: 'google', via: 'GOOGLE' } }),
    );
    const error = await w.directory
      .put('GOOGLE', change({ method: { kind: 'sso', name: 'Site SSO', via: 'SITE' } }))
      .catch(caught => caught);
    should(error).be.instanceOf(LoginEntryError);
    should(error.refusal).equal('bad_via');
    should(error.message).containEql('circle');
  });

  it('should refuse a provider that is not saved, or the entry itself', async () => {
    const w = world();
    for (const [id, via] of [
      ['SITE', 'NOPE'],
      ['SITE', 'SITE'],
    ] as const) {
      const error = await w.directory
        .put(id, change({ label: 'Site', match: ['site.example'], method: { kind: 'github', via } }))
        .catch(caught => caught);
      should(error).be.instanceOf(LoginEntryError);
      should(error.refusal).equal('bad_via');
    }
  });
});
