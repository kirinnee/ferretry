// The leaf subpath, not the barrel: the app's `vite.config.ts` imports this file, and Vite loads a workspace package
// through Node's type stripping, which refuses the barrel's TypeScript-only syntax (parameter properties).
import { HOSTED_APP_ORIGIN } from '@ferretry/kernel/contract/hosted-app';

/** The hosted app's origin: where a pairing link, a catalog and a share link point. Owned by the kernel's `hosted-app` module. */
export { HOSTED_APP_ORIGIN };

/**
 * Today's shared service origin, never a carrier or a daemon address. The no-store advertisement chooses the
 * rendezvous at runtime and can withdraw it without a release. Local builds and forks share this directory.
 */
export const HOSTED_RELAY_DIRECTORY_ORIGIN = 'https://ferretry-hosted-relay.kirinnee97.workers.dev';
