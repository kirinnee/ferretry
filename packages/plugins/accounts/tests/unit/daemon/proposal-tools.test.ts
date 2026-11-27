import { describe, it } from 'bun:test';
import type { ToolHandler } from '@ferretry/kernel/manifest';
import should from 'should';
import { type TaskPlan, TaskPlanSchema } from '../../../contract/routes/index.ts';
import { LoginEntryError } from '../../../daemon/lib/accounts.ts';
import { IdentityLinkError } from '../../../daemon/lib/identity-links.ts';
import { type ProposalToolDeps, proposalTools } from '../../../daemon/lib/proposal-tools.ts';
import { RecipeValueError } from '../../../daemon/lib/secrets/login-recipes.ts';
import { SecureCopyError } from '../../../daemon/lib/secure-copy/errors.ts';
import { SignInRuleSuggestionError } from '../../../daemon/lib/sign-in-rules/suggestions.ts';
import { TaskPlanError } from '../../../daemon/lib/task-plans/service.ts';

/** The two asking tools over recording fakes: what each one tells a ferret, who may call it, and what it never says. */

const SENTINEL = 'FAKE-PROPOSE-9c41e2';
const SIGN_IN = 'si_000000000000000a';
const PROPOSAL = 'rp_0123456789abcdef';
const FERRET = { credential: { tokenClass: 'ferret', ferret: 'F1' } } as never;
const PERSON = { credential: { tokenClass: 'admin' } } as never;

const PLAN: TaskPlan = TaskPlanSchema.parse({
  v: 1,
  id: 'a'.repeat(32),
  sessionId: 'F1',
  agendaItemId: 'A193',
  lines: [
    {
      kind: 'paste',
      line: 0,
      uses: 1,
      why: 'the deploy token',
      state: 'waiting',
      from: { kind: 'command', program: 'gh' },
      to: { kind: 'terminal', program: 'vercel' },
    },
  ],
  state: 'pending',
  raisedAt: '2026-11-01T14:00:00.000Z',
  expiresAt: '2026-11-01T16:00:00.000Z',
});

interface Options {
  readonly proposed?: 'pending' | 'applied';
  readonly recipeError?: unknown;
  readonly suggestError?: unknown;
  readonly planError?: unknown;
  readonly linksError?: unknown;
  readonly linkFiled?: 'pending' | 'known';
  readonly noLinks?: boolean;
  readonly redact?: (text: string) => Promise<string>;
}

function world(options: Options = {}) {
  const seen = {
    recipes: [] as unknown[][],
    suggestions: [] as unknown[][],
    plans: [] as unknown[][],
    links: [] as unknown[],
  };
  const deps: ProposalToolDeps = {
    recipes: {
      propose: async (...args) => {
        seen.recipes.push(args);
        if (options.recipeError !== undefined) throw options.recipeError;
        return {
          id: PROPOSAL,
          login: 'GITHUB_A',
          signIn: SIGN_IN,
          state: options.proposed ?? 'pending',
          ...((options.proposed ?? 'pending') === 'pending' ? { agendaItemId: 'A7' } : {}),
        } as never;
      },
    },
    suggestions: {
      suggest: async (...args) => {
        seen.suggestions.push(args);
        if (options.suggestError !== undefined) throw options.suggestError;
        return { signIn: SIGN_IN, host: 'github.com', agenda: 'A8' } as never;
      },
    },
    ...(options.noLinks === true
      ? {}
      : {
          links: {
            propose: async ask => {
              seen.links.push(ask);
              if (options.linksError !== undefined) throw options.linksError;
              return options.linkFiled ?? 'pending';
            },
          },
        }),
    plans: {
      propose: async (...args) => {
        seen.plans.push(args);
        if (options.planError !== undefined) throw options.planError;
        return PLAN;
      },
    },
    redact: options.redact ?? (async text => text),
  };
  const tools = proposalTools(deps);
  const run = async (tool: ToolHandler, input: unknown, caller: never = FERRET) => await tool(caller, input as never);
  return { tools, seen, run };
}

