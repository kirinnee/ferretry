import { describe, it } from 'bun:test';
import { type AccountIndexDocument, PutLoginEntryRequestSchema, type SecretName } from '@ferretry/protocol';
import should from 'should';
import {
  combinedValues,
  LoginDirectory,
  LoginVault,
  SecretRedactor,
  type SecretVaultDocument,
} from '../../../src/lib/secrets/index.ts';
import { FakeSecretCipher, MemoryLoginIndex, MemorySecretDocuments } from '../runtime/mounts/support.ts';

/**
 * F4 of the #1094 review: a change to a saved login is ALL OR NOTHING. New ciphertext is staged under fresh
 * names, the index (written atomically by its store) is the one commit point, and unreferenced ciphertext is
 * swept after the commit or at boot. A failure injected at each write, and a daemon that "stops" there and
 * boots again over the same files, must show the username/password pair entirely old or entirely new — never
 * mixed — and keep the old password masked until the new one has committed.
 */

const CLOCK = { now: () => '2026-10-31T09:00:00.000Z' };
const OLD_USER = 'kirin-old';
const NEW_USER = 'kirin-new';
const OLD_PASSWORD = 'OLD-UNIQUE-password-1';
const NEW_PASSWORD = 'NEW-UNIQUE-password-2';

/** An index whose writes fail while `failing` is set: the commit itself is refused. */
class FailingIndex extends MemoryLoginIndex {
  failing = false;
  override async write(document: AccountIndexDocument): Promise<void> {
    if (this.failing) throw new Error('disk full writing the index');
    await super.write(document);
  }
}

/** A sealed document whose `nth` write from now fails (1 = the next one). */
class FailingSealed extends MemorySecretDocuments {
  private countdown = 0;
  failOn(nth: number): void {
    this.countdown = nth;
  }
  override async write(document: SecretVaultDocument): Promise<void> {
    if (this.countdown > 0) {
      this.countdown -= 1;
      if (this.countdown === 0) throw new Error('disk full writing the sealed logins');
    }
    await super.write(document);
  }
}

/** One daemon's view over the files: building another over the same stores is a restart. */
function boot(index: FailingIndex, sealed: FailingSealed) {
  const cipher = new FakeSecretCipher();
  let key = 0;
  const directory = new LoginDirectory(index, sealed, cipher, CLOCK, {
    newKey: () => `L${(key++).toString(16).toUpperCase().padStart(24, '0')}`,
  });
  const vault = new LoginVault(index, sealed, cipher);
  const masked = async (value: string): Promise<boolean> =>
    !(await new SecretRedactor(combinedValues(vault)).redact(`echo ${value}`)).includes(value);
  /** What the owner and a card see for the entry: the pair, never mixed. */
  const pair = async (): Promise<readonly [string, string]> => [
    await vault.fill('GITHUB', 'username', 0),
    await vault.fill('GITHUB', 'password', 0),
  ];
  return { directory, vault, masked, pair };
}

async function withOldPair() {
  const index = new FailingIndex();
  const sealed = new FailingSealed();
  const daemon = boot(index, sealed);
  await daemon.directory.put(
    'GITHUB',
    PutLoginEntryRequestSchema.parse({ label: 'GitHub', username: OLD_USER, password: OLD_PASSWORD }),
  );
  return { index, sealed, daemon };
}

const sealedCount = async (sealed: FailingSealed): Promise<number> =>
  Object.keys((await sealed.read())?.entries ?? {}).length;

