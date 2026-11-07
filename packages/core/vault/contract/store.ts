import { defineState } from '@ferretry/kernel/contract';
import { z } from 'zod';

/**
 * The sealed store (spine D16): BYTE FOR BYTE today's. The sealing is today's, copied as-is from
 * `packages/daemon/src/lib/secrets` and `adapters/secrets/webcrypto-secret-cipher.ts`: AES-256-GCM, a random 96-bit
 * IV per seal, the secret's NAME as additional authenticated data, `iv` and `ciphertext` base64. The key is today's
 * `vault.key` exactly: 32 random bytes, base64, one trailing newline, mode `0600`.
 *
 * The only change is the envelope: today's `{ "v": 1, "cipher", "entries" }` is `{ "format": 1, "cipher", "entries" }`
 * (the `one-format` rule). Every entry's `iv`, `ciphertext`, `createdAt` and `updatedAt` move byte for byte; nothing
 * is ever decrypted and re-encrypted to move them (the out-of-product converter renames one key).
 */

export const SECRET_CIPHER_ALGORITHM = 'AES-256-GCM' as const;
/** 96-bit nonce, the size AES-GCM is specified for. */
export const SECRET_IV_BYTES = 12;
export const VAULT_KEY_BYTES = 32;

const Base64Schema = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/u, 'base64');

/** One sealed entry, exactly as today writes it. */
export const SealedSecretSchema = z.strictObject({
  iv: Base64Schema,
  ciphertext: Base64Schema,
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type SealedSecret = z.infer<typeof SealedSecretSchema>;

export const VaultDocumentSchema = z.strictObject({
  format: z.literal(1),
  cipher: z.literal(SECRET_CIPHER_ALGORITHM),
  /** Keyed by secret name; the name is the AAD, so moving an entry under another name fails to open. */
  entries: z.record(
    z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/u)
      .max(64),
    SealedSecretSchema,
  ),
});
export type VaultDocument = z.infer<typeof VaultDocumentSchema>;

/** `state/vault/vault.json` (sealed). */
export const VaultFile = defineState({
  name: 'vault',
  path: 'vault.json',
  store: 'secret',
  format: 1,
  schema: VaultDocumentSchema,
  mode: 0o600,
});

/** `state/vault/vault.key`: minted on the first write, never configured; present and unusable RAISES (never re-mint). */
export const VaultKeyFile = defineState({
  name: 'vault-key',
  path: 'vault.key',
  store: 'secret',
  format: 1,
  mode: 0o600,
});

/** Today's key-file text check: base64 of exactly {@link VAULT_KEY_BYTES} bytes, trailing whitespace ignored. */
export function isVaultKeyText(text: string): boolean {
  const raw = text.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(raw)) return false;
  return atob(raw).length === VAULT_KEY_BYTES;
}

/** Why the store could not be used (today's `SecretStoreFailure`). Any of them fails closed. */
export type SecretStoreFailure = 'unreadable' | 'key_missing' | 'undecipherable' | 'full';