const PROPOSE = { signIn: SIGN_IN, recipe: '1. Open the page.\n2. Press sign in.', why: 'the button moved' };

describe('account_propose', () => {
  it('should file a recipe on the sign-in as the calling ferret and say the owner decides, without waiting', async () => {
    const { tools, seen, run } = world();

    const answer = await run(tools.account_propose, PROPOSE);

    should(answer.isError).not.equal(true);
    should(seen.recipes).eql([['F1', { signIn: SIGN_IN }, PROPOSE.recipe, PROPOSE.why]]);
    should(seen.suggestions).eql([]);
    should(answer.text)
      .containEql('Proposed a recipe')
      .and.containEql('(^A7)')
      .and.containEql('You do not need to wait');
    should(answer.data).eql({ recipe: { id: PROPOSAL, login: 'GITHUB_A', state: 'pending', agendaItemId: 'A7' } });
  });

  it('should say a recipe was updated at once when the owner allows that for the sign-in', async () => {
    const { tools, run } = world({ proposed: 'applied' });

    const answer = await run(tools.account_propose, PROPOSE);

    should(answer.text).containEql('was updated').and.not.containEql('(!');
    should((answer.data as { recipe: { state: string } }).recipe.state).equal('applied');
  });

  it('should only suggest a standing rule when asked to preapprove alone, filing no recipe', async () => {
    const { tools, seen, run } = world();

    const answer = await run(tools.account_propose, { signIn: SIGN_IN, preapprove: true, why: 'every deploy' });

    should(seen.recipes).eql([]);
    should(seen.suggestions).eql([['F1', { signIn: SIGN_IN, why: 'every deploy' }]]);
    should(answer.isError).not.equal(true);
    should(answer.text)
      .containEql('Suggested a standing rule for github.com (^A8)')
      .and.containEql('you will not hear back');
    should(answer.data).eql({});
  });

  it('should do both when a recipe and preapprove come together, and say both', async () => {
    const { tools, seen, run } = world();

    const answer = await run(tools.account_propose, { ...PROPOSE, preapprove: true });

    should(seen.recipes).have.length(1);
    should(seen.suggestions).have.length(1);
    should(answer.text).containEql('Proposed a recipe').and.containEql('Suggested a standing rule');
  });

  it('should refuse a call that asks for neither a recipe nor a rule, naming the field', async () => {
    const { tools, seen, run } = world();

    const answer = await run(tools.account_propose, { signIn: SIGN_IN, why: 'nothing' });

    should(answer.isError).equal(true);
    should(answer.text).containEql('recipe: suggest a recipe, a standing rule');
    should(seen.recipes).eql([]);
  });

  it('should hold "S lives in I" for the owner when only an identity is named, filing no recipe and no rule', async () => {
    const { tools, seen, run } = world();

    const answer = await run(tools.account_propose, {
      signIn: SIGN_IN,
      identity: 'work',
      why: 'the login lives there',
    });

    should(answer.isError).not.equal(true);
    should(seen.links).eql([{ signIn: SIGN_IN, identity: 'work', why: 'the login lives there' }]);
    should(seen.recipes).eql([]);
    should(seen.suggestions).eql([]);
    should(answer.text).containEql(`[${SIGN_IN}] lives in browser identity 'work'`).and.containEql('the owner decides');
  });

  it('should say an edge the graph already holds is known, and say both when a recipe comes with it', async () => {
    const known = world({ linkFiled: 'known' });
    should(
      (await known.run(known.tools.account_propose, { signIn: SIGN_IN, identity: 'work', why: 'x' })).text,
    ).containEql('already known to live in browser identity');

    const both = world();
    const answer = await both.run(both.tools.account_propose, { ...PROPOSE, identity: 'work' });
    should(answer.text).containEql('Proposed a recipe').and.containEql('lives in browser identity');
    should(both.seen.links).have.length(1);
  });

  it('should refuse an identity key that could leave the profile folder, naming the field, and touch nothing', async () => {
    const { tools, seen, run } = world();
    const answer = await run(tools.account_propose, { signIn: SIGN_IN, identity: '../agent', why: 'x' });
    should(answer.isError).equal(true);
    should(answer.text).startWith('identity:');
    should(seen.links).eql([]);
  });

  it('should tell a refusal of the identity proposal as its own sentence, and a failure it does not own as the fixed one', async () => {
    const refused = world({
      linksError: new IdentityLinkError('not_found', 'Name a sign-in that account_hint lists.'),
    });
    const said = await refused.run(refused.tools.account_propose, { signIn: SIGN_IN, identity: 'work', why: 'x' });
    should(said).match({ isError: true, text: 'Name a sign-in that account_hint lists.' });

    const broken = world({ linksError: new Error('ENOENT /home/someone/secret-path') });
    const fixed = await broken.run(broken.tools.account_propose, { signIn: SIGN_IN, identity: 'work', why: 'x' });
    should(fixed.isError).equal(true);
    should(fixed.text).not.containEql('ENOENT');

    const none = world({ noLinks: true });
    should((await none.run(none.tools.account_propose, { signIn: SIGN_IN, identity: 'work', why: 'x' })).isError).equal(
      true,
    );
  });

  it('should refuse a call that is not an object the schema takes, as a sentence', async () => {
    const { tools, run } = world();

    const answer = await run(tools.account_propose, undefined);

    should(answer.isError).equal(true);
    should(answer.text).containEql('signIn');
  });

  it('should refuse a call that is not a ferret’s, and touch no service', async () => {
    const { tools, seen, run } = world();

    const answer = await run(tools.account_propose, PROPOSE, PERSON);

    should(answer.isError).equal(true);
    should(answer.text).containEql('Only an agent');
    should([seen.recipes, seen.suggestions]).eql([[], []]);
  });

  it('should say a refused recipe in the service’s own words, whether the sign-in is unknown or the recipe holds a value', async () => {
    for (const error of [
      new LoginEntryError('unknown_sign_in', 'no such sign-in'),
      new RecipeValueError('a recipe never holds a value'),
    ]) {
      const { tools, run } = world({ recipeError: error });

      const answer = await run(tools.account_propose, PROPOSE);

      should(answer.isError).equal(true);
      should(answer.text).equal(error.message);
    }
  });

  it('should never quote an error it does not own: a recipe that fails for another reason is a fixed sentence', async () => {
    const { tools, run } = world({ recipeError: new Error(`the store said ${SENTINEL}`) });

    const answer = await run(tools.account_propose, PROPOSE);

    should(answer.isError).equal(true);
    should(answer.text).equal('The recipe could not be filed right now; try again later.');
    should(JSON.stringify(answer)).not.containEql(SENTINEL);
  });

  it('should fail a suggestion made on its own with the refusal, and the fixed sentence when it is not ours', async () => {
    const ours = world({
      suggestError: new SignInRuleSuggestionError('bad_request', 'No standing rule can cover this.'),
    });
    const refused = await ours.run(ours.tools.account_propose, { signIn: SIGN_IN, preapprove: true, why: 'x' });
    should(refused.isError).equal(true);
    should(refused.text).equal('No standing rule can cover this.');

    const other = world({ suggestError: new Error(`boom ${SENTINEL}`) });
    const failed = await other.run(other.tools.account_propose, { signIn: SIGN_IN, preapprove: true, why: 'x' });
    should(failed.isError).equal(true);
    should(failed.text).equal('The suggestion could not be raised right now; try again later.');
    should(JSON.stringify(failed)).not.containEql(SENTINEL);
  });

  it('should not report a filed recipe as failed when only the suggestion beside it is refused', async () => {
    const ours = world({ suggestError: new SignInRuleSuggestionError('capacity', 'You asked three times this hour.') });
    const refused = await ours.run(ours.tools.account_propose, { ...PROPOSE, preapprove: true });
    should(refused.isError).not.equal(true);
    should(refused.text).containEql('Proposed a recipe').and.containEql('No rule was suggested: You asked three times');
    should(refused.data).have.property('recipe');

    const other = world({ suggestError: new Error(`boom ${SENTINEL}`) });
    const failed = await other.run(other.tools.account_propose, { ...PROPOSE, preapprove: true });
    should(failed.isError).not.equal(true);
    should(failed.text).containEql('Proposed a recipe').and.containEql('The suggestion could not be raised right now.');
    should(JSON.stringify(failed)).not.containEql(SENTINEL);
  });

  it('should mask every word through the redactor, and say nothing at all when the redactor cannot run', async () => {
    const masking = world({ redact: async text => text.replaceAll('github.com', '[masked]') });
    const masked = await masking.run(masking.tools.account_propose, { signIn: SIGN_IN, preapprove: true, why: 'x' });
    should(masked.text).containEql('[masked]').and.not.containEql('github.com');

    const broken = world({
      redact: async () => {
        throw new Error(SENTINEL);
      },
    });
    const refused = await broken.run(broken.tools.account_propose, PROPOSE);
    should(refused.isError).equal(true);
    should(refused.text).equal('The owner could not be asked right now; nothing was changed.');
    should(JSON.stringify(refused)).not.containEql(SENTINEL);
  });
});

