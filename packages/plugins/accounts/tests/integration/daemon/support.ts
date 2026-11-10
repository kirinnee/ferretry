/**
 * In-memory stores for the account store's sealed-logins test (today's `runtime/mounts/support.ts`, the parts it uses).
 * There is one index format, 1: nothing older is planted.
 */
import type { Instant } from '@ferretry/std';
import type { AccountIndexDocument } from '../../../contract/routes/index.ts';
import type { LoginIndexStore } from '../../../daemon/lib/accounts.ts';
import { SecretStoreError } from '../../../daemon/lib/seal.ts';

export const CLOCK = { now: () => '2026-10-31T09:00:00.000Z' as Instant };

/** The index held in memory: `undefined` until written, or a failure for a damaged one. */
export class MemoryLoginIndex implements LoginIndexStore {
  document: AccountIndexDocument | undefined;
  constructor(private readonly failure?: SecretStoreError) {}
  async read(): Promise<AccountIndexDocument | undefined> {
    if (this.failure !== undefined) throw this.failure;
    return this.document;
  }
  async write(document: AccountIndexDocument): Promise<void> {
    this.document = document;
  }
  /** The committed index; a test that reads one before anything committed fails here. */
  get accounts(): AccountIndexDocument {
    if (this.document === undefined) throw new Error('no index has been committed');
    return this.document;
  }
}

/**
 * The Vault's sealed documents in memory, recording every call in order and failing a put on demand: what the
 * reseal-order tests (S83) need beyond the Vault's own `FakeSealedDocuments`.
 */
export class NamedSealedDocuments {
  readonly values = new Map<string, string>();
  readonly calls: string[] = [];
  failPut = false;
  open(_own: unknown, _document: unknown) {
    return {
      put: async (name: string, value: string | Uint8Array) => {
        this.calls.push(`put ${name}`);
        if (this.failPut) throw new Error('disk full');
        this.values.set(name, typeof value === 'string' ? value : new TextDecoder().decode(value));
      },
      get: async (name: string) => {
        this.calls.push(`get ${name}`);
        return this.values.get(name);
      },
      getBytes: async (name: string) => {
        const value = this.values.get(name);
        return value === undefined ? undefined : new TextEncoder().encode(value);
      },
      delete: async (name: string) => {
        this.calls.push(`delete ${name}`);
        return this.values.delete(name);
      },
      names: async () => [...this.values.keys()],
    };
  }
}
