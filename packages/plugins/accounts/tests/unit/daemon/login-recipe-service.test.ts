/**
 * LOGIN RECIPES AS POLICY (`secrets/login-recipes.ts`): a recipe never holds a value, a proposal is a ferret's words filed
 * on one sign-in and waits on the owner (or applies at once only where the owner turned auto-apply on), and every recipe
 * the daemon serves is masked again on the way out.
 */

import { describe, it } from 'bun:test';
import should from 'should';
import type { LoginRecipeProposal, SignInSummary } from '../../../contract/routes/index.ts';
import { LoginRecipeService, type RecipeAgendaPort } from '../../../daemon/lib/secrets/login-recipes.ts';
import { list } from '../../support/app/accounts-fixtures.ts';

const SECRET = 'hunter2-api-token';
const GITHUB_SIGN_IN = 'si_0000000000000001';
const WORK_SIGN_IN = 'si_0000000000000002';
const NOW = '2026-11-01T09:00:00.000Z';
const CURRENT = '# Sign in\nClick Sign in.';

const baseListing = list();
const fixture = baseListing.signIns.find(each => each.id === GITHUB_SIGN_IN);
if (fixture === undefined) throw new Error('the fixture has a GitHub sign-in');
/** The GitHub sign-in with no recipe, proposals or facts of its own: each case adds what it needs. */
const {
  recipe: _recipe,
  recipeVersion: _version,
  recipeBy: _by,
  proposals: _proposals,
  observed: _observed,
  ...github
} = fixture;
const withRecipe = (extra: Partial<SignInSummary>): SignInSummary => ({ ...github, recipe: CURRENT, ...extra });

function world(
  options: {
    signIns?: SignInSummary[];
    applied?: boolean;
    dropped?: LoginRecipeProposal[];
    redactFails?: boolean;
    cardFails?: boolean;
    cardRefused?: boolean;
    auditFails?: boolean;
    closeFails?: boolean;
  } = {},
) {
  const signIns = options.signIns ?? [withRecipe({})];
  const calls = {
    filed: [] as LoginRecipeProposal[],
    cards: [] as Parameters<RecipeAgendaPort['raise']>[1][],
    closed: [] as string[],
    linked: [] as string[],
    audit: [] as unknown[],
    refused: [] as string[],
  };
  const service = new LoginRecipeService({
    accounts: {
      list: async () => ({ accounts: baseListing.accounts, signIns }),
      proposeSignIn: async (_id, proposal) => {
        calls.filed.push(proposal);
        return { applied: options.applied === true, dropped: options.dropped ?? [] };
      },
      proposalCardSignIn: async (_id, _proposal, card) => {
        calls.linked.push(card);
        if (options.cardFails === true) throw new Error('the store is busy');
      },
      decideSignIn: async (id, proposalId, decision) => {
        const proposal = signIns.find(each => each.id === id)?.proposals?.find(each => each.id === proposalId);
        if (proposal === undefined) throw new Error('no such proposal');
        calls.closed.push(`decided ${decision}`);
        return { signIn: signIns.find(each => each.id === id) as SignInSummary, proposal };
      },
    },
    refuse: (refusal, words) => {
      calls.refused.push(refusal);
      return new Error(`${refusal}: ${words}`);
    },
    values: {
      redact: async text => {
        if (options.redactFails === true) throw new Error('the vault is locked');
        return text.replaceAll(SECRET, '[redacted]');
      },
    },
    agenda: {
      raise: async (_session, card) => {
        calls.cards.push(card);
        return options.cardRefused === true ? { ok: false, message: 'Asks is paused' } : { ok: true, id: 'ask-1' };
      },
      close: async (_session, id, note) => {
        calls.closed.push(`${id}: ${note}`);
        if (options.closeFails === true) throw new Error('Asks is paused');
      },
    },
    audit: {
      record: async entry => {
        calls.audit.push(entry);
        if (options.auditFails === true) throw new Error('the audit log is full');
      },
    },
    clock: { now: () => NOW },
    newId: () => 'rp_0000000000000009',
  });
  return { service, calls };
}

const proposal = (extra: Partial<LoginRecipeProposal> = {}): LoginRecipeProposal => ({
  id: 'rp_0000000000000001',
  recipe: 'new steps',
  base: CURRENT,
  why: 'the button moved',
  sessionId: 'session-1',
  proposedAt: NOW,
  ...extra,
});

