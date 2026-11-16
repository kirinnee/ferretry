/**
 * THE SITE A HOST BELONGS TO, as a page card's lock groups acts and scripts (secrev-1333 L2): tabs on sibling subdomains
 * of one registrable domain share cookies, so `mail.example.com` and `accounts.example.com` are one site. Without a
 * public-suffix list it is the host's last two labels, port dropped: never narrower than the registrable domain, and
 * sometimes wider (every `*.co.uk` page is one "site"), which only ever counts more acts. An IP address, `localhost`
 * or a one-label host is its own site.
 *
 * Copied from today's `daemon/src/lib/input-requests/login-observer.ts`: the page's side of how acts are grouped, so the
 * hosts a page act is told under (`ActedPage`) and the Vault's lock agree on what one site is.
 */
export function siteOf(host: string): string {
  const bare = host.toLowerCase().replace(/:[0-9]+$/u, '');
  if (bare.startsWith('[') || /^[0-9.]+$/u.test(bare)) return bare;
  const labels = bare.split('.').filter(label => label !== '');
  return labels.length <= 2 ? labels.join('.') : labels.slice(-2).join('.');
}
