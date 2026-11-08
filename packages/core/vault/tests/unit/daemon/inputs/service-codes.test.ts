import { describe, it } from 'bun:test';
import should from 'should';
import type { InputRaise, InputTargetFacts } from '../../../../contract/index.ts';
import { account, page, pageField, SESSION, SIGN_IN, site, terminal } from './grant-fixtures.ts';
import { OWNER, refusal, world, type WorldOptions } from './world.ts';

/**
 * A one-time code Ferretry makes from a saved 2FA key and types into a code card ("Use code from Ferretry"): who may
 * ask for it, where it may go, what is done when the code did not go through, and how a card is opened again for the
 * owner to type it. The accounts, the page and the observer are fakes; the service is the real one.
 */

const AT = '2026-10-01T00:00:00.000Z';
const SEEDED = {
  id: 'tf_0000000000a1',
  kind: 'totp',
  label: 'App',
  addedAt: AT,
  addedBy: 'owner',
  automatic: true,
  params: { algorithm: 'SHA1', digits: 6, period: 30 },
} as const;
const SMS = {
  id: 'tf_0000000000a2',
  kind: 'sms',
  label: 'Phone',
  addedAt: AT,
  addedBy: 'owner',
  automatic: false,
  endsWith: '42',
} as const;

const CODE_RAISE: InputRaise = {
  target: { kind: 'page', key: 'app' },
  prompt: 'GitHub asks for the code',
  fields: [{ id: 'code', label: 'Code', sensitivity: 'code', element: { kind: 'selector', selector: '#otp' } }],
  submit: 'owner-default',
};

const codePage = (over: Parameters<typeof pageField>[1] = {}): InputTargetFacts => page({}, [pageField('code', over)]);

const sudoSignIn = () =>
  site({ place: { kind: 'terminal', tool: 'ssh', host: 'kirin-box', dest: 'bastion' } as never, id: SIGN_IN });

const withKey = (over: WorldOptions = {}): WorldOptions => ({
  facts: codePage(),
  accounts: { accounts: [account({ factors: [SEEDED, SMS] })], signIns: [site()] },
  ...over,
});

const useCode = (body: Record<string, unknown> = {}) => ({ entry: 'GITHUB', factor: SEEDED.id, ...body });

