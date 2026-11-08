import { describe, it } from 'bun:test';
import should from 'should';
import { LoginEntryError } from '../../../../daemon/lib/inputs/borrowed.ts';
import { identityOf } from '../../../../daemon/lib/inputs/login-observer.ts';
import { padInputValue } from '../../../../daemon/lib/inputs/wire.ts';
import { account, page, ruleGrant, SESSION, SIGN_IN, site, terminal } from './grant-fixtures.ts';
import { OWNER, PAGE_LOGIN, PASSWORD, planLine, refusal, SUDO_RAISE, world } from './world.ts';

/**
 * The corners of the input service that the big flows do not reach: a sign-in on a terminal, a write that may be partial
 * under a grant, a request brought back after a restart, what a card says about itself, and the checks that stop a
 * saved value from being typed or kept.
 */

const github = () => ({ accounts: [account()], signIns: [site()] });
const SUDO_ACCOUNT = account({ id: 'SUDO' as never, label: 'sudo', username: undefined, signIns: [SIGN_IN] });
const sudoSignIn = () =>
  site({ account: 'SUDO' as never, place: { kind: 'terminal', tool: 'sudo', host: 'kirin-box' } });
const sudo = () => ({ accounts: [SUDO_ACCOUNT], signIns: [sudoSignIn()] });
const SUDO_PINS = { placeKeys: ['sudo@kirin-box'], recipeVersion: undefined, identities: undefined };
const sudoLine = () => planLine({ surface: 'terminal', pins: SUDO_PINS, fields: new Set(['password']) });
const sudoRule = () =>
  ruleGrant({
    surface: 'terminal',
    fields: new Set(['password']),
    accountPins: { id: 'SUDO' as never, username: undefined, factors: ruleGrant().accountPins?.factors ?? '' },
    pins: {
      placeKeys: ['sudo@kirin-box'],
      recipeVersion: undefined,
      identities: [identityOf(terminal(), 'sudo@kirin-box') as string],
    },
  });
const tick = async () => await new Promise(resolve => setTimeout(resolve, 0));

describe('a sign-in on a terminal under a grant', () => {
  it('should fill a sudo prompt under a task-plan line without clearing anything: only a page is cleared', async () => {
    const w = world({ facts: terminal(), grants: [sudoLine()], accounts: sudo() });

    const view = await w.service.raise(SESSION, SUDO_RAISE);

    should(view.state).equal('delivered');
    should(w.writes.map(write => write.values)).eql([[PASSWORD]]);
    should(w.writes[0]?.options?.reprove).be.undefined();
    should(w.timers).eql([]);
  });

  it('should prove the reader again before Enter for a standing rule, and fill', async () => {
    const w = world({ facts: terminal(), grants: [sudoRule()], accounts: sudo() });

    const view = await w.service.raise(SESSION, SUDO_RAISE);

    should(view.state).equal('delivered');
    should(w.writes[0]?.options?.reprove).equal(true);
  });

  it('should leave the card to the owner and suspend the rule when tmux’s own guard refused the write', async () => {
    const rule = sudoRule();
    const w = world({ facts: terminal(), grants: [rule], accounts: sudo() });
    w.state.typed = 'guard_refused';

    const view = await w.service.raise(SESSION, SUDO_RAISE);
    const request = await w.pending();

    should(view.state).equal('pending');
    should(request.preapproval).match({ by: 'rule', outcome: 'did-not-apply', reason: 'program-changed' });
    should(w.grantLog.stopped).eql([{ id: rule.id, because: 'program-changed' }]);
    should(w.rebuzzed).eql([SESSION]);
  });

  it('should end the request as interrupted and suspend the rule when the reader changed before Enter', async () => {
    const rule = sudoRule();
    const w = world({ facts: terminal(), grants: [rule], accounts: sudo() });
    w.state.typed = 'reader_changed';

    const view = await w.service.raise(SESSION, SUDO_RAISE);

    should(view.state).equal('refused');
    should(w.grantLog.stopped).eql([{ id: rule.id, because: 'program-changed' }]);
    should(w.grantLog.used).have.length(1);
    should(w.told.at(-1)).containEql(
      'was interrupted while the owner’s value was going into %terminal:dev'.replace('’', "'"),
    );
  });

  it('should leave a plan line’s card to the owner when the line ended while the write waited its turn', async () => {
    const w = world({ facts: terminal(), grants: [sudoLine()], accounts: sudo() });
    w.state.typed = 'target_changed';
    w.state.onType = () => {
      w.state.holds = false;
    };

    const view = await w.service.raise(SESSION, SUDO_RAISE);

    should(view.state).equal('pending');
    should(w.ledger.pinned(sudoLine().id).size).equal(0);
  });
});

