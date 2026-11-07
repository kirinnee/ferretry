/** The hosted app's origin: where a pairing link, a catalog and a share link point (today's `HOSTED_APP_ORIGIN`). */
export const HOSTED_APP_ORIGIN = 'https://ferretry.pages.dev';

/**
 * Today's shared service origin, never a carrier or a daemon address. The no-store advertisement chooses the
 * rendezvous at runtime and can withdraw it without a release. Local builds and forks share this directory.
 */
export const HOSTED_RELAY_DIRECTORY_ORIGIN = 'https://ferretry-hosted-relay.kirinnee97.workers.dev';
