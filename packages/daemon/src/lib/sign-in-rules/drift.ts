import {
  type AccountKey,
  AccountKeySchema,
  type AccountSummary,
  factorFingerprint,
  placeKeys,
  type SignInId,
  type SignInRuleBody,
  type SignInRuleIneligible,
  type SignInRulePins,
  type SignInRuleSuspension,
  type SignInSummary,
  type TwoFactorKeySummary,
} from '@ferretry/protocol';
import { ineligibleBecause, tappedIdentities } from './eligibility.ts';

/**
 * PINNED FACTS AND THEIR DRIFT (docs/secrets.md, "Standing sign-in rules"). Pure: a listing comes in, pins or a
 * suspension reason come out. The same snapshot is taken when a rule is staged and again when it is committed, and the
 * same comparison runs after every account change, at load, and (R3c-4) before every fill, so the three can never
 * disagree about what "the same sign-in" means.
 *
 * What is pinned, and so suspends the rule when it changes: the account's immutable key, its handle and its username;
 * the sign-in's login domains and its recipe version; the field identities the owner's own taps have history with; and
 * a fingerprint of the account's 2FA keys (id, kind, whether Ferretry makes its codes — never `verified`, the label or
 * when it was added). NOT pinned: the password itself, a label, whether a code "worked", pending proposals, defaults.
 */

/** The account listing as rules read it: summaries, and each handle's immutable `L…` key. */
export interface RuleListing {
  readonly accounts: readonly AccountSummary[];
  readonly signIns: readonly SignInSummary[];
  /** Handle → key. */
  readonly keys: ReadonlyMap<string, string>;
}

/** A sign-in with its account and that account's key, as one listing has them. */
interface Found {
  readonly signIn: SignInSummary;
  readonly account: AccountSummary;
  readonly key: AccountKey;
}

function found(listing: RuleListing, signInId: SignInId): Found | undefined {
  const signIn = listing.signIns.find(each => each.id === signInId);
  const account = signIn === undefined ? undefined : listing.accounts.find(each => each.id === signIn.account);
  const key = AccountKeySchema.safeParse(account === undefined ? undefined : listing.keys.get(account.id));
  return signIn === undefined || account === undefined || !key.success ? undefined : { signIn, account, key: key.data };
}

/**
 * The 2FA key a rule's code is made from: the NEWEST key Ferretry holds a seed for, by when it was added (then id), never
 * by whether a code of it went through — a ferret can steer that (secrev-1241 I1).
 */
export function pinnedFactor(keys: readonly TwoFactorKeySummary[]): TwoFactorKeySummary | undefined {
  return [...keys]
    .filter(key => key.automatic)
    .sort((left, right) => Date.parse(right.addedAt) - Date.parse(left.addedAt) || left.id.localeCompare(right.id))[0];
}

export type PinsSnapshot =
  | {
      readonly ok: true;
      readonly pins: SignInRulePins;
      readonly signIn: SignInSummary;
      readonly account: AccountSummary;
    }
  | { readonly ok: false; readonly because: SignInRuleIneligible | 'not-found' | 'no-code-key' };

/**
 * WHAT A RULE FOR THIS SIGN-IN WOULD BE PINNED TO NOW, or why there can't be one: gone, not eligible (a terminal or
 * provider sign-in, no password, no tapped history), or a code asked for an account with no key Ferretry makes codes
 * for. `totp` pins the key the code comes from ({@link pinnedFactor}).
 */
export function snapshotPins(listing: RuleListing, signInId: SignInId, totp: boolean): PinsSnapshot {
  const at = found(listing, signInId);
  if (at === undefined) return { ok: false, because: 'not-found' };
  const because = ineligibleBecause(at.signIn);
  if (because !== undefined) return { ok: false, because };
  const factor = totp ? pinnedFactor(at.account.factors) : undefined;
  if (totp && factor === undefined) return { ok: false, because: 'no-code-key' };
  return {
    ok: true,
    signIn: at.signIn,
    account: at.account,
    pins: {
      accountKey: at.key,
      account: at.account.id,
      ...(at.account.username === undefined ? {} : { username: at.account.username }),
      placeKeys: [...placeKeys(at.signIn.place)],
      ...(at.signIn.recipeVersion === undefined ? {} : { recipeVersion: at.signIn.recipeVersion }),
      identities: [...tappedIdentities(at.signIn)],
      factors: factorFingerprint(at.account.factors),
      ...(factor === undefined ? {} : { factor: factor.id }),
    },
  };
}

/** The same members, each once on both sides. */
const sameSet = (left: readonly string[], right: readonly string[]): boolean => {
  const sorted = (values: readonly string[]): readonly string[] => [...new Set(values)].sort();
  const [one, other] = [sorted(left), sorted(right)];
  return one.length === left.length && other.length === right.length && one.join('\n') === other.join('\n');
};

/** Two pin sets equal field for field (sets compared as sets): the stage→commit check. */
export function samePins(left: SignInRulePins, right: SignInRulePins): boolean {
  return (
    left.accountKey === right.accountKey &&
    left.account === right.account &&
    left.username === right.username &&
    sameSet(left.placeKeys, right.placeKeys) &&
    left.recipeVersion === right.recipeVersion &&
    sameSet(left.identities, right.identities) &&
    left.factors === right.factors &&
    left.factor === right.factor
  );
}

/**
 * WHETHER A RULE'S PINNED FACTS STILL HOLD in this listing, and the first that does not. Sticky by design: the caller
 * suspends on any answer, and a fact changed back later does not resume the rule.
 *
 * - `sign-in-gone`: the sign-in (or its account) was removed.
 * - `account-changed`: the sign-in moved to another account (a merge: another key), the account was renamed, its
 *   username changed, or the sign-in no longer types a password of its own (another method, or "via" a provider). The
 *   same refusal {@link snapshotPins} makes, so the stage, the commit and the follower agree (secrev-1274a L4).
 * - `place-changed`: its login domains changed, or it is no longer a page sign-in.
 * - `recipe-changed`: its recipe version moved (the owner's edit, an approved proposal or an auto-applied one).
 * - `factor-changed`: any 2FA key added, removed, changed in kind, or given or stripped of its seed.
 * - `form-changed`: a pinned field identity is no longer observed at the sign-in's domains (a new form replaced it).
 */
export function ruleDrift(body: SignInRuleBody, listing: RuleListing): SignInRuleSuspension | undefined {
  const signIn = listing.signIns.find(each => each.id === body.signIn);
  if (signIn === undefined) return 'sign-in-gone';
  const account = listing.accounts.find(each => each.id === signIn.account);
  if (account === undefined) return 'sign-in-gone';
  const pins = body.pins;
  if (listing.keys.get(account.id) !== pins.accountKey) return 'account-changed';
  if (account.id !== pins.account || account.username !== pins.username) return 'account-changed';
  if (signIn.via !== undefined || signIn.method.via !== undefined || signIn.method.kind !== 'password')
    return 'account-changed';
  if (signIn.place.kind !== 'site' || !sameSet(placeKeys(signIn.place), pins.placeKeys)) return 'place-changed';
  if (signIn.recipeVersion !== pins.recipeVersion) return 'recipe-changed';
  if (factorFingerprint(account.factors) !== pins.factors) return 'factor-changed';
  const keys = new Set(pins.placeKeys);
  const seen = new Set((signIn.observed ?? []).filter(fact => keys.has(fact.at)).map(fact => fact.identity));
  if (pins.identities.some(identity => !seen.has(identity))) return 'form-changed';
  return undefined;
}
