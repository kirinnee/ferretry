import {
  type AccountId,
  type AccountList,
  type IdentityAnswer,
  type IdentityLink,
  placeHosts,
  type PlaceKey,
  type SignInId,
  type SignInSummary,
} from '../../contract/routes/index.ts';

/**
 * THE ACCOUNT → BROWSER-IDENTITY GRAPH, as pure functions (W-124 U5). Nothing here reads a store, a clock or a page:
 * the caller hands in the edges ({@link IdentityLink}), the sign-ins and what a page showed, and gets an answer back.
 *
 * - {@link resolveIdentity}: which identity holds the sign-in a host needs, following `method.via` edges to the provider
 *   account that is actually live in one. Two identities never become a silent pick: that is `ambiguous`.
 * - {@link recoveryPlan}: the steps that sign a site back in after a page showed its login. Steps NAME sign-ins and
 *   accounts, never a value; the caller runs each by the existing paths (click, choose, a standing rule, or an owner card).
 *
 * A circle in the `via` edges is refused when the sign-in is saved (`accountIndexProblems`); the walk below also keeps
 * the accounts it has passed, so a circle that somehow existed ends the walk instead of the daemon.
 */

type Listing = Pick<AccountList, 'accounts' | 'signIns'>;

/** One way a sign-in reaches an identity: the sign-ins passed through (the first is the site's own) and where it ends. */
interface Route {
  readonly identity: string;
  readonly path: readonly SignInSummary[];
}

const byId = (left: SignInSummary, right: SignInSummary): number =>
  left.id < right.id ? -1 : left.id > right.id ? 1 : 0;

/**
 * The provider sign-in a site sign-in goes through: the one the listing NAMES (`via.signIn`, the provider account's
 * site sign-in), never "any sign-in of that account": a provider account that also signs in at some other site holds
 * its session in that other site's page, which says nothing about the provider's own.
 */
const providerOf = (signIn: SignInSummary, list: Listing): SignInSummary | undefined => {
  const named = signIn.via?.signIn;
  return list.signIns.find(
    other => other.id === named && other.account === signIn.method.via && other.place.kind === 'site',
  );
};

/**
 * Every identity `signIn` lives in. Its own edges first: a round trip through the provider keeps the provider on the
 * path (the page asks the provider's button, not the site's own form), any other edge holds it directly. Else the
 * identities of the provider sign-in it goes through, which only a link on THAT sign-in proves.
 */
function routesOf(
  signIn: SignInSummary,
  links: readonly IdentityLink[],
  list: Listing,
  seen: ReadonlySet<AccountId>,
): Route[] {
  const own = links.filter(link => link.signIn === signIn.id);
  const via = signIn.method.via;
  const provider = via === undefined || seen.has(via) ? undefined : providerOf(signIn, list);
  if (own.length > 0)
    return own.map(link => ({
      identity: link.identity,
      path: link.how === 'provider-round-trip' && provider !== undefined ? [signIn, provider] : [signIn],
    }));
  if (via === undefined || provider === undefined) return [];
  return routesOf(provider, links, list, new Set([...seen, via])).map(route => ({
    ...route,
    path: [signIn, ...route.path],
  }));
}

/** The routes of every sign-in at `host`, grouped by identity (each group in sign-in id order). */
function routesFor(
  links: readonly IdentityLink[],
  list: Listing,
  host: PlaceKey,
): ReadonlyMap<string, readonly Route[]> {
  const found = new Map<string, Route[]>();
  for (const signIn of list.signIns.filter(each => placeHosts(each.place).includes(host)).sort(byId))
    for (const route of routesOf(signIn, links, list, new Set([signIn.account])))
      found.set(route.identity, [...(found.get(route.identity) ?? []), route]);
  return found;
}

/** The identity a site's sign-in lives in: one (with the provider accounts it passes through), several, or none. */
export type Resolution = IdentityAnswer | { readonly none: true };

export function resolveIdentity(links: readonly IdentityLink[], list: Listing, host: PlaceKey): Resolution {
  const found = routesFor(links, list, host);
  const identities = [...found.keys()].sort();
  const [first, second] = identities;
  if (first === undefined) return { none: true };
  if (second !== undefined) return { ambiguous: identities };
  const routes = found.get(first) as readonly Route[];
  const accounts = [...new Set(routes.map(route => (route.path[0] as SignInSummary).account))].sort();
  if (routes.length > 1) return { identity: first, ambiguousAccounts: accounts };
  return { identity: first, via: (routes[0] as Route).path.slice(1).map(hop => hop.account) };
}

/** What a page showed, as Browsers reports it. `providerSignedIn`: the provider's own page still holds its session. */
export interface PageFacts {
  readonly providerSignedIn: boolean;
  /** Whether the sign-in to fill has a standing rule that covers it (a password sign-in only). */
  readonly standingRule: boolean;
}

/** One step back in. A step names; it never carries a value. */
export type RecoveryStep =
  | { readonly do: 'click-provider'; readonly provider: AccountId }
  | { readonly do: 'choose-account'; readonly account: AccountId }
  | { readonly do: 'fill'; readonly signIn: SignInId; readonly by: 'standing-rule' }
  | { readonly do: 'ask-owner'; readonly signIn: SignInId };

/** Fill by the existing rule path when one covers the sign-in, else raise the owner's card. */
const fillOrAsk = (signIn: SignInId, facts: PageFacts): RecoveryStep =>
  facts.standingRule ? { do: 'fill', signIn, by: 'standing-rule' } : { do: 'ask-owner', signIn };

/**
 * The steps that sign `host` back in after its page showed a login, in the one identity that holds it. `[]` when there
 * is nothing to say: no identity holds it, or several do, or one identity holds it under several accounts (`resolveIdentity` says `ambiguous` or `ambiguousAccounts`; the owner picks, never us).
 * - A password sign-in held directly: fill it, or ask.
 * - A sign-in through a provider: click the provider's button, then choose its account when the provider is still
 *   signed in, else sign the provider in first (fill it, or ask), which the provider's own page then completes.
 */
export function recoveryPlan(
  links: readonly IdentityLink[],
  list: Listing,
  host: PlaceKey,
  facts: PageFacts,
): readonly RecoveryStep[] {
  const found = routesFor(links, list, host);
  const [only, ...rest] = [...found.values()];
  if (only === undefined || rest.length > 0 || only.length !== 1) return [];
  const { path } = only[0] as Route;
  const [site, provider] = path;
  if (site === undefined) return [];
  if (provider === undefined) return [fillOrAsk(site.id, facts)];
  return [
    { do: 'click-provider', provider: provider.account },
    facts.providerSignedIn ? { do: 'choose-account', account: provider.account } : fillOrAsk(provider.id, facts),
  ];
}
