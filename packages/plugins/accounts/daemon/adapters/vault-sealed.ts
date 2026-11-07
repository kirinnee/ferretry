import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  SECRET_CIPHER_ALGORITHM,
  type SealedDocumentHandle,
  type SealedName,
  SealedNameSchema,
} from '@ferretry/core-vault/contract';
import {
  type AccountSealedStore,
  type SecretCipherPort,
  type SecretDocumentStore,
  SecretStoreError,
  type SecretVaultDocument,
} from '../lib/seal.ts';

/**
 * TODO(vault contract): `names()` on `SealedDocumentHandle` (lead asked the Vault owner, 2026-11-07). The account store
 * needs it for today's sweep of values no account points at (S73, I152, I188), the redactor's masks (S10) and the
 * damaged-store check (S70). Until the Vault's handle has it, a handle without it fails CLOSED as `key_missing`.
 */
export type SealedHandleWithNames = SealedDocumentHandle & { names?(): Promise<readonly SealedName[]> };

/** An entry the Vault holds: the account store sees its name, never its bytes; opening it asks the Vault. */
const IN_VAULT = 'vault';
/** An entry sealed in THIS process's memory under {@link MemoryCipher}'s key: a new value on its way in. */
const IN_MEMORY = 'm:';

const AAD = (name: string): Buffer => Buffer.from(name, 'utf8');

/**
 * AES-256-GCM under a key made at start and never written anywhere: what a value is sealed with while it is only in
 * the daemon's memory — a 2FA seed waiting for its passkey (S89), or a new password or seed between its seal and the
 * write that hands it to the Vault. A restart forgets the key, and with it every value sealed this way.
 */
export class MemoryCipher implements SecretCipherPort {
  readonly algorithm = SECRET_CIPHER_ALGORITHM;
  readonly #key = randomBytes(32);

  async seal(name: string, plaintext: string): Promise<{ readonly iv: string; readonly ciphertext: string }> {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv).setAAD(AAD(name));
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    return { iv: `${IN_MEMORY}${iv.toString('base64')}`, ciphertext: body.toString('base64') };
  }

  /** Whether an entry is one this cipher sealed (and so can open without the Vault). */
  holds(entry: { readonly iv: string }): boolean {
    return entry.iv.startsWith(IN_MEMORY);
  }

  open(name: string, entry: { readonly iv: string; readonly ciphertext: string }): string {
    try {
      const body = Buffer.from(entry.ciphertext, 'base64');
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.#key,
        Buffer.from(entry.iv.slice(IN_MEMORY.length), 'base64'),
      )
        .setAAD(AAD(name))
        .setAuthTag(body.subarray(body.length - 16));
      return Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]).toString('utf8');
    } catch {
      throw new SecretStoreError('undecipherable', `${name} could not be opened`);
    }
  }

  async openAll(
    entries: Readonly<Record<string, { readonly iv: string; readonly ciphertext: string }>>,
  ): Promise<ReadonlyMap<string, string>> {
    const opened = new Map<string, string>();
    for (const [name, entry] of Object.entries(entries)) opened.set(name, this.open(name, entry));
    return opened;
  }
}

const sealedName = (name: string): SealedName => {
  const parsed = SealedNameSchema.safeParse(name);
  if (!parsed.success) throw new SecretStoreError('unreadable', 'a sealed name the Vault cannot hold');
  return parsed.data;
};

/** A Vault failure as the account store's own, never with its message (it could name a value's place). */
const failed = (error: unknown, what: string): never => {
  if (error instanceof SecretStoreError) throw error;
  throw new SecretStoreError('unreadable', `the Vault could not ${what}`);
};

/**
 * THE ACCOUNTS' SEALED VALUES, IN THE VAULT (`login-secrets.json`, today's document, now a sealed document of Accounts'
 * own), presented as the whole-document store and cipher today's account store was written against, so that code is
 * copied unchanged:
 *
 * - `read()` lists the names the Vault holds, each as an entry with no bytes in it ({@link IN_VAULT}).
 * - `seal()` seals a NEW value in memory ({@link MemoryCipher}); nothing reaches the Vault yet, so a change the store
 *   then refuses leaves nothing behind.
 * - `write(document)` hands every in-memory entry to the Vault under its (fresh) name, then forgets every name the
 *   document no longer has (the sweep). A value in use is never overwritten: new values get fresh names.
 * - `openAll()` opens an in-memory entry here and asks the Vault for a stored one.
 */
export function vaultSealedStore(handle: SealedHandleWithNames): AccountSealedStore {
  const memory = new MemoryCipher();
  const names = async (): Promise<readonly SealedName[]> => {
    if (handle.names === undefined)
      throw new SecretStoreError('key_missing', 'the Vault cannot list the accounts’ sealed values yet');
    return await handle.names().catch((error: unknown) => failed(error, 'list the accounts’ sealed values'));
  };
  const sealed: SecretDocumentStore = {
    read: async (): Promise<SecretVaultDocument | undefined> => {
      const held = await names();
      if (held.length === 0) return undefined;
      return {
        format: 1,
        cipher: SECRET_CIPHER_ALGORITHM,
        // The Vault stamps its own entries; the account store never reads these.
        entries: Object.fromEntries(
          held.map(name => [name, { iv: IN_VAULT, ciphertext: IN_VAULT, createdAt: '', updatedAt: '' }]),
        ),
      };
    },
    write: async (document: SecretVaultDocument): Promise<void> => {
      for (const [name, entry] of Object.entries(document.entries))
        if (memory.holds(entry))
          await handle
            .put(sealedName(name), memory.open(name, entry))
            .catch((error: unknown) => failed(error, 'keep a new value'));
      const keep = new Set(Object.keys(document.entries));
      for (const name of await names())
        if (!keep.has(name))
          await handle.delete(name).catch((error: unknown) => failed(error, 'forget a value no account uses'));
    },
  };
  const cipher: SecretCipherPort = {
    algorithm: SECRET_CIPHER_ALGORITHM,
    seal: async (name, plaintext) => await memory.seal(name, plaintext),
    openAll: async entries => {
      const opened = new Map<string, string>();
      for (const [name, entry] of Object.entries(entries)) {
        if (memory.holds(entry)) {
          opened.set(name, memory.open(name, entry));
          continue;
        }
        const value = await handle.get(sealedName(name)).catch((error: unknown) => failed(error, 'open a value'));
        if (value === undefined) throw new SecretStoreError('undecipherable', `${name} is not in the Vault`);
        opened.set(name, value);
      }
      return opened;
    },
  };
  return { sealed, cipher };
}
