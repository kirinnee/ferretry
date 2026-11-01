import { describe, it } from 'bun:test';
import { type PutLoginEntry, PutLoginEntryRequestSchema, type SecretName } from '@ferretry/protocol';
import should from 'should';
import {
  combinedValues,
  LoginDirectory,
  LoginEntryError,
  LoginStoreLock,
  LoginVault,
  SecretRedactor,
} from '../../../src/lib/secrets/index.ts';
import { InputLoginAdapter } from '../../../src/lib/input-requests/login-adapter.ts';
import { FakeSecretCipher, MemoryLoginIndex, MemorySecretDocuments } from '../runtime/mounts/support.ts';

/**
 * F1 of the #1094 security review: every saved login shares two files, and a change reads both, awaits sealing
 * and writes both back. Two changes that overlap must BOTH survive, and every acknowledged secret must stay
 * masked. Each case holds the first change at its seal (a gate released by hand), starts the second, then
 * releases them in the WORST order, so the outcome is decided by the lock and not by timing.
 */

const CLOCK = { now: () => '2026-10-31T09:00:00.000Z' };
const FIRST = 'first-UNIQUE-password-1';
const SECOND = 'second-UNIQUE-password-2';

/** Seals like the fake cipher, but each seal waits until the test opens its gate. */
class GatedCipher extends FakeSecretCipher {
  readonly waiting: (() => void)[] = [];
  sealsStarted = 0;

  override async seal(name: SecretName, plaintext: string) {
    this.sealsStarted += 1;
    await new Promise<void>(resolve => this.waiting.push(resolve));
    return await super.seal(name, plaintext);
  }

  /** Opens the gate of the seal that started `index`th (0-based), once it is waiting. */
  async open(index: number): Promise<void> {
    for (let spin = 0; spin < 100 && this.waiting[index] === undefined; spin += 1) await Bun.sleep(1);
    const gate = this.waiting[index];
    if (gate === undefined) throw new Error(`seal ${index} never started`);
    gate();
  }
}

function world() {
  const index = new MemoryLoginIndex();
  const sealed = new MemorySecretDocuments();
  const cipher = new GatedCipher();
  let key = 0;
  const directory = new LoginDirectory(index, sealed, cipher, CLOCK, {
    newKey: () => `L${(key++).toString(16).toUpperCase().padStart(24, '0')}`,
  });
  const vault = new LoginVault(index, sealed, cipher);
  const masked = async (value: string): Promise<boolean> =>
    !(await new SecretRedactor(combinedValues(vault)).redact(`echo ${value}`)).includes(value);
  return { index, sealed, cipher, directory, vault, masked };
}

const change = (input: unknown): PutLoginEntry => PutLoginEntryRequestSchema.parse(input);
const settle = async (): Promise<void> => {
  for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
};

