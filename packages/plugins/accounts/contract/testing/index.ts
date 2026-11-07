/** `@ferretry/plugin-accounts/contract/testing` (§7.8): the contract's fake and the conformance suite. */
import { describe, expect, test } from 'bun:test';
import { type AccountsApi, type PlaceKey, type SignInSummary, SignInSummarySchema, terminalKey } from '../index.ts';

/** An in-memory `AccountsApi` over a fixed set of sign-ins. */
export function fakeAccounts(signIns: readonly SignInSummary[] = []): AccountsApi {
  const all = signIns.map(signIn => SignInSummarySchema.parse(signIn));
  const keysOf = (signIn: SignInSummary): readonly string[] =>
    signIn.place.kind === 'site' ? [...signIn.place.domains, ...signIn.place.match] : [terminalKey(signIn.place)];
  return { signInsFor: async (place: PlaceKey) => all.filter(signIn => keysOf(signIn).includes(place)) };
}

/** What every `AccountsApi` keeps. */
export function accountsConformance(name: string, make: () => AccountsApi, place: PlaceKey): void {
  describe(`AccountsApi conformance: ${name}`, () => {
    test('a sign-in summary carries an id, an account and a place, never a value', async () => {
      for (const signIn of await make().signInsFor(place)) {
        expect(SignInSummarySchema.safeParse(signIn).success).toBe(true);
        expect(Object.keys(signIn).sort()).toEqual(['account', 'id', 'place']);
      }
    });
  });
}