describe('signin_plan', () => {
  const CALL = {
    lines: [
      {
        kind: 'paste',
        from: { kind: 'command', program: 'gh' },
        to: { kind: 'terminal', program: 'vercel' },
        why: 'deploy',
      },
    ],
  };

  it('should raise the plan as the calling ferret and tell it only its own view of the plan', async () => {
    const { tools, seen, run } = world();

    const answer = await run(tools.signin_plan, CALL);

    should(answer.isError).not.equal(true);
    should(seen.plans).eql([['F1', CALL]]);
    should(answer.text).containEql('Asked the owner to approve 1 line in advance (^A193)');
    should(answer.data).eql({
      taskPlan: {
        id: PLAN.id,
        agendaItemId: 'A193',
        state: 'pending',
        expiresAt: PLAN.expiresAt,
        lines: [{ line: 0, state: 'waiting' }],
      },
    });
  });

  it('should answer the same under its old name task_plan, on the same handler', async () => {
    const named = world();
    const asked = await named.run(named.tools.signin_plan, CALL);
    const old = world();
    const answered = await old.run(old.tools.task_plan, CALL);

    should(old.tools.task_plan).equal(old.tools.signin_plan);
    should(answered).eql(asked);
    should(old.seen.plans).eql(named.seen.plans);
  });

  it('should hand the service an empty call when none is given, so its own schema refuses it', async () => {
    const { tools, seen, run } = world();

    await run(tools.signin_plan, undefined);

    should(seen.plans).eql([['F1', {}]]);
  });

  it('should refuse a call that is not a ferret’s, and raise nothing', async () => {
    const { tools, seen, run } = world();

    const answer = await run(tools.signin_plan, CALL, PERSON);

    should(answer.isError).equal(true);
    should(answer.text).containEql('Only an agent');
    should(seen.plans).eql([]);
  });

  it('should say a refused plan in the service’s own words, for either error it owns', async () => {
    for (const error of [
      new SecureCopyError('capacity', 'three plans are waiting; wait for the owner'),
      new TaskPlanError(409, 'passkey_required', 'a passkey is needed'),
    ]) {
      const { tools, run } = world({ planError: error });

      const answer = await run(tools.signin_plan, CALL);

      should(answer.isError).equal(true);
      should(answer.text).equal(error.message);
    }
  });

  it('should never quote an error it does not own', async () => {
    const { tools, run } = world({ planError: new Error(`agenda said ${SENTINEL}`) });

    const answer = await run(tools.signin_plan, CALL);

    should(answer.isError).equal(true);
    should(answer.text).equal('The owner could not be asked right now; nothing was changed.');
    should(JSON.stringify(answer)).not.containEql(SENTINEL);
  });

  it('should mask the answer through the redactor', async () => {
    const { tools, run } = world({ redact: async text => text.replaceAll('A193', '[card]') });

    const answer = await run(tools.signin_plan, CALL);

    should(answer.text).containEql('(^[card])').and.not.containEql('A193');
  });
});