describe('saved logins changed at the same time', () => {
  it('should keep BOTH of two overlapping saves to different logins, and keep both masked', async () => {
    const w = world();
    const first = w.directory.put('FIRST', change({ label: 'first', password: FIRST }));
    await settle();
    const second = w.directory.put('SECOND', change({ label: 'second', password: SECOND }));
    await settle();

    // The second has not even begun while the first holds the store: it waits behind it.
    should(w.cipher.sealsStarted).equal(1);
    await w.cipher.open(0);
    await first;
    await w.cipher.open(1);
    await second;

    should((await w.directory.list()).map(entry => entry.id)).deepEqual(['FIRST', 'SECOND']);
    should(await w.vault.fill('FIRST', 'password', 0)).equal(FIRST);
    should(await w.vault.fill('SECOND', 'password', 0)).equal(SECOND);
    should(await w.masked(FIRST)).be.true();
    should(await w.masked(SECOND)).be.true();
  });

  it('should keep a card’s save and a Settings edit of the same login, whichever lands second', async () => {
    const w = world();
    await w.directory.put('SUDO', change({ label: 'sudo', match: ['sudo@laptop'] }));
    const saved = w.directory.saveFields('SUDO', 'ignored', 'sudo@kirin-box', { password: FIRST });
    await settle();
    const edited = w.directory.put('SUDO', change({ label: 'sudo (both machines)', username: 'kirin' }));
    await w.cipher.open(0);
    await Promise.all([saved, edited]);

    const [entry] = await w.directory.list();
    should(entry).match({
      id: 'SUDO',
      label: 'sudo (both machines)',
      username: 'kirin',
      match: ['sudo@laptop', 'sudo@kirin-box'],
      fields: { password: true },
    });
    should(await w.vault.fill('SUDO', 'password', 0)).equal(FIRST);
    should(await w.masked(FIRST)).be.true();
  });

  it('should rename a login that a card is saving into, and keep the saved password under the new name', async () => {
    const w = world();
    await w.directory.put('SUDO_LAPTOP', change({ label: 'sudo' }));
    const saved = w.directory.saveFields('SUDO_LAPTOP', 'sudo', 'sudo@kirin-box', { password: FIRST });
    await settle();
    const renamed = w.directory.rename('SUDO_LAPTOP', 'SUDO_KIRIN_BOX');
    await w.cipher.open(0);
    await Promise.all([saved, renamed]);

    should((await w.directory.list()).map(entry => entry.id)).deepEqual(['SUDO_KIRIN_BOX']);
    should(await w.vault.fill('SUDO_KIRIN_BOX', 'password', 0)).equal(FIRST);
    should(await w.masked(FIRST)).be.true();
  });

  it('should keep a save that overlaps removing another login, and leave the removed one gone', async () => {
    const w = world();
    const pending = w.directory.put('GONE', change({ label: 'gone', password: SECOND }));
    await w.cipher.open(0);
    await pending;
    const saved = w.directory.put('KEPT', change({ label: 'kept', password: FIRST }));
    await settle();
    const removed = w.directory.remove('GONE');
    await w.cipher.open(1);
    await Promise.all([saved, removed]);

    should((await w.directory.list()).map(entry => entry.id)).deepEqual(['KEPT']);
    should(await w.vault.fill('KEPT', 'password', 0)).equal(FIRST);
    should(await w.masked(FIRST)).be.true();
    should([...(await w.vault.values()).values()]).deepEqual([FIRST]);
  });

  it('should save the same login from two cards at once, the second password winning and nothing orphaned', async () => {
    const w = world();
    const one = w.directory.saveFields('SUDO', 'sudo', 'sudo@a', { password: FIRST });
    await settle();
    const two = w.directory.saveFields('SUDO', 'sudo', 'sudo@b', { password: SECOND });
    await w.cipher.open(0);
    await w.cipher.open(1);
    await Promise.all([one, two]);

    const [entry] = await w.directory.list();
    should(entry?.match).deepEqual(['sudo@a', 'sudo@b']);
    should(await w.vault.fill('SUDO', 'password', 0)).equal(SECOND);
    should(Object.keys((await w.sealed.read())?.entries ?? {})).have.length(1);
  });

  it('should let the next change through after one that failed', async () => {
    const w = world();
    const refused = w.directory.put('NEW', change({ password: FIRST }));
    const after = w.directory.put('OK', change({ label: 'ok' }));
    should(await refused.catch(error => error)).be.instanceOf(LoginEntryError);
    should((await after).id).equal('OK');
  });

  it('should keep a username and a password from one card together, in one change', async () => {
    const w = world();
    const saving = w.directory.saveFields('GITHUB', 'GitHub (kirinnee)', 'github.com', {
      username: 'kirinnee',
      password: FIRST,
    });
    await w.cipher.open(0);
    const summary = await saving;

    should(summary).match({ label: 'GitHub (kirinnee)', username: 'kirinnee', match: ['github.com'] });
    should(summary.fields.password).be.true();
    should(await w.vault.fill('GITHUB', 'username', 0)).equal('kirinnee');
    should(await w.vault.fill('GITHUB', 'password', 0)).equal(FIRST);
  });
});

describe('two cards saving through the input bridge at once', () => {
  it('should keep both, because the bridge saves through the same locked directory', async () => {
    const w = world();
    const bridge = new InputLoginAdapter(w.directory, w.vault);
    const one = bridge.save('SUDO_A', 'sudo on a', 'sudo@a', { password: FIRST });
    await settle();
    const two = bridge.save('SUDO_B', 'sudo on b', 'sudo@b', { password: SECOND });
    await w.cipher.open(0);
    await w.cipher.open(1);
    await Promise.all([one, two]);

    should((await bridge.listing()).accounts.map(account => account.id)).deepEqual(['SUDO_A', 'SUDO_B']);
    should(await w.masked(FIRST)).be.true();
    should(await w.masked(SECOND)).be.true();
  });
});

describe('the store lock', () => {
  it('should run changes one at a time in the order they arrived, and survive one that throws', async () => {
    const lock = new LoginStoreLock();
    const order: string[] = [];
    const slow = lock.run(async () => {
      await Bun.sleep(5);
      order.push('slow');
    });
    const failing = lock.run(async () => {
      order.push('failing');
      throw new Error('no');
    });
    const fast = lock.run(async () => {
      order.push('fast');
      return 'done';
    });

    await slow;
    should(await failing.catch(error => error.message)).equal('no');
    should(await fast).equal('done');
    should(order).deepEqual(['slow', 'failing', 'fast']);
  });
});
