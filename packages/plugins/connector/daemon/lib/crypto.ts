/** Randomness and SHA-256 for the authorization server, from the runtime's WebCrypto. */
import type { ConnectorCrypto } from './oauth/model.ts';

export const webCryptoConnector: ConnectorCrypto = {
  randomBytes: length => crypto.getRandomValues(new Uint8Array(length)),
  sha256: async text => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))),
};
