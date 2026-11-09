/**
 * "SAVE AS" ON A CARD (`logins.ts`): a typed username and password kept as one account in one change, the place it was
 * typed at added to what the account signs in at, and the boot sweep run over the same store.
 */

import { describe, it } from 'bun:test';
import should from 'should';
import { LoginDirectory } from '../../../daemon/lib/logins.ts';
import { CLOCK, CountingSealed, FakeSecretCipher, MemoryLoginIndex } from './support.ts';

const PASSWORD = 'synthetic-card-password';

function world() {
  const index = new MemoryLoginIndex();
  const sealed = new CountingSealed();
  const logins = new LoginDirectory(index, sealed, new FakeSecretCipher(), CLOCK);
  return { index, sealed, logins };
}

const refusal = async (work: Promise<unknown>) =>
  (await work.catch((error: unknown) => error)) as Error & { refusal?: string };

describe('saving what a login card typed', () => {
  it('should refuse to update an account that does not exist, writing nothing', async () => {
    const w = world();

    const refused = await refusal(
      w.logins.saveFields('GITHUB', 'GitHub', 'github.com', { username: 'kirinnee' }, 'update'),
    );

    should(refused.refusal).equal('unknown_login');
    should(refused.message).equal('there is no account GITHUB to update');
    should(w.index.document).be.undefined();
  });

  it('should add the place it was typed at to the website the account already signs in on', async () => {
    const w = world();
    await w.logins.saveFields('GITHUB', 'GitHub', 'github.com', { username: 'kirinnee', password: PASSWORD }, 'new');

    await w.logins.saveFields('GITHUB', 'GitHub', 'gist.github.com', { username: 'kirinnee' }, 'update', 'kirinnee');

    const signIns = Object.values(w.index.accounts.signIns);
    should(signIns).have.length(1);
    should(signIns[0]?.place).eql({
      kind: 'site',
      domains: ['github.com', 'gist.github.com'],
      match: ['github.com', 'gist.github.com'],
    });
  });

  it('should not add a place the account already signs in at', async () => {
    const w = world();
    await w.logins.saveFields('GITHUB', 'GitHub', 'github.com', { username: 'kirinnee', password: PASSWORD }, 'new');
    const before = JSON.stringify(w.index.accounts.signIns);

    await w.logins.saveFields('GITHUB', 'GitHub', 'github.com', { username: 'kirinnee' }, 'update', 'kirinnee');

    should(JSON.stringify(w.index.accounts.signIns)).equal(before);
  });

  it('should refuse an update that would write over someone else', async () => {
    const w = world();
    await w.logins.saveFields('GITHUB', 'GitHub', 'github.com', { username: 'kirinnee', password: PASSWORD }, 'new');

    const otherBox = await refusal(
      w.logins.saveFields('GITHUB', 'GitHub', 'github.com', { username: 'someone-else' }, 'update'),
    );
    const otherPage = await refusal(
      w.logins.saveFields('GITHUB', 'GitHub', 'github.com', { password: PASSWORD }, 'update', 'someone-else'),
    );

    should([otherBox.refusal, otherPage.refusal]).eql(['invalid_change', 'invalid_change']);
  });
});

describe('the boot sweep, through the login directory', () => {
  it('should do nothing to a store with nothing in it', async () => {
    should(await world().logins.sweepUnreferenced()).eql({ swept: 0 });
  });

  it('should say how many sealed values nothing points at went, and keep the ones an account holds', async () => {
    const w = world();
    await w.logins.saveFields('GITHUB', 'GitHub', 'github.com', { username: 'kirinnee', password: PASSWORD }, 'new');
    const sealed = await w.sealed.read();
    if (sealed === undefined) throw new Error('nothing was sealed');
    await w.sealed.write({
      ...sealed,
      entries: { ...sealed.entries, ORPHAN: { iv: 'ORPHAN', ciphertext: 'nothing-points-here' } },
    });

    should(await w.logins.sweepUnreferenced()).eql({ swept: 1 });
    should(Object.keys((await w.sealed.read())?.entries ?? {})).not.containEql('ORPHAN');
    should(Object.keys((await w.sealed.read())?.entries ?? {})).have.length(1);
  });
});
