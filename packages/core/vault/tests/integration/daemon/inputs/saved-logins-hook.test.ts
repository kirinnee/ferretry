import { describe, it } from 'bun:test';
import should from 'should';
import type { SavedLoginsProvider } from '../../../../contract/index.ts';
import { SavedLoginsThroughHook } from '../../../../daemon/adapters/inputs/saved-logins.ts';
import type { SignInId } from '../../../../daemon/lib/inputs/borrowed.ts';
import { padInputValue } from '../../../../daemon/lib/inputs/wire.ts';
import { account, page, SESSION, site } from '../../../unit/daemon/inputs/grant-fixtures.ts';
import { OWNER, PAGE_LOGIN, PASSWORD, refusal, USERNAME, world } from '../../../unit/daemon/inputs/world.ts';

/**
 * The Vault's input card with the saved-login half switched on through `input.saved:saved`: the real adapter over a
 * provider that is a fake, in front of the real input service. A saved login is offered and typed, "Save as" keeps
 * what was typed, and with Accounts off nothing is offered or kept and every value is typed by hand (fail closed).
 */
// The shared fixtures' sign-in id is longer than the id grammar the hook parses against, so these use a real one.
const SIGN_IN_ID = 'si_0123456789abcdef' as SignInId;
const github = () => ({ accounts: [account({ signIns: [SIGN_IN_ID] })], signIns: [site({ id: SIGN_IN_ID })] });

function provider(over: Partial<SavedLoginsProvider> = {}): SavedLoginsProvider {
  return {
    listing: async () => github(),
    fill: async (_id, role) => (role === 'username' ? USERNAME : PASSWORD),
    save: async () => undefined,
    choice: async () => ({}),
    observeSignIn: async () => undefined,
    checkedByUse: async () => undefined,
    ...over,
  };
}

const typed = (user: string, pass: string) => [
  { field: 'user', padded: padInputValue(user) },
  { field: 'pass', padded: padInputValue(pass) },
];

/** A page login card over the production adapter, looked up on every call from `current` (undefined: Accounts is off). */
async function card(current: () => SavedLoginsProvider | undefined) {
  const hook = new SavedLoginsThroughHook(current);
  const w = world({ facts: page(), loginPort: hook, choicePort: hook });
  await w.service.raise(SESSION, PAGE_LOGIN);
  return { w, request: await w.pending() };
}

describe('saved logins on an input card, through the hook', () => {
  it('should offer a saved login on the card and type what the account holds', async () => {
    const { w, request } = await card(() => provider());

    should(request.saved?.offers.map(offer => offer.id)).eql(['GITHUB']);
    const result = await w.service.deliver(SESSION, request.id, w.send(request, { entry: 'GITHUB' }), OWNER);

    should(result.state).equal('delivered');
    should(w.writes.map(write => write.values)).eql([[USERNAME, PASSWORD]]);
  });

  it('should keep what the owner typed as a new account when the card says "Save as"', async () => {
    const saved: unknown[][] = [];
    const { w, request } = await card(() => provider({ save: async (...args) => void saved.push(args) }));

    const result = await w.service.deliver(
      SESSION,
      request.id,
      w.send(request, {
        fields: typed('kirin', 'a-long-enough-password'),
        save: { entry: 'NEW_ACCOUNT', label: 'GitHub' },
      }),
      OWNER,
    );

    should(result.state).equal('delivered');
    should(saved).have.length(1);
    should(saved[0]?.slice(0, 2)).eql(['NEW_ACCOUNT', 'GitHub']);
    should(saved[0]?.[3]).eql({ username: 'kirin', password: 'a-long-enough-password' });
  });

  it('should offer nothing saved and still deliver a typed value while Accounts provides nothing', async () => {
    const { w, request } = await card(() => undefined);

    should(request.saved?.offers ?? []).eql([]);
    const result = await w.service.deliver(
      SESSION,
      request.id,
      w.send(request, { fields: typed('kirin', PASSWORD) }),
      OWNER,
    );

    should(result.state).equal('delivered');
    should(w.writes.map(write => write.values)).eql([['kirin', PASSWORD]]);
  });

  it('should refuse a saved entry, typing nothing, when Accounts is turned off after the card was drawn', async () => {
    let on = true;
    const { w, request } = await card(() => (on ? provider() : undefined));
    on = false;

    should(request.saved?.offers).have.length(1);
    const refused = await refusal(w.service.deliver(SESSION, request.id, w.send(request, { entry: 'GITHUB' }), OWNER));

    should(refused.message).equal('Ferretry could not read the saved accounts, so nothing was typed');
    should(w.writes).eql([]);
  });

  it('should refuse a saved entry and a "Save as" with a sentence, typing nothing, while Accounts provides nothing', async () => {
    const { w, request } = await card(() => undefined);

    const entry = await refusal(w.service.deliver(SESSION, request.id, w.send(request, { entry: 'GITHUB' }), OWNER));
    const saved = await refusal(
      w.service.deliver(
        SESSION,
        request.id,
        w.send(request, {
          fields: typed('kirin', 'a-long-enough-password'),
          save: { entry: 'NEW_ACCOUNT', label: 'GitHub' },
        }),
        OWNER,
      ),
    );

    for (const refused of [entry, saved])
      should(refused.message).equal('Ferretry could not read the saved accounts, so nothing was typed');
    should(w.writes).eql([]);
  });

  it('should never let the typed value into an event, an audit entry, a note or a refusal sentence', async () => {
    const down = await card(() =>
      provider({
        fill: async () => {
          throw new Error(`the store failed holding ${PASSWORD}`);
        },
      }),
    );
    const failed = await refusal(
      down.w.service.deliver(SESSION, down.request.id, down.w.send(down.request, { entry: 'GITHUB' }), OWNER),
    );
    const ok = await card(() => provider());
    const delivered = await ok.w.service.deliver(
      SESSION,
      ok.request.id,
      ok.w.send(ok.request, { entry: 'GITHUB' }),
      OWNER,
    );
    const agentView = await ok.w.service.agentView(SESSION, ok.request.agendaItemId, 0);
    const owned = await ok.w.service.list(OWNER, SESSION);

    should(failed.message).not.containEql(PASSWORD);
    // The value WAS typed, so the checks below mean something: it is in the target and in no answer, view or listing.
    should(ok.w.writes.map(write => write.values)).eql([[USERNAME, PASSWORD]]);
    for (const surface of [delivered, agentView, owned]) should(JSON.stringify(surface)).not.containEql(PASSWORD);
    for (const each of [down.w, ok.w])
      should(JSON.stringify([each.events, each.audits, each.notes, each.told, each.cards])).not.containEql(PASSWORD);
  });

  for (const [name, answer] of [
    ['a number', 123456],
    ['an object', { value: 'x' }],
    ['nothing', undefined],
    ['an empty string', ''],
  ] as const)
    it(`should type nothing and say a fixed sentence when the provider answers ${name} for a value`, async () => {
      const { w, request } = await card(() => provider({ fill: async () => answer as never }));

      const refused = await refusal(
        w.service.deliver(SESSION, request.id, w.send(request, { entry: 'GITHUB' }), OWNER),
      );

      should(refused.message).equal('Ferretry could not open the account, so nothing was typed');
      should(w.writes).eql([]);
    });
});

