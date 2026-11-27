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

/** Every identity `signIn` lives in: its own edges, else those of the provider account it signs in through. */
function routesOf(
  signIn: SignInSummary,
  links: readonly IdentityLink[],
  list: Listing,
  seen: ReadonlySet<AccountId>,
): Route[] {
  const own = links.filter(link => link.signIn === signIn.id);
  if (own.length > 0) return own.map(link => ({ identity: link.identity, path: [signIn] }));
  const via = signIn.method.via;
  if (via === undefined || seen.has(via)) return [];
  const passed = new Set([...seen, via]);
  return list.signIns
    .filter(other => other.account === via && other.place.kind === 'site')
    .sort(byId)
    .flatMap(provider =>
      routesOf(provider, links, list, passed).map(route => ({ ...route, path: [signIn, ...route.path] })),
    );
}

/** The routes of every sign-in at `host`, one per identity (the first, in sign-in id order, wins its identity). */
function routesFor(links: readonly IdentityLink[], list: Listing, host: PlaceKey): ReadonlyMap<string, Route> {
  const found = new Map<string, Route>();
  for (const signIn of list.signIns.filter(each => placeHosts(each.place).includes(host)).sort(byId))
    for (const route of routesOf(signIn, links, list, new Set([signIn.account])))
      if (!found.has(route.identity)) found.set(route.identity, route);
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
  const route = found.get(first) as Route;
  return { identity: first, via: route.path.slice(1).map(hop => hop.account) };
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
 * is nothing to say: no identity holds it, or several do (`resolveIdentity` says `ambiguous`; the owner picks, never us).
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
  if (found.size !== 1) return [];
  const { path } = [...found.values()][0] as Route;
  const [site, provider] = path;
  if (site === undefined) return [];
  if (provider === undefined) return [fillOrAsk(site.id, facts)];
  return [
    { do: 'click-provider', provider: provider.account },
    facts.providerSignedIn ? { do: 'choose-account', account: provider.account } : fillOrAsk(provider.id, facts),
  ];
}
