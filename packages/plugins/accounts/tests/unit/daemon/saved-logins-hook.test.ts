/**
 * WHAT ACCOUNTS ANSWERS THE VAULT'S INPUT CARD (`input.saved:saved`, `saved-logins-hook.ts`): the listing, the one value
 * a field types, "Save as", the card order and the facts of a sign-in, over the real account store. A value is answered
 * only by `fill`, and nothing the Vault sends is trusted: a bad id or shape is refused with no value in the sentence.
 */

import { describe, it } from 'bun:test';
import should from 'should';
import { AccountsSavedLogins } from '../../../daemon/lib/saved-logins-hook.ts';
import { AccountVault, LoginDirectory } from './lib.ts';
import { CLOCK, CountingSealed, FakeSecretCipher, MemoryLoginIndex } from './support.ts';

const PASSWORD = 'synthetic-card-password-UNIQUE';

function world(over: { readonly vault?: false } = {}) {
  const index = new MemoryLoginIndex();
  const sealed = new CountingSealed();
  const cipher = new FakeSecretCipher();
  const logins = new LoginDirectory(index, sealed, cipher, CLOCK);
  const asked: (string | undefined)[] = [];
  const hook = new AccountsSavedLogins({
    logins,
    ...(over.vault === false ? {} : { vault: new AccountVault(index, sealed, cipher) }),
    choice: {
      of: async sessionId => {
        asked.push(sessionId);
        return { defaults: {} };
      },
    },
  });
  return { index, hook, asked };
}

const refusal = async (work: Promise<unknown>) => (await work.catch((error: unknown) => error)) as Error;

describe('the saved logins Accounts offers the Vault’s input card', () => {
  it('should list what "Save as" kept and answer each field’s value only to fill', async () => {
    const w = world();

    await w.hook.save('GITHUB', 'GitHub', 'github.com', { username: 'kirinnee', password: PASSWORD }, 'new');
    const listing = await w.hook.listing();

    should(listing.accounts.map(each => each.id)).eql(['GITHUB']);
    should(JSON.stringify(listing)).not.containEql(PASSWORD);
    should(await w.hook.fill('GITHUB', 'username', 0)).equal('kirinnee');
    should(await w.hook.fill('GITHUB', 'password', 0)).equal(PASSWORD);
  });

  it('should fold what the daemon saw after a submit into the sign-in, and ignore a use of a key that is gone', async () => {
    const w = world();
    await w.hook.save('GITHUB', 'GitHub', 'github.com', { username: 'kirinnee', password: PASSWORD }, 'new');
    const [signIn] = (await w.hook.listing()).signIns;

    await w.hook.observeSignIn(signIn?.id ?? '', {
      at: 'github.com',
      surface: 'page',
      identity: '0123456789abcdef',
      masked: true,
      noEchoAfterSubmit: false,
      navigatedAway: true,
      secondFactor: 'none',
      tapped: true,
    });
    await w.hook.observeSignIn(signIn?.id ?? '', { at: 'github.com', surface: 'page', identity: '0123456789abcdef' });
    await w.hook.checkedByUse('GITHUB', 'tf_0123456789ab', true);

    const after = await w.hook.listing();
    should(after.signIns[0]?.observed?.map(each => each.at)).eql(['github.com']);
  });

  it('should answer who is asking from the daemon’s own order and nothing from the Vault’s side', async () => {
    const w = world();

    should(await w.hook.choice('s1')).eql({ defaults: {} });
    should(w.asked).eql(['s1']);
  });

  it('should refuse a value when it keeps none, and an id or role that is not one, naming no value', async () => {
    const none = world({ vault: false });
    const w = world();
    await w.hook.save('GITHUB', 'GitHub', undefined, { username: 'kirinnee', password: PASSWORD });

    const noVault = await refusal(none.hook.fill('GITHUB', 'password', 0));
    const badId = await refusal(w.hook.fill('not an id!', 'password', 0));
    const badRole = await refusal(w.hook.fill('GITHUB', 'seed' as never, 0));
    const badFactor = await refusal(w.hook.fill('GITHUB', 'totp', 0, { factor: 'nope' }));
    const extra = await refusal(w.hook.save('GITHUB', 'GitHub', undefined, { username: 'a', note: PASSWORD } as never));
    const badMode = await refusal(w.hook.save('GITHUB', 'GitHub', undefined, {}, 'merge' as never));
    const badSeen = await refusal(w.hook.observeSignIn('si_0123456789abcdef', { at: 7, secret: PASSWORD }));
    const badSignIn = await refusal(
      w.hook.observeSignIn('nope', { at: 'github.com', surface: 'page', identity: '0123456789abcdef' }),
    );
    const badAccount = await refusal(w.hook.checkedByUse('not an id!', 'tf_0123456789ab', true));
    const badKey = await refusal(w.hook.checkedByUse('GITHUB', 'nope', true));

    should(noVault.message).equal('Accounts keeps no values, so nothing was typed.');
    for (const error of [noVault, badId, badRole, badFactor, extra, badMode, badSeen, badSignIn, badAccount, badKey]) {
      should(error).be.an.Error();
      should(error.message).not.containEql(PASSWORD);
    }
  });
});
