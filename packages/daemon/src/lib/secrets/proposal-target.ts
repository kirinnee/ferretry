import type { AccountSummary, SignInId, SignInSummary } from '@ferretry/protocol';

/**
 * WHICH SIGN-IN AN `account.propose` CALL IS ABOUT, one decision for both halves of the call (a recipe, and a
 * standing-rule suggestion): the sign-in named. A miss has one refusal, one agent-facing code and one sentence, so the
 * ferret reads the same answer whichever half it used. The words name only ids the ferret already reads through
 * `account_hint`.
 */
type ProposalTargetMiss = {
  readonly refusal: 'unknown_sign_in';
  readonly code: 'not_found';
  readonly words: string;
};

type ProposalTargetFound =
  | { readonly ok: true; readonly signIn: SignInSummary; readonly account: AccountSummary }
  | ({ readonly ok: false } & ProposalTargetMiss);

export function proposalTarget(
  listing: { readonly accounts: readonly AccountSummary[]; readonly signIns: readonly SignInSummary[] },
  signInId: SignInId,
): ProposalTargetFound {
  const signIn = listing.signIns.find(each => each.id === signInId);
  const account = listing.accounts.find(each => each.id === signIn?.account);
  return signIn === undefined || account === undefined
    ? {
        ok: false,
        refusal: 'unknown_sign_in',
        code: 'not_found',
        words: `There is no sign-in ${signInId}; account_hint lists them.`,
      }
    : { ok: true, signIn, account };
}
