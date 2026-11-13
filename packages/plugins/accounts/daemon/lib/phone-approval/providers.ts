/**
 * THE HOST RULES OF "APPROVE ON YOUR PHONE" (docs/input-requests.md): which identity provider a page's host belongs to,
 * and whether a number a provider's view gave can have been read on that host. Copied from today's
 * `browser/transport/push-number.ts` (`identityProviderOf`, `numberSourceFits`, bb89d054d).
 *
 * TODO(contract): these belong to Browsers' `push-number.ts` (the scan that finds the number); the daemon's decision
 * on the browser's answer is the I200 enforcer and Accounts owns that row, so the host rules are copied here until
 * Browsers' contract exports them. A host rule that drifts from the scan only ever refuses more: a number is believed
 * when BOTH agree.
 */
import type { PushNumberProvider } from '@ferretry/core-vault/contract';

/** A host is `domain` or one of its subdomains, on a label boundary: never a look-alike that merely ends the same. */
const under = (host: string, domain: string): boolean => host.endsWith(`.${domain}`) && host.length > domain.length + 1;

const MICROSOFT_HOSTS: ReadonlySet<string> = new Set(['login.microsoftonline.com', 'login.live.com']);
const GOOGLE_HOST = 'accounts.google.com';
const OKTA_DOMAINS = ['okta.com', 'oktapreview.com', 'okta-emea.com'] as const;
const DUO_DOMAIN = 'duosecurity.com';

/**
 * Which identity provider a page's host belongs to, from a FIXED list: Microsoft's and Google's sign-in hosts exactly,
 * and an organisation's own subdomain of Okta's or Duo's (never the bare apex). `undefined` for any other host.
 */
export function identityProviderOf(host: string): PushNumberProvider | undefined {
  const name = host.toLowerCase();
  if (MICROSOFT_HOSTS.has(name)) return 'microsoft';
  if (name === GOOGLE_HOST) return 'google';
  if (OKTA_DOMAINS.some(domain => under(name, domain))) return 'okta';
  if (under(name, DUO_DOMAIN)) return 'duo';
  return undefined;
}

/**
 * Whether a number from `from` can have been read on `host`: Microsoft's only on its two sign-in hosts, Google's only on
 * accounts.google.com, Duo's only on a Duo host, Okta's on an Okta host. Okta's widget also runs on an organisation's
 * own domain (`login.company.com`): such a host fits only when the daemon names it in `oktaCustomHosts`, the domains of
 * a provider sign-in some saved sign-in goes `via` (secrev-1244 R1). Never just any domain of the matched sign-in.
 */
export function numberSourceFits(
  from: PushNumberProvider,
  host: string,
  oktaCustomHosts: ReadonlySet<string> = new Set(),
): boolean {
  const name = host.toLowerCase();
  switch (from) {
    case 'microsoft':
      return MICROSOFT_HOSTS.has(name);
    case 'google':
      return name === GOOGLE_HOST;
    case 'duo':
      return under(name, DUO_DOMAIN);
    case 'okta':
      return identityProviderOf(name) === 'okta' || oktaCustomHosts.has(name);
  }
}
