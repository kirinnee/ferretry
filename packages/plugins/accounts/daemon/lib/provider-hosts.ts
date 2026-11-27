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

/**
 * The provider account's sign-in AT ITS OWN LOGIN HOST, out of its sign-ins (`[id, record]`), never its first saved
 * site: a Google account that also signs in at another site holds that site's session there, which proves nothing
 * about Google's.
 */
export function providerOwnSignIn<Id extends string>(
  kind: LoginMethodKind | undefined,
  providerSignIns: readonly (readonly [Id, { readonly place: Place }])[],
): readonly [Id, { readonly place: Place }] | undefined {
  const hosts = kind === undefined ? undefined : PROVIDER_LOGIN_HOSTS[kind];
  return providerSignIns.find(
    ([, other]) =>
      hosts !== undefined && other.place.kind === 'site' && other.place.domains.some(d => hosts.includes(d)),
  );
}
