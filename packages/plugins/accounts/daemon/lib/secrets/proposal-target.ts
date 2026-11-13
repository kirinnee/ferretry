import type { AccountSummary, SignInId, SignInSummary } from '../../../contract/routes/index.ts';

/** A proposal names exactly one canonical sign-in. Account-only selectors are refused. */
export function proposalTarget(
  listing: { readonly accounts: readonly AccountSummary[]; readonly signIns: readonly SignInSummary[] },
  ask: { readonly signIn: SignInId },
) {
  const signIn =
    Object.keys(ask).length === 1 && typeof ask.signIn === 'string'
      ? listing.signIns.find(each => each.id === ask.signIn)
      : undefined;
  const account = listing.accounts.find(each => each.id === signIn?.account);
  return signIn === undefined || account === undefined
    ? {
        ok: false as const,
        refusal: 'unknown_sign_in' as const,
        code: 'not_found' as const,
        words: 'Name a sign-in; account_hint lists them.',
      }
    : { ok: true as const, signIn, account };
}
