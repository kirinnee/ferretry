import { describe, it } from 'bun:test';
import type { AccountId } from '@ferretry/protocol';
import should from 'should';
import { LoginEntryError } from '../../../src/lib/secrets/accounts.ts';
import { LoginRecipeService } from '../../../src/lib/secrets/login-recipes.ts';
import { proposalTarget } from '../../../src/lib/secrets/proposal-target.ts';
import { SignInRuleSuggestionError, SignInRuleSuggestions } from '../../../src/lib/sign-in-rules/index.ts';
import { GITHUB, listing, NOW } from '../sign-in-rules/support.ts';

/**
 * ONE ANSWER FOR ONE `account.propose` (audit C64): the recipe half and the standing-rule half resolve the sign-in with
 * the same decision, so a ferret reads the same code and words for "no such sign-in", "no such account", "signs in
 * nowhere" and "signs in at several places" whichever half it used.
 */

const withNowhere = () => {
  const all = listing();
  all.accounts.push({ ...all.accounts[0], id: 'NOWHERE' as AccountId, label: 'Nowhere' } as never);
  return all;
};

describe('which sign-in an account.propose call is about', () => {
  it('should find the named sign-in, or the account’s only one', () => {
    should(proposalTarget(listing(), { signIn: GITHUB })).match({ ok: true, signIn: { id: GITHUB } });
    should(proposalTarget(listing(), { login: 'SUDO' as AccountId })).match({ ok: true, account: { id: 'SUDO' } });
  });

  it('should give each miss one refusal, one code and one sentence, naming no label or username', () => {
    const misses = [
      proposalTarget(listing(), { signIn: 'si_00000000000000ff' as never }),
      proposalTarget(listing(), { login: 'NOBODY' as AccountId }),
      proposalTarget(withNowhere(), { login: 'NOWHERE' as AccountId }),
      proposalTarget(listing(), { login: 'GITHUB_WORK' as AccountId }),
    ];
    should(misses.map(miss => (miss.ok ? 'ok' : `${miss.refusal}/${miss.code}`))).eql([
      'unknown_sign_in/not_found',
      'unknown_login/not_found',
      'no_sign_in/bad_request',
      'account_has_sign_ins/bad_request',
    ]);
    for (const miss of misses) {
      should(JSON.stringify(miss)).not.containEql('GitHub work');
      should(JSON.stringify(miss)).not.containEql('Nowhere');
    }
  });

  it('should refuse the recipe half and the suggestion half with the same words', async () => {
    const recipes = new LoginRecipeService({
      accounts: { list: async () => withNowhere() },
    } as never);
    const suggestions = new SignInRuleSuggestions({
      accounts: { listing: async () => withNowhere() },
      agenda: { raise: async () => ({ ok: true, id: 'A1' }), close: async () => undefined },
      redact: async text => text,
      audit: { record: async () => undefined },
      clock: { now: () => NOW },
    });
    for (const login of ['NOBODY', 'NOWHERE', 'GITHUB_WORK'] as AccountId[]) {
      const recipe = (await recipes.resolve({ login }).catch((error: unknown) => error)) as LoginEntryError;
      const rule = (await suggestions
        .suggest('s-one', { login, why: 'daily' })
        .catch((error: unknown) => error)) as SignInRuleSuggestionError;
      should(recipe).be.instanceOf(LoginEntryError);
      should(rule).be.instanceOf(SignInRuleSuggestionError);
      should(rule.message).equal(recipe.message);
    }
  });
});