describe('a recipe never holds a value', () => {
  it('should pass a recipe the redactor leaves alone', async () => {
    await world().service.assertNoValue('Click Sign in.');
  });

  it('should refuse a recipe the redactor changes, without saying the value', async () => {
    const refused = await world()
      .service.assertNoValue(`Type ${SECRET} then click Sign in.`)
      .catch((error: unknown) => error as Error);

    should(refused.message).equal(
      'a recipe never holds a value, and this one contains a saved or secret value; take it out',
    );
    should(refused.message).not.containEql(SECRET);
  });

  it('should refuse, failing closed, when the redactor cannot run', async () => {
    const refused = await world({ redactFails: true })
      .service.assertNoValue('Click Sign in.')
      .catch((error: unknown) => error as Error);

    should(refused.message).equal('Ferretry could not check the recipe for values, so it was not kept');
  });
});

describe('naming the sign-in a proposal is for', () => {
  it('should find the sign-in and its account', async () => {
    const found = await world().service.resolve({ signIn: GITHUB_SIGN_IN });

    should(found.signIn.id).equal(GITHUB_SIGN_IN);
    should(found.account.id).equal('GITHUB');
  });

  it('should refuse a sign-in that does not exist, and a selector that names more than a sign-in', async () => {
    const w = world();

    const unknown = await w.service
      .resolve({ signIn: 'si_00000000000000ff' })
      .catch((error: unknown) => error as Error);
    const extra = await w.service
      .resolve({ signIn: GITHUB_SIGN_IN, account: 'GITHUB' } as never)
      .catch((error: unknown) => error as Error);

    should(unknown.message).equal('unknown_sign_in: Name a sign-in; account_hint lists them.');
    should(extra.message).equal('unknown_sign_in: Name a sign-in; account_hint lists them.');
    should(w.calls.refused).eql(['unknown_sign_in', 'unknown_sign_in']);
  });
});

