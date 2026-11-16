/**
 * THE SEAM BETWEEN ACCOUNTS AND THE VAULT: where an account's password and 2FA seeds rest, sealed under the vault's
 * key in a document of their own, so `${secret:…}`, `fy secret use` and the secret listing never reach one (S9, S12,
 * I126). Today's `lib/secrets/types.ts` boundaries, copied as-is: the Vault provides the store and the cipher, and
 * Accounts holds the index that names each seal.
 *
 * PENDING THE VAULT CONTRACT (lead, 2026-11-07): `@ferretry/core-vault/contract` has no port for this yet. Until it
 * lands, `build` is handed these two through `AccountSealedStore` below; the shape is the one the Vault will provide.
 */
import type { SealedSecret, SecretStoreFailure, VaultDocument } from '@ferretry/core-vault/contract';

export type { SealedSecret, SecretStoreFailure };

/**
 * A store that cannot answer. IT IS NEVER PROJECTED AS AN EMPTY STORE: a person told "no accounts" over an index that
 * is merely unreadable will recreate every one on top of a file that is still there. The failure travels.
 */
export class SecretStoreError extends Error {
  constructor(
    readonly failure: SecretStoreFailure,
    message: string,
  ) {
    super(message);
    this.name = 'SecretStoreError';
  }
}

/** The sealed document, in the Vault's own envelope (`format: 1`, the cipher, entries by sealed name). */
export interface SecretVaultDocument {
  readonly format: VaultDocument['format'];
  /** The algorithm the entries were sealed with, so a change can refuse rather than guess. */
  readonly cipher: string;
  readonly entries: Readonly<Record<string, SealedSecret>>;
}

/**
 * Durable boundary for the sealed document. `read` answers `undefined` ONLY for a store never written; anything else
 * raises {@link SecretStoreError}, because those are not the same fact.
 */
export interface SecretDocumentStore {
  read(): Promise<SecretVaultDocument | undefined>;
  write(document: SecretVaultDocument): Promise<void>;
}

/**
 * Sealing and opening one value under the vault's key. `name` is authenticated data: an entry cannot be moved to
 * another name by editing the document.
 */
export interface SecretCipherPort {
  readonly algorithm: string;
  seal(name: string, plaintext: string): Promise<{ readonly iv: string; readonly ciphertext: string }>;
  /** Every entry opened under ONE read of the key; raises `undecipherable` / `key_missing`. */
  openAll(
    entries: Readonly<Record<string, { readonly iv: string; readonly ciphertext: string }>>,
  ): Promise<ReadonlyMap<string, string>>;
}

/** What the Vault hands Accounts: the sealed document for login values, and the cipher under the vault's key. */
export interface AccountSealedStore {
  readonly sealed: SecretDocumentStore;
  readonly cipher: SecretCipherPort;
}

/** A source of values to mask (today's `RedactionValueSource`): what the Vault's redactor asks Accounts for. */
export interface RedactionValueSource {
  values(): Promise<ReadonlyMap<string, string>>;
}
