import { HOSTED_APP_ORIGIN } from '@ferretry/kernel/contract';

/** The hosted app's origin: where the published model catalog and its signed release list are read from. Owned by the kernel's `hosted-app` module. */
export { HOSTED_APP_ORIGIN };

/** The build define that replaces the key below when the build names another hosted app (`scripts/ci/hosted-app-origin.sh --defines`). */
declare const __FY_HOSTED_APP_RELEASE_KEY__: string | undefined;

/** The production hosted app's release public key (Ed25519, PEM). */
const PRODUCTION_RELEASE_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAnoDPIkeAlpqBnzRttizycYDdns+41tiEHbGKK+7t+78=
-----END PUBLIC KEY-----
`;

/**
 * The hosted app's release public key (Ed25519, PEM): the one a published model catalog is verified against. The same
 * bytes as `packages/app/release-signing-key.pub`, which owns the fact; a plugin may not import another package's file,
 * so the copy is held here until the app publishes the key through its contract. A build for another hosted app (the
 * 5.0 preview) is given THAT app's key by the same build script that gives it the origin, so the daemon verifies the
 * catalog the origin it points at actually serves.
 */
export const HOSTED_APP_RELEASE_KEY =
  typeof __FY_HOSTED_APP_RELEASE_KEY__ === 'string' && __FY_HOSTED_APP_RELEASE_KEY__.includes('BEGIN PUBLIC KEY')
    ? __FY_HOSTED_APP_RELEASE_KEY__
    : PRODUCTION_RELEASE_KEY;
