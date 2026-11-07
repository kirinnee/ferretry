import { describe, it } from 'bun:test';
import should from 'should';
import type { AccountIndexDocument } from '../../../contract/routes/index.ts';
import { MemoryCipher, vaultSealedStore } from '../../../daemon/adapters/vault-sealed.ts';
import { AccountDirectory, AccountVault } from './lib.ts';
import { CLOCK, MemoryLoginIndex, NamedSealedDocuments } from './support.ts';
import manifest from '../../../manifest.ts';

/**
 * The account store over the Vault's sealed-document handle (`daemon/adapters/vault-sealed.ts`): the copied store
 * code runs unchanged, values reach the Vault only when a change is written, and the sweep forgets only what no
 * account points at.
 */

const PASSWORD = 'github-UNIQUE-password-1';

/** An index whose next write fails on demand: the commit point. */
class FailingIndex extends MemoryLoginIndex {
  failNext = false;
  override async write(document: AccountIndexDocument): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('disk full writing the index');
    }
    await super.write(document);
  }
}

function world() {
  const index = new FailingIndex();
  const vault = new NamedSealedDocuments();
  const { sealed, cipher } = vaultSealedStore(vault.open(undefined, undefined));
  const values = new AccountVault(index, sealed, cipher);
  const directory = new AccountDirectory(index, sealed, cipher, CLOCK, { hostName: 'kirin-box', seals: values });
  return { index, vault, values, directory };
}

const sealedNames = (index: MemoryLoginIndex): string[] =>
  Object.values(index.accounts.accounts).flatMap(account => Object.values(account.seals ?? {}) as string[]);

