import type { ConnectorCrypto } from '../../lib/connector/oauth/model.ts';

/** The same WebCrypto boundary as the daemon's outbound MCP OAuth client. */
export const webCryptoConnector: ConnectorCrypto = {
  randomBytes: length => crypto.getRandomValues(new Uint8Array(length)),
  sha256: async text => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))),
};
