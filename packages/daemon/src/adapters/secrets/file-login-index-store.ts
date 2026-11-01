import { join } from 'node:path';
import { type AccountIndexDocument, AccountIndexDocumentSchema } from '@ferretry/protocol';
import {
  type FileSystemPort,
  type FoundationPaths,
  LoginIndexDocumentSchema,
  type LoginIndexStore,
  SecretStoreError,
  type StoredLoginIndex,
} from '../../lib/index.ts';

/** The account index (it was the saved logins' index, and keeps the name): labels, places, which fields exist. */
export const LOGIN_INDEX_DOCUMENT = 'login-entries.json';

/**
 * The version 1 index as it was before the migration to accounts, kept once (docs/secrets.md, "Going back to an older
 * daemon"). Written only if absent, never read by this daemon.
 */
export const LOGIN_INDEX_VERSION_1_BACKUP = 'login-entries.v1.json';

/** The secret fields, sealed under the vault's key like the vault itself. */
export const LOGIN_SECRETS_DOCUMENT = 'login-secrets.json';

const LOGIN_INDEX_MODE = 0o600;

/**
 * The account index on disk, `0600` like the vault. It holds no value, but a username and where an account signs in
 * are still the owner's business. It READS a version 1 index (saved logins, for the migration) or a version 2 one,
 * and WRITES only version 2. DAMAGED IS NOT EMPTY: a file that parses as neither raises, and only a state home that
 * never saved a login answers `undefined`. No part of the file reaches an error message.
 */
export class FileLoginIndexStore implements LoginIndexStore {
  private readonly path: string;
  private readonly backup: string;

  constructor(
    paths: FoundationPaths,
    private readonly files: FileSystemPort,
  ) {
    this.path = join(paths.state, LOGIN_INDEX_DOCUMENT);
    this.backup = join(paths.state, LOGIN_INDEX_VERSION_1_BACKUP);
  }

  async read(): Promise<StoredLoginIndex | undefined> {
    const raw = await this.files.readText(this.path);
    if (raw === undefined) return undefined;
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      throw new SecretStoreError('unreadable', `${LOGIN_INDEX_DOCUMENT} is not JSON`);
    }
    const version = typeof decoded === 'object' && decoded !== null ? (decoded as { v?: unknown }).v : undefined;
    if (version === 2) {
      const parsed = AccountIndexDocumentSchema.safeParse(decoded);
      if (parsed.success) return { v: 2, document: parsed.data };
    } else if (version === 1) {
      const parsed = LoginIndexDocumentSchema.safeParse(decoded);
      if (parsed.success) return { v: 1, document: parsed.data, bytes: raw };
    }
    throw new SecretStoreError('unreadable', `${LOGIN_INDEX_DOCUMENT} is not an account index this daemon writes`);
  }

  async write(document: AccountIndexDocument): Promise<void> {
    await this.files.writeTextAtomic(this.path, `${JSON.stringify(document, undefined, 2)}\n`);
    await this.files.setMode(this.path, LOGIN_INDEX_MODE);
  }

  async keepVersion1(bytes: string): Promise<void> {
    if ((await this.files.readText(this.backup)) !== undefined) return;
    await this.files.writeTextAtomic(this.backup, bytes);
    await this.files.setMode(this.backup, LOGIN_INDEX_MODE);
  }
}