describe('typing a code Ferretry makes', () => {
  it('should title the card by the keys of the account that signs in here, and type the code once the owner taps', async () => {
    const w = world(withKey());

    const view = await w.service.raise(SESSION, CODE_RAISE);
    const request = await w.pending();
    const result = await w.service.deliver(SESSION, request.id, w.send(request, useCode()), OWNER);

    should(w.cards[0]?.title).equal('One-time code for github.com, by authenticator app or SMS');
    should(request.saved?.offers[0]?.codes).eql([{ factor: SEEDED.id, label: 'App' }]);
    should(result).match({ state: 'delivered' });
    should(w.fills).eql([{ id: 'GITHUB', role: 'totp', factor: SEEDED.id }]);
    should(w.writes.map(write => write.values)).eql([['123456']]);
    should(view.state).equal('pending');
  });

  it('should name only the place on the card a ferret can read when no account signs in here', async () => {
    const w = world(withKey({ accounts: { accounts: [], signIns: [] } }));

    await w.service.raise(SESSION, CODE_RAISE);

    should(w.cards[0]?.title).equal('Needs a code');
  });

  it('should word the card for the one key a code goes to when only one key ends in a code', async () => {
    const w = world(withKey({ accounts: { accounts: [account({ factors: [SMS] })], signIns: [site()] } }));

    await w.service.raise(SESSION, { ...CODE_RAISE, factor: SMS.id });

    should(w.cards[0]?.title).equal('One-time code for github.com, by SMS');
  });

  it('should refuse a key the card does not offer, a key on a card with no code field, and a sign-in that is not the account’s', async () => {
    const w = world(withKey());
    await w.service.raise(SESSION, CODE_RAISE);
    const request = await w.pending();

    const unknownKey = await refusal(
      w.service.deliver(SESSION, request.id, w.send(request, useCode({ factor: 'tf_000000000099' })), OWNER),
    );
    const otherSignIn = await refusal(
      w.service.deliver(SESSION, request.id, w.send(request, useCode({ signIn: 'si_00000000000000ff' })), OWNER),
    );
    const noAccount = await refusal(
      w.service.deliver(SESSION, request.id, w.send(request, useCode({ entry: 'NOBODY' })), OWNER),
    );

    should(unknownKey.message).containEql('is not one GITHUB makes codes from for this target');
    should(otherSignIn.message).containEql('is not one of GITHUB');
    should(noAccount.code).equal('not_found');
    should(w.writes).eql([]);
  });

  it('should refuse a key for a card that has no code field, naming that nothing was typed', async () => {
    const w = world({ facts: page(), accounts: { accounts: [account({ factors: [SEEDED] })], signIns: [site()] } });
    await w.service.raise(SESSION, {
      target: { kind: 'page', key: 'app' },
      prompt: 'GitHub login',
      fields: [
        { id: 'user', sensitivity: 'plain', element: { kind: 'selector', selector: '#login_field' } },
        { id: 'pass', sensitivity: 'secret', element: { kind: 'selector', selector: '#password' } },
      ],
      submit: 'owner-default',
    });
    const request = await w.pending();

    const error = await refusal(w.service.deliver(SESSION, request.id, w.send(request, useCode()), OWNER));

    should(error.message).containEql('this card has no code field for a 2FA key to fill');
    should(w.writes).eql([]);
  });

  it('should refuse the saved accounts when they cannot be read, typing nothing', async () => {
    const w = world(withKey());
    await w.service.raise(SESSION, CODE_RAISE);
    const request = await w.pending();
    w.state.listingFails = true;

    const error = await refusal(w.service.deliver(SESSION, request.id, w.send(request, useCode()), OWNER));

    should(error.code).equal('unavailable');
    should(w.writes).eql([]);
  });

  it('should never type a code Ferretry made into a prompt that is no longer a code program’s', async () => {
    const w = world({
      facts: terminal({
        foreground: { pid: 11, pgid: 11, comm: 'ssh', argv: 'ssh bastion' },
        program: 'ssh',
        promptLine: 'Verification code:',
      }),
      accounts: { accounts: [account({ factors: [SEEDED] })], signIns: [sudoSignIn()] },
    });
    w.state.codeProgram = true;
    await w.service.raise(SESSION, {
      target: { kind: 'terminal', key: 'dev' },
      prompt: 'the bastion wants the 2FA code',
      sensitivity: 'code',
      submit: 'owner-default',
    });
    const request = await w.pending();
    w.state.codeProgram = false;

    const error = await refusal(w.service.deliver(SESSION, request.id, w.send(request, useCode()), OWNER));
    const after = await w.pending();

    should(error.message).containEql('Ferretry never types a code it made into one');
    should(after.fields.map(field => field.sensitivity)).eql(['secret']);
    should(w.writes).eql([]);
  });

  it('should refuse a code card to the page when the target cannot be looked at again before the write', async () => {
    const w = world(withKey());
    await w.service.raise(SESSION, CODE_RAISE);
    const request = await w.pending();
    w.state.facts = page({}, [pageField('code', { visible: false })]);

    const error = await refusal(w.service.deliver(SESSION, request.id, w.send(request, useCode()), OWNER));

    should(w.writes).eql([]);
    should(error).be.instanceOf(Error);
  });
});

describe('use it now, right after the owner saved a key', () => {
  const now = (w: ReturnType<typeof world>, request: { observedDigest?: string }, over = {}) =>
    w.service.useNow((w as unknown as { id: string }).id, {
      account: 'GITHUB',
      factor: SEEDED.id,
      observedDigest: request.observedDigest ?? '',
      actor: { kind: 'host' },
      ...over,
    } as never);

  it('should type the first code into the open code card and say it was typed', async () => {
    const w = world(withKey());
    await w.service.raise(SESSION, CODE_RAISE);
    const request = await w.pending();

    const typed = await w.service.useNow(request.id, {
      account: 'GITHUB' as never,
      factor: SEEDED.id as never,
      observedDigest: request.observedDigest ?? '',
      actor: { kind: 'device', deviceId: 'd1' } as never,
    });

    should(typed).be.true();
    should(w.writes.map(write => write.values)).eql([['123456']]);
  });

  it('should type nothing for a card that is gone, a card that is not all codes, or a card redrawn since', async () => {
    const w = world(withKey());
    await w.service.raise(SESSION, CODE_RAISE);
    const request = await w.pending();
    const use = (id: string, digest: string) =>
      w.service.useNow(id, {
        account: 'GITHUB' as never,
        factor: SEEDED.id as never,
        observedDigest: digest,
        actor: { kind: 'host' },
      });

    should(await use('f'.repeat(32), request.observedDigest ?? '')).be.false();
    should(await use(request.id, 'e'.repeat(64))).be.false();
    should(w.writes).eql([]);
    await w.service.cancel(SESSION, request.id, OWNER);
    should(await use(request.id, request.observedDigest ?? '')).be.false();

    const login = world({ facts: page(), accounts: { accounts: [account()], signIns: [site()] } });
    await login.service.raise(SESSION, {
      target: { kind: 'page', key: 'app' },
      prompt: 'login',
      fields: [
        { id: 'user', sensitivity: 'plain', element: { kind: 'selector', selector: '#u' } },
        { id: 'pass', sensitivity: 'secret', element: { kind: 'selector', selector: '#p' } },
      ],
      submit: 'owner-default',
    });
    const card = await login.pending();
    should(
      await login.service.useNow(card.id, {
        account: 'GITHUB' as never,
        factor: SEEDED.id as never,
        observedDigest: card.observedDigest ?? '',
        actor: { kind: 'host' },
      }),
    ).be.false();
    void now;
  });

  it('should say which target an open card is about, for the 2FA key set up from it, and nothing once it ended', async () => {
    const w = world(withKey());
    await w.service.raise(SESSION, CODE_RAISE);
    const request = await w.pending();

    should(w.service.cardTarget(request.id)).eql({ matchKey: 'github.com', observedDigest: request.observedDigest });
    await w.service.cancel(SESSION, request.id, OWNER);
    should(w.service.cardTarget(request.id)).be.undefined();
    should(w.service.cardTarget('f'.repeat(32))).be.undefined();
    void SIGN_IN;
  });
});