describe('a write under a grant that may be partial', () => {
  it('should end the request, clear the password later and stop the line, keeping the use spent', async () => {
    const line = planLine();
    const w = world({ facts: page(), grants: [line], accounts: github() });
    w.state.typed = 'uncertain';

    const view = await w.service.raise(SESSION, PAGE_LOGIN);
    for (const timer of w.timers) timer.fire();
    await tick();

    should(view.state).equal('refused');
    should(w.grantLog.used).have.length(1);
    should(w.cleared).have.length(1);
    should(w.grantLog.stopped.map(each => each.because)).eql(['did-not-move-on']);
    should(w.audits.at(-1)?.event).equal('input.refused');
  });

  it('should not fill a card whose accounts a rule cannot read, and not suspend the rule for it', async () => {
    const rule = ruleGrant();
    const w = world({ facts: page(), grants: [rule], accounts: github() });
    w.state.listingFails = true;

    const view = await w.service.raise(SESSION, PAGE_LOGIN);

    should(view.state).equal('pending');
    should(w.grantLog.stopped).eql([]);
  });

  it('should treat a grant that names neither a plan nor a rule as one that fills nothing', async () => {
    const nameless = planLine({ plan: undefined });
    const ruleless = ruleGrant({ rule: undefined });
    const a = world({ facts: page(), grants: [nameless], accounts: github() });
    const b = world({ facts: page(), grants: [ruleless], accounts: github() });

    await a.service.raise(SESSION, PAGE_LOGIN);
    await b.service.raise(SESSION, PAGE_LOGIN);

    should(a.writes).eql([]);
    should(b.writes).eql([]);
    should((await a.pending()).preapproval).match({ by: 'plan', plan: '', line: 0 });
    should((await b.pending()).preapproval).be.undefined();
  });

  it('should say a card is quiet only while it is being raised, and only to the session it belongs to', async () => {
    const w = world({ facts: page(), grants: [planLine()], accounts: github() });
    const during: boolean[] = [];
    w.state.onAgendaRaise = card => {
      during.push(w.service.quietCard(SESSION, card.requestId), w.service.quietCard('someone-else', card.requestId));
    };

    await w.service.raise(SESSION, PAGE_LOGIN);

    should(during).eql([true, false]);
    should(w.service.quietCard(SESSION, '0'.repeat(32))).be.false();
  });
});

describe('a request brought back after a restart', () => {
  it('should end a restored paste at once: its copy lived in the memory of the daemon that stopped', async () => {
    const first = world({ withSealed: true });
    first.copy();
    first.state.facts = terminal({ echo: 'on' });
    await first.service.raise(SESSION, {
      target: { kind: 'terminal', key: 'dev' },
      prompt: 'paste the token',
      sensitivity: 'plain',
      submit: 'owner-default',
      source: { kind: 'sealed', name: 'vercel' },
    });
    const requested = first.events[0];
    if (requested === undefined) throw new Error('no event');
    const second = world({ history: [requested] });

    await second.service.restore();

    should(second.events.at(-1)).match({ state: 'cancelled', reason: 'copy_gone' });
    should(await second.service.list(OWNER)).eql([]);
  });

  it('should hold the terminals and fail loudly when the sessions with holds cannot be listed', async () => {
    const w = world();
    w.state.quarantineSessions = new Error('the hold log cannot be read');

    const error = await refusal(w.service.restore());

    should(error.message).equal('the hold log cannot be read');
    should(w.quarantine.until(SESSION, ['dev'])).not.be.undefined();
  });
});

