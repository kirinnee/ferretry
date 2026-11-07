/**
 * `state/mcp/oauth.json`: what is known about each MCP sign-in that is NOT secret: issuer, endpoints, client id,
 * expiry. The tokens are in the Vault; this file never holds one. DAMAGED IS NOT EMPTY (the state port raises).
 */
import { SecretNameSchema } from '@ferretry/core-vault/contract';
import { z } from 'zod';

const Text = z.string().min(1).max(2048);

/** How a client with a secret authenticates, and where a pre-registered client's secret is named. */
const CLIENT_AUTH_SHAPE = {
  tokenAuth: z.enum(['client_secret_post', 'client_secret_basic']).optional(),
  clientSecretRef: SecretNameSchema.optional(),
} as const;

const RegistrationSchema = z.strictObject({
  issuer: Text,
  redirectUri: Text,
  paste: z.literal(true).optional(),
  clientId: Text,
  hasClientSecret: z.boolean(),
  ...CLIENT_AUTH_SHAPE,
});

const RecordSchema = z.strictObject({
  serverUrl: Text,
  issuer: Text,
  redirectUri: Text,
  tokenEndpoint: Text,
  revocationEndpoint: Text.optional(),
  clientId: Text,
  hasClientSecret: z.boolean(),
  ...CLIENT_AUTH_SHAPE,
  resource: Text,
  scope: z.string().max(2048).optional(),
  signedInAt: Text,
  expiresAt: Text.optional(),
  renewable: z.boolean(),
  needsSignIn: z.boolean().optional(),
});

export const McpOAuthStateFileSchema = z.strictObject({
  format: z.literal(1),
  registrations: z.record(z.string(), z.array(RegistrationSchema)),
  connections: z.record(z.string(), RecordSchema),
});
