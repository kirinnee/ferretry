/**
 * Ferretry's hosted relay DIRECTORY — a service origin, never a carrier or a daemon address.
 *
 * OWNER DECISION (temporary): this is deliberately compiled into every build route, including
 * local builds and forks. The prior per-build resolution left the Nix package direct-only while
 * the release archive worked, which is a worse failure than a fork discovering Ferretry's hosted
 * service by default. When this moves from the personal Cloudflare workers.dev subdomain to a
 * product domain such as relay.ferretry.dev, change this one constant and nothing else.
 *
 * The directory's advertisement remains a no-store runtime read. It chooses the carrier and can
 * withdraw it, so this literal does not compile a relay endpoint into a binary.
 */
export const HOSTED_RELAY_DIRECTORY_ORIGIN = 'https://ferretry-hosted-relay.kirinnee97.workers.dev';
