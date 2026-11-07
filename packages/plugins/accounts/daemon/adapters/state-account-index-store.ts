import type { StateFileDef, StatePort } from '@ferretry/kernel/contract';
import { type AccountIndexDocument, AccountIndexDocumentSchema } from '../../shared/index.ts';
import type { LoginIndexStore } from '../lib/accounts.ts';
import { SecretStoreError } from '../lib/seal.ts';

/** The account index's file (`state/accounts/accounts.json`): labels, places, which fields exist. Never a value. */
export const ACCOUNT_INDEX_DOCUMENT = 'accounts.json';

/**
 * The account index through the kernel's state port, `0600` (S68): it holds no value, but a username and where an
 * account signs in are still the owner's business. DAMAGED IS NOT EMPTY: a file the kernel reads as damaged, or one
 * that does not parse as an index, raises, and only a home that never saved an account answers `undefined`. No part
 * of the file reaches an error message.
 */
export class StateAccountIndexStore implements LoginIndexStore {
  constructor(
    private readonly state: Pick<StatePort, 'read' | 'write'>,
    private readonly file: StateFileDef,
  ) {}

  async read(): Promise<AccountIndexDocument | undefined> {
    const read = await this.state.read(this.file);
    if (!read.ok) throw new SecretStoreError('unreadable', read.error.sentence);
    if (read.value === undefined) return undefined;
    const parsed = AccountIndexDocumentSchema.safeParse({ format: 1, ...(read.value as object) });
    if (!parsed.success)
      throw new SecretStoreError('unreadable', `${ACCOUNT_INDEX_DOCUMENT} is not an account index this daemon writes`);
    return parsed.data;
  }

  async write(document: AccountIndexDocument): Promise<void> {
    await this.state.write(this.file, document);
  }
}