describe('a saved login changed all or nothing', () => {
  it('should keep the OLD pair, masked, when staging the new ciphertext fails', async () => {
    const { sealed, daemon } = await withOldPair();
    sealed.failOn(1);
    const failed = await daemon.directory
      .saveFields('GITHUB', 'GitHub', 'github.com', { username: NEW_USER, password: NEW_PASSWORD })
      .catch(error => error);

    should(failed).be.an.Error();
    should(await daemon.pair()).deepEqual([OLD_USER, OLD_PASSWORD]);
    should(await daemon.masked(OLD_PASSWORD)).be.true();
    should(await sealedCount(sealed)).equal(1);
  });

  it('should keep the OLD pair, masked, when the index commit fails — and sweep the staged one at boot', async () => {
    const { index, sealed, daemon } = await withOldPair();
    index.failing = true;
    const failed = await daemon.directory
      .saveFields('GITHUB', 'GitHub', 'github.com', { username: NEW_USER, password: NEW_PASSWORD })
      .catch(error => error);
    index.failing = false;

    should(failed).be.an.Error();
    should(await daemon.pair()).deepEqual([OLD_USER, OLD_PASSWORD]);
    should(await daemon.masked(OLD_PASSWORD)).be.true();
    // The staged value was typed into the target before the save was tried: it stays masked until swept.
    should(await daemon.masked(NEW_PASSWORD)).be.true();
    should(await sealedCount(sealed)).equal(2);

    const restarted = boot(index, sealed);
    should((await restarted.directory.sweepUnreferenced()).swept).equal(1);
    should(await restarted.pair()).deepEqual([OLD_USER, OLD_PASSWORD]);
    should(await restarted.masked(OLD_PASSWORD)).be.true();
    should(await sealedCount(sealed)).equal(1);
  });

  it('should show the NEW pair once committed even if the sweep fails, the old value masked until a later sweep', async () => {
    const { index, sealed, daemon } = await withOldPair();
    sealed.failOn(2);
    await daemon.directory.saveFields('GITHUB', 'GitHub', 'github.com', { username: NEW_USER, password: NEW_PASSWORD });

    should(await daemon.pair()).deepEqual([NEW_USER, NEW_PASSWORD]);
    should(await daemon.masked(NEW_PASSWORD)).be.true();
    should(await daemon.masked(OLD_PASSWORD)).be.true();

    const restarted = boot(index, sealed);
    should((await restarted.directory.sweepUnreferenced()).swept).equal(1);
    should(await restarted.pair()).deepEqual([NEW_USER, NEW_PASSWORD]);
    should(await restarted.masked(NEW_PASSWORD)).be.true();
  });

  it('should show the OLD pair after a daemon that stopped between staging and commit boots again', async () => {
    const { index, sealed, daemon } = await withOldPair();
    // The "crash": the stage lands and the process dies before the index is written.
    index.failing = true;
    await daemon.directory
      .saveFields('GITHUB', 'GitHub', 'github.com', { username: NEW_USER, password: NEW_PASSWORD })
      .catch(() => undefined);
    index.failing = false;

    const restarted = boot(index, sealed);
    should(await restarted.pair()).deepEqual([OLD_USER, OLD_PASSWORD]);
    should(await restarted.masked(OLD_PASSWORD)).be.true();
    should(await restarted.masked(NEW_PASSWORD)).be.true();
    await restarted.directory.sweepUnreferenced();
    should(await restarted.pair()).deepEqual([OLD_USER, OLD_PASSWORD]);
  });

  it('should commit a clean change in three writes and leave exactly the new ciphertext', async () => {
    const { sealed, daemon } = await withOldPair();
    await daemon.directory.saveFields('GITHUB', 'GitHub', 'github.com', { username: NEW_USER, password: NEW_PASSWORD });

    should(await daemon.pair()).deepEqual([NEW_USER, NEW_PASSWORD]);
    should(await sealedCount(sealed)).equal(1);
    should(await daemon.masked(OLD_PASSWORD)).be.false();
  });

  it('should never write the new value under the name the index points at', async () => {
    const { index, sealed, daemon } = await withOldPair();
    const before = index.accounts.accounts.GITHUB?.seals.password as SecretName;
    const sealedBefore = (await sealed.read())?.entries[before];
    index.failing = true;
    await daemon.directory.saveFields('GITHUB', 'GitHub', undefined, { password: NEW_PASSWORD }).catch(() => undefined);

    should((await sealed.read())?.entries[before]).deepEqual(sealedBefore);
  });

  it('should keep everything at boot when there is no committed index to sweep against', async () => {
    const index = new FailingIndex();
    const sealed = new FailingSealed();
    await sealed.write({
      v: 1,
      cipher: new FakeSecretCipher().algorithm,
      entries: {
        L000000000000000000000000_PASSWORD_00000000: { iv: 'x', ciphertext: 'y', createdAt: 'a', updatedAt: 'a' },
      },
    });
    should(await boot(index, sealed).directory.sweepUnreferenced()).deepEqual({ swept: 0 });
    should(await sealedCount(sealed)).equal(1);
  });

  it('should remove a login at its commit even when the sweep after it fails, leaving the orphan masked', async () => {
    const { sealed, daemon } = await withOldPair();
    sealed.failOn(1);
    should(await daemon.directory.remove('GITHUB')).be.true();
    should(await daemon.directory.list()).deepEqual([]);
    should(await daemon.masked(OLD_PASSWORD)).be.true();
  });
});

