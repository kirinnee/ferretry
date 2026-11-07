import type { AccountId, AccountSummary, SignInId, SignInSummary } from '@ferretry/protocol';

/**
 * WHICH SIGN-IN AN `account.propose` CALL IS ABOUT, one decision for both halves of the call (a recipe, and a
 * standing-rule suggestion): the sign-in named, or — for the older `{ login }` — the account's ONLY sign-in. Each miss
 * has one refusal, one agent-facing code and one sentence, so the ferret reads the same answer whichever half it used.
 * The words name only ids the ferret already reads through `account_hint`.
 */
type ProposalTargetMiss =
  | { readonly refusal: 'unknown_sign_in'; readonly code: 'not_found'; readonly words: string }
  | { readonly refusal: 'unknown_login'; readonly code: 'not_found'; readonly words: string }
  | { readonly refusal: 'no_sign_in'; readonly code: 'bad_request'; readonly words: string }
  | { readonly refusal: 'account_has_sign_ins'; readonly code: 'bad_request'; readonly words: string };

type ProposalTargetFound =
  | { readonly ok: true; readonly signIn: SignInSummary; readonly account: AccountSummary }
  | ({ readonly ok: false } & ProposalTargetMiss);

interface ProposalTargetAsk {
  readonly signIn?: SignInId | undefined;
  readonly login?: AccountId | undefined;
}

export function proposalTarget(
  listing: { readonly accounts: readonly AccountSummary[]; readonly signIns: readonly SignInSummary[] },
  ask: ProposalTargetAsk,
): ProposalTargetFound {
  if (ask.signIn !== undefined) {
    const signIn = listing.signIns.find(each => each.id === ask.signIn);
    const account = listing.accounts.find(each => each.id === signIn?.account);
    return signIn === undefined || account === undefined
      ? {
          ok: false,
          refusal: 'unknown_sign_in',
          code: 'not_found',
          words: `There is no sign-in ${ask.signIn}; account_hint lists them.`,
        }
      : { ok: true, signIn, account };
  }
  const account = listing.accounts.find(each => each.id === ask.login);
  if (account === undefined)
    return {
      ok: false,
      refusal: 'unknown_login',
      code: 'not_found',
      words: `There is no account ${String(ask.login)}; account_hint lists them.`,
    };
  const own = listing.signIns.filter(each => each.account === account.id);
  const [only] = own;
  if (only === undefined)
    return {
      ok: false,
      refusal: 'no_sign_in',
      code: 'bad_request',
      words: 'That account signs in nowhere yet; name a sign-in (account_hint lists them).',
    };
  if (own.length > 1)
    return {
      ok: false,
      refusal: 'account_has_sign_ins',
      code: 'bad_request',
      words: `That account signs in at ${String(own.length)} places; name one as signIn (${own.map(each => each.id).join(', ')}).`,
    };
  return { ok: true, signIn: only, account };
}
