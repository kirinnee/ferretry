import { describe, it } from 'bun:test';
import type { SignInId } from '@ferretry/protocol';
import should from 'should';
import { LoginEntryError } from '../../../src/lib/secrets/accounts.ts';
import { LoginRecipeService } from '../../../src/lib/secrets/login-recipes.ts';
import { proposalTarget } from '../../../src/lib/secrets/proposal-target.ts';
import { SignInRuleSuggestionError, SignInRuleSuggestions } from '../../../src/lib/sign-in-rules/index.ts';
import { GITHUB, listing, NOW } from '../sign-in-rules/support.ts';

/**
 * ONE ANSWER FOR ONE `account.propose` (audit C64): the recipe half and the standing-rule half resolve the sign-in with
 * the same decision, so a ferret reads the same code and words for "no such sign-in" whichever half it used.
 */

describe('which sign-in an account.propose call is about', () => {
  it('should find the named sign-in', () => {
    should(proposalTarget(listing(), GITHUB)).match({ ok: true, signIn: { id: GITHUB } });
  });

  it('should give a miss one refusal, one code and one sentence, naming no label or username', () => {
    const miss = proposalTarget(listing(), 'si_00000000000000ff' as SignInId);

    should(miss.ok ? 'ok' : `${miss.refusal}/${miss.code}`).equal('unknown_sign_in/not_found');
    should(JSON.stringify(miss)).not.containEql('GitHub work');
  });

  it('should refuse the recipe half and the suggestion half with the same words', async () => {
    const recipes = new LoginRecipeService({
      accounts: { list: async () => listing() },
    } as never);
    const suggestions = new SignInRuleSuggestions({
      accounts: { listing: async () => listing() },
      agenda: { raise: async () => ({ ok: true, id: 'A1' }), close: async () => undefined },
      redact: async text => text,
      audit: { record: async () => undefined },
      clock: { now: () => NOW },
    });
    const signIn = 'si_00000000000000ff' as SignInId;

    const recipe = (await recipes.resolve(signIn).catch((error: unknown) => error)) as LoginEntryError;
    const rule = (await suggestions
      .suggest('s-one', { signIn, why: 'daily' })
      .catch((error: unknown) => error)) as SignInRuleSuggestionError;

    should(recipe).be.instanceOf(LoginEntryError);
    should(rule).be.instanceOf(SignInRuleSuggestionError);
    should(rule.message).equal(recipe.message);
  });
});
