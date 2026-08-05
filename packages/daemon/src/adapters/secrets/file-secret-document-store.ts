import { join } from 'node:path';
import {
  type FileSystemPort,
  type FoundationPaths,
  SecretStoreError,
  type SecretDocumentStore,
  type SecretVaultDocument,
} from '../../lib/index.ts';

/**
 * Owner read/write only, for the vault and for the key that opens it.
 *
 * `0600` is what the daemon's own `api-token` uses and is the defensible baseline: it stops another
 * local account, and it stops nothing about the account this daemon runs as.
 */
const SECRET_MODE = 0o600;

/** The sealed vault. */
export const SECRETS_DOCUMENT = 'secrets.json';

/** The key the vault is sealed under, in its own file. */
export const SECRETS_KEY = 'secrets.key';

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
  private readonly documentPath: string;
  private readonly keyPath: string;

  constructor(
    paths: FoundationPaths,
    private readonly files: FileSystemPort,
  ) {
    this.documentPath = join(paths.state, SECRETS_DOCUMENT);
    this.keyPath = join(paths.state, SECRETS_KEY);
  }

  /** Where the key rests, so the cipher adapter and this store cannot disagree about the path. */
  get keyFile(): string {
    return this.keyPath;
  }

  async read(): Promise<SecretVaultDocument | undefined> {
    const raw = await this.files.readText(this.documentPath);
    if (raw === undefined) return undefined;
    const parsed = parseVaultDocument(raw);
    // Ciphertext with no key is the one state that MUST NOT look like an empty store: the entries
    // are still there, and a person told the vault is empty will write new secrets over them.
    if (Object.keys(parsed.entries).length > 0 && (await this.files.readText(this.keyPath)) === undefined)
      throw new SecretStoreError('key_missing', `${SECRETS_DOCUMENT} holds sealed secrets and ${SECRETS_KEY} is gone`);
    return parsed;
  }

  async write(document: SecretVaultDocument): Promise<void> {
    await this.files.writeTextAtomic(this.documentPath, `${JSON.stringify(document, undefined, 2)}\n`);
    await this.files.setMode(this.documentPath, SECRET_MODE);
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
  if (candidate.v !== 1 || typeof candidate.cipher !== 'string')
    throw new SecretStoreError(
      'unreadable',
      `${SECRETS_DOCUMENT} does not declare a version and cipher this daemon writes`,
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
  return { v: 1, cipher: candidate.cipher, entries: sealed };
}
