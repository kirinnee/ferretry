import {
  type LoginObserved,
  placeKeys,
  SIGN_IN_RULE_HISTORY_TAPS,
  type SignInRuleIneligible,
  type SignInSummary,
  taskPlanKeysFitLine,
} from '@ferretry/protocol';

/**
 * WHO MAY BE PRE-APPROVED (docs/secrets.md, "Standing sign-in rules"): only a page password sign-in the OWNER signed in
 * to by hand, from a paired device, at least {@link SIGN_IN_RULE_HISTORY_TAPS} times in a row with the page
 * moving on. Pure: the sign-in comes in, a reason or nothing comes out.
 *
 * ## ONLY THE OWNER'S OWN TAPS COUNT
 *
 * History is the `tapped` fact alone, which the login observer writes only for a `device` fill (`observerByOf`), at the
 * moment the page moved on unsteered. Plan fills, rule fills and the admin token's deliveries (`host`: the owner at the
 * machine, or a ferret that read `api-token`) never write it, so no fill can qualify a sign-in for a rule — least of
 * all its own. A 2FA key's `verified` fact is not read here or anywhere a rule is decided (secrev-1241 I1).
 */

/** An observed fact that is the owner's own tap history: tapped and masked, moved on, twice or more in a row. */
const ownerHistory = (fact: LoginObserved): boolean =>
  fact.tapped?.value === true &&
  fact.tapped.count >= SIGN_IN_RULE_HISTORY_TAPS &&
  fact.masked?.value === true &&
  (fact.surface !== 'page' || fact.navigatedAway?.value === true);

/**
 * The field identities at the sign-in's own login domains that have the owner's tapped history, sorted, or none. A rule
 * pins exactly these: it never fills a form the owner has not signed in to by hand.
 */
export function tappedIdentities(signIn: Pick<SignInSummary, 'place' | 'observed'>): readonly string[] {
  const keys = new Set(placeKeys(signIn.place));
  const seen = (signIn.observed ?? []).filter(fact => keys.has(fact.at) && ownerHistory(fact));
  return [...new Set(seen.map(fact => fact.identity))].sort();
}

/**
 * Why a sign-in can't have a standing rule, before any passkey is asked: a terminal sign-in (pages only, R3c §18), a
 * provider sign-in, one that types no password, or one without the owner's tapped history. `undefined`: it can.
 */
export function ineligibleBecause(
  signIn: Pick<SignInSummary, 'place' | 'method' | 'via' | 'observed'>,
): Exclude<SignInRuleIneligible, 'no-passkey'> | undefined {
  if (signIn.place.kind !== 'site') return 'tool-not-covered';
  if (signIn.via !== undefined || signIn.method.via !== undefined) return 'via-provider';
  if (signIn.method.kind !== 'password') return 'not-password';
  const keys = placeKeys(signIn.place);
  if (keys.length === 0 || !taskPlanKeysFitLine('sign-in', keys)) return 'tool-not-covered';
  if (tappedIdentities(signIn).length === 0) return 'no-history';
  return undefined;
}
