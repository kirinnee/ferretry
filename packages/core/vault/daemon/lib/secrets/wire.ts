/**
 * The secret routes' wire shapes that the frozen contract does not hold, used only inside this package (`common.md`:
 * protocol code that is not in the contract and only used here goes to `daemon/lib`). Copied field for field from
 * today's `protocol/src/lib/secrets.ts` (listing, put, removed) and `protocol/src/lib/secret-clone.ts` (copying a
 * secret to another machine).
 *
 * NOTHING HERE CARRIES A SECRET VALUE A CALLER CAN READ. A value travels IN on {@link PutSecretBodySchema} and never
 * back; a copy's values travel only inside a bundle's ciphertext, which only the target daemon opens.
 *
 * FOR THE LEAD: the app and `fy` halves (Accounts owns `fy secret`) need these too, so they belong in
 * `@ferretry/core-vault/contract`; that is a contract change and was asked for in the port report.
 */

import { InstantSchema } from '@ferretry/std';
import { z } from 'zod';
import {
  MAX_SECRETS_PER_DAEMON,
  SecretNameSchema,
  SecretSummarySchema,
  SecretValueSchema,
} from '../../../contract/index.ts';

// ─── listing ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** The listing's own version field; a wire shape, not a stored format. */
export const SECRET_SCHEMA_VERSION = 1 as const;

/** One configured `${secret:NAME}` reference, with where it is and whether the store holds it. */
export const SecretReferenceViewSchema = z
  .object({
    name: SecretNameSchema,
    /** Human-readable origin, e.g. `config/daemon.json → agentEnvironment.API_BASE`. */
    origin: z.string().min(1),
    /** False when no secret of this name exists; the launch that reads it will refuse. */
    resolved: z.boolean(),
  })
  .strict();
export type SecretReferenceView = z.infer<typeof SecretReferenceViewSchema>;

/** `damaged` is NOT an empty list: it is its own state, so a surface never invites recreating everything. */
export const SecretStoreHealthSchema = z.enum(['ready', 'damaged']);
export type SecretStoreHealth = z.infer<typeof SecretStoreHealthSchema>;

export const SecretListSchema = z
  .object({
    v: z.literal(SECRET_SCHEMA_VERSION),
    health: SecretStoreHealthSchema,
    /** Why the store is damaged, in terms an operator can act on. Present only when damaged. */
    diagnosis: z.string().min(1).optional(),
    secrets: z.array(SecretSummarySchema).max(MAX_SECRETS_PER_DAEMON).readonly(),
    references: z.array(SecretReferenceViewSchema).readonly(),
  })
  .strict();
export type SecretList = z.infer<typeof SecretListSchema>;

/** What a delete answers: the name, and a literal `true` (a 404 is how "there was none" is reported). */
export const RemovedSecretSchema = z.object({ name: SecretNameSchema, removed: z.literal(true) }).strict();
export type RemovedSecret = z.infer<typeof RemovedSecretSchema>;

/** `POST /v1/secrets`: creating a secret, or replacing one that exists (today's `PutSecretRequestSchema`). */
export const PutSecretBodySchema = z
  .object({
    name: SecretNameSchema,
    value: SecretValueSchema,
  })
  .strict();
export type PutSecretBody = z.infer<typeof PutSecretBodySchema>;

// ─── copying to another machine ───────────────────────────────────────────────────────────────────────────────────

export const SECRET_CLONE_SCHEMA_VERSION = 1 as const;

/** How long an opened import accepts a bundle. */
export const SECRET_IMPORT_TTL_SECONDS = 300;

/** Unpadded base64url, the one binary spelling these fields use. */
const Base64UrlSchema = z.string().regex(/^[A-Za-z0-9_-]+$/u, 'expected unpadded base64url');

/** `fy_daemon_` + base64url SHA-256 of the identity key's SPKI (spine D17). */
export const DaemonIdSchema = z.string().regex(/^fy_daemon_[A-Za-z0-9_-]{43}$/u, 'invalid daemon id');
export type DaemonId = z.infer<typeof DaemonIdSchema>;

/** `fy_secret_import_` and 22 base64url characters: 128 random bits, never a counter. */
export const SecretImportIdSchema = z
  .string()
  .regex(/^fy_secret_import_[A-Za-z0-9_-]{22}$/u, 'invalid secret import id');
export type SecretImportId = z.infer<typeof SecretImportIdSchema>;

/**
 * An MCP server's access token's name in the store (today's `isSignInSecretName`, `protocol/src/lib/mcp-oauth.ts`):
 * the one sign-in the vault holds, which a copy never carries.
 */
