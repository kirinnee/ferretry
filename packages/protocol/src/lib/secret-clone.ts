/**
 * Copying secrets from one machine to another, as the wire describes it (`docs/secrets.md`, "Copying
 * secrets to another machine").
 *
 * NOTHING HERE CARRIES A SECRET VALUE A CALLER CAN READ. The values travel only inside
 * {@link SealedSecretBundleSchema}'s `ciphertext`: AES-256-GCM under a key that exists on exactly two
 * daemons — the SOURCE, which derives it from a one-time X25519 key of its own and the TARGET's offered
 * public key, and the TARGET, which derives it from the private half it never let go of. The browser
 * that carries the bundle from one to the other holds neither private key, so the bytes it relays are
 * opaque to it. A bundle is therefore NOT a secret value in the sense `secrets.ts` means, and the "no
 * schema carries a value out" rule there still holds.
 *
 * THE THREE STEPS, each on its own daemon:
 *
 * 1. the TARGET opens an import: a one-time key pair, an id and a short expiry, signed with the
 *    target's own daemon identity — the key whose fingerprint IS its daemon id;
 * 2. the SOURCE, after a passkey confirmation for this act alone, checks that signature and seals the
 *    chosen values to the offered key, bound to both daemon ids, the import id and the expiry;
 * 3. the TARGET opens the bundle once, files the values in its own store, and forgets the import.
 */

import { z } from 'zod';
import { InstantSchema } from './common.ts';
import { isSignInSecretName } from './mcp-oauth.ts';
import { DaemonIdSchema } from './pairing.ts';
import { MAX_SECRETS_PER_DAEMON, SecretNameSchema } from './secrets.ts';

export const SECRET_CLONE_SCHEMA_VERSION = 1 as const;

/** The target's half: opening an import, and completing one at `/:importId`. */
export const SECRET_IMPORTS_PATH = '/v1/secrets/imports' as const;

/** The source's half: sealing chosen secrets for one import, at `/:importId`. */
export const SECRET_EXPORTS_PATH = '/v1/secrets/exports' as const;

/**
 * How long an opened import accepts a bundle. Long enough for a person to pick names and confirm a
 * passkey on the other machine; short enough that a forgotten one is gone before anybody finds it.
 */
export const SECRET_IMPORT_TTL_SECONDS = 300;

/** Unpadded base64url, the one binary spelling these fields use. */
const Base64UrlSchema = z.string().regex(/^[A-Za-z0-9_-]+$/u, 'expected unpadded base64url');

/** `fy_secret_import_` and 22 base64url characters: 128 random bits, never a counter. */
export const SecretImportIdSchema = z
  .string()
  .regex(/^fy_secret_import_[A-Za-z0-9_-]{22}$/u, 'invalid secret import id');
export type SecretImportId = z.infer<typeof SecretImportIdSchema>;

/**
 * The name of a secret a copy MAY carry: a key a person stored, never a sign-in (docs/secrets.md,
 * "Copying secrets to another machine"). Owner decision 2026-10-20: "don't copy sign-in, copy env var
 * credentials only". A sign-in token is half of a login whose refresh half cannot travel, and a refresh
 * token that lived on two machines would sign one of them out the first time the other refreshed.
 *
 * It is a BRAND, so everything downstream of a copy — the request, the bundle's plaintext, the names
 * the target files — is typed to hold only these, and a sign-in's name cannot reach a bundle by
 * forgetting a check: there is no other way to make one than to parse through here.
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

/**
 * What the TARGET publishes about one import. Every field is public: a key pair's public half, an id, an
 * expiry and a signature. The private half never leaves the target's memory.
 */
export const SecretImportOfferSchema = z.strictObject({
  v: z.literal(SECRET_CLONE_SCHEMA_VERSION),
  importId: SecretImportIdSchema,
  /** The target. A source refuses an offer whose `identityKey` does not hash to it. */
  daemonId: DaemonIdSchema,
  /** The target's Ed25519 daemon identity, as SubjectPublicKeyInfo DER — the key the daemon id fingerprints. */
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

/**
 * The sealed values, as the browser carries them from source to target.
 *
 * Every field but `ciphertext` and `nonce` is also authenticated data, so a bundle cannot be re-pointed
 * at another import, another machine or another set of names without the target refusing it whole.
 */
export const SealedSecretBundleSchema = z.strictObject({
  v: z.literal(SECRET_CLONE_SCHEMA_VERSION),
  importId: SecretImportIdSchema,
  sourceDaemonId: DaemonIdSchema,
  targetDaemonId: DaemonIdSchema,
  expiresAt: InstantSchema,
  /** The names inside, so the target can say what arrived without opening anything first. */
  names: SecretCloneNamesSchema,
  /** The source's one-time X25519 public key, raw. */
  ephemeralKey: Base64UrlSchema,
  nonce: Base64UrlSchema,
  /** AES-256-GCM, tag appended. Opens only on the target, only for this import. */
  ciphertext: Base64UrlSchema,
});
export type SealedSecretBundle = z.infer<typeof SealedSecretBundleSchema>;

/** The source's answer: the bundle, and the names it sealed (what its security log records). */
export const SecretExportResponseSchema = z.strictObject({
  bundle: SealedSecretBundleSchema,
  names: SecretCloneNamesSchema,
});
export type SecretExportResponse = z.infer<typeof SecretExportResponseSchema>;

/** Completing an import on the target. */
export const SecretImportCompleteRequestSchema = z.strictObject({ bundle: SealedSecretBundleSchema });
export type SecretImportCompleteRequest = z.infer<typeof SecretImportCompleteRequestSchema>;

/** What arrived: every name copied, and which of those replaced a secret this machine already held. */
export const SecretImportResultSchema = z.strictObject({
  importId: SecretImportIdSchema,
  sourceDaemonId: DaemonIdSchema,
  imported: SecretCloneNamesSchema,
  replaced: z.array(CloneableSecretNameSchema).max(MAX_SECRETS_PER_DAEMON).readonly(),
});
export type SecretImportResult = z.infer<typeof SecretImportResultSchema>;

/**
 * Why a clone step refused. Each is a different next step for the person, so none collapses into one.
 *
 * - `identity_unavailable`: this daemon cannot read its own identity, so it can neither sign nor check one.
 * - `offer_invalid`: the offer's signature, fingerprint or shape does not hold — it was not made by the
 *   machine it names.
 * - `offer_expired`: the import timed out; open a new one.
 * - `same_machine`: the source was asked to copy to itself.
 * - `import_unknown`: the target holds no such import (never opened, timed out, or the daemon restarted).
 * - `import_spent`: the import was already used — a bundle is accepted once.
 * - `bundle_invalid`: the bundle does not open for this import: tampered, sealed to another key, or for
 *   another machine. The import is spent by the attempt.
 */
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
