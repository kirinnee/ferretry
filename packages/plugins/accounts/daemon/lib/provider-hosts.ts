import type { LoginMethodKind, Place } from '../../contract/routes/index.ts';

/**
 * THE HOSTS A PROVIDER SIGNS ITS OWN ACCOUNTS IN AT, by the method a site's sign-in names ("Sign in with Google").
 * A fixed list of login hosts, matched EXACTLY: it names the page where the provider's own session lives, which is the
 * only sign-in that proves a provider session (identity graph, W-124 U5). `sso` and `password` have no fixed host, so
 * nothing proves their provider and the graph withholds rather than guesses.
 */
const PROVIDER_LOGIN_HOSTS: Readonly<Partial<Record<LoginMethodKind, readonly string[]>>> = {
  google: ['accounts.google.com'],
  github: ['github.com'],
  microsoft: ['login.microsoftonline.com', 'login.live.com'],
  apple: ['appleid.apple.com'],
};

/** Whether `place` is a site sign-in at the login host of the provider `kind` names. */
export function isProviderOwnSite(kind: LoginMethodKind, place: Place): boolean {
  const hosts = PROVIDER_LOGIN_HOSTS[kind];
  return hosts !== undefined && place.kind === 'site' && place.domains.some(domain => hosts.includes(domain));
}
