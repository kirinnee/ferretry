import { join } from 'node:path';
import {
  type FileSystemPort,
  type FoundationPaths,
  type LoginIndexDocument,
  LoginIndexDocumentSchema,
  type LoginIndexStore,
  SecretStoreError,
} from '../../lib/index.ts';

/** The saved logins' index: labels, matches, usernames and which secret fields exist. Nothing secret. */
export const LOGIN_INDEX_DOCUMENT = 'login-entries.json';

/** The saved logins' secret fields, sealed under the vault's key like the vault itself. */
export const LOGIN_SECRETS_DOCUMENT = 'login-secrets.json';

const LOGIN_INDEX_MODE = 0o600;

/**
 * The saved-login index on disk, `0600` like the vault. It holds no value, but a username and what a login
 * is for are still the owner's business. DAMAGED IS NOT EMPTY: a file that will not parse raises, and only a
 * state home that never saved a login answers `undefined`. No part of the file reaches an error message.
 */
export class FileLoginIndexStore implements LoginIndexStore {
  private readonly path: string;

  constructor(
    paths: FoundationPaths,
    private readonly files: FileSystemPort,
  ) {
    this.path = join(paths.state, LOGIN_INDEX_DOCUMENT);
  }

  async read(): Promise<LoginIndexDocument | undefined> {
    const raw = await this.files.readText(this.path);
    if (raw === undefined) return undefined;
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      throw new SecretStoreError('unreadable', `${LOGIN_INDEX_DOCUMENT} is not JSON`);
    }
    const parsed = LoginIndexDocumentSchema.safeParse(decoded);
    if (!parsed.success)
      throw new SecretStoreError('unreadable', `${LOGIN_INDEX_DOCUMENT} is not a saved-login index this daemon writes`);
    return parsed.data;
  }

  async write(document: LoginIndexDocument): Promise<void> {
    await this.files.writeTextAtomic(this.path, `${JSON.stringify(document, undefined, 2)}\n`);
    await this.files.setMode(this.path, LOGIN_INDEX_MODE);
  }
}