describe('the hook’s adapter', () => {
  it('should answer cannot-tell, an empty order and no facts when Accounts provides nothing', async () => {
    const hook = new SavedLoginsThroughHook(() => undefined);

    await should(hook.listing()).rejected();
    await should(hook.fill('GITHUB' as never, 'password', 0)).rejected();
    await should(hook.save('GITHUB' as never, 'GitHub', undefined, {})).rejected();
    should(await hook.of(SESSION)).eql({});
    await should(hook.observeSignIn('si_0123456789abcdef' as never, {} as never)).fulfilled();
    await should(hook.checkedByUse('GITHUB' as never, 'tf_0123456789ab' as never, true)).fulfilled();
  });

  it('should refuse a listing with a field the card may not show, and an order that carries more than it needs', async () => {
    const smuggling = new SavedLoginsThroughHook(() =>
      provider({
        listing: async () => ({ ...github(), accounts: [{ ...account(), password: PASSWORD }] }),
        choice: async () => ({ defaults: {}, password: PASSWORD }),
      }),
    );
    const throwing = new SavedLoginsThroughHook(() =>
      provider({
        choice: async () => {
          throw new Error('the board is down');
        },
      }),
    );

    await should(smuggling.listing()).rejected();
    should(await smuggling.of(SESSION)).eql({});
    should(await throwing.of(SESSION)).eql({});
  });

  it('should refuse a value that is not one non-empty string, in a sentence that names none', async () => {
    for (const answer of [123456, { value: PASSWORD }, undefined, '']) {
      const hook = new SavedLoginsThroughHook(() => provider({ fill: async () => answer as never }));

      const error = await hook.fill('GITHUB' as never, 'password', 0).then(
        () => undefined,
        (caught: unknown) => caught,
      );

      should((error as Error).message).equal('Accounts answered a value Ferretry cannot read.');
    }
  });

  it('should hand the provider exactly what the card asked and tell it what the daemon saw', async () => {
    const seen: unknown[] = [];
    const hook = new SavedLoginsThroughHook(() =>
      provider({
        fill: async (...args) => {
          seen.push(['fill', ...args]);
          return PASSWORD;
        },
        save: async (...args) => void seen.push(['save', ...args]),
        choice: async id => ({ folder: `/work/${id}`, home: '/home/kirin' }),
        observeSignIn: async (...args) => void seen.push(['observe', ...args]),
        checkedByUse: async (...args) => void seen.push(['checked', ...args]),
      }),
    );

    should(await hook.fill('GITHUB' as never, 'totp', 7, { factor: 'tf_0123456789ab' as never })).equal(PASSWORD);
    await hook.save('GITHUB' as never, 'GitHub', 'github.com', { username: 'kirin' }, 'new', 'kirin');
    should(await hook.of(SESSION)).eql({ folder: `/work/${SESSION}`, home: '/home/kirin' });
    await hook.observeSignIn('si_0123456789abcdef' as never, { at: 'github.com' } as never);
    await hook.checkedByUse('GITHUB' as never, 'tf_0123456789ab' as never, false);

    should(seen).eql([
      ['fill', 'GITHUB', 'totp', 7, { factor: 'tf_0123456789ab' }],
      ['save', 'GITHUB', 'GitHub', 'github.com', { username: 'kirin' }, 'new', 'kirin'],
      ['observe', 'si_0123456789abcdef', { at: 'github.com' }],
      ['checked', 'GITHUB', 'tf_0123456789ab', false],
    ]);
  });
});
