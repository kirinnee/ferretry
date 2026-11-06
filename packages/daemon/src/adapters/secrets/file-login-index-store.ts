import { join } from 'node:path';
import { type AccountIndexDocument, AccountIndexDocumentSchema } from '@ferretry/protocol';
import { type FileSystemPort, type FoundationPaths, type LoginIndexStore, SecretStoreError } from '../../lib/index.ts';

/** The account index (it was the saved logins' index, and keeps the name): labels, places, which fields exist. */
export const LOGIN_INDEX_DOCUMENT = 'login-entries.json';

/** The secret fields, sealed under the vault's key like the vault itself. */
export const LOGIN_SECRETS_DOCUMENT = 'login-secrets.json';

const LOGIN_INDEX_MODE = 0o600;

/**
 * The account index on disk, `0600` like the vault. It holds no value, but a username and where an account signs in
 * are still the owner's business. It reads and writes version 2 only. DAMAGED IS NOT EMPTY: a file that does not
 * parse as one raises, and only a state home that never saved a login answers `undefined`.
 * No part of the file reaches an error message.
 */
export class FileLoginIndexStore implements LoginIndexStore {
  private readonly path: string;

  constructor(
    paths: FoundationPaths,
    private readonly files: FileSystemPort,
  ) {
    this.path = join(paths.state, LOGIN_INDEX_DOCUMENT);
  }

  async read(): Promise<AccountIndexDocument | undefined> {
    const raw = await this.files.readText(this.path);
    if (raw === undefined) return undefined;
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      throw new SecretStoreError('unreadable', `${LOGIN_INDEX_DOCUMENT} is not JSON`);
    }
    const parsed = AccountIndexDocumentSchema.safeParse(decoded);
    if (parsed.success) return parsed.data;
    throw new SecretStoreError('unreadable', `${LOGIN_INDEX_DOCUMENT} is not an account index this daemon writes`);
  }

  async write(document: AccountIndexDocument): Promise<void> {
    await this.files.writeTextAtomic(this.path, `${JSON.stringify(document, undefined, 2)}\n`);
    await this.files.setMode(this.path, LOGIN_INDEX_MODE);
  }
}
