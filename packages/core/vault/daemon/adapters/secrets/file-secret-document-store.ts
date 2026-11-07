import { SecretStoreError, type SecretDocumentStore, type SecretVaultDocument } from '../../lib/secrets/types.ts';
import type { SealedFiles } from './kernel-sealed-files.ts';

/** The sealed vault (`state/vault/vault.json`, spine D16; today's `secrets.json`). */
export const SECRETS_DOCUMENT = 'vault.json';

/** The key the vault is sealed under, in its own file (`state/vault/vault.key`; today's `secrets.key`). */
export const SECRETS_KEY = 'vault.key';

/**
 * The secret vault on disk, and the honest statement of what that protects.
 *
 * WHAT THIS PROTECTS AGAINST — and it is a real, common failure, not a theoretical one:
 *
 *   The vault is ciphertext, and the key lives in a DIFFERENT file with a different name. The single
 *   most likely way a secret escapes a developer machine is one file travelling somewhere it should
 *   not: `state/` swept into a backup, a state home tarred for a bug report, a directory synced to a
 *   cloud drive, a file pasted into a chat. Every one of those moves `secrets.json` without
 *   `secrets.key`, and every one of them now fails safe.
 *
 * WHAT IT DOES NOT PROTECT AGAINST, and must never be described as protecting against:
 *
 *   Anyone who can read both files. The key sits beside the ciphertext, so anybody with this user
 *   account — or a backup that took the whole directory — has everything. This is encryption at rest
 *   against ACCIDENTS, not against an attacker with local access. A key derived from a passphrase
 *   nobody types, or held in an OS keychain, would be a different and stronger claim; this is not
 *   that, and calling it that would be the overclaim the whole subsystem is written to avoid.
 *
 * DAMAGED IS NOT EMPTY. A document that will not parse, or ciphertext whose key file has gone,
 * raises rather than answering an empty vault. Only a state home that has never held a secret
 * answers `undefined`.
 */
export class FileSecretDocumentStore implements SecretDocumentStore {
  constructor(private readonly files: SealedFiles) {}

  async read(): Promise<SecretVaultDocument | undefined> {
    const raw = await this.files.readText('vault');
    if (raw === undefined) return undefined;
    const parsed = parseVaultDocument(raw);
    // Ciphertext with no key is the one state that MUST NOT look like an empty store: the entries
    // are still there, and a person told the vault is empty will write new secrets over them.
    if (Object.keys(parsed.entries).length > 0 && (await this.files.readText('key')) === undefined)
      throw new SecretStoreError('key_missing', `${SECRETS_DOCUMENT} holds sealed secrets and ${SECRETS_KEY} is gone`);
    return parsed;
  }

  async write(document: SecretVaultDocument): Promise<void> {
    // The kernel writes a `secret` file atomically and `0600` (today's `writeTextAtomic` + `setMode`).
    await this.files.writeText('vault', `${JSON.stringify(document, undefined, 2)}\n`);
  }
}

/**
 * The document, or a refusal naming the file.
 *
 * Nothing from the file body reaches the message. It is ciphertext rather than plaintext, but a
 * parser error that quotes its input is a habit that leaks the moment the shape changes.
 */
export function parseVaultDocument(raw: string): SecretVaultDocument {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new SecretStoreError('unreadable', `${SECRETS_DOCUMENT} is not JSON`);
  }
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded))
    throw new SecretStoreError('unreadable', `${SECRETS_DOCUMENT} is not a vault document`);
  const candidate = decoded as Record<string, unknown>;
  if (candidate.format !== 1 || typeof candidate.cipher !== 'string')
    throw new SecretStoreError(
      'unreadable',
      `${SECRETS_DOCUMENT} does not declare the format and cipher this daemon writes`,
    );
  const entries = candidate.entries;
  if (entries === null || typeof entries !== 'object' || Array.isArray(entries))
    throw new SecretStoreError('unreadable', `${SECRETS_DOCUMENT} has no entry table`);
  const sealed: Record<string, SecretVaultDocument['entries'][string]> = {};
  for (const [name, entry] of Object.entries(entries as Record<string, unknown>)) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry))
      throw new SecretStoreError('unreadable', `${SECRETS_DOCUMENT} entry ${name} is not an object`);
    const fields = entry as Record<string, unknown>;
    if (
      typeof fields.iv !== 'string' ||
      typeof fields.ciphertext !== 'string' ||
      typeof fields.createdAt !== 'string' ||
      typeof fields.updatedAt !== 'string'
    )
      throw new SecretStoreError('unreadable', `${SECRETS_DOCUMENT} entry ${name} is missing its sealed fields`);
    sealed[name] = {
      iv: fields.iv,
      ciphertext: fields.ciphertext,
      createdAt: fields.createdAt,
      updatedAt: fields.updatedAt,
    };
  }
  return { format: 1, cipher: candidate.cipher, entries: sealed };
}
