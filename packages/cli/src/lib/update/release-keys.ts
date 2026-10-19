/**
 * The Ed25519 public keys a standalone self-update trusts, as base64url SPKI DER.
 *
 * EMPTY UNTIL THE OWNER SETS UP RELEASE SIGNING, and empty means the standalone update REFUSES rather
 * than trusting checksums alone: a checksum fetched from the same place as the archive proves only
 * that the download was not truncated. The steps are in `docs/updating.md`; `sign-daemon-release.sh`
 * reads this file and refuses to sign with a key that is not listed here, so a release can never be
 * signed by a key no shipped `fy` would accept.
 */
export const DAEMON_RELEASE_KEYS: readonly string[] = [];