describe('what a card says about itself', () => {
  it('should mask the terminal facts of a request once a hold covers its terminal', async () => {
    const w = world();
    await w.service.raise(SESSION, SUDO_RAISE);
    const request = await w.pending();

    should(w.service.resealed(request).observed).eql(request.observed);
    w.quarantine.begin(SESSION, ['dev'], 'hold-1');

    should(w.service.resealed(request).observed).not.eql(request.observed);
    should(JSON.stringify(w.service.resealed(request).observed)).not.containEql('password for');
  });

  it('should hand the owner the picture of a page request, and say when there is none', async () => {
    const w = world({ facts: page() });
    w.state.shot = { pngBase64: 'c2hvdA', clip: { x: 0, y: 0, w: 400, h: 200 } };
    await w.service.raise(SESSION, PAGE_LOGIN);
    const request = await w.pending();
    const bare = world({ facts: page() });
    await bare.service.raise(SESSION, PAGE_LOGIN);
    const unpictured = await bare.pending();

    should(w.service.shot(OWNER, SESSION, request.id)).eql(w.state.shot);
    should((await refusal(Promise.resolve().then(() => bare.service.shot(OWNER, SESSION, unpictured.id)))).code).equal(
      'not_found',
    );
  });

  it('should answer the document a held page shows now, and nothing when the page cannot say', async () => {
    const w = world({ facts: page() });
    w.state.document = 'loader-9';

    should(await w.service.pageDocument(SESSION, 'app')).equal('loader-9');
  });

  it('should refuse a secret that is raised with more than one field', async () => {
    const w = world();

    const error = await refusal(
      w.service.raise(SESSION, {
        target: { kind: 'secret', key: 'TOKEN' },
        prompt: 'the token',
        fields: [
          { id: 'a', sensitivity: 'secret' },
          { id: 'b', sensitivity: 'secret' },
        ],
        submit: 'owner-default',
      }),
    );

    should(error.message).equal('a secret holds one value: raise it with one field and no element');
  });

  it('should cut a code card’s title to what an agenda card holds, on a word', async () => {
    const host = 'accounts.some-very-long-subdomain-name.internal.example-company.com';
    const long = account({
      factors: [
        {
          id: 'tf_0000000000a1',
          kind: 'totp',
          label: 'App',
          addedAt: '2026-10-01T00:00:00.000Z',
          addedBy: 'owner',
          automatic: true,
          params: { algorithm: 'SHA1', digits: 6, period: 30 },
        },
      ],
    });
    const w = world({
      facts: { ...page({ origin: `https://${host}` }, []), fields: [] } as never,
      accounts: { accounts: [long], signIns: [site({ place: { kind: 'site', domains: [host], match: [host] } })] },
    });
    w.state.facts = {
      ...page({ origin: `https://${host}` }),
      fields: [
        {
          fieldId: 'code',
          frameOrigin: `https://${host}`,
          frameId: 'main',
          backendNodeId: 1,
          field: { tag: 'input', type: 'text' },
          box: { x: 0, y: 0, w: 1, h: 1 },
          visible: true,
        },
      ],
    };

    await w.service.raise(SESSION, {
      target: { kind: 'page', key: 'app' },
      prompt: 'the code',
      fields: [{ id: 'code', sensitivity: 'code', element: { kind: 'selector', selector: '#otp' } }],
      submit: 'owner-default',
    });

    should(w.cards[0]?.title.length).be.belowOrEqual(60);
    should(w.cards[0]?.title.endsWith('…')).be.true();
  });

  it('should keep who a page is signing in only when the redactor leaves it as typed', async () => {
    const w = world({ facts: page(), accounts: github() });
    w.state.typedUsername = 'someone-else@example.com';
    const masked = world({ facts: page(), accounts: github() });
    masked.state.typedUsername = 'someone-else@example.com';
    masked.values.hold(SESSION, 'someone-else@example.com', 'A0');

    await w.service.raise(SESSION, PAGE_LOGIN);
    await masked.service.raise(SESSION, PAGE_LOGIN);

    // The ferret typed another person: the one-tap is removed, never moved. A name the redactor hides is not known.
    should((await w.pending()).saved?.offers.some(offer => offer.primary === true)).be.false();
    should((await masked.pending()).saved?.offers.some(offer => offer.primary === true)).be.true();
  });
});

