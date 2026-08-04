/**
 * Reading the daemon's stored Ed25519 identity, on WebCrypto.
 *
 * It delegates to `WebCryptoRelayCrypto.importDaemonIdentity` rather than deriving the fingerprint
 * itself, because a second spelling of "the SHA-256 of the SubjectPublicKeyInfo" is a second identity,
 * and the two would never meet. The same code computes the fingerprint here, in the browser and in
 * the Worker that verifies the claim.
 *
 * There is no `create` here on purpose: pairing mints the key, and a relay that could mint one too
 * would be able to rename this daemon. See `lib/relay/identity.ts`.
 */

import type { DaemonIdentity } from '@ferretry/relay';
import { WebCryptoRelayCrypto } from '@ferretry/relay/adapters';
import type { RelayIdentityKeys } from '../../lib/relay/index.ts';

export class WebCryptoRelayIdentityKeys implements RelayIdentityKeys {
  constructor(private readonly relayCrypto: WebCryptoRelayCrypto = new WebCryptoRelayCrypto()) {}

  async load(privateKeyPem: string): Promise<DaemonIdentity> {
    return await this.relayCrypto.importDaemonIdentity(privateKeyPem);
  }
}
