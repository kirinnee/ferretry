import type { MintsDocument, SecretName } from '../../../contract/index.ts';

/** The one place the mint ledger is read and written: a state document, never a value. */
export interface MintStore {
  read(): Promise<MintsDocument | undefined>;
  update(change: (current: MintsDocument) => MintsDocument): Promise<void>;
}

/**
 * WHO WROTE A SECRET'S CURRENT VALUE. A non-core plugin's `put` (the only write a plugin has, held to its manifest's
 * minted pattern) records the plugin's id and the identity of that write (the entry's random seal nonce); a secret is
 * "minted by" a plugin only while the entry still carries that very write. An owner's replacement, or a delete and
 * re-create, seals a new nonce, so a value somebody else put under a matching name is never a plugin's mint. The ledger
 * holds ids and nonces, never a value.
 *
 * Damaged is not "nobody minted it": a ledger that cannot be read answers `false` here (nothing is sent on its word).
 */
export class MintLedger {
  constructor(private readonly store: MintStore) {}

  async record(by: string, name: SecretName, write: string): Promise<void> {
    await this.store.update(current => ({ ...current, entries: { ...current.entries, [name]: { by, write } } }));
  }

  async forget(name: SecretName): Promise<void> {
    await this.store.update(current => {
      if (current.entries[name] === undefined) return current;
      const { [name]: _gone, ...rest } = current.entries;
      return { ...current, entries: rest };
    });
  }

  /** Whether `by` wrote the value now held under `name` (`write` is that entry's current write identity, or absent). */
  async mintedBy(by: string, name: SecretName, write: string | undefined): Promise<boolean> {
    if (write === undefined) return false;
    let document: MintsDocument | undefined;
    try {
      document = await this.store.read();
    } catch {
      return false;
    }
    const entry = document?.entries[name];
    return entry !== undefined && entry.by === by && entry.write === write;
  }
}
