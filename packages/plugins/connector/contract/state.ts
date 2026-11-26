/**
 * `state/connector/connector.json`: what the authorization server remembers (docs/mcp-connector.md "Storage").
 *
 * HASH-ONLY. Every credential below is a SHA-256 digest: a client secret, an access token, a refresh token. There is
 * no field that could hold the raw value, so a copy of this file (a backup, a move, a bug report) cannot sign anyone
 * in. A client's own name and a grant's id are not secret. DAMAGED IS NOT EMPTY: a damaged file fails the subsystem
 * closed rather than reading as "nobody is signed in" and then being rewritten.
 *
 * There is one shape. A file written by v4 is carried by the converter, which writes this one; nothing here reads an
 * older spelling.
 */
import { InstantSchema } from '@ferretry/std';
import { z } from 'zod';
import { CONNECTOR_SCOPES } from './wire.ts';

const ScopeSchema = z.enum(CONNECTOR_SCOPES);
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);

/** A client Claude registered (RFC 7591). Only the digest of its secret is kept. */
const ClientSchema = z.strictObject({
  id: z.string().regex(/^fycl_[a-z2-7]{10}$/u),
  name: z.string().max(100),
  redirectUris: z.array(z.string().url()).min(1).max(5),
  grantTypes: z
    .array(z.enum(['authorization_code', 'refresh_token']))
    .min(1)
    .max(2),
  authMethod: z.enum(['none', 'client_secret_post', 'client_secret_basic']),
  secretDigest: DigestSchema.optional(),
  createdAt: InstantSchema,
});
export type ConnectorClient = z.infer<typeof ClientSchema>;

/** A live access or refresh token: its digest, expiry (epoch ms), audience and scopes. */
const TokenSchema = z.strictObject({
  digest: DigestSchema,
  expiresAt: z.number().finite(),
  audience: z.string(),
  scopes: z.array(ScopeSchema),
});

/**
 * A refresh token that was rotated away. `expiresAt` is that token's OWN refresh expiry: once past it the token is
 * simply invalid, so the entry is dropped on the next write. `rotatedAt` and `successors` (the digests of the
 * access and refresh token its rotation issued) exist for the one-minute retry window after a lost response.
 * `retryable` is written only by a FIRST rotation and absent once the token's one retry is spent: a record without
 * it (a retried token, or the pair a retry superseded) can never be retried, and reuse revokes.
 */
const UsedRefreshSchema = z.strictObject({
  digest: DigestSchema,
  expiresAt: z.number().finite(),
  rotatedAt: z.number().finite(),
  successors: z.strictObject({ access: DigestSchema, refresh: DigestSchema }).optional(),
  retryable: z.literal(true).optional(),
});
export type UsedRefresh = z.infer<typeof UsedRefreshSchema>;

const GrantSchema = z.strictObject({
  id: z.string().regex(/^cg_[a-z2-7]{10}$/u),
  clientId: z.string(),
  clientName: z.string(),
  redirectHost: z.string(),
  scopes: z.array(ScopeSchema),
  createdAt: InstantSchema,
  approvedBy: z.string(),
  lastUsedAt: InstantSchema.optional(),
  revokedAt: InstantSchema.optional(),
  /**
   * Written by an approval BEFORE it is audited and flipped to approved. A pending record is never connected: the
   * index does not know it, the owner never sees it and a code cannot redeem it, so a crash between the write and
   * the audit leaves nothing but an inert record that the next write drops.
   */
  pending: z.literal(true).optional(),
  access: z.array(TokenSchema),
  refresh: z.array(TokenSchema),
  usedRefresh: z.array(UsedRefreshSchema),
});
export type ConnectorGrant = z.infer<typeof GrantSchema>;

export const ConnectorStateFileSchema = z.strictObject({
  format: z.literal(1),
  clients: z.array(ClientSchema).max(20),
  grants: z.array(GrantSchema),
});
export type ConnectorState = z.infer<typeof ConnectorStateFileSchema>;