export function isSignInSecretName(name: string): boolean {
  return /^MCP_(?:[A-Z0-9_]+_)?[0-9A-F]{16}_ACCESS$/u.test(name);
}

/**
 * The name of a secret a copy MAY carry: a key a person stored, never a sign-in (owner decision 2026-10-20: "don't
 * copy sign-in, copy env var credentials only"). A BRAND, so a sign-in's name cannot reach a bundle by forgetting a
 * check: there is no other way to make one than to parse through here.
 */
export const CloneableSecretNameSchema = SecretNameSchema.refine(
  name => !isSignInSecretName(name),
  'a sign-in is not copied: sign in on the other machine instead',
).brand<'CloneableSecretName'>();
export type CloneableSecretName = z.infer<typeof CloneableSecretNameSchema>;

/** Which secrets to copy: names only, each once, at least one. */
export const SecretCloneNamesSchema = z
  .array(CloneableSecretNameSchema)
  .min(1)
  .max(MAX_SECRETS_PER_DAEMON)
  .refine(names => new Set(names).size === names.length, 'each secret is named once')
  .readonly();

/** What the TARGET publishes about one import. Every field is public; the private half never leaves its memory. */
export const SecretImportOfferSchema = z.strictObject({
  v: z.literal(SECRET_CLONE_SCHEMA_VERSION),
  importId: SecretImportIdSchema,
  daemonId: DaemonIdSchema,
  /** The target's Ed25519 daemon identity, as SubjectPublicKeyInfo DER. */
  identityKey: Base64UrlSchema,
  /** The import's one-time X25519 public key, raw. */
  publicKey: Base64UrlSchema,
  expiresAt: InstantSchema,
  /** Ed25519 over the fields above, by `identityKey`. */
  signature: Base64UrlSchema,
});
export type SecretImportOffer = z.infer<typeof SecretImportOfferSchema>;

/** What a person asks the SOURCE for: these names, sealed to that offer. */
export const SecretExportRequestSchema = z.strictObject({
  offer: SecretImportOfferSchema,
  names: SecretCloneNamesSchema,
});
export type SecretExportRequest = z.infer<typeof SecretExportRequestSchema>;

/** The sealed values, as the browser carries them; every field but `ciphertext` and `nonce` is authenticated. */
export const SealedSecretBundleSchema = z.strictObject({
  v: z.literal(SECRET_CLONE_SCHEMA_VERSION),
  importId: SecretImportIdSchema,
  sourceDaemonId: DaemonIdSchema,
  targetDaemonId: DaemonIdSchema,
  expiresAt: InstantSchema,
  names: SecretCloneNamesSchema,
  ephemeralKey: Base64UrlSchema,
  nonce: Base64UrlSchema,
  ciphertext: Base64UrlSchema,
});
export type SealedSecretBundle = z.infer<typeof SealedSecretBundleSchema>;

export const SecretExportResponseSchema = z.strictObject({
  bundle: SealedSecretBundleSchema,
  names: SecretCloneNamesSchema,
});
export type SecretExportResponse = z.infer<typeof SecretExportResponseSchema>;

/** Completing an import on the target: the bundle and nothing else (S150: other fields refused at parse). */
export const SecretImportCompleteRequestSchema = z.strictObject({ bundle: SealedSecretBundleSchema });
export type SecretImportCompleteRequest = z.infer<typeof SecretImportCompleteRequestSchema>;

/** What arrived: `imported` was new here and is filed; `kept` was already held and left exactly as it was. */
export const SecretImportResultSchema = z.strictObject({
  importId: SecretImportIdSchema,
  sourceDaemonId: DaemonIdSchema,
  imported: z.array(CloneableSecretNameSchema).max(MAX_SECRETS_PER_DAEMON).readonly(),
  filedAt: InstantSchema.optional(),
  kept: z.array(CloneableSecretNameSchema).max(MAX_SECRETS_PER_DAEMON).readonly(),
});
export type SecretImportResult = z.infer<typeof SecretImportResultSchema>;

/** Why a clone step refused. Each is a different next step for the person. */
export const SECRET_CLONE_REFUSALS = [
  'identity_unavailable',
  'offer_invalid',
  'offer_expired',
  'same_machine',
  'import_unknown',
  'import_spent',
  'bundle_invalid',
] as const;
export const SecretCloneRefusalSchema = z.enum(SECRET_CLONE_REFUSALS);
export type SecretCloneRefusal = z.infer<typeof SecretCloneRefusalSchema>;