describe('a ferret proposing steps', () => {
  it('should file the proposal on the sign-in against the recipe it was made for, and raise one ask for the owner', async () => {
    const w = world();

    const answer = await w.service.propose(
      'session-1',
      { signIn: GITHUB_SIGN_IN },
      'Click Continue.',
      'the button moved',
    );

    should(answer).eql({
      id: 'rp_0000000000000009',
      login: 'GITHUB',
      signIn: GITHUB_SIGN_IN,
      state: 'pending',
      agendaItemId: 'ask-1',
    });
    should(w.calls.filed[0]).eql({
      id: 'rp_0000000000000009',
      recipe: 'Click Continue.',
      base: CURRENT,
      why: 'the button moved',
      sessionId: 'session-1',
      proposedAt: NOW,
    });
    should(w.calls.cards[0]).match({
      sourceRef: 'rp_0000000000000009',
      signIn: GITHUB_SIGN_IN,
      subject: 'Recipe change on github.com',
    });
    should(w.calls.cards[0]?.context).equal(
      '- # Sign in\n- Click Sign in.\n+ Click Continue.\n\nThe ferret says: the button moved',
    );
    should(w.calls.cards[0]?.howToResolve).containEql(
      `fy account site recipe approve ${GITHUB_SIGN_IN} rp_0000000000000009`,
    );
    should(w.calls.cards[0]?.howToResolve).containEql(`on the account's github.com › Recipe`);
    should(w.calls.linked).eql(['ask-1']);
    should(w.calls.audit).eql([]);
  });

  it('should file a first recipe with no base, and say there are no line changes when the text is the same', async () => {
    const first = world({ signIns: [withRecipe({ recipe: undefined })] });
    const same = world();

    await first.service.propose('session-1', { signIn: GITHUB_SIGN_IN }, 'First steps.', 'none yet');
    await same.service.propose('session-1', { signIn: GITHUB_SIGN_IN }, CURRENT, 'it still works');

    should(first.calls.filed[0]).not.have.property('base');
    should(first.calls.cards[0]?.context).equal('+ First steps.\n\nThe ferret says: none yet');
    should(same.calls.cards[0]?.context).equal('No line changes.\n\nThe ferret says: it still works');
  });

  it('should cut a long diff to fit the card, saying how many changed lines are left out', async () => {
    const w = world();
    const long = Array.from({ length: 60 }, (_, index) => `Step ${String(index)}: ${'x'.repeat(60)}`).join('\n');

    await w.service.propose('session-1', { signIn: GITHUB_SIGN_IN }, long, 'rewrote it');

    const context = w.calls.cards[0]?.context ?? '';
    should(context.length).be.belowOrEqual(2_048);
    should(context).match(/… \d+ more changed line\(s\): see the whole diff in Settings/u);
  });

  it('should name a terminal sign-in by its program and host, and a bare site by its match host', async () => {
    const terminal = world({
      signIns: [withRecipe({ id: WORK_SIGN_IN, place: { kind: 'terminal', tool: 'sudo', host: 'kirin-box' } })],
    });
    const matchOnly = world({
      signIns: [withRecipe({ place: { kind: 'site', domains: [], match: ['app.vercel.com'] } })],
    });

    await terminal.service.propose('session-1', { signIn: WORK_SIGN_IN }, 'Type it.', 'why');
    await matchOnly.service.propose('session-1', { signIn: GITHUB_SIGN_IN }, 'Type it.', 'why');

    should(terminal.calls.cards[0]?.howToResolve).containEql(`on the account's sudo@kirin-box › Recipe`);
    should(matchOnly.calls.cards[0]?.howToResolve).containEql(`on the account's app.vercel.com › Recipe`);
    should(matchOnly.calls.cards[0]?.subject).equal('Recipe change for app.vercel.com');
  });

  it('should still answer pending when Asks refuses the card, and when the card cannot be linked to the proposal', async () => {
    const refused = world({ cardRefused: true });
    const unlinked = world({ cardFails: true });

    const noCard = await refused.service.propose('session-1', { signIn: GITHUB_SIGN_IN }, 'Steps.', 'why');
    const noLink = await unlinked.service.propose('session-1', { signIn: GITHUB_SIGN_IN }, 'Steps.', 'why');

    should(noCard).eql({ id: 'rp_0000000000000009', login: 'GITHUB', signIn: GITHUB_SIGN_IN, state: 'pending' });
    should(noLink.agendaItemId).equal('ask-1');
  });

  it('should apply at once, and audit it, where the owner turned auto-apply on: no ask is raised', async () => {
    const w = world({ applied: true });

    const answer = await w.service.propose('session-1', { signIn: GITHUB_SIGN_IN }, 'Steps.', 'why');

    should(answer.state).equal('applied');
    should(w.calls.cards).eql([]);
    should(w.calls.audit).eql([
      {
        event: 'secrets.changed',
        actor: { kind: 'host' },
        subject: 'GITHUB',
        outcome: 'succeeded',
        detail: {
          action: 'login-recipe-auto',
          proposal: 'rp_0000000000000009',
          session: 'session-1',
          signIn: GITHUB_SIGN_IN,
          by: 'agent',
        },
      },
    ]);
  });

  it('should not let a failed audit write undo an applied proposal', async () => {
    const w = world({ applied: true, auditFails: true });

    should((await w.service.propose('session-1', { signIn: GITHUB_SIGN_IN }, 'Steps.', 'why')).state).equal('applied');
  });

  it('should close the ask of each proposal that was pushed out by a newer one, and ignore one that had none', async () => {
    const w = world({
      dropped: [
        proposal({ id: 'rp_0000000000000002', agendaItemId: 'ask-old' }),
        proposal({ id: 'rp_0000000000000003' }),
      ],
      closeFails: true,
    });

    await w.service.propose('session-1', { signIn: GITHUB_SIGN_IN }, 'Steps.', 'why');

    should(w.calls.closed).eql(['ask-old: Replaced by a newer recipe proposal.']);
  });

  it('should refuse a proposal or a reason that holds a value, and file nothing', async () => {
    const recipe = world();
    const reason = world();

    const inRecipe = await recipe.service
      .propose('session-1', { signIn: GITHUB_SIGN_IN }, `Type ${SECRET}.`, 'why')
      .catch((error: unknown) => error as Error);
    const inReason = await reason.service
      .propose('session-1', { signIn: GITHUB_SIGN_IN }, 'Steps.', `because ${SECRET}`)
      .catch((error: unknown) => error as Error);

    should(inRecipe.message).containEql('never holds a value');
    should(inReason.message).containEql('never holds a value');
    should(recipe.calls.filed).eql([]);
    should(reason.calls.filed).eql([]);
  });

  it('should show a fixed sentence on the ask when the current recipe cannot be masked for it', async () => {
    const w = world();
    let calls = 0;
    const flaky = new LoginRecipeService({
      accounts: {
        list: async () => ({ accounts: baseListing.accounts, signIns: [withRecipe({})] }),
        proposeSignIn: async () => ({ applied: false, dropped: [] }),
        proposalCardSignIn: async () => undefined,
        decideSignIn: async () => Promise.reject(new Error('unused')),
      },
      refuse: (_refusal, words) => new Error(words),
      // The two value checks pass; masking the card's own text is what fails.
      values: {
        redact: async text => {
          calls += 1;
          if (calls > 2) throw new Error('the vault is locked');
          return text;
        },
      },
      agenda: {
        raise: async (_session, card) => {
          w.calls.cards.push(card);
          return { ok: true, id: 'ask-1' };
        },
        close: async () => undefined,
      },
      audit: { record: async () => undefined },
      clock: { now: () => NOW },
    });

    const answer = await flaky.propose('session-1', { signIn: GITHUB_SIGN_IN }, 'Steps.', 'why');

    should(w.calls.cards[0]?.context).equal('The change could not be shown here; see it in Settings.');
    should(answer.id).match(/^rp_[0-9a-f]{16}$/u);
  });
});