describe('the account store over the Vault', () => {
  it('I125 keeps password and seed values in Vault sealed handles and only their names in a private index', async () => {
    const w = world();
    await w.directory.putAccount('GITHUB', { label: 'GitHub', password: PASSWORD });
    const target = await w.directory.seedTarget('GITHUB');
    const seed = 'JBSWY3DPEHPK3PXP';
    await w.directory.addSeed(target.key, seed, { params: { algorithm: 'SHA1', digits: 6, period: 30 } });
    should([...w.vault.values.values()])
      .containEql(PASSWORD)
      .and.containEql(seed);
    const index = JSON.stringify(w.index.accounts);
    should(index).not.containEql(PASSWORD);
    should(index).not.containEql(seed);
    should(manifest.data.state.find(file => file.name === 'accounts')?.mode).equal(0o600);
    should(manifest.data.state.find(file => file.name === 'login-secrets')?.mode).equal(0o600);
  });
  it('S9 I125 S68 should keep the value in the Vault under its sealed name, and only the name in the index', async () => {
    const w = world();
    await w.directory.putAccount('GITHUB', { label: 'GitHub', password: PASSWORD });
    const [name] = sealedNames(w.index);
    should(name).match(/^L[0-9A-F]{24}_PASSWORD_[0-9A-F]{8}$/u);
    should(w.vault.values.get(name ?? '')).equal(PASSWORD);
    should(JSON.stringify(w.index.accounts)).not.containEql(PASSWORD);
  });

  it('should expose sealed values only through the redactor source', async () => {
    const w = world();
    await w.directory.putAccount('GITHUB', { label: 'GitHub', password: PASSWORD });
    should([...(await w.values.values()).values()]).containEql(PASSWORD);
    should(JSON.stringify(await w.directory.list())).not.containEql(PASSWORD);
  });

  it('I152 S73 I188 should leave a value whose commit failed as an orphan, swept by the next change, keeping the one in use', async () => {
    const w = world();
    await w.directory.putAccount('GITHUB', { label: 'GitHub', password: PASSWORD });
    const [inUse] = sealedNames(w.index);
    w.index.failNext = true;
    await w.directory.putAccount('GITHUB', { password: 'github-UNIQUE-password-2' }).catch(() => undefined);
    should(w.vault.values.size).equal(2);
    should(sealedNames(w.index)).eql([inUse]);
    await w.directory.putAccount('GITLAB', { label: 'GitLab' });
    should([...w.vault.values.keys()]).eql([inUse]);
    should(w.vault.values.get(inUse ?? '')).equal(PASSWORD);
  });

  it('S83 should move a value on merge as one step: put under the kept name, and forget the old only after', async () => {
    const w = world();
    await w.directory.putAccount('KEEP', { label: 'Keep' });
    await w.directory.putAccount('FROM', { label: 'From', password: PASSWORD });
    const [from] = sealedNames(w.index);
    w.vault.calls.length = 0;
    await w.directory.merge('KEEP', 'FROM');
    const [kept] = sealedNames(w.index);
    should(kept).not.equal(from);
    should(w.vault.values.get(kept ?? '')).equal(PASSWORD);
    should(w.vault.values.has(from ?? '')).be.false();
    const put = w.vault.calls.indexOf(`put ${kept}`);
    const forgot = w.vault.calls.indexOf(`delete ${from}`);
    should(put).be.greaterThan(-1);
    should(forgot).be.greaterThan(put);
  });

  it('S83 should forget nothing when the put of a merge fails: the old value stays where it was', async () => {
    const w = world();
    await w.directory.putAccount('KEEP', { label: 'Keep' });
    await w.directory.putAccount('FROM', { label: 'From', password: PASSWORD });
    const [from] = sealedNames(w.index);
    w.vault.failPut = true;
    w.vault.calls.length = 0;
    await w.directory.merge('KEEP', 'FROM').catch(() => undefined);
    should(w.vault.calls.some(call => call.startsWith('delete '))).be.false();
    should(w.vault.values.get(from ?? '')).equal(PASSWORD);
    should((await w.directory.list()).accounts.map(account => account.id)).eql(['FROM', 'KEEP']);
  });

  it('S70 should read an index naming a value the Vault does not hold as damaged, and sweep nothing', async () => {
    const w = world();
    await w.directory.putAccount('GITHUB', { label: 'GitHub', password: PASSWORD });
    await w.directory.putAccount('GITLAB', { label: 'GitLab', password: 'gitlab-UNIQUE-password-3' });
    const [missing] = sealedNames(w.index);
    w.vault.values.delete(missing ?? '');
    const boot = await w.directory.prepare();
    should(boot.damaged).be.a.String();
    should(w.vault.values.size).equal(1);
  });

  it('S70 should fail closed, naming no value, when the Vault cannot list the names', async () => {
    const vault = new NamedSealedDocuments();
    const handle = vault.open(undefined, undefined);
    const { sealed, cipher } = vaultSealedStore({
      ...handle,
      names: async () => {
        throw new Error(`EIO reading ${PASSWORD}`);
      },
    });
    const directory = new AccountDirectory(new MemoryLoginIndex(), sealed, cipher, CLOCK, { hostName: 'kirin-box' });
    const refused = await directory.list().catch((error: unknown) => error as { failure?: string; message: string });
    should(refused).match({ failure: 'unreadable' });
    should(String((refused as { message: string }).message)).not.containEql(PASSWORD);
  });
});

describe('a value sealed in memory only', () => {
  it('S89 should open only under the name it was sealed for, and never in another process', async () => {
    const memory = new MemoryCipher();
    const sealed = await memory.seal('stage:st_x:seed', 'JBSWY3DPEHPK3PXP');
    should(sealed.ciphertext).not.containEql('JBSWY3DPEHPK3PXP');
    should((await memory.openAll({ 'stage:st_x:seed': sealed })).get('stage:st_x:seed')).equal('JBSWY3DPEHPK3PXP');
    should(() => memory.open('stage:st_y:seed', sealed)).throw();
    should(() => new MemoryCipher().open('stage:st_x:seed', sealed)).throw();
  });
});
