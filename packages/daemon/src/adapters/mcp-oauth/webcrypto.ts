/** Randomness and SHA-256 for PKCE, from the runtime's WebCrypto. */
import type { McpOAuthCrypto } from '../../lib/mcp-oauth/ports.ts';

export const webCryptoMcpOAuth: McpOAuthCrypto = {
  randomBytes: length => crypto.getRandomValues(new Uint8Array(length)),
  sha256: async text => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))),
};
