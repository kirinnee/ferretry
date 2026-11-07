/** The hosted app's origin: where the published model catalog and its signed release list are read from. */
export const HOSTED_APP_ORIGIN = 'https://ferretry.pages.dev';

/**
 * The hosted app's release public key (Ed25519, PEM): the one a published model catalog is verified against. The same
 * bytes as `packages/app/release-signing-key.pub`, which owns the fact; a plugin may not import another package's file,
 * so the copy is held here until the app publishes the key through its contract.
 */
export const HOSTED_APP_RELEASE_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAnoDPIkeAlpqBnzRttizycYDdns+41tiEHbGKK+7t+78=
-----END PUBLIC KEY-----
`;