describe('a listing as it may be served', () => {
  it('should mask every recipe, proposal and reason again now, keeping the version and who wrote the recipe', async () => {
    const w = world();
    const waiting = proposal({ recipe: `type ${SECRET}`, base: `old ${SECRET}`, why: `because ${SECRET}` });
    const served = await w.service.scrubbedAccounts({
      accounts: baseListing.accounts,
      signIns: [
        withRecipe({ recipe: `Use ${SECRET}.`, recipeVersion: 3, recipeBy: 'ferret', proposals: [waiting] }),
        { ...github, id: WORK_SIGN_IN },
      ],
    });

    const [one, two] = served.signIns;
    should(one).match({ recipe: 'Use [redacted].', recipeVersion: 3, recipeBy: 'ferret' });
    should(one?.proposals?.[0]).match({ recipe: 'type [redacted]', base: 'old [redacted]', why: 'because [redacted]' });
    should(JSON.stringify(served)).not.containEql(SECRET);
    should(two?.id).equal(WORK_SIGN_IN);
    should(two).not.have.property('recipe');
  });

  it('should leave a proposal with no base without one, and a sign-in with no recipe or proposals untouched', async () => {
    const w = world();
    const bare: SignInSummary = { ...github };
    const { base: _base, ...noBase } = proposal();

    const served = await w.service.scrubbedAccounts({
      accounts: baseListing.accounts,
      signIns: [bare, { ...github, proposals: [noBase] }],
    });

    should(served.signIns[0]).equal(bare);
    should(served.signIns[1]?.proposals?.[0]).not.have.property('base');
  });

  it('should drop every recipe and proposal, failing closed, when the redactor cannot run', async () => {
    const w = world({ redactFails: true });

    const served = await w.service.scrubbedAccounts({
      accounts: baseListing.accounts,
      signIns: [withRecipe({ recipeVersion: 2, recipeBy: 'ferret', proposals: [proposal()] })],
    });

    const [one] = served.signIns;
    should(one).not.have.property('recipe');
    should(one).not.have.property('recipeVersion');
    should(one).not.have.property('proposals');
    should(one?.id).equal(GITHUB_SIGN_IN);
  });
});

describe('the owner answering a proposal', () => {
  const waiting = proposal({ agendaItemId: 'ask-1' });
  const withWaiting = () => world({ signIns: [withRecipe({ proposals: [waiting] })] });

  it('should close the proposal’s ask as approved, and serve the sign-in masked', async () => {
    const w = withWaiting();

    const signIn = await w.service.decideSignIn(GITHUB_SIGN_IN, waiting.id, 'approve');

    should(signIn.id).equal(GITHUB_SIGN_IN);
    should(w.calls.closed).eql(['decided approve', 'ask-1: Approved: the recipe was updated.']);
  });

  it('should close the ask as declined, and check no value on a decline', async () => {
    const w = world({
      signIns: [withRecipe({ proposals: [proposal({ agendaItemId: 'ask-1', recipe: `type ${SECRET}` })] })],
    });

    await w.service.decideSignIn(GITHUB_SIGN_IN, waiting.id, 'decline');

    should(w.calls.closed).eql(['decided decline', 'ask-1: Declined.']);
  });

  it('should refuse to approve a recipe that has come to hold a value since it was proposed, and answer nothing', async () => {
    const w = world({
      signIns: [withRecipe({ proposals: [proposal({ agendaItemId: 'ask-1', recipe: `type ${SECRET}` })] })],
    });

    const refused = await w.service
      .decideSignIn(GITHUB_SIGN_IN, waiting.id, 'approve')
      .catch((error: unknown) => error as Error);

    should(refused.message).containEql('never holds a value');
    should(w.calls.closed).eql([]);
  });

  it('should close nothing for a proposal that never had an ask, and not fail when Asks cannot close it', async () => {
    const quiet = world({ signIns: [withRecipe({ proposals: [proposal()] })] });
    const failing = world({ signIns: [withRecipe({ proposals: [waiting] })], closeFails: true });

    await quiet.service.decideSignIn(GITHUB_SIGN_IN, waiting.id, 'approve');
    await failing.service.decideSignIn(GITHUB_SIGN_IN, waiting.id, 'approve');

    should(quiet.calls.closed).eql(['decided approve']);
    should(failing.calls.closed).eql(['decided approve', 'ask-1: Approved: the recipe was updated.']);
  });

  it('should go on to the answer when the proposal it is checking is not on the list any more', async () => {
    const w = withWaiting();

    await should(w.service.decideSignIn(GITHUB_SIGN_IN, 'rp_00000000000000ff', 'approve')).be.rejectedWith(
      'no such proposal',
    );
  });
});