describe('the boot sweep against a damaged index (F6)', () => {
  it('should delete NOTHING and say so when the index names a version whose ciphertext is missing', async () => {
    const { index, sealed, daemon } = await withOldPair();
    // A staged orphan beside the committed value, then the committed value goes missing (a damaged reference).
    index.failing = true;
    await daemon.directory.saveFields('GITHUB', 'GitHub', undefined, { password: NEW_PASSWORD }).catch(() => undefined);
    index.failing = false;
    const committed = index.accounts.accounts.GITHUB?.seals.password as string;
    const document = (await sealed.read()) as SecretVaultDocument;
    const { [committed]: _lost, ...rest } = document.entries;
    await sealed.write({ ...document, entries: rest });
    const before = await sealedCount(sealed);

    const result = await boot(index, sealed).directory.sweepUnreferenced();

    should(result.swept).equal(0);
    should(result.damaged).containEql('1 sealed value');
    should(await sealedCount(sealed)).equal(before);
    should(await daemon.masked(NEW_PASSWORD)).be.true();
  });

  it('should sweep nothing after a commit either while another entry points at missing ciphertext', async () => {
    const { index, sealed, daemon } = await withOldPair();
    const committed = index.accounts.accounts.GITHUB?.seals.password as string;
    const document = (await sealed.read()) as SecretVaultDocument;
    const { [committed]: _lost, ...rest } = document.entries;
    await sealed.write({
      ...document,
      entries: { ...rest, L000000000000000000000009_PASSWORD_DEADBEEF: document.entries[committed] as never },
    });
    await daemon.directory.put('OTHER', PutLoginEntryRequestSchema.parse({ label: 'other', password: NEW_PASSWORD }));

    should(Object.keys((await sealed.read())?.entries ?? {})).containEql('L000000000000000000000009_PASSWORD_DEADBEEF');
  });
});

describe('the boot sweep and a change in flight', () => {
  it('should wait for a change that has staged but not committed, and never take its ciphertext', async () => {
    const index = new GatedIndex();
    const sealed = new FailingSealed();
    const daemon = boot(index, sealed);
    await daemon.directory.put(
      'GITHUB',
      PutLoginEntryRequestSchema.parse({ label: 'GitHub', username: OLD_USER, password: OLD_PASSWORD }),
    );
    index.hold();
    const saving = daemon.directory.saveFields('GITHUB', 'GitHub', undefined, {
      username: NEW_USER,
      password: NEW_PASSWORD,
    });
    await index.reached();
    // Staged, not committed: the sweep must queue behind the change, not run now.
    let swept: unknown;
    const sweeping = daemon.directory.sweepUnreferenced().then(result => {
      swept = result;
    });
    await Bun.sleep(5);
    should(swept).be.undefined();
    index.release();
    await saving;
    await sweeping;

    should(await daemon.pair()).deepEqual([NEW_USER, NEW_PASSWORD]);
    should(swept).deepEqual({ swept: 0 });
    should(await sealedCount(sealed)).equal(1);
  });
});

/** An index whose next write waits until released, so a change can be held between staging and commit. */
class GatedIndex extends FailingIndex {
  private gate: Promise<void> | undefined;
  private open: () => void = () => undefined;
  private arrived: () => void = () => undefined;
  private arrival: Promise<void> = Promise.resolve();
  hold(): void {
    this.gate = new Promise<void>(resolve => {
      this.open = resolve;
    });
    this.arrival = new Promise<void>(resolve => {
      this.arrived = resolve;
    });
  }
  async reached(): Promise<void> {
    await this.arrival;
  }
  release(): void {
    const open = this.open;
    this.gate = undefined;
    open();
  }
  override async write(document: AccountIndexDocument): Promise<void> {
    if (this.gate !== undefined) {
      this.arrived();
      await this.gate;
    }
    await super.write(document);
  }
}