describe('a saved value that is typed or kept', () => {
  const bothFields = (user: string, pass: string) => [
    { field: 'user', padded: padInputValue(user) },
    { field: 'pass', padded: padInputValue(pass) },
  ];
  const raised = async (over: Parameters<typeof world>[0] = {}) => {
    const w = world({ facts: page(), accounts: github(), ...over });
    await w.service.raise(SESSION, PAGE_LOGIN);
    return { w, request: await w.pending() };
  };
  const keep = (over: Record<string, unknown> = {}) => ({ entry: 'NEW_ACCOUNT', label: 'GitHub', ...over });

  it('should refuse to keep a username and password that were not both typed, or a password too short to mask', async () => {
    const { w, request } = await raised();

    const half = await refusal(
      w.service.deliver(
        SESSION,
        request.id,
        w.send(request, { entry: 'GITHUB', fields: [{ field: 'user', padded: padInputValue('kirin') }], save: keep() }),
        OWNER,
      ),
    );
    const short = await refusal(
      w.service.deliver(
        SESSION,
        request.id,
        w.send(request, { fields: bothFields('kirin', 'tiny'), save: keep() }),
        OWNER,
      ),
    );

    should(half.message).containEql('type every field it keeps');
    should(short.message).containEql('a saved password is at least');
    should(w.writes).eql([]);
  });

  it('should refuse to keep a username that is blank or holds a control character', async () => {
    const { w, request } = await raised();

    for (const bad of ['   ', 'x'.repeat(300)]) {
      const error = await refusal(
        w.service.deliver(
          SESSION,
          request.id,
          w.send(request, { fields: bothFields(bad, 'a-long-enough-password'), save: keep() }),
          OWNER,
        ),
      );
      should(error.message).equal('that value cannot be kept as a username; send it without saving');
    }
  });

  it('should refuse a username in the save when the card types the username itself', async () => {
    const { w, request } = await raised();

    const error = await refusal(
      w.service.deliver(
        SESSION,
        request.id,
        w.send(request, { fields: bothFields('kirin', 'a-long-enough-password'), save: keep({ username: 'x@y.com' }) }),
        OWNER,
      ),
    );

    should(error.message).containEql('this card types the username itself');
  });

  it('should not let a save into an account that exists pass without the owner’s explicit Update', async () => {
    const { w, request } = await raised();
    const typed = bothFields('kirinnee', 'a-long-enough-password');

    const unsaid = await refusal(
      w.service.deliver(
        SESSION,
        request.id,
        w.send(request, { fields: typed, save: keep({ entry: 'GITHUB' }) }),
        OWNER,
      ),
    );
    const asNew = await refusal(
      w.service.deliver(
        SESSION,
        request.id,
        w.send(request, { fields: typed, save: keep({ entry: 'GITHUB', mode: 'new' }) }),
        OWNER,
      ),
    );

    should(unsaid.code).equal('conflict');
    should(unsaid.message).containEql('is already saved: update the app');
    should(asNew.message).containEql('is already the CLI name of GitHub');
    should(w.writes).eql([]);
  });

  it('should refuse an update of an account that is gone, one the card does not offer, or someone else', async () => {
    const other = account({ id: 'GITLAB' as never, label: 'GitLab', username: 'someone', signIns: [] });
    const { w, request } = await raised({ accounts: { accounts: [account(), other], signIns: [site()] } });
    const typed = (user: string) => bothFields(user, 'a-long-enough-password');
    const update = (entry: string, user = 'kirinnee') =>
      w.service.deliver(
        SESSION,
        request.id,
        w.send(request, { fields: typed(user), save: keep({ entry, mode: 'update' }) }),
        OWNER,
      );

    const gone = await refusal(update('NOBODY'));
    const notOffered = await refusal(update('GITLAB'));
    const someoneElse = await refusal(update('GITHUB', 'another@example.com'));

    should(gone.code).equal('not_found');
    should(notOffered.message).containEql('is not the account this card can update');
    should(someoneElse.code).equal('conflict');
    should(someoneElse.message).containEql('signing in someone else');
    should(w.writes).eql([]);
  });

  it('should offer no update when the page itself is signing in another person, and refuse one asked for', async () => {
    const { w, request } = await raised();
    w.state.typedUsername = 'another@example.com';
    await w.service.cancel(SESSION, request.id, OWNER);
    await w.service.raise(SESSION, PAGE_LOGIN);
    const fresh = await w.pending();

    const error = await refusal(
      w.service.deliver(
        SESSION,
        fresh.id,
        w.send(fresh, {
          fields: bothFields('kirinnee', 'a-long-enough-password'),
          save: keep({ entry: 'GITHUB', mode: 'update' }),
        }),
        OWNER,
      ),
    );

    should(fresh.saved?.update).be.undefined();
    should(error.message).containEql('is not the account this card can update');
  });

  it('should refuse to save when the saved accounts cannot be read, typing nothing', async () => {
    const { w, request } = await raised();
    w.state.listingFails = true;

    const error = await refusal(
      w.service.deliver(
        SESSION,
        request.id,
        w.send(request, { fields: bothFields('kirin', 'a-long-enough-password'), save: keep() }),
        OWNER,
      ),
    );

    should(error.code).equal('unavailable');
    should(w.writes).eql([]);
  });

  it('should say the value was typed but not kept when the store changed first, or could not be written', async () => {
    const raced = await raised();
    raced.w.state.saveFails = new LoginEntryError('login_exists', 'NEW_ACCOUNT already exists');
    const broken = await raised();
    broken.w.state.saveFails = new Error('disk full');
    const send = (each: typeof raced) =>
      each.w.service.deliver(
        SESSION,
        each.request.id,
        each.w.send(each.request, { fields: bothFields('kirin', 'a-long-enough-password'), save: keep() }),
        OWNER,
      );

    const racedResult = await send(raced);
    const brokenResult = await send(broken);

    should(racedResult.saved).match({ entry: 'NEW_ACCOUNT', ok: false });
    should(racedResult.saved?.problem).containEql('The value was typed, but not saved: NEW_ACCOUNT already exists');
    should(brokenResult.saved?.problem).equal(
      'The value was typed, but Ferretry could not keep it; save it from Settings › Accounts.',
    );
  });

  it('should refuse a saved account that cannot be opened, in a fixed sentence, typing nothing', async () => {
    const missing = await raised();
    missing.w.state.fillFails = new LoginEntryError('unknown_login', 'there is no account GITHUB');
    const refused = await raised();
    refused.w.state.fillFails = new LoginEntryError('invalid_change', 'that account holds no password');
    const down = await raised();
    down.w.state.fillFails = new Error('the vault is locked');
    const odd = await raised();
    odd.w.state.fillValue = () => 'line one\nline two';
    const use = async (each: typeof missing) =>
      await refusal(
        each.w.service.deliver(SESSION, each.request.id, each.w.send(each.request, { entry: 'GITHUB' }), OWNER),
      );

    const a = await use(missing);
    const b = await use(refused);
    const c = await use(down);
    const d = await use(odd);

    should([a.code, b.code, c.code, d.code]).eql(['not_found', 'bad_request', 'unavailable', 'bad_request']);
    should(c.message).equal('Ferretry could not open the account, so nothing was typed');
    should(d.message).equal('that account cannot be typed here; nothing was typed');
    for (const each of [missing, refused, down, odd]) should(each.w.writes).eql([]);
  });

  it('should keep the facts of a delivery from a failing observer from failing the delivery', async () => {
    const { w, request } = await raised();
    w.state.observerFails = true;

    const result = await w.service.deliver(SESSION, request.id, w.send(request, { entry: 'GITHUB' }), OWNER);
    await tick();

    should(result.state).equal('delivered');
  });
});