describe('a code that did not go through', () => {
  const typedCode = async (w: ReturnType<typeof world>) => {
    await w.service.raise(SESSION, CODE_RAISE);
    const request = await w.pending();
    await w.service.deliver(SESSION, request.id, w.send(request, useCode()), OWNER);
    await new Promise(resolve => setTimeout(resolve, 0));
    return request;
  };

  it('should open the card again for the owner to type the code, and tell the agent which card to wait on', async () => {
    const w = world(withKey());
    w.state.codeWorked = false;

    const first = await typedCode(w);
    const [again] = await w.service.list(OWNER, SESSION);

    should(w.codesChecked).have.length(1);
    should(again?.id).equal(first.id);
    should(again?.state).equal('pending');
    should(again?.agendaItemId).equal('A2');
    should(w.cards[1]?.ask).startWith("The saved key's code didn't go through: type the code.");
    should(w.told.at(-1)).containEql('so the owner is asked to type it on A2. Wait on A2.');
  });

  it('should leave a code that worked, or could not be told, alone', async () => {
    const worked = world(withKey());
    worked.state.codeWorked = true;
    const unknown = world(withKey());
    unknown.state.codeWorked = undefined;

    await typedCode(worked);
    await typedCode(unknown);

    should(await worked.service.list(OWNER, SESSION)).eql([]);
    should(await unknown.service.list(OWNER, SESSION)).eql([]);
  });

  it('should not let a check that failed undo the delivery', async () => {
    const w = world(withKey());
    w.state.codeWorked = new Error('the look fell over');

    await typedCode(w);

    should(await w.service.list(OWNER, SESSION)).eql([]);
  });

  it('should not ask the observer about a code that was not submitted, or at all with no observer wired', async () => {
    const unsent = world(withKey());
    unsent.state.codeWorked = false;
    await unsent.service.raise(SESSION, CODE_RAISE);
    const request = await unsent.pending();
    await unsent.service.deliver(SESSION, request.id, unsent.send(request, useCode({ submit: false })), OWNER);
    const blind = world(withKey({ withObserver: false }));

    await typedCode(blind);

    should(unsent.codesChecked).eql([]);
    should(blind.codesChecked).eql([]);
  });

  it('should only tell the agent, raising no card, when another request waits on the same target', async () => {
    const w = world(withKey());
    w.state.codeWorked = false;
    let release: () => void = () => undefined;
    w.state.codeGate = new Promise<void>(resolve => {
      release = resolve;
    });
    await w.service.raise(SESSION, CODE_RAISE);
    const request = await w.pending();
    await w.service.deliver(SESSION, request.id, w.send(request, useCode()), OWNER);
    await w.service.raise(SESSION, CODE_RAISE);
    release();
    await new Promise(resolve => setTimeout(resolve, 0));

    should(w.cards).have.length(2);
    should(w.told.at(-1)).containEql('the code Ferretry made did not go through on %browser:app');
  });

  it('should only tell the agent when the target is gone, or when the agenda takes no new card', async () => {
    const gone = world(withKey());
    gone.state.codeWorked = false;
    gone.state.onType = () => {
      gone.state.observe = () => ({ ok: false, reason: 'target_gone' });
    };
    const full = world(withKey());
    full.state.codeWorked = false;
    full.state.onType = () => {
      full.state.agendaFails = true;
    };

    await typedCode(gone);
    await typedCode(full);

    should(gone.told.at(-1)).containEql('did not go through on %browser:app');
    should(full.told.at(-1)).containEql('did not go through on %browser:app');
    should(gone.cards).have.length(1);
    should(full.cards).have.length(1);
  });

  it('should do nothing at all once the session has ended', async () => {
    const w = world(withKey());
    w.state.codeWorked = false;
    w.state.onType = () => {
      w.state.sessionEnded = true;
    };

    await typedCode(w);

    should(w.cards).have.length(1);
  });
});
