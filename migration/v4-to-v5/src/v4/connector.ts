/**
 * v4's Claude connector files (4.291.x, after PR 2550). A LOCAL copy on purpose: the product has no v4 reader.
 *
 * - `config/daemon.json` `connector`: read by v4 as `unknown` and parsed by `connectorConfiguration`
 *   (`packages/daemon/src/lib/connector/config.ts`) so that a typo switches the connector off and never refuses the boot.
 *   The block's rules are the ones v5's `ConnectorConfigSchema` declares word for word, so this tool checks the block
 *   with that schema and never restates a rule here.
 * - `state/connector/connector.json` (`adapters/connector/file-store.ts`, `connectorStateSchema`): `{version: 1,
 *   clients, grants}`, `0600` in a `0700` folder, HASH-ONLY (client secrets, access and refresh tokens are SHA-256
 *   digests). Not strict: v4's zod object strips an unknown key, and so does this one. v4 REFUSES a file that does
 *   not check ("damaged is not empty": every connector access is refused), so this tool refuses it too.
 *   `usedRefresh` has three spellings in the wild:
 *     1. a bare digest string (a file written before the retry window existed);
 *     2. an object whose `expiresAt` / `rotatedAt` may be absent (written before the 30-day stamp existed);
 *     3. the full record, with `successors` and, on a FIRST rotation only, `retryable: true` (PR 2550: the one-shot
 *        retry; a record without it can never be retried and a second presentation revokes the grant).
 * - `state/connector/calls.jsonl` (+ `calls.1.jsonl`, the one rotated file): one line per WRITE tool call, arguments
 *   already redacted by v4. Never opened for a value; each line is checked to be one JSON object and re-stamped.
 * - Pending sign-ins and authorization codes live in v4's MEMORY only, so there is no file to carry.
 */
import { z } from 'zod';

export const V4_CONNECTOR_STATE = 'state/connector/connector.json';
export const V4_CONNECTOR_CALLS = 'state/connector/calls.jsonl';
export const V4_CONNECTOR_CALLS_ROTATED = 'state/connector/calls.1.jsonl';

/** The two scopes v4 knew (`CONNECTOR_SCOPES`). */
const Scope = z.enum(['fleet:read', 'fleet:write']);
const Digest = z.string().regex(/^[a-f0-9]{64}$/u);

const Client = z.object({
  id: z.string().regex(/^fycl_[a-z2-7]{10}$/u),
  name: z.string().max(100),
  redirectUris: z.array(z.string().url()).min(1).max(5),
  grantTypes: z
    .array(z.enum(['authorization_code', 'refresh_token']))
    .min(1)
    .max(2),
  authMethod: z.enum(['none', 'client_secret_post', 'client_secret_basic']),
  secretDigest: Digest.optional(),
  createdAt: z.string().datetime(),
});

const Token = z.object({
  digest: Digest,
  expiresAt: z.number().finite(),
  audience: z.string(),
  scopes: z.array(Scope),
});

/** A rotated-away refresh token in any of v4's three spellings (a bare digest reads as `{ digest }`). */
export const V4UsedRefresh = z.preprocess(
  value => (typeof value === 'string' ? { digest: value } : value),
  z.object({
    digest: Digest,
    expiresAt: z.number().finite().optional(),
    rotatedAt: z.number().finite().optional(),
    successors: z.object({ access: Digest, refresh: Digest }).optional(),
    retryable: z.literal(true).optional(),
  }),
);
export type V4UsedRefresh = z.infer<typeof V4UsedRefresh>;

const Grant = z.object({
  id: z.string().regex(/^cg_[a-z2-7]{10}$/u),
  clientId: z.string(),
  clientName: z.string(),
  redirectHost: z.string(),
  scopes: z.array(Scope),
  createdAt: z.string().datetime(),
  approvedBy: z.string(),
  lastUsedAt: z.string().datetime().optional(),
  revokedAt: z.string().datetime().optional(),
  access: z.array(Token),
  refresh: z.array(Token),
  usedRefresh: z.array(V4UsedRefresh),
});

export const V4ConnectorState = z.object({
  version: z.literal(1),
  clients: z.array(Client).max(20),
  grants: z.array(Grant),
});
export type V4ConnectorState = z.infer<typeof V4ConnectorState>;
