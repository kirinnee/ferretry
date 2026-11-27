import type { StateFileDef, StatePort } from '@ferretry/kernel/contract';
import { type IdentityLinksDocument, IdentityLinksDocumentSchema } from '../../contract/routes/index.ts';
import type { IdentityLinksStore } from '../lib/identity-links.ts';
import { SecretStoreError } from '../lib/seal.ts';

/**
 * The identity graph's edges through the kernel's state port (`state/accounts/identity-links.json`, `0600`). It holds
 * keys, ids and times, never a value. DAMAGED IS NOT EMPTY: a file the kernel reads as damaged, or one that does not
 * parse, raises; only a home that never recorded an edge answers the empty document. No part of the file reaches an
 * error message.
 */
export class StateIdentityLinksStore implements IdentityLinksStore {
  constructor(
    private readonly state: Pick<StatePort, 'read' | 'write'>,
    private readonly file: StateFileDef,
  ) {}

  async read(): Promise<IdentityLinksDocument> {
    const read = await this.state.read(this.file);
    if (!read.ok) throw new SecretStoreError('unreadable', read.error.sentence);
    if (read.value === undefined) return { format: 1, links: [], proposals: [] };
    const parsed = IdentityLinksDocumentSchema.safeParse({ format: 1, ...(read.value as object) });
    if (!parsed.success)
      throw new SecretStoreError('unreadable', 'identity-links.json is not a graph this daemon writes');
    return parsed.data;
  }

  async write(document: IdentityLinksDocument): Promise<void> {
    await this.state.write(this.file, document);
  }
}
