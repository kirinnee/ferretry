/**
 * "SAVE AS" ON A CARD (`logins.ts`): a typed username and password kept as one account in one change, the place it was
 * typed at added to what the account signs in at, and the boot sweep run over the same store.
 */

import { describe, it } from 'bun:test';
import should from 'should';
import { passwordProblem } from '../../../app/lib/login-form.ts';
import { LOGIN_PASSWORD_MIN_LENGTH, PutAccountRequestSchema } from '../../../contract/routes/index.ts';
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

describe('Appendix D: Save as, through the login directory', () => {
  it('S136 should make a new account or an explicit Update of the same username, never one with another username', async () => {
    const w = world();
    await w.logins.saveFields('GITHUB', 'GitHub', 'github.com', { username: 'kirinnee', password: PASSWORD }, 'new');
    // The same username (however it is cased) is the same person: Update replaces the password.
    await w.logins.saveFields(
      'GITHUB',
      'GitHub',
      'github.com',
      { username: 'KirinNee', password: 'synthetic-card-password-2' },
      'update',
      'kirinnee',
    );
    should(Object.keys(w.index.accounts.accounts)).eql(['GITHUB']);
    // Another username is never an Update of this account: not from the box, not from the page.
    for (const refused of [
      await refusal(w.logins.saveFields('GITHUB', 'GitHub', undefined, { username: 'someone-else' }, 'update')),
      await refusal(
        w.logins.saveFields('GITHUB', 'GitHub', undefined, { password: PASSWORD }, 'update', 'someone-else'),
      ),
    ])
      should(refused.refusal).equal('invalid_change');
    should(w.index.accounts.accounts.GITHUB?.username).equal('KirinNee');
  });

  it('I144 should start on new: a handle an account already has is refused, and only Update overwrites a saved password', async () => {
    const w = world();
    await w.logins.saveFields('GITHUB', 'GitHub', 'github.com', { username: 'kirinnee', password: PASSWORD }, 'new');
    const seal = w.index.accounts.accounts.GITHUB?.seals;
    const clash = await refusal(
      w.logins.saveFields(
        'GITHUB',
        'GitHub',
        'github.com',
        { username: 'kirinnee', password: 'synthetic-new-password' },
        'new',
      ),
    );
    should(clash.refusal).equal('login_exists');
    should(w.index.accounts.accounts.GITHUB?.seals).eql(seal);
    await w.logins.saveFields(
      'GITHUB',
      'GitHub',
      'github.com',
      { password: 'synthetic-new-password' },
      'update',
      'kirinnee',
    );
    should(w.index.accounts.accounts.GITHUB?.seals).not.eql(seal);
  });

  it('I146 should never offer an Update for someone that account is not, and never let a typed username choose the account', async () => {
    const w = world();
    await w.logins.saveFields('GITHUB', 'GitHub', 'github.com', { username: 'kirinnee', password: PASSWORD }, 'new');
    await w.logins.saveFields('NOUSER', 'No user', 'example.com', { password: PASSWORD }, 'new');
    // The page signs in someone else; an account with no username saved cannot be told to be the same person.
    should(
      (await refusal(w.logins.saveFields('GITHUB', 'GitHub', undefined, { password: PASSWORD }, 'update', 'other')))
        .refusal,
    ).equal('invalid_change');
    should(
      (await refusal(w.logins.saveFields('NOUSER', 'No user', undefined, { password: PASSWORD }, 'update', 'anyone')))
        .refusal,
    ).equal('invalid_change');
    // The account is the handle the card named: a second account typed with the same username is its own account.
    await w.logins.saveFields(
      'GITHUB_WORK',
      'GitHub work',
      'github.com',
      { username: 'kirinnee', password: PASSWORD },
      'new',
    );
    should(Object.keys(w.index.accounts.accounts).sort()).eql(['GITHUB', 'GITHUB_WORK', 'NOUSER']);
  });

  it('I148 should keep no password under 8 characters and no code: the write schema refuses it and the app warns first', () => {
    const short = 'x'.repeat(LOGIN_PASSWORD_MIN_LENGTH - 1);
    should(LOGIN_PASSWORD_MIN_LENGTH).be.aboveOrEqual(8);
    should(PutAccountRequestSchema.safeParse({ password: short }).success).be.false();
    should(PutAccountRequestSchema.safeParse({ password: `${short}x` }).success).be.true();
    // The app says so before anything is sent, so a short password is never dropped silently.
    should(passwordProblem(short)).equal(`At least ${LOGIN_PASSWORD_MIN_LENGTH} characters.`);
    // What an account keeps from a card is a username and a password: no field a code could be saved in.
    const fields: Parameters<LoginDirectory['saveFields']>[3] = { username: 'kirinnee', password: PASSWORD };
    should(Object.keys(fields)).eql(['username', 'password']);
    should(PutAccountRequestSchema.safeParse({ code: '123456' }).success).be.false();
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
      entries: {
        ...sealed.entries,
        ORPHAN: {
          iv: 'ORPHAN',
          ciphertext: 'nothing-points-here',
          createdAt: '2026-10-31T09:00:00.000Z',
          updatedAt: '2026-10-31T09:00:00.000Z',
        },
      },
    });

    should(await w.logins.sweepUnreferenced()).eql({ swept: 1 });
    should(Object.keys((await w.sealed.read())?.entries ?? {})).not.containEql('ORPHAN');
    should(Object.keys((await w.sealed.read())?.entries ?? {})).have.length(1);
  });
});
